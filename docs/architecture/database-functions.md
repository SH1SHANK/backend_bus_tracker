# Database Functions & Stored Procedures (RPCs)

## 1. Overview and Security Principles

All transactional transit logic, sequence locking, and privileged telemetry operations are executed directly inside PostgreSQL via stored functions (PL/pgSQL and SQL).

### Security & Privilege Guidelines
- **`SECURITY DEFINER` Usage:** Functions that modify internal tables (`devices`, `bus_current_state`, `bus_positions`) or project data across restricted boundaries run with the privileges of their owner (`postgres`), bypassing caller table permissions.
- **Search-Path Hardening:** All `SECURITY DEFINER` functions explicitly configure `SET search_path = public, pg_temp` (or `pg_catalog, public, pg_temp`) to prevent search-path hijacking attacks.
- **Role Isolation:** Privileged ingestion and provisioning functions are granted **exclusively to `service_role`**. Public execution is strictly revoked (`REVOKE ALL ON FUNCTION ... FROM PUBLIC`).

---

## 2. Telemetry Ingestion & Device Lifecycle RPCs (Currently Deployed)

### 2.1 `public.ingest_telemetry_packet(...)` [DEPLOYED / CANONICAL]
The single canonical telemetry ingestion engine. Invoked by Fastify on `POST /api/v1/telemetry`.

```sql
FUNCTION public.ingest_telemetry_packet(
  p_device_id text,
  p_seq integer,
  p_epoch integer,
  p_recorded_at timestamptz,
  p_latitude double precision,
  p_longitude double precision,
  p_speed numeric,
  p_heading numeric,
  p_accuracy numeric
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, extensions, pg_temp;
```

#### Operational Workflow & Order of Operations
1. **Advisory Locks:** Acquires a transaction-scoped advisory lock on `hashtext(p_device_id)` (Namespace 1001) to serialize packet execution for the physical device.
2. **Device Validation:** Queries `devices` where `device_id = p_device_id`. Verifies device exists and `is_active = true`. Resolves associated `bus_id`.
3. **Bus Advisory Lock:** Acquires second transaction-scoped advisory lock on `hashtext(bus_id::text)` (Namespace 1002) to serialize against concurrent trip start/end operations.
4. **Epoch Validation:** Rejects packet with `STALE_EPOCH` if `p_epoch < device.current_epoch`, or `FUTURE_EPOCH` if `p_epoch > device.current_epoch`.
5. **Bus State Row Lock:** Selects `bus_current_state` with `FOR UPDATE`.
6. **Sequence & Duplicate Verification:**
   - If `p_seq = current_state.seq` and `p_epoch = current_state.epoch`: Compares coordinates, speed, heading, accuracy, and timestamp. If matching, returns `{ ok: true, code: 'DUPLICATE_PACKET', stored: false }`. If differing, returns `{ ok: false, code: 'SEQUENCE_REUSE_CONFLICT' }`.
   - If `p_seq < current_state.seq` within the same epoch: Returns `{ ok: false, code: 'STALE_SEQUENCE' }`.
7. **Persistence:**
   - Inserts record into `bus_positions`.
   - Upserts `bus_current_state` with new fix, updating `seq = p_seq`, `epoch = p_epoch`, `status = (p_speed > 2.0 ? 'moving' : 'stationary')`.
   - Updates `devices.last_seen_at = now()`.
8. **Spatial Geofencing & Event Generation:**
   - Identifies active `trip_id` and associated route stops.
   - Evaluates whether the bus is within stop radius ($30\text{ meters}$) to record `stop_arrival`.
   - Evaluates whether the bus moved outside departure hysteresis ($45\text{ meters}$) to record `stop_departure`.
   - Evaluates route corridor distance ($100\text{ meters}$) to record `route_deviation`.
9. **Return Payload:** Returns JSONB confirming storage and count of generated events.

- **Grants:** `REVOKE ALL FROM PUBLIC; GRANT EXECUTE TO service_role;`.

---

### 2.2 `public.reset_device_sequence(...)` [DEPLOYED]
Invoked on tracker cold boot by Fastify `POST /api/v1/auth/reset-session`.

```sql
FUNCTION public.reset_device_sequence(
  p_device_id text,
  p_secret text,
  p_session_id text DEFAULT NULL
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, extensions, pg_temp;
```

#### Workflow & Current Production Behavior
1. Serializes on device advisory lock (1001).
2. Locks device row `FOR UPDATE`. Checks `is_active = true`.
3. **Idempotency Check:** If `p_session_id` matches `devices.last_session_id`, immediately returns `{ ok: true, code: 'SUCCESS', epoch: current_epoch, idempotent_retry: true }`.
4. **Credential Verification:** Normalizes Bcrypt prefix `$2b$` to `$2a$` and verifies `crypt(p_secret, secret_hash) == secret_hash`.
   - *Current Limitation:* In the live database, this function does **not** check secret minimum length. Fastify enforces $\ge 16$ chars on the gateway.
5. Serializes on bus advisory lock (1002).
6. Advances `current_epoch = current_epoch + 1` and updates `last_session_id = p_session_id`.
7. Resets `bus_current_state.seq = 0` and sets `bus_current_state.epoch = new_epoch`.
8. Returns JSONB with negotiated epoch.
- **Grants:** `REVOKE ALL FROM PUBLIC; GRANT EXECUTE TO service_role;`.

---

### 2.3 `public.register_tracking_device(...)` [DEPLOYED]
Administrative device provisioning function.

```sql
FUNCTION public.register_tracking_device(
  p_device_id text,
  p_bus_id uuid,
  p_secret text
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, extensions, pg_temp;
```
- Hashes `p_secret` using `crypt(p_secret, gen_salt('bf', 8))`.
- *Current Limitation:* Live database currently checks `IF length(p_secret) < 8 THEN ... WEAK_SECRET`. This differs from Fastify's $\ge 16$ character requirement.
- Inserts or updates `devices` table, binding the tracker to `p_bus_id` with initial `current_epoch = 1`.
- **Grants:** `REVOKE ALL FROM PUBLIC; GRANT EXECUTE TO service_role;`.

---

## 3. Rider Read & Presentation RPCs (Currently Deployed)

### 3.1 `public.get_active_bus_positions_v2()` [DEPLOYED / CANONICAL]
The primary read RPC consumed by the Flutter mobile client. Returns the canonical live projection of all active campus buses.

```sql
FUNCTION public.get_active_bus_positions_v2()
RETURNS TABLE (
  bus_id uuid,
  bus_number text,
  display_name text,
  is_active boolean,
  device_id text,
  active_trip_id uuid,
  route_id uuid,
  latitude double precision,
  longitude double precision,
  speed numeric,
  heading numeric,
  accuracy numeric,
  status text,
  recorded_at timestamptz,
  last_updated timestamptz,
  epoch integer,
  seq integer
)
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = pg_catalog, public, pg_temp;
```
- Joins `buses` with `bus_current_state` and active `trips`.
- Filters: `buses.is_active = true` and `bus_current_state.recorded_at > now() - interval '24 hours'`.
- **Grants:** `GRANT EXECUTE TO anon, authenticated, service_role;`.

---

### 3.2 `public.get_active_trip_stop_events(p_trip_id uuid)` [DEPLOYED]
Returns the chronological journal of arrived and departed stops for an active trip.

```sql
FUNCTION public.get_active_trip_stop_events(p_trip_id uuid)
RETURNS TABLE (
  event_id uuid,
  trip_id uuid,
  bus_id uuid,
  stop_id uuid,
  stop_code text,
  stop_name text,
  event_type text,
  occurred_at timestamptz
)
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = pg_catalog, public, pg_temp;
```
- Consumed by Flutter's `SupabaseTransitRepository._fetchBusStopEvents` to resolve route progress indicators.
- **Grants:** `GRANT EXECUTE TO anon, authenticated, service_role;`.

---

### 3.3 `public.get_route_geometry(p_route_id uuid)` [DEPLOYED]
Fetches the GeoJSON / coordinate polyline for a specified transit route.

```sql
FUNCTION public.get_route_geometry(p_route_id uuid)
RETURNS TABLE (
  route_id uuid,
  path_source text,
  is_verified boolean,
  coordinates jsonb
)
LANGUAGE plpgsql
STABLE
SECURITY INVOKER
SET search_path = public, extensions, pg_temp;
```
- Reads `routes.path`. If NULL, falls back to synthesizing a straight line through the ordered stops from `route_stops`.
- *Current Limitation:* In the fallback branch, `is_verified` is returned as `true` instead of `false`.
- **Grants:** `GRANT EXECUTE TO anon, authenticated, service_role;`.

---

## 4. Discovery & Spatial Lookup RPCs (Currently Deployed)

- `public.get_nearby_buses(p_lat, p_lon, p_radius_meters)`: PostGIS `ST_DWithin` lookup returning buses within radius. (Used by Fastify `/api/v1/buses/nearby`).
- `public.get_nearby_stops(p_lat, p_lon, p_radius_meters, p_limit)`: PostGIS `ST_DWithin` lookup returning stops ordered by distance. (Used by Fastify `/api/v1/stops/nearest`).
- `public.get_campus_buildings_nearby(p_lat, p_lon, p_radius_meters)`: Spatial query for campus POIs and structures.

---

## 5. User Profile & Onboarding RPCs (Currently Deployed)

- `public.ensure_my_profile()`: Creates student profile row upon initial Supabase Auth signup.
- `public.get_my_profile()`: Reads authenticated user profile.
- `public.update_my_profile(...)`: Updates display name, branch, batch, hostel, and preferences.
- `public.complete_onboarding(...)`: Sets onboarding completion flag.
- `public.get_departments()` / `public.get_hostels()`: Reference data readers.

---

## 6. Deprecated & Legacy RPCs (Currently Deployed — Scheduled for Removal)

The following functions exist in the live production database but represent obsolete, broken, or insecure legacy code:

| Function Signature | Reason for Deprecation |
|---|---|
| `public.ingest_telemetry(...)` | Broken. References dropped `(bus_id, recorded_at)` unique constraint. Superseded by `ingest_telemetry_packet`. |
| `public.nearby_buses(...)` | Insecure & legacy. Lacks `pg_temp` in search path; superseded by `get_nearby_buses`. |
| `public.nearest_stops(...)` | Insecure & legacy. Lacks `pg_temp` in search path; superseded by `get_nearby_stops`. |
| `public.get_route_geometry_legacy(...)` | Obsolete. Reads orphaned table `route_geometries`; superseded by `get_route_geometry`. |

---

## 7. Proposed RPCs (Under Review — NOT YET IMPLEMENTED IN PRODUCTION)

> [!WARNING]
> **Implementation Status: Proposed Specification Only**  
> The functions below have been audited, designed, and specified to resolve confirmed production defects, but have **NOT YET been deployed** to `fnngudikrvelpuhngtlw`. Production currently relies on non-transactional HTTP calls in Fastify `src/routes/trips.ts`.

### 7.1 Proposed: `public.start_bus_trip(p_bus_id uuid, p_route_id uuid)`
- **Target Responsibility:** Atomic trip creation, bus event generation, and live state association.
- **Proposed Signature:**
  ```sql
  CREATE OR REPLACE FUNCTION public.start_bus_trip(
    p_bus_id uuid,
    p_route_id uuid
  )
  RETURNS jsonb
  LANGUAGE plpgsql
  SECURITY DEFINER
  SET search_path = public, pg_temp;
  ```
- **Execution Grant:** Restricted to `service_role`.

### 7.2 Proposed: `public.end_bus_trip(p_trip_id uuid)`
- **Target Responsibility:** Atomic trip completion, termination event journal, and live state unlinking.
- **Proposed Signature:**
  ```sql
  CREATE OR REPLACE FUNCTION public.end_bus_trip(
    p_trip_id uuid
  )
  RETURNS jsonb
  LANGUAGE plpgsql
  SECURITY DEFINER
  SET search_path = public, pg_temp;
  ```
- **Execution Grant:** Restricted to `service_role`.

### 7.3 Proposed: Secret Length Hardening Patch
- **Target Responsibility:** Modify `register_tracking_device` and `reset_device_sequence` to enforce `IF length(p_secret) < 16 THEN ...`, matching Fastify gateway validation.
