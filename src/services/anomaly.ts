import { config } from '../config.js';
import { haversineM } from '../lib/geo.js';
import type { TelemetryInput } from '../schemas/telemetry.js';

export interface LastState {
  seq: number;
  recorded_at: string;
  latitude: number;
  longitude: number;
}

export type Anomaly =
  | { kind: 'ok'; seqReset: boolean }
  | { kind: 'duplicate' }
  | { kind: 'stale' }
  | { kind: 'gps_jump' | 'impossible_speed'; impliedSpeedKmh: number; distanceM: number };

/**
 * Step 5: anomaly detection against the bus's last accepted state.
 * - duplicate: same seq + timestamp (client retry)
 * - stale: timestamp not newer than current state (out-of-order / replay)
 * - seq <= last but timestamp newer => device rebooted (seq counter reset); accepted
 * - gps_jump / impossible_speed: implied speed between fixes exceeds limit
 */
export function detectAnomaly(p: TelemetryInput, last: LastState | null): Anomaly {
  if (!last) return { kind: 'ok', seqReset: false };

  const t = config.telemetry;
  const ts = Date.parse(p.timestamp);
  const lastTs = Date.parse(last.recorded_at);

  if (ts === lastTs && p.seq === last.seq) return { kind: 'duplicate' };
  if (ts <= lastTs) return { kind: 'stale' };

  const dt = (ts - lastTs) / 1000;
  const distanceM = haversineM(last.latitude, last.longitude, p.latitude, p.longitude);
  const impliedSpeedKmh = (distanceM / dt) * 3.6;

  if (distanceM >= t.minJumpCheckDistM && impliedSpeedKmh > t.maxSpeedKmh * t.impliedSpeedSlack) {
    return { kind: distanceM >= t.gpsJumpDistM ? 'gps_jump' : 'impossible_speed', impliedSpeedKmh, distanceM };
  }
  return { kind: 'ok', seqReset: p.seq <= last.seq };
}
