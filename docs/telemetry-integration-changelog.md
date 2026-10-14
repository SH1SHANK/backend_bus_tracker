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

## Phase 5: Integration Testing & Coverage
- **Date**: 2026-10-14
- **Branch**: `fix/telemetry-supabase-compatibility`
- **Files Modified**:
  - `test/auth.route.test.ts` (new)
  - `test/reset_session.test.ts`
  - `test/telemetry.route.test.ts`
  - `test/core.test.ts`
- **What Changed & Why**:
  - `test/auth.route.test.ts`: tests device auth with Bcrypt credentials, wrong password (401), inactive device (401), short secrets (400), and `/readyz` probe (200).
  - `test/reset_session.test.ts`: tests valid session reset (200), idempotent session retry (200), invalid credentials (401), missing `session_id` (400), and short secrets (400).
  - `test/telemetry.route.test.ts`: tests valid packet (200), duplicate packet (200), sequence reuse conflict (409), unauthorized/inactive device (401), revoked token deactivation (401), out of bounds (422), missing mandatory epoch (400), and explicit epoch with nullable metrics (200).
- **Verification Result**: `tsc -p tsconfig.json` exit 0, `vitest run` 38/38 tests passed across 4 test suites. `npm run build` completed successfully.
- **Clarification**: All 38 tests are unit and mocked-route integration tests. Live database contracts were independently verified via read-only SQL queries on the Supabase catalog (`pg_proc` and `information_schema.columns`).
