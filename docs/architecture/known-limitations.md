# Known Limitations, Defects, & Technical Debt

This document records confirmed discrepancies, verified software defects, security drifts, and architectural technical debt discovered during the technical audit of October 15, 2026.

---

## 1. High-Priority Defects (P0)

### 1.1 Fastify Non-Transactional Trip Lifecycle
- **Affected File:** `backend_bus_tracker/src/routes/trips.ts` (lines 15–77)
- **Defect Description:**
  Endpoints `POST /api/v1/trips/start` and `POST /api/v1/trips/:id/end` execute multiple sequential, non-transactional HTTP requests to Supabase PostgREST:
  ```typescript
  // Trips start:
  const { data: trip } = await supabase.from('trips').insert(...).select().single();
  await Promise.all([
    supabase.from('bus_events').insert(...),
    supabase.from('bus_current_state').update({ trip_id: trip.id }).eq('bus_id', busId)
  ]);
  ```
- **Failure Impact:** If the Fastify process crashes, is terminated by Render, or experiences a network timeout after inserting the trip but before updating current state and recording the event:
  - An orphaned active trip remains in `trips`.
  - The partial unique index `trips_one_active_per_bus` blocks subsequent trip starts for the bus.
  - Live bus tracking desynchronizes because `bus_current_state.trip_id` was never set.
- **Recommended Remedy:** Implement atomic database RPCs `public.start_bus_trip(p_bus_id, p_route_id)` and `public.end_bus_trip(p_trip_id)` and invoke them from Fastify.

---

### 1.2 Device Secret Length Invariant Drift
- **Affected Objects:** `register_tracking_device` and `reset_device_sequence` in `fnngudikrvelpuhngtlw`
- **Defect Description:**
  Fastify's TypeBox schema strictly enforces `minLength: 16` for tracker secrets. However:
  - `register_tracking_device` in PostgreSQL only checks `IF length(p_secret) < 8 THEN ...`.
  - `reset_device_sequence` does not validate secret length at all.
- **Failure Impact:** A tracker could be provisioned via SQL with an 8-character secret that is subsequently rejected by Fastify gateway schemas.
- **Recommended Remedy:** Align both database functions to enforce `IF length(p_secret) < 16 THEN ...`.

---

## 2. Operational & Protocol Limitations (P1)

### 2.1 Realtime CDC Notifications Blocked by Revoked SELECT
- **Affected File:** `NITC_BUS_TRACKING_APP/lib/data/transit/transit_repository.dart` (lines 250–265)
- **Defect Description:**
  In migration `20261014050000_rider_telemetry_projection_access.sql`, table-level `SELECT` on `bus_current_state` was revoked from `anon` and `authenticated` to force clients to use `get_active_bus_positions_v2()`. Supabase Realtime CDC evaluates table `SELECT` permissions before broadcasting WAL changes. Consequently, rider Realtime WebSocket subscriptions receive zero events.
- **Mitigation Implemented:** The Flutter client's 15-second polling timer (`pollTimer`) acts as the fallback, refreshing positions reliably.
- **Target Resolution:** If sub-second push updates are desired, implement a dedicated Realtime Broadcast trigger.

---

## 3. Database Cleanliness & Legacy Debt (P2)

### 3.1 Duplicate Partial Unique Index on `trips`
- **Affected Database Table:** `public.trips`
- **Issue:** The live production database contains two identical partial unique indexes on `(bus_id) WHERE status = 'active'`:
  1. `trips_one_active_per_bus`
  2. `trips_single_active_per_bus`
- **Impact:** Doubles index write maintenance overhead during trip start/completion.
- **Remedy:** Execute `DROP INDEX public.trips_single_active_per_bus;`.

### 3.2 False Geometry Verification Flag on Fallback
- **Affected Function:** `public.get_route_geometry(p_route_id uuid)`
- **Issue:** When `routes.path` is NULL, the function synthesizes a straight line through the ordered stops from `route_stops`. However, it retains `is_verified = true` and `path_source = 'manual'` from `routes`, falsely claiming that a synthetic straight line is verified road geometry.
- **Remedy:** In the fallback branch, return `is_verified = false` and `path_source = 'synthesized_stops'`.

### 3.3 Broken and Insecure Legacy RPCs in Production
The following functions reside in production but are dead, broken, or insecure:
- `ingest_telemetry`: Throws a Postgres runtime error because it references a dropped `(bus_id, recorded_at)` unique constraint.
- `nearby_buses` & `nearest_stops`: Obsolete functions that lack `pg_temp` in their search path and were never revoked from `anon`.
- `get_route_geometry_legacy`: Reads from the orphaned, unused table `route_geometries`.
- **Remedy:** Drop these four functions in migration `20261015060000`.

### 3.4 Untracked Migration in Production
- **Affected File:** `NITC_BUS_TRACKING_APP/supabase/migrations/20261015050000_fix_auth_users_trigger_and_profile_sync.sql`
- **Issue:** This migration file exists in the local workspace as an untracked file, yet its DDL is already applied to the production database `fnngudikrvelpuhngtlw`.
- **Remedy:** Commit this migration file to `main` to align Git history with deployed reality.
