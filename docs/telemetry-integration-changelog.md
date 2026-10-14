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
