import { beforeAll, describe, expect, it, vi } from 'vitest';

const { mockResetDeviceSequence } = vi.hoisted(() => ({
  mockResetDeviceSequence: vi.fn(async (_fn: string, args: any) => {
    if (args.p_secret === 'wrong_secret_12345') {
      return { data: { ok: false, code: 'INVALID_CREDENTIALS', error: 'Invalid device credentials' }, error: null };
    }
    if (args.p_session_id === 'cached_session_id') {
      return {
        data: {
          ok: true,
          code: 'SUCCESS',
          device_id: args.p_device_id,
          bus_id: 'b1-uuid',
          epoch: 2,
          idempotent_retry: true,
        },
        error: null,
      };
    }
    return {
      data: {
        ok: true,
        code: 'SUCCESS',
        device_id: args.p_device_id,
        bus_id: 'b1-uuid',
        epoch: 2,
        idempotent_retry: false,
      },
      error: null,
    };
  }),
}));

vi.mock('../src/lib/supabase.js', () => ({
  supabase: {
    rpc: mockResetDeviceSequence,
    from: vi.fn(() => ({
      select: vi.fn(() => ({
        eq: vi.fn(() => ({
          maybeSingle: vi.fn(async () => ({
            data: { bus_id: 'b1-uuid', credential_hash: 'dummy', is_active: true },
            error: null,
          })),
        })),
      })),
    })),
  },
}));

import { buildApp } from '../src/app.js';

let app: Awaited<ReturnType<typeof buildApp>>;

beforeAll(async () => {
  app = await buildApp();
});

const postReset = (payload: object) =>
  app.inject({
    method: 'POST',
    url: '/api/v1/auth/reset-session',
    payload,
  });

describe('POST /api/v1/auth/reset-session', () => {
  it('advances epoch on valid device credentials', async () => {
    const res = await postReset({
      device_id: 'NITC-BUS-001',
      secret: 'super_secret_device_pass_16chars',
      session_id: 'boot_session_001',
      reason: 'firmware_reboot',
    });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.ok).toBe(true);
    expect(body.epoch).toBe(2);
    expect(body.idempotent_retry).toBe(false);
  });

  it('handles idempotent retry when session_id matches existing session', async () => {
    const res = await postReset({
      device_id: 'NITC-BUS-001',
      secret: 'super_secret_device_pass_16chars',
      session_id: 'cached_session_id',
    });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.ok).toBe(true);
    expect(body.epoch).toBe(2);
    expect(body.idempotent_retry).toBe(true);
  });

  it('rejects invalid credentials with 401', async () => {
    const res = await postReset({
      device_id: 'NITC-BUS-001',
      secret: 'wrong_secret_12345',
      session_id: 'boot_session_001',
    });
    expect(res.statusCode).toBe(401);
    expect(res.json().code).toBe('INVALID_CREDENTIALS');
  });

  it('rejects missing session_id with 400', async () => {
    const res = await postReset({
      device_id: 'NITC-BUS-001',
      secret: 'super_secret_device_pass_16chars',
    });
    expect(res.statusCode).toBe(400);
  });

  it('rejects secrets shorter than 16 characters with 400', async () => {
    const res = await postReset({
      device_id: 'NITC-BUS-001',
      secret: 'short_secret',
      session_id: 'boot_session_001',
    });
    expect(res.statusCode).toBe(400);
  });

  it('rejects missing device_id with 400', async () => {
    const res = await postReset({
      secret: 'super_secret_device_pass_16chars',
      session_id: 'boot_session_001',
    });
    expect(res.statusCode).toBe(400);
  });
});
