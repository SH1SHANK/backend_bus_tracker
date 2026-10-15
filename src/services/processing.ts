import { config } from '../config.js';
import type { TelemetryInput } from '../schemas/telemetry.js';

const round = (n: number, dp: number) => Math.round(n * 10 ** dp) / 10 ** dp;

export interface NormalisedTelemetry {
  seq: number;
  recordedAt: string;
  latitude: number;
  longitude: number;
  speed: number | null;
  heading: number | null;
  accuracy: number | null;
  status: 'moving' | 'stationary';
  epoch: number;
}

/** Step 6: normalise + determine bus state. */
export function processTelemetry(p: TelemetryInput): NormalisedTelemetry {
  const speed = p.speed != null ? round(p.speed, 1) : null;
  // Round to 1 decimal place BEFORE modulo so values in [359.95, 360) wrap cleanly to 0 instead of 360.0
  const roundedHeading = p.heading != null ? round(p.heading, 1) : null;
  const heading = roundedHeading != null ? round(((roundedHeading % 360) + 360) % 360, 1) : null;
  const accuracy = p.accuracy != null ? round(p.accuracy, 1) : null;
  const isMoving = speed != null && speed >= config.telemetry.stationarySpeedKmh;

  return {
    seq: p.seq,
    recordedAt: new Date(p.timestamp).toISOString(),
    latitude: round(p.latitude, 6),
    longitude: round(p.longitude, 6),
    speed,
    heading,
    accuracy,
    status: isMoving ? 'moving' : 'stationary',
    epoch: p.epoch,
  };
}
