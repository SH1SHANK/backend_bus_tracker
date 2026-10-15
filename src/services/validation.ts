import { config } from '../config.js';
import type { TelemetryInput } from '../schemas/telemetry.js';

export interface Rejection {
  code: string;
  message: string;
}

/** Step 4: telemetry validation (stateless checks). */
export function validateTelemetry(p: TelemetryInput, now = new Date()): Rejection | null {
  const t = config.telemetry;
  const ts = Date.parse(p.timestamp);
  if (Number.isNaN(ts)) return { code: 'bad_timestamp', message: 'timestamp is not a valid date' };

  const skewMs = ts - now.getTime();
  if (skewMs > t.maxFutureSkewS * 1000)
    return { code: 'timestamp_in_future', message: 'timestamp is ahead of server time' };
  if (-skewMs > t.maxAgeS * 1000)
    return { code: 'timestamp_too_old', message: 'timestamp is older than allowed window' };

  // (0,0) is what many GNSS modules emit without a fix
  if (p.latitude === 0 && p.longitude === 0)
    return { code: 'no_gps_fix', message: 'coordinates are (0,0)' };

  const b = t.bbox;
  if (p.latitude < b.minLat || p.latitude > b.maxLat || p.longitude < b.minLon || p.longitude > b.maxLon)
    return { code: 'outside_service_area', message: 'position is outside the service area' };

  if (p.accuracy != null && p.accuracy > t.maxAccuracyM)
    return { code: 'poor_accuracy', message: `accuracy worse than ${t.maxAccuracyM} m` };

  if (p.speed != null && p.speed > t.maxSpeedKmh)
    return { code: 'speed_out_of_range', message: `speed above ${t.maxSpeedKmh} km/h` };

  return null;
}
