# Backend Telemetry Integration Rules (Strict Implementation Constraints)

## Zero-Legacy & No Backward Compatibility Policy
- **No Existing Users, Devices, or Telemetry Data**: There are no existing production users, telemetry data, or provisioned devices.
- **Strict Prohibition on Unnecessary Fallbacks & Legacy Support**:
  - Do NOT implement backward compatibility, dual-algorithm checks, or legacy credential migration (e.g. no `scrypt` fallback).
  - Standardize cleanly and exclusively on **Bcrypt with 8 salt rounds** (`bcryptjs` in Node.js, `pgcrypto` `gen_salt('bf', 8)` in PostgreSQL).
  - Update the provisioning flow cleanly to use Bcrypt with 8 rounds.
  - Do NOT add obsolete RPC fallbacks or dual-table writing paths.

## Secret Invariant
- **16-Character Minimum Secret Length**: Consistently enforce a 16-character minimum secret length across the API (`minLength: 16`), database functions (`register_tracking_device` and `reset_device_sequence`), and provisioning scripts.

## Device Identifier & Architecture Mapping
- `devices.id` is the internal primary key UUID.
- `devices.device_id` is the hardware tracker text ID (e.g., `'NITC-BUS-001'`).
- Fastify JWT `sub` stores `devices.device_id` (text).
- `ingest_telemetry_packet(p_device_id text)` takes the text ID, resolves internal UUID for updates, and stores the text ID in `bus_positions.device_id` and `bus_current_state.device_id`.
- `devices.bus_id` stores `buses.id` (UUID).

## Initial Epoch and Reset-Retry Behaviour
- **Initial Epoch**: New devices start at `current_epoch = 1` (epoch 0 is reserved for unassigned/system records). Fresh trackers emit packets with `epoch = 1`.
- **Reboot Session Reset**: Trackers invoke `POST /api/v1/auth/reset-session` on boot with `{ device_id, secret, session_id, reason }`.
- **Idempotent Retry**: If an HTTP response is lost, retry with the same `session_id` returns the established epoch with `idempotent_retry: true` without incrementing again.
- **Sequence Reset**: `bus_current_state.seq` resets to `0`, allowing post-reboot `seq = 1` packets to pass strictly monotonically.

## Phased Execution & Safety
- **Read-Only Phase 0**: Keep Phase 0 strictly read-only until the plan and contracts are verified.
- **New Branch Execution**: Implement changes phase by phase exclusively on branch `fix/telemetry-supabase-compatibility`.
- **Continuous Documentation**: Maintain `docs/telemetry-integration-changelog.md` and `docs/pr-description.md` at every phase.
- **Verification Gates**: Execute automated typecheck and tests before committing each phase.
