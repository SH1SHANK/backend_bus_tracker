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
# Option A: Single-round-trip boot auth + session epoch reset
POST /api/v1/auth/device
  {"device_id":"NITC-BUS-001","secret":"...","session_id":"boot-1728901234-a8f9","reason":"cold_boot"}
  → {token, token_type:"Bearer", expires_in:43200, epoch:2, idempotent_retry:false}

# Option B: Dedicated session epoch reset
POST /api/v1/auth/reset-session
  {"device_id":"NITC-BUS-001","secret":"...","session_id":"boot-1728901234-a8f9","reason":"cold_boot"}
  → {ok:true, code:"SUCCESS", epoch:2, device_id:"NITC-BUS-001", bus_id:"...", idempotent_retry:false}

# Stream live telemetry (or flush offline queue via POST /api/v1/telemetry/batch)
POST /api/v1/telemetry     Authorization: Bearer <token>
  {"device_id":"NITC-BUS-001","seq":1,"epoch":2,"timestamp":"2026-10-14T04:30:00.000Z",
   "latitude":11.3216,"longitude":75.9345,"speed":12.5,"heading":90,"accuracy":8}
```
| Response | Meaning | Device action |
|---|---|---|
| 200 `stored:true` | accepted | advance `seq++`, drop from buffer |
| 200 `stored:false` (`duplicate`) | idempotent retry acknowledged | advance `seq++`, drop from buffer |
| 401 | token expired / device disabled | re-auth via `/auth/device`, retry |
| 403 | `device_id` ≠ token | fix firmware |
| 409 | `STALE_EPOCH_PACKET` / `OUT_OF_ORDER_PACKET` / `SEQUENCE_REUSE_CONFLICT` | re-sync session epoch or advance `seq` |
| 422 | bad data (`gps_jump`, `poor_accuracy`, `outside_service_area`) | drop packet, advance `seq++` |
| 429 / 5xx | backoff | keep in buffer, exponential retry |

## System Architecture & Client Separation

The Fastify backend operates as a dedicated **hardware telemetry gateway, session coordinator, and administrative control plane**. 

- **Physical Trackers:** Transmit GPS fixes exclusively to Fastify (`/api/v1/auth/reset-session`, `/api/v1/telemetry`, `/api/v1/telemetry/batch`).
- **Flutter Mobile App:** Connects directly to Supabase PostgREST and RPCs using the public `anon` key (`get_active_bus_positions_v2`). The mobile client does not call Fastify directly.
- **Authoritative Database:** Fastify uses the privileged `service_role` key to invoke PostgreSQL stored procedures (`ingest_telemetry_packet`, `reset_device_sequence`).

For the complete plain-language explanation and canonical technical specifications, refer to [Tracklet Architecture Documentation](docs/README.md).

