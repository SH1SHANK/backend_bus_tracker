# Tracklet Backend Development & Testing Guide

## 1. Prerequisites & Tooling

To run, develop, and test the `backend_bus_tracker` API gateway, you need:

1. **Node.js**: `v20.x` or `v22.x` (LTS). Verify with `node -v`.
2. **npm**: `v10.x` or higher.
3. **Docker Desktop / Docker Engine**: For running isolated local Supabase containers.
4. **Supabase CLI**: Required for local database management (`npx supabase` or installed globally).
5. **Git**: Version control.

---

## 2. Local Setup Step-by-Step

### 2.1 Start Isolated Local Supabase
The database schema and migrations are maintained in the companion repository `NITC_BUS_TRACKING_APP`.

```bash
# Navigate to the mobile app repository
cd /path/to/NITC_BUS_TRACKING_APP

# Start local Supabase containers (runs Postgres, PostgREST, Kong, Realtime)
npx supabase start

# Confirm services are healthy
npx supabase status
```

Local Supabase exposes:
- **API Gateway (Kong)**: `http://127.0.0.1:54321`
- **PostgreSQL Database**: `postgresql://postgres:postgres@127.0.0.1:54322/postgres`
- **Supabase Studio UI**: `http://127.0.0.1:54323`

### 2.2 Configure Backend Environment
Navigate to `backend_bus_tracker` and create a local `.env` file:

```bash
cd /path/to/backend_bus_tracker

# Copy template
cp .env.example .env
```

Configure `.env` with the local Supabase credentials:
```ini
NODE_ENV=development
PORT=3000
HOST=127.0.0.1
LOG_LEVEL=info

# Local Supabase credentials from 'supabase status'
SUPABASE_URL=http://127.0.0.1:54321
SUPABASE_SERVICE_ROLE_KEY=eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZS1kZW1vIiwicm9sZSI6InNlcnZpY2Vfcm9sZSIsImV4cCI6MTk4MzgxMjk5Nn0.EGIM96RAZx35lJzdJsyH-qQwv8Hdp7fsn3W0YpN81IU

# Device JWT Signing Secret (>= 32 chars)
DEVICE_JWT_SECRET=super-secret-jwt-token-with-at-least-32-characters-long
DEVICE_JWT_TTL_S=43200

# Geographic plausibility bounds (NITC Kozhikode)
SERVICE_MIN_LAT=11.200000
SERVICE_MAX_LAT=11.450000
SERVICE_MIN_LON=75.800000
SERVICE_MAX_LON=76.100000

# Proxy Trust (private RFC1918 subnets)
TRUSTED_PROXIES=127.0.0.1,10.0.0.0/8,172.16.0.0/12,192.168.0.0/16
```

### 2.3 Install Dependencies & Verify Build
```bash
# Install node modules
npm install

# Check TypeScript types
npm run typecheck

# Build production bundle
npm run build
```

### 2.4 Run Development Server
```bash
# Starts hot-reloading dev server on http://127.0.0.1:3000
npm run dev
```

---

## 3. Test Architecture & Verification Matrix

The test strategy uses four complementary tiers of testing:

```mermaid
flowchart TD
    Tier1["Tier 1: Pure Unit Tests<br/>(test/core.test.ts)"]
    Tier2["Tier 2: Mocked Route Tests<br/>(test/*.route.test.ts)"]
    Tier3["Tier 3: Real Fastify-to-DB Integration<br/>(test/integration/supabase.integration.test.ts)"]
    Tier4["Tier 4: PostgreSQL Direct SQL Tests<br/>(NITC_BUS_TRACKING_APP/supabase/tests/telemetry_ingestion_test.sql)"]

    Tier1 -->|Validates| Math["Haversine, heading, status, clock drift"]
    Tier2 -->|Validates| HTTP["TypeBox schemas, error mapping, status codes"]
    Tier3 -->|Validates| EndToEnd["Real HTTP requests -> Real Postgres RPCs -> Row asserts"]
    Tier4 -->|Validates| SQL["Advisory locks, PostGIS, 7-field equality, constraints"]
```

### Comparison Matrix

| Test Tier | Execution Command | Target | What It Proves | What It Does NOT Prove |
|---|---|---|---|---|
| **Tier 1: Unit Tests** | `npm test` | In-memory functions (`src/services/`) | Haversine distance, speed calculations, coordinate checks, Bcrypt hash verification. | Does not prove Fastify route wiring or database compatibility. |
| **Tier 2: Mocked Route Tests** | `npm test` | Fastify app with Vitest mocks | TypeBox validation schemas, HTTP status codes (200, 400, 401, 409, 422), route error handling. | Does not prove actual PostgreSQL stored procedures or SQL locks work. |
| **Tier 3: Real Integration Tests** | `npm run test:integration` | Real Fastify app $\to$ Local Supabase RPCs | End-to-end integration: HTTP injection calls real `ingest_telemetry_packet` & `reset_device_sequence`, verifies DB rows, bidirectional Bcrypt. | Does not prove cellular antenna physics, live WebSocket delivery to Flutter clients across the network, or Render cloud ingress topology. |
| **Tier 4: Direct SQL Tests** | `docker exec ... psql < telemetry_ingestion_test.sql` | PostgreSQL engine directly | PostgreSQL locking, PostGIS spatial functions, exact 7-field equality, RLS, Realtime publication table membership. | Does not test Fastify HTTP gateway routing or live client subscriptions. |

---

## 4. Running the Tests

### 4.1 Unit & Mocked Route Tests
Fast, hermetic tests that run without external dependencies:
```bash
npm test
```
Expected output: 41 tests passed across 5 files (includes bidirectional Bcrypt unit tests and proxy anti-spoofing unit tests).

### 4.2 Real Fastify-to-Supabase Integration Tests
Executes real HTTP requests against local Supabase:
```bash
npm run test:integration
```
Expected output: 15 tests passed across 1 file (includes bidirectional Node <-> Postgres Bcrypt verification, session reset idempotency, and advisory-lock concurrency).

### 4.3 Direct PostgreSQL Database Tests
Runs the 18 comprehensive SQL test suites inside the local Supabase Postgres container:
```bash
docker exec -i supabase_db_NITC_BUS_TRACKING_APP psql -U postgres -d postgres -f - < ../NITC_BUS_TRACKING_APP/supabase/tests/telemetry_ingestion_test.sql
```
Expected output: `ALL 18 TEST SUITES PASSED CLEANLY WITH ZERO LEFTOVER STATE!`.

---

## 5. Known Operational Limitations & Verification Boundaries

1. **Live Realtime WebSocket Delivery**:
   - **Verified**: Database-side CDC publication membership (`bus_current_state` enrolled in `supabase_realtime`) and instantaneous canonical row persistence via `ingest_telemetry_packet` are verified.
   - **Limitation / Flutter Responsibility**: We have **not** connected an active WebSocket client to verify real-time event streaming across the network. Live WebSocket delivery is an out-of-process client integration responsibility and must be validated through the Flutter mobile app test suite.

2. **Render Cloud Ingress Topology**:
   - **Verified**: Automated unit tests (`test/security.test.ts`) verify that Fastify's RFC1918 `trustProxy` configuration ignores spoofed `X-Forwarded-For` headers from untrusted direct sockets and stops at the first untrusted hop in multi-hop chains. Authenticated telemetry routes also key rate limits on `req.user.sub` (device identifier), preventing IP-spoofing evasion.
   - **Limitation**: The physical Render production deployment topology (e.g., whether Render assigns specific non-RFC1918 gateway IPs or whether an upstream CDN/Cloudflare is active) has not been inspected live. Render dashboard network settings should be verified during staging deployment.

3. **Sequential Trip Completion**:
   - **Limitation**: In `src/routes/trips.ts`, `/trips/:id/end` performs sequential REST updates (`trips` update -> `Promise.all([bus_events, bus_current_state])`) rather than an atomic database transaction. If the Node process terminates between calls, `trip` is marked completed while `bus_current_state.trip_id` may remain populated until cleared by the next incoming telemetry packet. An atomic `end_bus_trip` RPC should be added in a future database migration.

---

## 6. Troubleshooting & Debugging Guide

### 1. `INVALID_CREDENTIALS` / 401 on Session Reset
- **Symptom**: `POST /api/v1/auth/reset-session` returns HTTP 401 `invalid_credentials` even with the correct secret.
- **Root Cause**: Bcrypt hash version mismatch. `pgcrypto` strictly expects `$2a$08$...`. If `bcryptjs` generates `$2b$08$...`, PostgreSQL fails verification.
- **Fix**: Check `src/lib/password.ts`. Ensure `hashSecret` replaces `^\$2b\$` with `$2a$`.

### 2. `outside_service_area` / 422 on Telemetry
- **Symptom**: Valid test packet rejected with HTTP 422 `outside_service_area`.
- **Root Cause**: Coordinates outside the NITC bounding box (`[11.200000, 11.450000]` lat, `[75.800000, 76.100000]` lon).
- **Fix**: Verify test coordinates are centered near NITC campus (e.g. `11.321456, 75.934567`).

### 3. `STALE_EPOCH_PACKET` / 409 Conflict
- **Symptom**: Tracker receives HTTP 409 after rebooting.
- **Root Cause**: The device emitted a packet using an epoch older than the current session in `bus_current_state`.
- **Fix**: Ensure the tracker calls `POST /api/v1/auth/reset-session` on every boot and updates its cached epoch.

### 4. `SEQUENCE_REUSE_CONFLICT` / 409 Conflict
- **Symptom**: Packet rejected with HTTP 409 `SEQUENCE_REUSE_CONFLICT`.
- **Root Cause**: The tracker reused sequence number `N` with conflicting telemetry data.
- **Fix**: Tracker must strictly increment `seq` for every new GPS reading. Retries of the same fix must send identical data.

### 5. Cannot Connect to Local Supabase (ECONNREFUSED)
- **Symptom**: `npm run test:integration` fails with connection refused on `127.0.0.1:54321`.
- **Root Cause**: Docker containers not running.
- **Fix**: Run `npx supabase start` in `NITC_BUS_TRACKING_APP` and check `docker ps`.

---

## 6. Security & Isolation Guidelines

1. **Never Connect Integration Tests to Production**:
   - `test/integration/supabase.integration.test.ts` contains an explicit safety guard that throws an immediate fatal exception if `SUPABASE_URL` does not point to `127.0.0.1` or `localhost`.
   - Never remove or bypass this guard.
2. **Deterministic Cleanup**:
   - All integration tests use unique prefixes (`INT-BUS-TEST-...`, `INT-DEV-TEST-...`).
   - `afterAll` hooks clean up all created rows in `bus_events`, `bus_positions`, `bus_current_state`, `devices`, and `buses`.
3. **No Secret Commitments**:
   - Secrets generated during tests or provisioning must never be hardcoded into Git history or logged in plaintext.
