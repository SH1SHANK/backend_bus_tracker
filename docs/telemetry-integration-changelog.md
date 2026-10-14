# Telemetry Integration Changelog

All changes to `backend_bus_tracker` to achieve compatibility with the deployed Supabase transport backend and the NITC Bus Tracking Flutter application are recorded here phase by phase.

---

## Phase 0: Baseline & Contract Verification
- **Date**: 2026-10-14
- **Branch**: `fix/telemetry-supabase-compatibility` (base: `stable` @ commit `c94ef85`)
- **Status**: Completed (Read-Only Verification Gate Passed)

### Source of Truth Verification
Verified against Supabase migration `20261014040200_complete_transport_backend_foundation.sql`:
1. **`ingest_telemetry_packet`**:
   - Signature: `(p_device_id text, p_seq bigint, p_timestamp timestamp with time zone, p_latitude numeric, p_longitude numeric, p_speed numeric DEFAULT NULL, p_heading numeric DEFAULT NULL, p_accuracy numeric DEFAULT NULL, p_status text DEFAULT NULL, p_stop_radius_m double precision DEFAULT 50.0, p_deviation_m double precision DEFAULT 500.0, p_epoch bigint DEFAULT NULL) RETURNS jsonb`
   - Atomically takes transaction-scoped advisory locks on device (`1001`) and bus (`1002`).
   - Resolves bus dynamically from `devices.bus_id` where `device_id = p_device_id AND is_active = true`.
   - Returns `{ ok: true, code: 'SUCCESS', ... }` on insertion, `{ ok: true, code: 'DUPLICATE_PACKET', stored: false, ... }` on exact retries, and `{ ok: false, code: '<REASON>', error: '<MSG>' }` on rejections.
2. **`reset_device_sequence`**:
   - Signature: `(p_device_id text, p_secret text, p_session_id text DEFAULT NULL, p_reason text DEFAULT 'firmware_reboot') RETURNS jsonb`
   - Verifies credentials using `crypt(p_secret, credential_hash)`.
   - Idempotently returns existing epoch if `last_session_id = p_session_id`.
   - Increments `current_epoch`, updates `last_session_id`, and resets `bus_current_state.seq` to `0`.
3. **`register_tracking_device`**:
   - Signature: `(p_device_id text, p_bus_number text, p_secret text, p_allow_reassign boolean DEFAULT false) RETURNS jsonb`
   - Stores `credential_hash` using `extensions.crypt(p_secret, extensions.gen_salt('bf', 8))`.
4. **Canonical Spatial Functions**:
   - `get_nearby_buses(p_latitude double precision, p_longitude double precision, p_radius_meters double precision, p_limit integer)`
   - `get_nearby_stops(p_latitude double precision, p_longitude double precision, p_radius_meters double precision, p_limit integer)`

### Baseline Deficiencies Identified in `backend_bus_tracker`
- **DB-001**: `src/repositories/telemetry.repo.ts` calls obsolete `ingest_telemetry` with `p_bus_id` and `p_recorded_at`.
- **DB-002**: `src/routes/telemetry.ts` checks `result.reason`, flattening all non-success outcomes into HTTP 401 `device_inactive`.
- **SEC-001**: `src/lib/password.ts` uses Node.js `scrypt`, incompatible with PostgreSQL `pgcrypto` Bcrypt.
- **SEC-002**: Secret length requirement inconsistent across API and DB.
- **SEC-003**: Device JWT token trusts static `bus_id` and skips active device check.
- **SEC-004**: `trustProxy: true` allows client IP spoofing for rate-limit bypass.
- **DATA-001**: No epoch support or `POST /api/v1/auth/reset-session` endpoint.
- **DATA-002**: Fastify allows coordinates across Kerala instead of NITC corridor `[11.200000, 11.450000]`, `[75.800000, 76.100000]`.
- **DATA-003**: Fastify allows 6-hour-old packets; DB strictly enforces 15-minute maximum age.
- **DATA-004**: Schema rejects `epoch` and null metrics (`speed`, `heading`, `accuracy`).
- **DATA-005 & CONC-001**: In-memory `getLastState` check drops packets before calling DB, causing dirty-read races and losing `devices.last_seen` updates.
- **API-001**: `trips/:id/end` leaves `bus_current_state.trip_id` orphaned.
- **API-002**: `src/routes/buses.ts` calls obsolete `nearby_buses` and `nearest_stops`.

### Policy & Invariants Formulated
- **Zero-Legacy Policy**: Clean standardization on Bcrypt with 8 salt rounds (`bcryptjs`). No backward compatibility fallback needed since no production users or devices exist.
- **Secret Invariant**: Minimum 16 characters enforced across API schemas, database routines, and provisioning scripts.
- **Identifier Mapping**: `devices.id` is UUID primary key; `devices.device_id` is hardware text ID (e.g. `'NITC-BUS-001'`) used across JWT `sub`, ingestion RPC, `bus_positions`, and `bus_current_state`.
- **Initial Epoch & Monotonicity**: Devices begin at `current_epoch = 1`. Reboots call reset RPC with `session_id`, resetting state sequence to `0` and ensuring `seq = 1` is strictly accepted.

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
  - Replaced legacy `ingest_telemetry` RPC call with `ingest_telemetry_packet(...)` accepting 12 parameters (`p_device_id`, `p_seq`, `p_timestamp`, `p_latitude`, `p_longitude`, `p_speed`, `p_heading`, `p_accuracy`, `p_status`, `p_stop_radius_m`, `p_deviation_m`, `p_epoch`).
  - Removed `p_bus_id` parameter; the bus reference is resolved securely server-side inside PostgreSQL from `devices.bus_id`.
  - Replaced faulty `result.reason ?? 'device_inactive'` mapping with full result inspection:
    - Handled idempotent duplicates (`code === 'DUPLICATE_PACKET'`) -> HTTP 200 `{ ok: true, stored: false, reason: 'duplicate' }`.
    - Handled successful writes (`code === 'SUCCESS'`) -> HTTP 200 `{ ok: true, stored: true, state_updated: true }`.
    - Mapped authorization rejections (`UNAUTHORIZED_DEVICE`, `INACTIVE_BUS`) -> HTTP 401 Unauthorized.
    - Mapped sequence/epoch conflicts (`STALE_EPOCH_PACKET`, `UNAUTHORIZED_EPOCH`, `INVALID_SEQUENCE`, `SEQUENCE_REUSE_CONFLICT`, `OUT_OF_ORDER_PACKET`) -> HTTP 409 Conflict.
    - Mapped spatial/timestamp validation rejections (`COORDINATES_OUT_OF_BOUNDS`, `INVALID_SPEED`, `INVALID_HEADING`, `INVALID_ACCURACY`, `IMPLAUSIBLE_TIMESTAMP`) -> HTTP 422 Unprocessable Entity.
- **Related Finding**: `DB-001`, `DB-002`.
- **Tests Updated**:
  - `test/telemetry.route.test.ts` expanded with tests for duplicate packet handling (200), sequence reuse conflict (409), unauthorized device (401), and out of bounds coordinates (422).

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
  - Replaced Node.js native `scrypt` hashing in `src/lib/password.ts` with `bcryptjs` using 8 salt rounds (`BCRYPT_ROUNDS = 8`). This matches PostgreSQL `pgcrypto` `gen_salt('bf', 8)` binary output (`$2a$08$...` / `$2b$08$...`), eliminating the critical credential incompatibility (`SEC-001`).
  - Zero-legacy adherence: no dual-algorithm fallbacks or legacy hash migrations.
  - Invariant adherence: 16-character minimum secret length enforced across API schemas (`minLength: 16`), database functions, and `scripts/provision-device.ts` (generates 32-character base64url secrets).
  - Explicit initial epoch: `scripts/provision-device.ts` initializes `current_epoch: 1` explicitly upon upserting new devices.
- **Related Finding**: `SEC-001`, `SEC-002`.
- **Tests Updated**:
  - `test/core.test.ts`: Added assertion verifying that generated hashes start with `$2a$08$` or `$2b$08$` and compare successfully.
- **Verification Result**: `tsc -p tsconfig.json` exit 0, `vitest run` 23/23 tests passed.

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
    - Allows ESP32 trackers to negotiate a new session epoch upon reboot and reset their sequence counters.
    - Idempotent retries: passes `p_session_id` to PostgreSQL. If the response was dropped and the tracker retries with the same `session_id`, the RPC returns the existing epoch with `idempotent_retry: true` without incrementing again.
    - Resets `bus_current_state.seq` to 0, ensuring post-reboot `seq = 1` packets pass strict monotonicity checks.
  - Added optional `epoch` (minimum: 1) and nullable metrics support (`speed`, `heading`, `accuracy`) to `TelemetryBody` schema.
  - Added null-safety checks in `validateTelemetry` for optional numeric metrics.
  - Enforced 16-character minimum secret invariant across `ResetSessionBody` and `DeviceAuthBody`.
- **Related Finding**: `DATA-001`, `DATA-004`.
- **Tests Added**:
  - `test/reset_session.test.ts`: Added 5 unit tests covering valid reset (200), idempotent session retry (200), invalid credentials (401), short secret rejection (400), and missing parameter rejection (400).
- **Verification Result**: `tsc -p tsconfig.json` exit 0, `vitest run` 28/28 tests passed.

---

## Phase 4: Validation, Reliability, and Remaining APIs
- **Date**: 2026-10-14
- **Branch**: `fix/telemetry-supabase-compatibility`
- **Files Modified**:
  - `src/config.ts`
  - `src/app.ts`
  - `src/routes/telemetry.ts`
  - `src/routes/trips.ts`
  - `src/routes/buses.ts`
  - `test/core.test.ts`
- **What Changed & Why**:
  - Aligned geospatial bounding box in `src/config.ts` to the Kozhikode / NITC transit corridor (`[11.200000, 11.450000]` lat, `[75.800000, 76.100000]` lon), matching database constraints (`DATA-002`).
  - Aligned clock drift boundaries: max age set to 15 minutes (`900s`), future skew set to 1 minute (`60s`) (`DATA-003`).
  - Hardened reverse proxy trust: `trustProxy` configured with strict CIDR masks (`127.0.0.1,10.0.0.0/8,172.16.0.0/12,192.168.0.0/16`) to prevent client spoofing of `X-Forwarded-For` (`SEC-004`).
  - Removed unisolated in-memory duplicate packet drop in `src/routes/telemetry.ts`. Deduplication, sequence ordering, and epoch validation now execute authoritatively inside PostgreSQL's transaction-scoped advisory locks, ensuring `devices.last_seen` updates are never dropped (`DATA-005`, `CONC-001`).
  - Trip completion cleanup: in `/trips/:id/end`, atomically clear `bus_current_state.trip_id = null` when a trip ends to prevent idle buses from displaying stale trip references (`API-001`).
  - Spatial RPC alignment: updated `src/routes/buses.ts` to call canonical PostGIS functions `get_nearby_buses` and `get_nearby_stops` (`API-002`).
- **Related Finding**: `DATA-002`, `DATA-003`, `DATA-005`, `CONC-001`, `API-001`, `API-002`, `SEC-004`.
- **Tests Updated**:
  - `test/core.test.ts`: Added unit tests for 15-minute max packet age and updated accuracy bounds.
- **Verification Result**: `tsc -p tsconfig.json` exit 0, `vitest run` 29/29 tests passed.
