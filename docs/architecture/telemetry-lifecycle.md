# Telemetry Lifecycle & Ingestion Engine

## 1. End-to-End Lifecycle Trace

This document details the lifecycle of a single geographic coordinate fix as it travels from physical hardware on a campus shuttle to the student's mobile screen.

```mermaid
flowchart TD
    subgraph Step1 ["1. Hardware Acquisition (ESP32)"]
        S1_1["GNSS Satellite Fix ($GPRMC sentence)"] --> S1_2["Parse Lat, Lon, Speed (km/h), Heading, Accuracy"]
        S1_2 --> S1_3["Assign Monotonic Sequence Number: seq = seq + 1"]
        S1_3 --> S1_4["Construct JSON Payload with Active Epoch"]
    end

    subgraph Step2 ["2. Gateway Ingress (Fastify Server)"]
        S2_1["HTTPS POST /api/v1/telemetry with Bearer JWT"] --> S2_2{"JWT Valid & sub == device_id?"}
        S2_2 -- No --> S2_Err1["HTTP 401 Unauthorized"]
        S2_2 -- Yes --> S2_3{"Rate Limit (< 300/min)?"}
        S2_3 -- No --> S2_Err2["HTTP 429 Too Many Requests"]
        S2_3 -- Yes --> S2_4["TypeBox Schema Validation"]
        S2_4 --> S2_5{"Stateless Corridor Check<br/>(11.2 <= lat <= 11.45,<br/>75.8 <= lon <= 76.1)?"}
        S2_5 -- No --> S2_Err3["HTTP 422 Unprocessable Entity"]
        S2_5 -- Yes --> S2_6["Check devices.is_active in DB"]
    end

    subgraph Step3 ["3. Database Engine (PostgreSQL RPC)"]
        S3_1["SELECT ingest_telemetry_packet(...)"] --> S3_2["pg_advisory_xact_lock(1001, device_id)"]
        S3_2 --> S3_3["Resolve bus_id & Lock (1002, bus_id)"]
        S3_3 --> S3_4{"Epoch Matches device.current_epoch?"}
        S3_4 -- Stale / Future --> S3_Err4["HTTP 409 STALE_EPOCH / FUTURE_EPOCH"]
        S3_4 -- Match --> S3_5["SELECT bus_current_state FOR UPDATE"]
        S3_5 --> S3_6{"seq == current_state.seq?"}
        S3_6 -- Yes (Identical Payload) --> S3_Dup["Return HTTP 200 DUPLICATE_PACKET"]
        S3_6 -- Yes (Conflicting Payload) --> S3_Err5["Return HTTP 409 SEQUENCE_REUSE_CONFLICT"]
        S3_6 -- seq < current_state.seq --> S3_Err6["Return HTTP 409 STALE_SEQUENCE"]
        S3_6 -- seq > current_state.seq --> S3_7["INSERT INTO bus_positions (History)"]
        S3_7 --> S3_8["UPSERT INTO bus_current_state (Live)"]
        S3_8 --> S3_9["Evaluate Geofence Stop Events (ST_DWithin)"]
        S3_9 --> S3_10["Commit Transaction"]
    end

    subgraph Step4 ["4. Rider Presentation (Flutter App)"]
        S4_1["15-second Timer Triggers Poll"] --> S4_2["RPC get_active_bus_positions_v2()"]
        S4_2 --> S4_3["Fetch Active Trip Stop Events"]
        S4_3 --> S4_4["Project onto Route Polyline (RouteProgressProjector)"]
        S4_4 --> S4_5["Compute ETA (BusEtaResult.valid)"]
        S4_5 --> S4_6["Update Live Map Marker & Bus Card UI"]
    end

    Step1 --> Step2
    Step2 --> Step3
    Step3 --> Step4
```

---

## 2. Thresholds, Rules, and Geofencing Logic

All spatial, temporal, and kinematic thresholds are enforced with strict mathematical boundaries:

### 2.1 Spatial Boundaries (NITC Campus Corridor)
- **Bounding Box:**
  - Latitude: $[11.200000, 11.450000]\text{ N}$
  - Longitude: $[75.800000, 76.100000]\text{ E}$
- Telemetry outside this corridor is rejected immediately at the Fastify gateway before touching the database.

### 2.2 Kinematic & Velocity Thresholds
- **Speed Invariant:** $0.0 \le \text{speed} \le 120.0\text{ km/h}$.
- **Status Derivation:**
  - Speed $\le 2.0\text{ km/h} \implies \text{status} = \text{'stationary'}$.
  - Speed $> 2.0\text{ km/h} \implies \text{status} = \text{'moving'}$.
- **Accuracy Cap:** $\text{accuracy} \le 50.0\text{ meters}$.

### 2.3 Stop Geofencing & Event Generation
When a bus is assigned to an active trip, `ingest_telemetry_packet` evaluates spatial relationships against all stops on the active route:
1. **Arrival Geofence:**
   - Radius: **30 meters** (`ST_DWithin(location, stop.location, 30)`).
   - If the bus enters the 30m geofence and no recent arrival event exists for this stop on this trip:
     - Generates `bus_events` entry with `event_type = 'stop_arrival'`.
2. **Departure Hysteresis:**
   - Radius: **45 meters** (`ST_DWithin(location, stop.location, 45) = false`).
   - If the bus was previously arrived at the stop and moves beyond 45 meters:
     - Generates `bus_events` entry with `event_type = 'stop_departure'`.
   - The 15-meter buffer between arrival (30m) and departure (45m) prevents false departure triggers due to GPS jitter while the bus is dwelling.
3. **Route Corridor Deviation:**
   - Radius: **100 meters** from `routes.path`.
   - If `ST_Distance(location::geometry, routes.path) > 100`:
     - Generates `bus_events` entry with `event_type = 'route_deviation'`.

---

## 3. Timestamp Semantics & Staleness Matrix

Telemetry tracks four distinct temporal markers:

| Timestamp Attribute | Origin / Meaning | Used For |
|---|---|---|
| `recorded_at` / `timestamp` | Device GNSS clock (UTC) | Spatial sequencing, kinematic physics, historical ordering. |
| `created_at` | PostgreSQL `now()` at insert | Ingestion audit logging, pipeline latency monitoring. |
| `last_seen_at` | PostgreSQL `now()` on device record | Hardware health tracking, offline device detection. |
| `last_updated` | PostgreSQL `now()` on current state | Client-side staleness detection and polling staleness flags. |

### Client-Side Staleness Rules
In the Flutter mobile client (`Bus.fromJson` and `BusPosition.fromJson`):
- A bus position is marked **fresh** if `now() - recorded_at < 60 seconds`.
- A bus position is marked **stale (`isStale = true`)** if `now() - recorded_at >= 60 seconds`.
- Stale buses render with muted/amber badges in the UI and their arrival ETA displays as `"Unavailable"`.
- Positions older than **24 hours** are completely filtered out of `get_active_bus_positions_v2()`.
