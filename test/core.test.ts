import { describe, expect, it } from 'vitest';
import { detectAnomaly } from '../src/services/anomaly.js';
import { validateTelemetry } from '../src/services/validation.js';
import { processTelemetry } from '../src/services/processing.js';
import { hashSecret, verifySecret } from '../src/lib/password.js';

const base = {
  device_id: 'NITC-BUS-001', seq: 100, epoch: 1, timestamp: '2026-10-07T06:40:12Z',
  latitude: 11.321234, longitude: 75.934567, speed: 18.4, heading: 143.2, accuracy: 4.1,
};
const last = { epoch: 1, seq: 99, recorded_at: '2026-10-07T06:40:02Z', latitude: 11.3212, longitude: 75.9345 };
const now = new Date('2026-10-07T06:40:13Z');

describe('validation', () => {
  it('accepts a good packet', () => expect(validateTelemetry(base, now)).toBeNull());
  it('rejects future timestamps', () =>
    expect(validateTelemetry({ ...base, timestamp: '2026-10-07T07:00:00Z' }, now)?.code).toBe('timestamp_in_future'));
  it('rejects (0,0)', () =>
    expect(validateTelemetry({ ...base, latitude: 0, longitude: 0 }, now)?.code).toBe('no_gps_fix'));
  it('rejects outside service area', () =>
    expect(validateTelemetry({ ...base, latitude: 28.6, longitude: 77.2 }, now)?.code).toBe('outside_service_area'));
  it('rejects poor accuracy (>500m)', () =>
    expect(validateTelemetry({ ...base, accuracy: 600 }, now)?.code).toBe('poor_accuracy'));
  it('rejects packets older than 15 minutes', () => {
    const oldTime = new Date(now.getTime() - 16 * 60 * 1000).toISOString();
    expect(validateTelemetry({ ...base, timestamp: oldTime }, now)?.code).toBe('timestamp_too_old');
  });
});

describe('anomaly detection', () => {
  it('ok with no prior state', () => expect(detectAnomaly(base, null).kind).toBe('ok'));
  it('ok for normal movement', () => expect(detectAnomaly(base, last).kind).toBe('ok'));
  it('duplicate', () =>
    expect(detectAnomaly({ ...base, seq: 99, timestamp: last.recorded_at }, last).kind).toBe('duplicate'));
  it('stale / out of order', () =>
    expect(detectAnomaly({ ...base, seq: 98, timestamp: '2026-10-07T06:39:50Z' }, last).kind).toBe('stale'));
  it('gps jump', () =>
    expect(detectAnomaly({ ...base, latitude: 11.5, longitude: 76.1 }, last).kind).toBe('gps_jump'));
  it('flags seq reset within same epoch or across new epoch', () => {
    expect(detectAnomaly({ ...base, seq: 3 }, last)).toEqual({ kind: 'ok', seqReset: true });
    expect(detectAnomaly({ ...base, epoch: 2, seq: 1 }, last)).toEqual({ kind: 'ok', seqReset: true });
  });
});

describe('processing + password', () => {
  it('normalises and derives status including 359.96 heading boundary wrap', () => {
    const p = processTelemetry({ ...base, speed: 0.3, heading: 360 });
    expect(p.status).toBe('stationary');
    expect(p.heading).toBe(0);
    expect(processTelemetry({ ...base, heading: 359.96 }).heading).toBe(0);
    expect(processTelemetry(base).status).toBe('moving');
  });
  it('verifies bcrypt hashes in both directions', async () => {
    const nodeHash = await hashSecret('correct horse battery');
    expect(nodeHash.startsWith('$2a$08$')).toBe(true);
    expect(await verifySecret('correct horse battery', nodeHash)).toBe(true);
    expect(await verifySecret('wrong', nodeHash)).toBe(false);

    const pgCryptoHash = '$2a$08$GpQ1v2atriVNaWxIHNkk9uX2UtAj4swpNYyBJUMcyUf1Wm7odNJTG';
    expect(await verifySecret('pg_secret_test_123', pgCryptoHash)).toBe(true);
    expect(await verifySecret('wrong_secret', pgCryptoHash)).toBe(false);
  });
});
