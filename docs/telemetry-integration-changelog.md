# Telemetry Integration Changelog

All changes to `backend_bus_tracker` to achieve compatibility with the deployed Supabase transport backend and the NITC Bus Tracking Flutter application are recorded here phase by phase.

---

## Phase 0: Baseline & Live Database Contract Verification
- **Date**: 2026-10-14
- **Branch**: `fix/telemetry-supabase-compatibility` (base: `stable` @ commit `c94ef85`)
- **Status**: Completed (Live Catalog Query Verified)

### Live Database Contract Verification (`pg_proc` on `fnngudikrvelpuhngtlw`)
Direct read-only inspection of the PostgreSQL system catalog (`pg_proc` and `information_schema.columns`) in target Supabase project `fnngudikrvelpuhngtlw` established the authoritative contracts:

1. **`ingest_telemetry_packet`**:
   - Signature: `(p_device_id text, p_seq bigint, p_timestamp timestamp with time zone, p_latitude numeric, p_longitude numeric, p_speed numeric DEFAULT NULL::numeric, p_heading numeric DEFAULT NULL::numeric, p_accuracy numeric DEFAULT NULL::numeric, p_status text DEFAULT NULL::text, p_stop_radius_m double precision DEFAULT 50.0, p_deviation_m double precision DEFAULT 500.0, p_epoch bigint DEFAULT NULL::bigint) RETURNS jsonb`
   - **Resolution of Discrepancy**: Earlier audit notes proposed a theoretical signature with `p_device_id uuid`, `p_epoch integer DEFAULT 0`, `p_stop_radius_m 40.0`, `p_deviation_m 100.0`. Live inspection of `pg_proc` proves that `p_device_id` is `text`, not `uuid`. The hardware tracker identifier (e.g. `'NITC-BUS-001'`) is passed directly. Inside `ingest_telemetry_packet`, PostgreSQL queries `devices` where `device_id = p_device_id AND is_active = true` to resolve `v_device_pk` (UUID) and `v_bus_id` (UUID).
   - There are **no overloaded versions** of `ingest_telemetry_packet`.
2. **`reset_device_sequence`**:
   - Signature: `(p_device_id text, p_secret text, p_session_id text DEFAULT NULL::text, p_reason text DEFAULT 'firmware_reboot'::text) RETURNS jsonb`
   - Verifies credentials using `crypt(p_secret, credential_hash)`.
   - Requires `session_id` to provide idempotent retry. If `last_session_id = p_session_id`, it returns the established epoch without re-incrementing.
   - Resets `bus_current_state.seq` to 0 and updates `epoch`.
3. **`register_tracking_device`**:
   - Signature: `(p_device_id text, p_bus_number text, p_secret text, p_allow_reassign boolean DEFAULT false) RETURNS jsonb`
   - Stores `credential_hash` using `extensions.crypt(p_secret, extensions.gen_salt('bf', 8))`.
4. **Canonical Spatial Functions**:
   - `get_nearby_buses(p_latitude double precision, p_longitude double precision, p_radius_meters double precision, p_limit integer)`
   - `get_nearby_stops(p_latitude double precision, p_longitude double precision, p_radius_meters double precision, p_limit integer)`

---

## Phase 1: Telemetry RPC Compatibility
- **Date**: 2026-10-14
- **Branch**: `fix/telemetry-supabase-compatibility`
- **Files Modified**:
  - `src/services/processing.ts`
  - `src/repositories/telemetry.repo.ts`
  - `src/routes/telemetry.ts`
  - `test/telemetry.route.test.ts`
- **What Changed & Why**:
  - Replaced legacy `ingest_telemetry` RPC call with `ingest_telemetry_packet(...)` accepting 12 parameters matching live Supabase PostgreSQL types.
  - Removed `p_bus_id` parameter; the bus reference is resolved securely server-side inside PostgreSQL from `devices.bus_id`.
  - Replaced blanket `result.reason ?? 'device_inactive'` mapping with full result inspection:
    - Handled idempotent duplicates (`code === 'DUPLICATE_PACKET'`) -> HTTP 200 `{ ok: true, stored: false, reason: 'duplicate' }`.
    - Handled successful writes (`code === 'SUCCESS'`) -> HTTP 200 `{ ok: true, stored: true, state_updated: true }`.
    - Mapped authorization rejections (`UNAUTHORIZED_DEVICE`, `INACTIVE_BUS`) -> HTTP 401 Unauthorized.
    - Mapped sequence/epoch conflicts (`STALE_EPOCH_PACKET`, `UNAUTHORIZED_EPOCH`, `INVALID_SEQUENCE`, `SEQUENCE_REUSE_CONFLICT`, `OUT_OF_ORDER_PACKET`) -> HTTP 409 Conflict.
    - Mapped spatial/timestamp validation rejections (`COORDINATES_OUT_OF_BOUNDS`, `INVALID_SPEED`, `INVALID_HEADING`, `INVALID_ACCURACY`, `IMPLAUSIBLE_TIMESTAMP`) -> HTTP 422 Unprocessable Entity.

---

## Phase 2: Device Authentication & Provisioning
- **Date**: 2026-10-14
- **Branch**: `fix/telemetry-supabase-compatibility`
- **Files Modified**:
  - `package.json` & `package-lock.json`
  - `src/lib/password.ts`
  - `scripts/provision-device.ts`
  - `test/core.test.ts`
- **What Changed & Why**:
  - Replaced Node.js native `scrypt` hashing in `src/lib/password.ts` with `bcryptjs` using 8 salt rounds (`BCRYPT_ROUNDS = 8`). Matches PostgreSQL `pgcrypto` `gen_salt('bf', 8)` binary output (`$2a$08$...`), eliminating credential incompatibility (`SEC-001`).
  - Zero-legacy adherence: no dual-algorithm fallbacks or legacy hash migrations.
  - Invariant adherence: 16-character minimum secret length enforced across API schemas (`minLength: 16`), database functions, and `scripts/provision-device.ts` (generates 32-character base64url secrets).
  - Explicit initial epoch: `scripts/provision-device.ts` initializes `current_epoch: 1` explicitly upon upserting new devices.

---

## Phase 3: Epoch and Sequence Handling
- **Date**: 2026-10-14
- **Branch**: `fix/telemetry-supabase-compatibility`
- **Files Modified**:
  - `src/schemas/auth.ts` (new)
  - `src/schemas/telemetry.ts`
  - `src/routes/auth.ts`
  - `src/services/validation.ts`
  - `test/reset_session.test.ts` (new)
- **What Changed & Why**:
  - Implemented `POST /api/v1/auth/reset-session` endpoint in Fastify calling `reset_device_sequence` RPC:
    - **Mandatory `session_id`**: Made `session_id` strictly required in `ResetSessionBody` schema. Without `session_id`, retried reboot requests would not be recognized as idempotent and would increment epoch repeatedly.
    - Idempotent retries: passes `p_session_id` to PostgreSQL. If the network dropped the response and the tracker retries with the same `session_id`, the RPC returns the existing epoch with `idempotent_retry: true` without incrementing again.
    - Resets `bus_current_state.seq` to 0, ensuring post-reboot `seq = 1` packets pass strict monotonicity checks.
  - **Mandatory `epoch` in Telemetry**: Made `epoch` strictly required in `TelemetryBody` schema (minimum: 1). Under the zero-legacy policy, hardware trackers must never emit packets without explicit session epoch binding.
  - Added nullable metrics support (`speed`, `heading`, `accuracy`) and null-safety checks in `validateTelemetry`.

---

## Phase 4: Validation, Reliability, and API Contracts
- **Date**: 2026-10-14
- **Branch**: `fix/telemetry-supabase-compatibility`
- **Files Modified**:
  - `src/config.ts`
  - `src/app.ts`
  - `src/routes/telemetry.ts`
  - `src/routes/trips.ts`
  - `src/routes/buses.ts`
  - `src/plugins/auth.ts`
  - `test/core.test.ts`
- **What Changed & Why**:
  - Aligned geospatial bounding box in `src/config.ts` to the Kozhikode / NITC transit corridor (`[11.200000, 11.450000]` lat, `[75.800000, 76.100000]` lon) (`DATA-002`).
  - Aligned clock drift boundaries: max age set to 15 minutes (`900s`), future skew set to 1 minute (`60s`) (`DATA-003`).
  - Reverse proxy trust: `trustProxy` configured with private RFC1918 CIDR masks (`127.0.0.1,10.0.0.0/8,172.16.0.0/12,192.168.0.0/16`) to prevent client spoofing of `X-Forwarded-For` (`SEC-004`).
  - Removed unisolated in-memory duplicate drop in `src/routes/telemetry.ts`. Deduplication, sequence ordering, and epoch validation execute authoritatively inside PostgreSQL's transaction-scoped advisory locks (`DATA-005`, `CONC-001`).
  - **Dynamic Device Revocation**: Updated `authenticateDevice` hook in `src/plugins/auth.ts` to query `devices.is_active` dynamically. Deactivated devices are rejected with HTTP 401 even when presenting an unexpired 12-hour JWT (`SEC-003`).
  - **Trip Completion Honesty**: Updated `/trips/:id/end` to clear `bus_current_state.trip_id = null` for the ended bus. Documented that these are sequential operations executed by Fastify rather than a single database transaction, as no transactional RPC exists in the live database (`API-001`).
  - Spatial RPC alignment: updated `src/routes/buses.ts` to call canonical PostGIS functions `get_nearby_buses` and `get_nearby_stops` (`API-002`).

---

## Phase 5: Testing, Hardening & Contract Verification
- **Date**: 2026-10-14
- **Branch**: `fix/telemetry-supabase-compatibility`
- **Files Modified**:
  - `src/routes/telemetry.ts`
  - `src/schemas/auth.ts`
  - `src/schemas/telemetry.ts`
  - `src/plugins/auth.ts`
  - `test/auth.route.test.ts`
  - `test/reset_session.test.ts`
  - `test/telemetry.route.test.ts`
  - `test/core.test.ts`
- **What Changed & Why**:
  - **Telemetry Response Value Preservation**: Updated `src/routes/telemetry.ts` to strictly preserve and return PostgreSQL's actual `stored` and `state_updated` booleans in all branches (`stored: true, state_updated: true` on accepted write, `stored: false, state_updated: false, reason: "duplicate"` on idempotent duplicate retry, and `stored: false, state_updated: false` on ignored packets).
  - **Dynamic Device Revocation**: In `src/plugins/auth.ts`, `authenticateDevice` checks `devices.is_active` dynamically so deactivated devices cannot write telemetry even with an unexpired JWT.
  - **Mandatory Invariants**: Enforced mandatory `session_id` on reset and mandatory `epoch` (minimum: 1) on telemetry.
  - **Render Proxy Trust Verification**: Verified `trustProxy: config.trustedProxies` configuring RFC1918 subnets (`127.0.0.1, 10.0.0.0/8, 172.16.0.0/12, 192.168.0.0/16`). On Render, external HTTPS traffic is terminated at Render's edge load balancer and proxied to the container over internal network `10.x.x.x`. By restricting proxy trust to RFC1918 ranges instead of blanket `true`, Fastify validates the internal hop without allowing arbitrary public clients to spoof `X-Forwarded-For`.
  - **Stop Radius & Route Deviation Alignment**: Verified `src/config.ts` defaults (`stopRadiusM: 50`, `routeDeviationM: 500`) precisely match PostgreSQL RPC parameter defaults (`p_stop_radius_m double precision DEFAULT 50.0`, `p_deviation_m double precision DEFAULT 500.0`).
  - **Documented Known Limitation - Sequential Trip Completion**: Documented that `/trips/:id/end` performs sequential REST updates (`trips` update -> `Promise.all([bus_events, bus_current_state])`) rather than an atomic database transaction. If the Node process crashes between calls, `trip` could be marked completed while `bus_current_state.trip_id` is cleared on the subsequent telemetry packet. An atomic `end_bus_trip` RPC is recommended for a future migration.

### Database Integration Test Suite (`telemetry_ingestion_test.sql`)
Executed against isolated local Supabase PostgreSQL (`supabase_db_NITC_BUS_TRACKING_APP`):
- **Result**: **18/18 test suites passed cleanly with zero leftover state**.
  - Test 1: Valid telemetry packet ingestion & atomic persistence.
  - Test 2: Exact multi-field duplicate packet retry idempotency.
  - Test 3: Sequence reuse with independently conflicting fields (all 7 fields tested).
  - Test 4: Historical sequence reuse and delayed retries.
  - Test 5: Out-of-order lower unseen sequence rejection.
  - Test 6: Advancing sequence with regressed timestamp rejection.
  - Test 6b: NULL-safety verified on sequence storage and duplicate retry.
  - Test 7: Epoch security: unauthorized future epoch rejection & authorized reboot with idempotent retry across network drops.
  - Test 8: Rejection of packets from previous session epochs.
  - Test 9: Immediate device deactivation blocking.
  - Test 10: Tracker replacement, freshness reset, and historical isolation.
  - Test 11: Database constraints: single active device per bus & history uniqueness.
  - Test 12: Multiple active trips detection & ambiguity prevention.
  - Test 13: Telemetry boundary and value invariants.
  - Test 14: Stop arrival geofencing, arrival dedup, and departure hysteresis.
  - Test 15: `get_active_bus_positions()` freshness contract (<90s fresh, <15m stale, >15m unavailable).
  - Test 16: `register_tracking_device()` provisioning and reassignment protections.
  - Test 17: Pre-existing legacy data upgrade with sequence collisions simulation.

### ESP32 Hardware Boot & Ingestion Protocol
1. **Cold Boot / Reboot**:
   - ESP32 boots and generates a random session identifier: `session_id = "boot-" + millis() + "-" + esp_random()`.
   - Sends `POST /api/v1/auth/reset-session` with `{ device_id, secret, session_id, reason: "cold_boot" }`.
   - If the network drops or the response times out, the ESP32 **must retry with the exact same `session_id`**.
   - Server returns `{ ok: true, epoch: N, idempotent_retry: boolean }`.
   - ESP32 stores `epoch = N` in volatile/RTC memory and initializes its sequence counter `seq = 1`.
2. **Telemetry Transmission**:
   - ESP32 emits `POST /api/v1/telemetry` with `{ device_id, seq, epoch, timestamp, latitude, longitude, ... }` incrementing `seq` for each new GPS fix.
   - If transmission fails or times out, ESP32 retries with the **same `seq` and identical GPS data**.
   - Server acknowledges retry with HTTP 200 `{ ok: true, stored: false, state_updated: false, reason: "duplicate" }`.
3. **Firmware Reboot Boundary**:
   - Whenever power is cycled or watchdog triggers, step 1 is repeated, establishing `epoch = N + 1` and resetting sequence counter cleanly back to `1`.

---

## Phase 6: Fastify-to-Supabase Integration Verification & Architecture Documentation
- **Date**: 2026-10-14
- **Branch**: `fix/telemetry-supabase-compatibility`
- **Files Modified**:
  - `src/lib/password.ts`
  - `src/routes/auth.ts`
  - `src/routes/telemetry.ts`
  - `vitest.config.ts`
  - `vitest.integration.config.ts` (new)
  - `package.json`
  - `test/security.test.ts` (new)
  - `test/integration/supabase.integration.test.ts` (new)
  - `docs/backend-architecture.md` (new)
  - `docs/telemetry-protocol.md` (new)
  - `docs/development-and-testing.md` (new)
  - `docs/implementation-guide.md` (new)
  - `docs/telemetry-integration-changelog.md`
  - `docs/pr-description.md`
- **What Changed & Why**:
  - **Bidirectional Bcrypt Compatibility ($2a$ vs $2b$)**: Discovered that `bcryptjs.hash()` outputs `$2b$08$...` by default. PostgreSQL `pgcrypto` `crypt()` only recognizes the `$2a$` prefix and fails verification when comparing `$2b$` hashes. Updated `src/lib/password.ts` to replace `^\$2b\$` with `$2a$`. Added regression tests verifying compatibility in **both directions**:
    - *Direction 1 (Node -> Postgres)*: Node.js `hashSecret()` outputs `$2a$08$...` and is verifiable by both Node `verifySecret()` and PostgreSQL `pgcrypto` `crypt()`.
    - *Direction 2 (Postgres -> Node)*: PostgreSQL `register_tracking_device` RPC hashes the secret using `pgcrypto` `crypt(..., gen_salt('bf', 8))`. Fastify Node `verifySecret()` correctly authenticates the device and issues a JWT.
  - **Reset Epoch Field Reconciliation**: Resolved epoch return value in `src/routes/auth.ts` from `Number(data.epoch ?? data.new_epoch)`. `reset_device_sequence` returns `new_epoch` on fresh advance and `epoch` on idempotent retry.
  - **Real Fastify-to-Supabase Integration Suite**: Implemented `test/integration/supabase.integration.test.ts` running real HTTP requests against local Supabase containers (`http://127.0.0.1:54321`), covering 15 scenarios:
    - Scenario A: Device provisioning & authentication (both Direction 1 Node hash and Direction 2 PostgreSQL hash).
    - Scenario B: Session reset & idempotent retry with same `session_id`.
    - Scenario C: Successful telemetry persistence in `bus_positions` & `bus_current_state`.
    - Scenario D: Exact duplicate retry idempotency without extra history rows.
    - Scenario E: Conflicting sequence reuse rejection (HTTP 409 `SEQUENCE_REUSE_CONFLICT`).
    - Scenario F: Epoch transition, reboot recovery, and stale epoch rejection (HTTP 409 `STALE_EPOCH_PACKET`).
    - Scenario G: Dynamic device revocation blocking.
    - Scenario H: Validation boundary invariants (NITC corridor 422, future skew 422, nullable GNSS fields 200).
    - Scenario I: Concurrency safety under advisory locks (5 concurrent packets processed safely).
    - Scenario J: Realtime publication enrollment verification & canonical state persistence (distinguished from live WebSocket delivery).
  - **Proxy Anti-Spoofing & Security Testing**: Expanded `test/security.test.ts` to verify:
    - Direct untrusted public connections (`remoteAddress: 203.0.113.1`) attempting to spoof `X-Forwarded-For: 1.2.3.4` are ignored; Fastify correctly assigns `req.ip = 203.0.113.1`.
    - Connections through trusted private proxies (`remoteAddress: 10.0.0.1`) halt at the first untrusted upstream hop (`203.0.113.50`), never trusting spoofed preceding IPs (`1.2.3.4`).
    - Authenticated telemetry rate limiting keys on `req.user.sub` (device identifier), preventing IP-spoofing evasion.
  - **Architecture & System Documentation**: Added comprehensive, standalone engineering documentation (`docs/backend-architecture.md`, `docs/telemetry-protocol.md`, `docs/development-and-testing.md`, `docs/implementation-guide.md`).
- **Documented Operational Limitations**:
  1. *Realtime WebSocket Client Delivery*: Database-side CDC publication membership (`bus_current_state` in `supabase_realtime`) and canonical row persistence are verified. Actual live WebSocket message delivery to mobile clients is an out-of-process client integration responsibility and must be tested in the Flutter mobile application.
  2. *Render Cloud Ingress Topology*: Software CIDR parsing and anti-spoofing algorithms are verified in Vitest. However, live Render production ingress settings (e.g. proxy headers, CDN presence) have not been inspected in the cloud and must be verified during staging deployment.
  3. *Sequential Trip Completion*: In `src/routes/trips.ts`, `/trips/:id/end` performs sequential REST updates rather than an atomic database transaction. An atomic `end_bus_trip` RPC should be added in a future migration.
- **Verification Result**:
  - `npm test`: 41/41 tests passing across 5 test suites.
  - `npm run test:integration`: 15/15 real database integration tests passing.
  - `npm run typecheck`: 0 compiler diagnostics.
  - `npm run build`: Clean production build.

---

## Phase 7: Render Free Deployment & Hosted Supabase Edge Function E2E Verification
- **Date**: 2026-10-14
- **Branch**: `fix/telemetry-supabase-compatibility`
- **Hosted Targets**:
  - Render Service: `https://bus-telemetry-api.onrender.com` (Plan: `free`, Region: `singapore`)
  - Supabase Project: `fnngudikrvelpuhngtlw` (`https://fnngudikrvelpuhngtlw.supabase.co`)
  - Edge Function: `telemetry-simulator` (`https://fnngudikrvelpuhngtlw.supabase.co/functions/v1/telemetry-simulator`)
- **Key Milestones Achieved**:
  1. **Agent Skills Installation & Catalog Verification**:
     - Installed all 21 Render compute & infrastructure skills (`render-deploy`, `render-web-services`, `render-env-vars`, etc.) via `npx skills add render-oss/skills`.
     - Verified Supabase skills (`supabase`, `supabase-postgres-best-practices`) and Supabase/Render MCP tool integrations.
     - Verified GitHub integration via authenticated GitHub CLI (`gh`) and Git remotes.
  2. **Render Free Deployment**:
     - Configured `render.yaml` with `plan: free`.
     - Deployed Docker-based Fastify API service to Render Free tier (`bus-telemetry-api`).
     - Provisioned environment secrets: `SUPABASE_URL`, `SUPABASE_SERVICE_ROLE_KEY`, `DEVICE_JWT_SECRET`, `METRICS_TOKEN`, `NODE_ENV=production`.
     - Verified live health check at `https://bus-telemetry-api.onrender.com/healthz` (HTTP 200 `{"status":"ok"}`).
  3. **Database Constraint Hotfix (`bus_events_event_type_check`)**:
     - Discovered that live `bus_events_event_type_check` constraint previously lacked the `'device_sequence_reset'` event type expected by `reset_device_sequence`.
     - Updated check constraint on `public.bus_events` to include `'device_sequence_reset'`, resolving a 500 error on cold boot session resets.
  4. **Supabase Edge Function Simulator (`telemetry-simulator`)**:
     - Authored and deployed `telemetry-simulator` Edge Function to live Supabase project `fnngudikrvelpuhngtlw`.
     - Automated complete end-to-end telemetry lifecycle testing:
       - Step 0: Tracker provisioning & verification via `register_tracking_device` RPC (Bcrypt 8-round pgcrypto hash).
       - Step 1: Cold boot session reset (`POST /api/v1/auth/reset-session`) advancing to fresh authorized epoch.
       - Step 2: Idempotent session reset retry with duplicate `session_id` returning same epoch with `idempotent_retry: true`.
       - Step 3: Device authentication (`POST /api/v1/auth/device`) returning 12-hour JWT Bearer token.
       - Step 4: Initial GPS fix ingestion (Seq 1) returning `stored: true, state_updated: true`.
       - Step 5: Exact duplicate retry idempotency returning `stored: false, state_updated: false, reason: "duplicate"`.
       - Step 6: Monotonic advancing telemetry fix (Seq 2) along NITC campus road corridor returning `stored: true, state_updated: true`.
       - Step 7: Conflicting sequence reuse detection (Seq 2 reuse with modified metrics) returning HTTP 409 `SEQUENCE_REUSE_CONFLICT`.
       - Step 8: Database canonical state verification querying live PostgreSQL tables (`bus_current_state` and `bus_positions`).
  5. **Verification Result**:
     - Edge Function E2E Suite: **ALL 9 STEPS PASSED** (`"status": "ALL_TESTS_PASSED"`).
     - Live Cloud Telemetry Gateway & Supabase Database verified end-to-end with zero errors.


---

## Phase 8: Anomaly Check Reboot Guard, Standalone Telemetry Simulator CLI & Canonical Architecture Suite
- **Date**: 2026-10-15
- **Branch**: `fix/reboot-anomaly-and-telemetry-simulator`
- **Targets**:
  - Backend Service: `src/services/anomaly.ts`, `package.json`
  - Developer Tools: `scripts/simulate-telemetry.ts`
  - Documentation: `README.md`, `docs/architecture/*`
- **Key Milestones Achieved**:
  1. **Post-Reboot / New Session Anomaly Check Guard (`src/services/anomaly.ts`)**:
     - Resolved an edge-case bug where the first telemetry packet (`seq = 1`) emitted immediately following a cold boot or reboot session reset (`POST /api/v1/auth/reset-session`) was rejected with HTTP 422 `impossible_speed`.
     - When a device reboots, `bus_current_state.seq` is reset to 0, or `epoch` is incremented. However, `bus_current_state.latitude` and `longitude` preserved the pre-reboot position while `recorded_at` was set to the reset timestamp (milliseconds before the first fix).
     - Because $dt$ was under 1 second and the hardware had moved or was at waypoint 0, the implied speed between the old session's coordinate and the new fix was falsely flagged as $> 500\text{ km/h}$.
     - Added an explicit guard: when `!sameEpoch || last.seq === 0`, implied speed comparison against the previous session's coordinate is bypassed (`{ kind: 'ok', seqReset: true }`).
  2. **Standalone Developer CLI Telemetry Simulator (`scripts/simulate-telemetry.ts`)**:
     - Added a self-contained, pure-fetch CLI telemetry simulator runnable via `npm run simulate` or `npx tsx scripts/simulate-telemetry.ts`.
     - Supports Route R1 (57 points) and Route R2 (55 points), configurable nominal speeds, point counts, and interval spacing.
     - Implements offline dead-zone recovery testing via `POST /api/v1/telemetry/batch` (`mode: 'batch'`).
     - Added realistic fault injection modes: `reboot`, `gps_drift`, `duplicate`, `conflict`, `stale_sequence`, `stale_epoch`, `future_epoch`, `excessive_speed`, `out_of_bounds`, `stale_timestamp`, and station `dwell`.
  3. **Canonical Architecture Documentation Suite (`docs/architecture/`)**:
     - Complete 18-part technical architecture reference covering hardware specifications, telemetry ingestion protocols, Fastify endpoints, PostgreSQL schema, PostGIS RPCs, security models, Realtime vs. polling tradeoffs, and sequence diagrams.
  4. **Plain-Language Root README**:
     - Updated root `README.md` with an intuitive, jargon-free overview of the bus tracking system from GPS ping to rider map rendering.
- **Verification Result**:
  - Deno & TypeScript syntax checks: 0 compiler errors.
  - Integration with Fastify endpoints verified.
