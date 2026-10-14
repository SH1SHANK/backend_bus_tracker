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
| **Hardening** | *(pending)* | `fix: enforce mandatory epoch/session_id and dynamic device revocation` | Made `epoch` and `session_id` strictly required, added dynamic `is_active` check in auth plugin, 38/38 tests passing. |

---

## Verification & Test Results

### Automated Unit and Route Test Suite (`npm test`)
*Note: The following 38 tests verify application logic, validation schemas, and route error mapping using isolated mocks.*
```
✓ test/core.test.ts (14 tests)
✓ test/reset_session.test.ts (6 tests)
✓ test/telemetry.route.test.ts (13 tests)
✓ test/auth.route.test.ts (5 tests)

Test Files  4 passed (4)
Tests       38 passed (38)
Duration    556ms
```

### TypeScript Compilation Check (`npm run typecheck`)
```
> bus-telemetry-api@1.0.0 typecheck
> tsc -p tsconfig.json

Exit code: 0 (Zero compiler errors)
```

### Production Build (`npm run build`)
```
> bus-telemetry-api@1.0.0 build
> tsc -p tsconfig.build.json

Exit code: 0 (Clean output to dist/)
```

### Live PostgreSQL Catalog Verification
Verified directly on project `fnngudikrvelpuhngtlw` via read-only SQL queries to `pg_proc` and `information_schema.columns`.

---

## Reviewer Checklist
- [x] Verified exact PostgreSQL types from live `pg_proc` (`p_device_id text`, `p_epoch bigint DEFAULT NULL`, `stop_radius 50.0`, `deviation 500.0`).
- [x] Zero legacy fallbacks or dual-algorithm checks introduced.
- [x] 16-character minimum secret length enforced across API schemas and scripts.
- [x] `session_id` mandatory for reboot resets to guarantee idempotency.
- [x] `epoch` mandatory for telemetry packets under zero-legacy rules.
- [x] Deactivated devices rejected even with valid 12-hour JWT.
- [x] Production build and test suite pass with zero errors.
- [x] No production mutations, DDL, or data changes executed.
