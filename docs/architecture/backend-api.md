# Fastify Backend API Specification

## 1. Application Architecture & Entry Point

The Fastify backend (`backend_bus_tracker`, branch `stable`) is built on **Node.js 22 LTS** and the **Fastify v5** web framework. It operates as a stateless HTTP gateway deployed on Render (`web` service).

```
backend_bus_tracker/
├── src/
│   ├── app.ts                  # Fastify instance builder, plugin registration, global error handler
│   ├── server.ts               # Process entry point, signal handlers (SIGTERM/SIGINT), port listening
│   ├── plugins/
│   │   ├── auth.ts             # JWT authentication hooks (Device & Staff Supabase tokens)
│   │   ├── security.ts         # Helmet headers, CORS, rate-limiting, IP proxy trust
│   │   └── metrics.ts          # Prometheus metrics registration (/metrics)
│   ├── routes/
│   │   ├── auth.ts             # POST /auth/device, POST /auth/reset-session
│   │   ├── telemetry.ts        # POST /telemetry, POST /telemetry/batch
│   │   ├── trips.ts            # POST /trips/start, POST /trips/:id/end
│   │   ├── buses.ts            # GET /buses, GET /buses/nearby, GET /buses/:id
│   │   ├── stops.ts            # GET /stops/nearest
│   │   └── health.ts           # GET /healthz, GET /readyz
│   ├── schemas/                # TypeBox (JSON Schema) type definitions
│   ├── services/               # Stateless validation, coordinate checks, password utilities
│   ├── repositories/           # Supabase RPC and table interface using service_role client
│   └── lib/                    # Supabase client singleton, Bcrypt wrapper, logger
└── test/                       # Vitest integration and unit test suites
```

---

## 2. Global Middleware & Hooks

1. **Security Headers (`@fastify/helmet`):**
   - Content Security Policy (CSP), X-Content-Type-Options, Strict-Transport-Security (HSTS), X-Frame-Options.
2. **CORS (`@fastify/cors`):**
   - Restricted to configured origins (`CORS_ORIGIN`). Supports preflight `OPTIONS` requests.
3. **Rate Limiting (`@fastify/rate-limit`):**
   - Memory store by default (or Redis if `REDIS_URL` configured).
   - Rate limit buckets:
     - Auth routes (`/api/v1/auth/*`): **10 requests / minute** per IP/device.
     - Telemetry ingestion (`/api/v1/telemetry*`): **300 requests / minute** per authenticated device.
     - Public discovery (`/api/v1/buses*`, `/api/v1/stops*`): **60 requests / minute** per IP.
     - Health checks (`/healthz`, `/readyz`, `/metrics`): Rate limiting disabled.
4. **Body Limit:**
   - Global payload cap: **1,048,576 bytes (1 MB)**. Malformed or oversized payloads are rejected at the TCP socket layer with HTTP 413.
5. **Observability (`prom-client`):**
   - Standard HTTP request duration histograms, request count counters, and Supabase RPC latency metrics exported on `/metrics`.

---

## 3. Complete Endpoint Inventory

### 3.1 Health & Diagnostics

#### `GET /healthz`
- **Purpose:** Kubernetes / Render liveness probe.
- **Auth:** None.
- **Response (HTTP 200):**
  ```json
  { "status": "ok", "uptime": 12450.2, "timestamp": "2026-10-15T13:15:00.000Z" }
  ```

#### `GET /readyz`
- **Purpose:** Readiness probe verifying database connectivity.
- **Auth:** None.
- **Operations:** Executes `SELECT id FROM buses LIMIT 1` via Supabase client.
- **Response (HTTP 200):**
  ```json
  { "status": "ready", "database": "connected" }
  ```
  Returns HTTP 503 Service Unavailable if Supabase connection fails.

#### `GET /metrics`
- **Purpose:** Prometheus telemetry metrics scraper.
- **Auth:** Bearer `METRICS_TOKEN` header (if configured in environment).
- **Response (HTTP 200):** Prometheus plaintext exposition format.

---

### 3.2 Device Authentication & Session Negotiation

#### `POST /api/v1/auth/reset-session`
- **Purpose:** Cold-boot session negotiation, advancing device epoch and resetting sequence counter.
- **Caller:** ESP32 hardware tracker on boot.
- **Auth:** Public endpoint; verified via Bcrypt device secret in database.
- **Request Body (`ResetSessionBody`):**
  ```json
  {
    "device_id": "NITC-BUS-001",
    "secret": "A1b2C3d4E5f6G7h8_HardwareSecret",
    "session_id": "boot-uuid-or-nonce-12345",
    "reason": "power_on_reset"
  }
  ```
- **Database Operation:** Invokes RPC `reset_device_sequence(p_device_id, p_secret, p_session_id)`.
- **Response (HTTP 200):**
  ```json
  {
    "ok": true,
    "code": "SUCCESS",
    "device_id": "NITC-BUS-001",
    "epoch": 3,
    "idempotent_retry": false,
    "token": "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9..."
  }
  ```

#### `POST /api/v1/auth/device`
- **Purpose:** Device token refresh without advancing epoch.
- **Caller:** ESP32 hardware tracker.
- **Request Body (`DeviceAuthBody`):**
  ```json
  {
    "device_id": "NITC-BUS-001",
    "secret": "A1b2C3d4E5f6G7h8_HardwareSecret"
  }
  ```
- **Database Operation:** Queries `devices` table, compares secret with `bcrypt.compare`, reads `bus_id` and `current_epoch`.
- **Response (HTTP 200):** Returns newly signed JWT token.

---

### 3.3 Telemetry Ingestion

#### `POST /api/v1/telemetry`
- **Purpose:** Real-time ingestion of single GPS coordinate fix.
- **Caller:** ESP32 hardware tracker.
- **Auth:** Bearer JWT in `Authorization` header (`sub === body.device_id`).
- **Validation Pipeline:**
  1. `onRequest`: JWT verification (`HS256`).
  2. `preValidation`: Rate limit check (300/min).
  3. `Schema`: TypeBox strict schema (`additionalProperties: false`).
  4. `preHandler`: Verifies `devices.is_active = true` in PostgreSQL.
  5. `Stateless Validation`: Lat/Lon corridor bounds, max speed ($120\text{ km/h}$), max time skew ($60\text{s}$).
- **Database Operation:** Invokes atomic RPC `ingest_telemetry_packet(...)`.
- **Response (HTTP 200):**
  ```json
  {
    "ok": true,
    "code": "SUCCESS",
    "device_id": "NITC-BUS-001",
    "bus_id": "d3b07384-d113-494b-9c8e-a2b1f84b6592",
    "epoch": 3,
    "seq": 204,
    "stored": true,
    "state_updated": true,
    "events_generated": 0
  }
  ```

#### `POST /api/v1/telemetry/batch`
- **Purpose:** Ingestion of offline FIFO queue packets after reconnect.
- **Caller:** ESP32 hardware tracker.
- **Auth:** Bearer JWT in `Authorization` header.
- **Payload:** Array of 1 to 50 packets (`TelemetryBatchBody`).
- **Processing:** Iterates through chronologically sorted packets calling `ingest_telemetry_packet`.
- **Response (HTTP 200):**
  ```json
  {
    "ok": true,
    "device_id": "NITC-BUS-001",
    "total": 12,
    "stored": 12,
    "duplicates": 0,
    "failed": 0,
    "errors": []
  }
  ```

---

### 3.4 Trip Management (Staff Operations)

> [!WARNING]
> **Verified Audit Defect in Trip Routes:**
> In the current `stable` branch (`src/routes/trips.ts`), `/trips/start` and `/trips/:id/end` execute sequential, non-transactional HTTP calls to Supabase. If the server crashes or network fails between calls, orphaned active trips remain in the database. See [Known Limitations](file:///Users/shashankmergu/Desktop/NITC_BUS_TRACKING_APP/docs/architecture/known-limitations.md).

#### `POST /api/v1/trips/start`
- **Purpose:** Starts a scheduled bus trip, associating a bus with a route.
- **Caller:** Driver / Staff mobile interface or admin panel.
- **Auth:** Bearer Supabase JWT with `role: admin` or `role: driver` in `app_metadata`.
- **Request Body:**
  ```json
  {
    "bus_id": "d3b07384-d113-494b-9c8e-a2b1f84b6592",
    "route_id": "e4c18495-e224-405c-0d9f-b3c2e95c7603"
  }
  ```
- **Current Execution Path:**
  1. `INSERT INTO trips (bus_id, route_id, status: 'active', started_at: now())`.
  2. `Promise.all([ INSERT INTO bus_events (...), UPDATE bus_current_state SET trip_id = ... ])`.
- **Response (HTTP 201):**
  ```json
  {
    "id": "f5d29506-f335-416d-1e0a-c4d3f06d8714",
    "bus_id": "d3b07384-d113-494b-9c8e-a2b1f84b6592",
    "route_id": "e4c18495-e224-405c-0d9f-b3c2e95c7603",
    "status": "active",
    "started_at": "2026-10-15T13:20:00.000Z"
  }
  ```

#### `POST /api/v1/trips/:id/end`
- **Purpose:** Concludes an active trip.
- **Caller:** Driver / Staff.
- **Auth:** Bearer Supabase JWT with `role: admin` or `role: driver`.
- **Path Parameter:** `id` (UUID).
- **Current Execution Path:**
  1. `UPDATE trips SET status = 'completed', ended_at = now() WHERE id = :id`.
  2. `Promise.all([ INSERT INTO bus_events (...), UPDATE bus_current_state SET trip_id = NULL ])`.
- **Response (HTTP 200):**
  ```json
  { "id": "f5d29506-f335-416d-1e0a-c4d3f06d8714", "status": "completed", "ended_at": "..." }
  ```

---

### 3.5 Read & Discovery Endpoints

These endpoints exist on Fastify for administrative dashboards and external integrations. (Mobile riders query Supabase directly).

#### `GET /api/v1/buses`
- **Purpose:** Read current live state of all buses.
- **Auth:** Supabase user token or anonymous.
- **Database Operation:** Queries `buses` joined with `bus_current_state`.

#### `GET /api/v1/buses/nearby`
- **Purpose:** Spatial query for buses within a given radius.
- **Query Parameters:** `lat` (float), `lon` (float), `radius` (meters, default 2000).
- **Database Operation:** Invokes `public.get_nearby_buses(lat, lon, radius)`.

#### `GET /api/v1/stops/nearest`
- **Purpose:** Find closest stops to a given coordinate.
- **Query Parameters:** `lat`, `lon`, `radius` (meters), `limit` (int, default 5).
- **Database Operation:** Invokes `public.get_nearby_stops(lat, lon, radius, limit)`.
