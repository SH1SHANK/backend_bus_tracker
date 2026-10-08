# Bus Telemetry API (Fastify + TypeScript → Supabase)

ESP32 → `POST /api/v1/telemetry` → validate → anomaly check → Supabase (PostgreSQL + PostGIS) → Realtime → Flutter.

## Setup
1. Supabase SQL editor (or `supabase db push`): run `supabase/migrations/0001_schema.sql`, then `0002_functions.sql`.
2. `cp .env.example .env`, fill `SUPABASE_URL`, `SUPABASE_SERVICE_ROLE_KEY`, `DEVICE_JWT_SECRET`.
3. `npm i && npm run dev`
4. Provision a device (prints secret once):
   `npm run provision-device -- BUS-001 NITC-BUS-001 "Test Bus 1"`
5. Add stops, a route, `route_stops` rows (SQL editor). Start a trip (admin/driver user):
   `POST /api/v1/trips/start {bus_id, route_id}`. Without an active trip, positions are stored but no stop events fire.
6. Grant a Supabase user a role: set `app_metadata.role` = `admin` or `driver` (server-side only).

## Device flow
```
POST /api/v1/auth/device   {"device_id":"NITC-BUS-001","secret":"..."}  → {token, expires_in}
POST /api/v1/telemetry     Authorization: Bearer <token>
  {"device_id":"NITC-BUS-001","seq":18421,"timestamp":"2026-10-07T06:40:12Z",
   "latitude":11.321234,"longitude":75.934567,"speed":18.4,"heading":143.2,"accuracy":4.1}
```
| Response | Meaning | Device action |
|---|---|---|
| 200 `stored:true` | accepted | drop from buffer |
| 200 `stored:false` (`duplicate`/`stale`) | already have it / older than state | drop from buffer |
| 401 | token expired / device disabled | re-auth, retry |
| 403 | `device_id` ≠ token | fix firmware |
| 422 | bad data (`gps_jump`, `poor_accuracy`, …) | drop packet |
| 429 / 5xx | backoff | keep in buffer, exponential retry |

## Flutter
- Live: subscribe to Supabase Realtime `postgres_changes` on `bus_current_state` (RLS: authenticated read).
- REST (Supabase user JWT as Bearer): `GET /api/v1/buses`, `/buses/:id`, `/buses/nearby?lat&lon&radius`, `/stops/nearest?lat&lon&limit`.

## Notes
- Rate limit is per device (30/min default); auth endpoint 10/min per IP.
- Route deviation uses `routes.path` if set, else a straight line through ordered stops (500 m threshold) — set `path` for curvy routes.
- Render free tier sleeps; use a paid instance for 5–10 s telemetry.
- `/metrics` (Prometheus) enabled only when `METRICS_TOKEN` is set.
