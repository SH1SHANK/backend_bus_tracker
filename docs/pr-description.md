# PR Description: Supabase Transport Backend Compatibility & Telemetry Hardening

## Problem & Motivation
The Fastify telemetry ingestion API gateway (`backend_bus_tracker`) diverged from the canonical Supabase transport backend deployed in `NITC_BUS_TRACKING_APP` (migration `20261014040200_complete_transport_backend_foundation.sql`). Specifically:
1. Ingestion failed immediately due to an obsolete RPC name (`ingest_telemetry` vs `ingest_telemetry_packet`), mismatched parameter names (`p_recorded_at` vs `p_timestamp`), extra deprecated parameters (`p_bus_id`), and dropped uniqueness constraints.
2. Device authentication failed because Node.js hashed credentials using `scrypt`, while PostgreSQL functions (`register_tracking_device` and `reset_device_sequence`) expected `pgcrypto` Bcrypt (`$2a$08$`).
3. Hardware tracker reboots caused permanent sequence rejection due to missing session epoch support and lack of a sequence reset endpoint.
4. Pre-ingestion duplicate dropping in Fastify memory caused race conditions and bypassed PostgreSQL transaction-scoped advisory locks (`1001` device, `1002` bus).

## Target Architecture
```
ESP32 Tracker (boot session_id)
  │
  ├── 1. POST /api/v1/auth/reset-session { device_id, secret, session_id }
  │       └── Calls reset_device_sequence() RPC -> advances epoch, resets seq=0
  │
  ├── 2. POST /api/v1/auth/device { device_id, secret }
  │       └── Verifies Bcrypt hash -> signs JWT { sub: device_id, bus_id }
  │
  └── 3. POST /api/v1/telemetry (Bearer JWT)
          └── Validates bounds & passes to ingest_telemetry_packet()
                ├── Advisory locks (1001, 1002)
                ├── Atomic writes: bus_positions, bus_current_state, devices.last_seen
                └── Emits Supabase Realtime update -> Flutter app
```

## Summary of Changes by Phase
- **Phase 0 — Baseline & Contract Verification**:
  - Validated database contracts, identifier mapping (`devices.id` UUID vs `devices.device_id` string), initial epoch (1), and idempotent reset-retry protocol.
- **Phase 1 — Telemetry RPC Compatibility**:
  - Migrated `src/repositories/telemetry.repo.ts` to `ingest_telemetry_packet`.
  - Mapped return codes (`SUCCESS`, `DUPLICATE_PACKET`, `UNAUTHORIZED_DEVICE`, `STALE_EPOCH_PACKET`, `COORDINATES_OUT_OF_BOUNDS`, etc.) to HTTP 200, 401, 409, 422.
- **Phase 2 — Device Authentication & Provisioning**:
  - Adopted pure-JS `bcryptjs` with 8 salt rounds matching PostgreSQL `pgcrypto`.
  - Enforced 16-character minimum secret length across API and provisioning script.
- **Phase 3 — Epoch & Sequence Handling**:
  - Added `POST /api/v1/auth/reset-session` route and schema.
  - Added optional `epoch` and nullable metrics support to telemetry schema.
- **Phase 4 — Validation, Reliability & API Contracts**:
  - Aligned geospatial bounds to NITC corridor (`[11.200000, 11.450000]`, `[75.800000, 76.100000]`).
  - Aligned clock drift to 15-minute maximum past age and 1-minute future skew.
  - Removed unisolated in-memory duplicate drop in `src/services/anomaly.ts`.
  - Cleared `bus_current_state.trip_id` on trip completion in `src/routes/trips.ts`.
  - Updated spatial queries to canonical `get_nearby_buses` and `get_nearby_stops`.
- **Phase 5 — Integration Testing**:
  - Comprehensive unit and route test coverage across normal ingestion, duplicates, reboot sequence resets, conflicts, and validation rejections.
- **Phase 6 — Final Review**:
  - Verified git cleanliness, zero secrets exposed, and automated typecheck passing.

## Important Implementation Decisions
1. **Zero-Legacy Policy**: Since there are no existing production users, devices, or telemetry rows, no fallback or dual-algorithm compatibility is included. All credentials use Bcrypt with 8 salt rounds.
2. **16-Character Secret Invariant**: Consistently enforced at `>= 16` characters across all schemas and scripts.
3. **Stateless Gateway**: Ingestion sequence and deduplication are handled authoritatively by PostgreSQL RPCs protected by transaction-scoped advisory locks.

## Reviewer Checklist
- [ ] No plaintext secrets or API keys committed.
- [ ] Working tree clean on branch `fix/telemetry-supabase-compatibility`.
- [ ] Typecheck passes: `npm run typecheck`.
- [ ] Tests pass: `npm test`.
- [ ] Verified contract compatibility with Supabase migration `20261014040200`.
