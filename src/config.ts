import 'dotenv/config';

const req = (k: string): string => {
  const v = process.env[k];
  if (!v) throw new Error(`Missing required env var ${k}`);
  return v;
};
const num = (k: string, d: number): number => {
  const v = process.env[k];
  if (v === undefined || v === '') return d;
  const n = Number(v);
  if (Number.isNaN(n)) throw new Error(`Env var ${k} must be a number`);
  return n;
};

const jwtSecret = req('DEVICE_JWT_SECRET');
if (jwtSecret.length < 32) throw new Error('DEVICE_JWT_SECRET must be at least 32 characters');

export const config = {
  env: process.env.NODE_ENV ?? 'development',
  isProd: process.env.NODE_ENV === 'production',
  port: num('PORT', 3000),
  host: process.env.HOST ?? '0.0.0.0',
  logLevel: process.env.LOG_LEVEL ?? 'info',
  supabaseUrl: req('SUPABASE_URL'),
  supabaseServiceKey: req('SUPABASE_SERVICE_ROLE_KEY'),
  jwtSecret,
  deviceTokenTtlS: num('DEVICE_JWT_TTL_S', 43_200),
  corsOrigins: (process.env.CORS_ORIGINS ?? '').split(',').map((s) => s.trim()).filter(Boolean),
  sentryDsn: process.env.SENTRY_DSN || undefined,
  metricsToken: process.env.METRICS_TOKEN || undefined,
  rateLimit: {
    globalMax: num('RATE_LIMIT_GLOBAL_PER_MIN', 120),
    telemetryMax: num('RATE_LIMIT_TELEMETRY_PER_MIN', 30),
    authMax: num('RATE_LIMIT_AUTH_PER_MIN', 10),
  },
  telemetry: {
    bbox: {
      minLat: num('SERVICE_MIN_LAT', 8.0),
      maxLat: num('SERVICE_MAX_LAT', 12.9),
      minLon: num('SERVICE_MIN_LON', 74.8),
      maxLon: num('SERVICE_MAX_LON', 77.5),
    },
    maxSpeedKmh: num('MAX_SPEED_KMH', 120),
    maxAccuracyM: num('MAX_ACCURACY_M', 100),
    maxFutureSkewS: 60,
    maxAgeS: num('MAX_PACKET_AGE_S', 21_600),
    stationarySpeedKmh: 2,
    impliedSpeedSlack: 1.5, // implied speed must exceed maxSpeed*slack to flag
    minJumpCheckDistM: 100, // ignore GPS noise below this displacement
    gpsJumpDistM: 1000,
    onlineWindowS: 60,
    stopRadiusM: num('STOP_RADIUS_M', 50),
    routeDeviationM: num('ROUTE_DEVIATION_M', 500),
  },
} as const;
