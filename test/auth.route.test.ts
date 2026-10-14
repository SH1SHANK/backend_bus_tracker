import { beforeAll, describe, expect, it, vi } from 'vitest';
import { hashSecret } from '../src/lib/password.js';

let validHash: string;

const { mockMaybeSingle } = vi.hoisted(() => ({
  mockMaybeSingle: vi.fn(),
}));

vi.mock('../src/lib/supabase.js', () => ({
  supabase: {
    from: vi.fn((table: string) => {
      if (table === 'buses') {
        return {
          select: vi.fn(() => ({
            limit: vi.fn(async () => ({ data: [{ id: 'b1' }], error: null })),
          })),
        };
      }
      return {
        select: vi.fn(() => ({
          eq: vi.fn(() => ({
            maybeSingle: mockMaybeSingle,
          })),
        })),
      };
    }),
  },
}));

import { buildApp } from '../src/app.js';

let app: Awaited<ReturnType<typeof buildApp>>;

beforeAll(async () => {
  validHash = await hashSecret('correct_horse_battery_16chars');
  mockMaybeSingle.mockImplementation(async () => ({
    data: { bus_id: 'b1-uuid', credential_hash: validHash, is_active: true },
    error: null,
  }));
  app = await buildApp();
});

const postAuth = (payload: object) =>
  app.inject({
    method: 'POST',
    url: '/api/v1/auth/device',
    payload,
  });

describe('POST /api/v1/auth/device', () => {
  it('returns JWT token on valid credentials', async () => {
    const res = await postAuth({
      device_id: 'NITC-BUS-001',
      secret: 'correct_horse_battery_16chars',
    });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.token).toBeDefined();
    expect(body.token_type).toBe('Bearer');
    expect(body.expires_in).toBe(43200);
  });

  it('rejects wrong secret with 401', async () => {
    const res = await postAuth({
      device_id: 'NITC-BUS-001',
      secret: 'wrong_secret_at_least_16_chars',
    });
    expect(res.statusCode).toBe(401);
    expect(res.json().code).toBe('invalid_credentials');
  });

  it('rejects inactive device with 401', async () => {
    mockMaybeSingle.mockImplementationOnce(async () => ({
      data: { bus_id: 'b1-uuid', credential_hash: validHash, is_active: false },
      error: null,
    }));
    const res = await postAuth({
      device_id: 'NITC-BUS-001',
      secret: 'correct_horse_battery_16chars',
    });
    expect(res.statusCode).toBe(401);
  });

  it('rejects secret shorter than 16 characters with 400', async () => {
    const res = await postAuth({
      device_id: 'NITC-BUS-001',
      secret: 'short_secret',
    });
    expect(res.statusCode).toBe(400);
  });

  it('readyz probe returns 200 when database is available', async () => {
    const res = await app.inject({ method: 'GET', url: '/readyz' });
    expect(res.statusCode).toBe(200);
    expect(res.json().status).toBe('ready');
  });
});
