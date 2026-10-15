# AI Agent Reference & Operating Guide

> [!IMPORTANT]
> **READ THIS BEFORE MAKING CODE OR DATABASE CHANGES**  
> This guide provides strict invariants, authority rules, and verification checklists for AI coding agents (and human engineers) working on Tracklet. Always follow these rules to maintain system integrity.

---

## 1. Authoritative Sources of Truth

| Subsystem | Authoritative Source | Disallowed Assumptions |
|---|---|---|
| **Backend Telemetry API** | `backend_bus_tracker` on branch `stable` | Do NOT use `development` or feature branches as production authority. |
| **Mobile & Web Client** | `NITC_BUS_TRACKING_APP` on branch `main` | Do NOT fabricate network calls to Fastify; Flutter queries Supabase directly. |
| **Database Schema & RPCs**| `NITC_BUS_TRACKING_APP/supabase/migrations/` and live project `fnngudikrvelpuhngtlw` | Do NOT rely on abandoned migrations in `backend_bus_tracker`. |
| **System Architecture** | `docs/architecture/` | Do NOT invent parallel APIs, Edge Functions, or redundant RPCs. |

---

## 2. Universal System Invariants (Must Never Be Broken)

1. **Strict Client-Backend Bifurcation:**
   - Physical ESP32 trackers communicate **only** with Fastify.
   - Flutter mobile apps communicate **only** with Supabase.
   - Fastify connects to Supabase using the privileged `service_role` key.
   - Mobile apps connect to Supabase using the public `anon` key or authenticated user tokens.
2. **Canonical Single Ingestion Path:**
   - All telemetry ingestion must flow exclusively through `public.ingest_telemetry_packet(...)`.
   - Never introduce secondary ingestion RPCs, direct table inserts from clients, or dual-table writing paths.
3. **Secret Invariant (16-Character Minimum):**
   - Device secrets must always be $\ge 16$ characters across Fastify schemas (`minLength: 16`), database functions (`register_tracking_device`, `reset_device_sequence`), and provisioning scripts.
4. **Bcrypt 8-Round Standard:**
   - Hardware credentials must use exclusively **Bcrypt with 8 salt rounds** (`bcryptjs` in Node.js, `extensions.gen_salt('bf', 8)` in PostgreSQL).
   - Zero-legacy policy: Do NOT introduce fallback algorithms (e.g. scrypt, plain MD5/SHA).
5. **Client-Side ETA & Progress Engine:**
   - Route progress projection, out-of-route detection, and arrival ETA calculations belong in Flutter (`bus_eta.dart`).
   - Do NOT attempt to move ETA calculations into PostgreSQL RPCs.
6. **Stateless Gateway / Transactional Database:**
   - Fastify must not maintain persistent in-memory session state across requests.
   - Multi-step mutating operations must be wrapped in atomic PostgreSQL transactions/RPCs.

---

## 3. Checklist for Modifying Subsystems

### When Modifying Fastify Backend (`backend_bus_tracker`):
- [ ] Inspect existing schemas in `src/schemas/` before editing route handlers.
- [ ] Verify that request schemas have `additionalProperties: false`.
- [ ] Ensure any newly added endpoints have rate-limiting and authentication middleware.
- [ ] Ensure secrets or credentials are never included in log outputs or response bodies.
- [ ] Run automated tests: `npm test` (all Vitest suites must pass).

### When Modifying PostgreSQL Schema or RPCs (`supabase/migrations/`):
- [ ] Check if the table or function already exists in `docs/architecture/database-schema.md` or `database-functions.md`.
- [ ] Always set `SECURITY DEFINER` functions with:
  ```sql
  SET search_path = public, pg_temp; -- or pg_catalog, public, pg_temp
  ```
- [ ] Revoke default public execution: `REVOKE ALL ON FUNCTION ... FROM PUBLIC;`.
- [ ] Explicitly grant execution to the minimum necessary role (`service_role` for ingestion/admin; `anon`/`authenticated` for rider projections).
- [ ] Use UTC timestamps (`timestamptz`) for all temporal records.
- [ ] Make all DDL migrations strictly backward-compatible.

### When Modifying Flutter Client (`NITC_BUS_TRACKING_APP`):
- [ ] Run architectural boundary check: `dart run tool/verify_architecture.dart`.
- [ ] Verify that no `dart:io` imports exist in application code (`lib/` must remain Web-compatible).
- [ ] Ensure UI widgets consume data through Riverpod providers, not direct repository or SDK calls.
- [ ] Run transit unit tests: `flutter test` (all 21 transit tests must pass).
- [ ] If modifying transit models, verify that nullability and field mappings agree with `docs/architecture/flutter-models.md`.

---

## 4. Prohibited Actions for AI Agents

- ❌ **Do NOT invent database columns or tables** without inspecting the remote schema or migration files.
- ❌ **Do NOT expose `service_role` credentials** to mobile clients or commit them into git repositories.
- ❌ **Do NOT write mock transit data** (fake buses, fabricated GPS coordinates) into production tables.
- ❌ **Do NOT add Edge Functions or redundant REST endpoints** when existing Supabase PostgREST or RPC endpoints already fulfill the requirement.
- ❌ **Do NOT modify production directly** during read-only audits or design tasks.
