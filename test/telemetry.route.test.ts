import { beforeAll, describe, expect, it, vi } from 'vitest';

const { mockIngestTelemetry, mockMaybeSingleDev } = vi.hoisted(() => ({
  mockIngestTelemetry: vi.fn(async (_dev: string, _bus: string, t: any) => {
    if (t.seq === 999) {
      return { ok: true, code: 'DUPLICATE_PACKET', stored: false, events: [] };
    }
    if (t.seq === 888) {
      return { ok: false, code: 'SEQUENCE_REUSE_CONFLICT', error: 'Sequence number was previously used with conflicting telemetry data' };
    }
    if (t.seq === 777) {
      return { ok: false, code: 'UNAUTHORIZED_DEVICE', error: 'Device not registered or inactive' };
    }
    if (t.seq === 666) {
      return { ok: false, code: 'COORDINATES_OUT_OF_BOUNDS', error: 'Latitude or longitude outside valid regional transit bounds' };
    }
    return { ok: true, code: 'SUCCESS', stored: true, state_updated: true, events: [] };
  }),
  mockMaybeSingleDev: vi.fn(async () => ({
    data: { is_active: true, bus_id: 'b1' },
    error: null,
  })),
}));

vi.mock('../src/repositories/telemetry.repo.js', () => ({
  getLastState: vi.fn(async () => null),
  ingestTelemetry: mockIngestTelemetry,
}));

vi.mock('../src/lib/supabase.js', () => ({
  supabase: {
    from: vi.fn(() => ({
      select: vi.fn(() => ({
        eq: vi.fn(() => ({
          maybeSingle: mockMaybeSingleDev,
        })),
      })),
    })),
  },
}));

import { buildApp } from '../src/app.js';

let app: Awaited<ReturnType<typeof buildApp>>;
let token: string;
const packet = (seq = 1, epoch = 1) => ({
  device_id: 'NITC-BUS-001', seq, epoch, timestamp: new Date().toISOString(),
  latitude: 11.321234, longitude: 75.934567, speed: 18.4, heading: 143.2, accuracy: 4.1,
});

beforeAll(async () => {
  app = await buildApp();
  token = app.jwt.sign({ sub: 'NITC-BUS-001', bus_id: 'b1', typ: 'device' }, { expiresIn: 60 });
});

const post = (payload: object, tok?: string) =>
  app.inject({
    method: 'POST', url: '/api/v1/telemetry', payload,
    headers: tok ? { authorization: `Bearer ${tok}` } : {},
  });

describe('POST /api/v1/telemetry', () => {
  it('401 without token', async () => expect((await post(packet())).statusCode).toBe(401));
  
  it('200 stores valid packet', async () => {
    const res = await post(packet(1), token);
    expect(res.statusCode).toBe(200);
    expect(res.json().stored).toBe(true);
    expect(res.json().state_updated).toBe(true);
    expect(res.json().ok).toBe(true);
  });

  it('200 handled duplicate packet without storing', async () => {
    const res = await post(packet(999), token);
    expect(res.statusCode).toBe(200);
    expect(res.json().stored).toBe(false);
    expect(res.json().state_updated).toBe(false);
    expect(res.json().reason).toBe('duplicate');
  });

  it('409 on sequence reuse conflict from DB', async () => {
    const res = await post(packet(888), token);
    expect(res.statusCode).toBe(409);
    expect(res.json().code).toBe('SEQUENCE_REUSE_CONFLICT');
  });

  it('401 on unauthorized or inactive device from DB', async () => {
    const res = await post(packet(777), token);
    expect(res.statusCode).toBe(401);
    expect(res.json().code).toBe('UNAUTHORIZED_DEVICE');
  });

  it('401 when device was deactivated after JWT issuance', async () => {
    mockMaybeSingleDev.mockImplementationOnce(async () => ({
      data: { is_active: false, bus_id: 'b1' },
      error: null,
    }));
    const res = await post(packet(1), token);
    expect(res.statusCode).toBe(401);
  });

  it('422 on coordinates out of bounds from DB', async () => {
    const res = await post(packet(666), token);
    expect(res.statusCode).toBe(422);
    expect(res.json().code).toBe('COORDINATES_OUT_OF_BOUNDS');
  });

  it('403 when device_id != token', async () =>
    expect((await post({ ...packet(), device_id: 'OTHER-DEV' }, token)).statusCode).toBe(403));
    
  it('400 on unknown field', async () =>
    expect((await post({ ...packet(), extra: 1 }, token)).statusCode).toBe(400));
    
  it('400 when mandatory epoch is missing', async () => {
    const p = packet();
    delete (p as any).epoch;
    expect((await post(p, token)).statusCode).toBe(400);
  });

  it('422 on (0,0)', async () =>
    expect((await post({ ...packet(), latitude: 0, longitude: 0 }, token)).statusCode).toBe(422));
    
  it('200 accepts packet with explicit epoch and nullable metrics', async () => {
    const res = await post(
      {
        ...packet(2, 2),
        speed: null,
        heading: null,
        accuracy: null,
      },
      token,
    );
    expect(res.statusCode).toBe(200);
    expect(res.json().stored).toBe(true);
  });

  it('healthz ok', async () => expect((await app.inject('/healthz')).statusCode).toBe(200));
});
