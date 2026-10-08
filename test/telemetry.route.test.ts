import { beforeAll, describe, expect, it, vi } from 'vitest';

vi.mock('../src/repositories/telemetry.repo.js', () => ({
  getLastState: vi.fn(async () => null),
  ingestTelemetry: vi.fn(async () => ({ ok: true, stored: true, state_updated: true, events: [] })),
}));

import { buildApp } from '../src/app.js';

let app: Awaited<ReturnType<typeof buildApp>>;
let token: string;
const packet = () => ({
  device_id: 'NITC-BUS-001', seq: 1, timestamp: new Date().toISOString(),
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
    const res = await post(packet(), token);
    expect(res.statusCode).toBe(200);
    expect(res.json().stored).toBe(true);
  });
  it('403 when device_id != token', async () =>
    expect((await post({ ...packet(), device_id: 'OTHER-DEV' }, token)).statusCode).toBe(403));
  it('400 on unknown field', async () =>
    expect((await post({ ...packet(), extra: 1 }, token)).statusCode).toBe(400));
  it('422 on (0,0)', async () =>
    expect((await post({ ...packet(), latitude: 0, longitude: 0 }, token)).statusCode).toBe(422));
  it('healthz ok', async () => expect((await app.inject('/healthz')).statusCode).toBe(200));
});
