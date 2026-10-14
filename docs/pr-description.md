# PR Description: Supabase Transport Backend Compatibility & Telemetry Hardening

## Overview
This PR brings the Fastify telemetry ingestion API gateway (`backend_bus_tracker`) into complete structural, cryptographic, and operational alignment with the deployed Supabase transport backend (`NITC_BUS_TRACKING_APP`, migration `20261014040200_complete_transport_backend_foundation.sql`) and the Flutter client.

Branch: `fix/telemetry-supabase-compatibility`  
Base Branch: `stable` (commit `c94ef85`)  

---

## Live Database Contract Verification (`pg_proc` on `fnngudikrvelpuhngtlw`)
Direct read-only inspection of the PostgreSQL system catalog (`pg_proc` and `information_schema.columns`) in target Supabase project `fnngudikrvelpuhngtlw` established the exact contracts:

| Function | Live Signature in PostgreSQL | Notes |
|---|---|---|
| `ingest_telemetry_packet` | `(p_device_id text, p_seq bigint, p_timestamp timestamp with time zone, p_latitude numeric, p_longitude numeric, p_speed numeric DEFAULT NULL, p_heading numeric DEFAULT NULL, p_accuracy numeric DEFAULT NULL, p_status text DEFAULT NULL, p_stop_radius_m double precision DEFAULT 50.0, p_deviation_m double precision DEFAULT 500.0, p_epoch bigint DEFAULT NULL) RETURNS jsonb` | Accepts hardware text ID (e.g. `'NITC-BUS-001'`). Resolves internal UUID (`v_device_pk`) and `bus_id` internally. Exactly 1 overload. |
| `reset_device_sequence` | `(p_device_id text, p_secret text, p_session_id text DEFAULT NULL, p_reason text DEFAULT 'firmware_reboot') RETURNS jsonb` | Verifies credentials via Bcrypt `crypt()`. Idempotently skips incrementing if `last_session_id = p_session_id`. |
| `register_tracking_device` | `(p_device_id text, p_bus_number text, p_secret text, p_allow_reassign boolean DEFAULT false) RETURNS jsonb` | Stores Bcrypt hash via `crypt(p_secret, gen_salt('bf', 8))`. |
| `get_nearby_buses` | `(p_latitude double precision, p_longitude double precision, p_radius_meters double precision DEFAULT 2000, p_limit integer DEFAULT 10) RETURNS TABLE(...)` | Canonical PostGIS spatial query. |
| `get_nearby_stops` | `(p_latitude double precision, p_longitude double precision, p_radius_meters double precision DEFAULT 500, p_limit integer DEFAULT 10) RETURNS TABLE(...)` | Canonical PostGIS spatial query. |

---

## Key Technical Decisions & Invariants Enforced
1. **Device Identifier Mapping**:
   - `devices.id` is the internal UUID primary key.
   - `devices.device_id` is the hardware tracker text ID (e.g. `'NITC-BUS-001'`).
   - Fastify JWT `sub` stores the text ID.
   - `ingest_telemetry_packet(p_device_id text)` receives this text ID, resolves the internal UUID for updates, and stores the text ID into `bus_positions.device_id` and `bus_current_state.device_id`.
2. **Zero-Legacy Policy**: Clean standardization on **Bcrypt with 8 salt rounds** (`bcryptjs` in Node, `pgcrypto` `gen_salt('bf', 8)` in PostgreSQL). No dual-algorithm fallback or legacy `scrypt` code.
3. **16-Character Minimum Secret Invariant**: Enforced uniformly across Fastify TypeBox schemas (`minLength: 16`), database functions, and provisioning scripts (32-character base64url secrets).
4. **Mandatory Epoch & Session Protocol**:
   - `session_id` in `ResetSessionBody` is mandatory to guarantee reboot idempotency. Lost responses retried with the same `session_id` return the established epoch without re-incrementing.
   - `epoch` in `TelemetryBody` is mandatory (minimum: 1). Under zero-legacy rules, no packet can omit session binding.
5. **Dynamic Token Invalidation**: `authenticateDevice` hook dynamically validates `devices.is_active` against Supabase. Deactivated devices are rejected with HTTP 401 even if they possess an unexpired 12-hour JWT.
6. **Trip Completion Clarification**: Ending a trip (`/trips/:id/end`) updates `trips`, inserts `bus_events`, and clears `bus_current_state.trip_id = null`. Because no single transactional RPC currently exists in PostgreSQL for trip lifecycle, these are executed sequentially by Fastify with explicit error handling.

---

## Phase-by-Phase Changes & Commit History

| Phase | Commit | Message | Key Changes |
|---|---|---|---|
| **Phase 0** | `e824aa0` | `docs: document telemetry integration baseline` | Baseline audit, contract verification against migration `20261014040200`, initialized changelog and PR draft. |
| **Phase 1** | `9062e3a` | `fix: align telemetry ingestion with Supabase RPC` | Migrated `telemetry.repo.ts` to `ingest_telemetry_packet`, removed `p_bus_id`, mapped return codes (`SUCCESS`, `DUPLICATE_PACKET`, `SEQUENCE_REUSE_CONFLICT`, etc.) to HTTP 200, 401, 409, 422. |
| **Phase 2** | `49fca41` | `fix: reconcile device credential handling with Bcrypt 8 rounds` | Replaced `scrypt` with `bcryptjs` (8 rounds), updated `provision-device.ts` with 32-char secrets and initial epoch 1. |
| **Phase 3** | `045ecc4` | `feat: support epoch-aware telemetry sessions and reset endpoint` | Implemented `POST /api/v1/auth/reset-session`, added `epoch` and nullable metrics to `TelemetryBody` schema, added `test/reset_session.test.ts`. |
| **Phase 4** | `19fbb02` | `fix: align telemetry validation, spatial APIs, and proxy trust` | Bounded coordinates to NITC corridor, clock drift to 15m past / 1m future, removed in-memory duplicate drop, cleared `trip_id` on trip end, updated spatial RPCs to `get_nearby_buses` and `get_nearby_stops`. |
| **Phase 5** | `d50797f` | `test: add comprehensive auth, readiness, and telemetry test coverage` | Added `test/auth.route.test.ts`, verified 35/35 tests passing across 4 suites, verified clean `npm run build`. |
| **Hardening** | `f2c35d1` | `fix: enforce mandatory epoch/session_id and dynamic device revocation` | Made `epoch` and `session_id` strictly required, added dynamic `is_active` check in auth plugin, 38/38 tests passing. |
| **Response & Protocols** | `08da6a4` | `fix: preserve stored/state_updated flags and document ESP32 protocol` | Returned exact `stored` and `state_updated` booleans from DB RPC in all branches; documented Render proxy trust and ESP32 reboot protocol. |
| **Phase 6** | *(current)* | `test: add Fastify-to-Supabase integration suite and architecture docs` | Fixed Bcrypt `$2a$` prefix compatibility with `pgcrypto`; resolved `new_epoch` reset mapping; added 14 real Fastify-to-Supabase integration tests; authored complete architecture and protocol documentation. |

---

## Verification & Test Results

### 1. Real Fastify-to-Supabase Database Integration Test Suite (`npm run test:integration`)
*Executed via HTTP injection through the actual Fastify application into local Supabase PostgreSQL (`http://127.0.0.1:54321`).*
```
✓ test/integration/supabase.integration.test.ts (14 tests)
  ✓ A. Provisioning & Authentication (2 tests)
  ✓ B. Session Reset & Idempotency (2 tests)
  ✓ C. Successful Telemetry Ingestion (1 test)
  ✓ D. Exact Duplicate Retry Idempotency (1 test)
  ✓ E. Conflicting Sequence Reuse (1 test)
  ✓ F. Epoch Transitions and Stale Packets (1 test)
  ✓ G. Dynamic Device Revocation (1 test)
  ✓ H. Validation and Boundary Invariants (3 tests)
  ✓ I. Concurrency Safety under Database Locks (1 test)
  ✓ J. Realtime Publication Enrollment (1 test)

Test Files  1 passed (1)
Tests       14 passed (14)
Duration    722ms
```

### 2. Isolated Database SQL Test Suite (`telemetry_ingestion_test.sql`)
Executed directly against isolated local Supabase PostgreSQL (`supabase_db_NITC_BUS_TRACKING_APP`):
- **Result**: **ALL 18 TEST SUITES PASSED CLEANLY WITH ZERO LEFTOVER STATE!**
  - Test 1: Valid telemetry packet ingestion & atomic persistence.
  - Test 2: Exact multi-field duplicate packet retry idempotency.
  - Test 3: Sequence reuse with independently conflicting fields (all 7 identity fields verified).
  - Test 4: Ingest advancing seq 101, then test historical seq 100 handling.
  - Test 5: Out-of-order lower unseen sequence rejection.
  - Test 6: Advancing sequence with regressed timestamp rejection.
  - Test 6b: Ingest packet with NULL nullable fields and test exact retry.
  - Test 7: Epoch security: reject unauthorized future epoch & test authorized reboot with idempotent retry across network drops.
  - Test 8: Reject packet from previous session epoch.
  - Test 9: Device deactivation and rejected ingestion.
  - Test 10: Tracker replacement, freshness reset, and historical isolation.
  - Test 11: Database constraints: single active device per bus & history uniqueness.
  - Test 12: Multiple active trips detection & ambiguity handling.
  - Test 13: Telemetry boundary and value invariants.
  - Test 14: Stop arrival geofencing, arrival dedup, and departure hysteresis.
  - Test 15: `get_active_bus_positions()` freshness (<90s fresh, <15m stale, >15m unavailable).
  - Test 16: `register_tracking_device()` provisioning and protections.
  - Test 17: Pre-existing legacy data upgrade with sequence collisions.

### 3. Automated Unit and Route Test Suite (`npm test`)
*Note: The following 40 tests verify application logic, validation schemas, security headers, and route error mapping using isolated mocks.*
```
✓ test/core.test.ts (14 tests)
✓ test/reset_session.test.ts (6 tests)
✓ test/telemetry.route.test.ts (13 tests)
✓ test/security.test.ts (2 tests)
✓ test/auth.route.test.ts (5 tests)

Test Files  5 passed (5)
Tests       40 passed (40)
Duration    617ms
```

### 4. TypeScript Compilation Check (`npm run typecheck`)
```
> bus-telemetry-api@1.0.0 typecheck
> tsc -p tsconfig.json

Exit code: 0 (Zero compiler errors)
```

### 4. Production Build (`npm run build`)
```
> bus-telemetry-api@1.0.0 build
> tsc -p tsconfig.build.json

Exit code: 0 (Clean output to dist/)
```

### 5. Configured Stop Radius and Route Deviation Alignment
`src/config.ts` configures:
- `stopRadiusM: num('STOP_RADIUS_M', 50)`
- `routeDeviationM: num('ROUTE_DEVIATION_M', 500)`
These match the PostgreSQL RPC parameter defaults: `p_stop_radius_m double precision DEFAULT 50.0`, `p_deviation_m double precision DEFAULT 500.0`.

### 6. Render Proxy Trust Verification
Render terminates external HTTPS traffic and proxies requests internally via `10.x.x.x` private addresses. By configuring `trustProxy: config.trustedProxies` with RFC1918 subnets (`127.0.0.1, 10.0.0.0/8, 172.16.0.0/12, 192.168.0.0/16`), Fastify only trusts proxy headers from internal load balancers, preventing public clients from spoofing `X-Forwarded-For`.

### 7. Known Limitation: Sequential Trip Completion
In `src/routes/trips.ts`, `/trips/:id/end` performs sequential REST updates:
1. Updates `trips` (`status = 'completed', ended_at = ...`)
2. Inserts `bus_events` (`event_type = 'trip_ended'`)
3. Updates `bus_current_state` (`trip_id = null`)
These calls are sequential, not a single database transaction. If the Node process terminates between calls, `trip` is completed but `bus_current_state.trip_id` may remain populated until cleared by the next incoming telemetry packet. An atomic `end_bus_trip` RPC should be added in a future database migration.

### 8. ESP32 Hardware Boot & Ingestion Protocol
1. **Boot / Reboot**:
   - ESP32 generates `session_id = "boot-" + millis() + "-" + esp_random()`.
   - Sends `POST /api/v1/auth/reset-session` with `{ device_id, secret, session_id, reason: "boot" }`.
   - Retries on drop with the **same `session_id`** (server returns existing epoch with `idempotent_retry: true`).
   - Caches `epoch` in RAM and resets `seq = 1`.
2. **Telemetry Ingestion**:
   - Sends `POST /api/v1/telemetry` with `{ device_id, seq, epoch, timestamp, latitude, longitude, ... }` incrementing `seq`.
   - If response times out, retry with identical `seq` and data.
   - Fastify responds with `stored: false, state_updated: false, reason: "duplicate"`.

---

## Reviewer Checklist
- [x] Verified exact PostgreSQL types from live `pg_proc` (`p_device_id text`, `p_epoch bigint DEFAULT NULL`, `stop_radius 50.0`, `deviation 500.0`).
- [x] Zero legacy fallbacks or dual-algorithm checks introduced.
- [x] 16-character minimum secret length enforced across API schemas and scripts.
- [x] `session_id` mandatory for reboot resets to guarantee idempotency.
- [x] `epoch` mandatory for telemetry packets under zero-legacy rules.
- [x] Deactivated devices rejected even with valid 12-hour JWT.
- [x] Database integration tests (18/18 suites) run and passed in isolated Supabase environment.
- [x] Telemetry responses preserve actual `stored` and `state_updated` values.
- [x] Production build and test suite pass with zero errors.
- [x] No production mutations, DDL, or data changes executed.
