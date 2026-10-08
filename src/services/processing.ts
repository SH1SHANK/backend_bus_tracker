import { config } from '../config.js';
import type { TelemetryInput } from '../schemas/telemetry.js';

const round = (n: number, dp: number) => Math.round(n * 10 ** dp) / 10 ** dp;

export interface NormalisedTelemetry {
  seq: number;
  recordedAt: string;
  latitude: number;
  longitude: number;
  speed: number;
  heading: number;
  accuracy: number;
  status: 'moving' | 'stationary';
}

/** Step 6: normalise + determine bus state. */
export function processTelemetry(p: TelemetryInput): NormalisedTelemetry {
  const speed = round(p.speed, 1);
  return {
    seq: p.seq,
    recordedAt: new Date(p.timestamp).toISOString(),
    latitude: round(p.latitude, 6),
    longitude: round(p.longitude, 6),
    speed,
    heading: round(((p.heading % 360) + 360) % 360, 1),
    accuracy: round(p.accuracy, 1),
    status: speed >= config.telemetry.stationarySpeedKmh ? 'moving' : 'stationary',
  };
}
