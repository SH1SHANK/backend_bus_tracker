# Canonical Transit Data Dictionary

## 1. Domain Entities & Glossary

| Entity Name | Database Table | Flutter Class | Definition / Scope |
|---|---|---|---|
| **Bus** | `buses` | `Bus` | A physical motorized shuttle vehicle operating within the NITC campus transit fleet. Identified by UUID (`id`) and vehicle number (`bus_number`). |
| **Tracking Device** | `devices` | *(Implicit in telemetry)* | The physical electronic tracker (ESP32) mounted inside the vehicle. Identified by hardware string `device_id` (e.g. `'NITC-BUS-001'`). |
| **Route** | `routes` | `BusRoute` | A designated transit path connecting campus locations. Identified by UUID and short code (e.g. `'CIRCULAR_1'`). Contains spatial geometry. |
| **Stop** | `stops` | `Stop` | A physical boarding point or shelter on campus. Possesses a WGS 84 geographic coordinate point. |
| **Route Stop** | `route_stops` | `RouteStopOccurrence` | The ordered association between a Route and a Stop, including sequence order, cumulative distance, and estimated duration. |
| **Trip** | `trips` | `tripId` | A single operational run of a Bus along a specific Route from start to finish. |
| **Bus Position** | `bus_positions` | `BusPosition` | An append-only historical record of a single GPS fix emitted by a tracker. |
| **Current State** | `bus_current_state` | `Bus.position` | The single canonical, latest-accepted geographic fix and operational status for an active bus. |
| **Transit Event** | `bus_events` | `BusStopEvent` | A discrete temporal transit event: trip start, trip completion, stop arrival, stop departure, or route corridor deviation. |
| **Scheduled Departure**| `bus_timings` | `ScheduledDeparture` | Static timetable departure entry defining scheduled bus trips. |

---

## 2. Universal Status Enums & Values

### 2.1 Bus Operational Status
- **Database (`bus_current_state.status`):**
  - `'stationary'`: Speed $\le 2.0\text{ km/h}$.
  - `'moving'`: Speed $> 2.0\text{ km/h}$.
- **Flutter Client (`BusStatus`):**
  - `live`: Bus actively moving or transmitting fresh telemetry within 60 seconds.
  - `delayed`: Bus experiencing significant schedule delay or stationary off-stop.
  - `due`: Bus dwelling at a stop or scheduled to arrive momentarily.
  - `offline`: No telemetry received for $> 60\text{ seconds}$ or bus disabled.

### 2.2 Trip Lifecycle Status (`trips.status`)
- `'scheduled'`: Trip created in dispatch but vehicle has not departed.
- `'active'`: Bus is currently traversing the route. (Enforced by partial unique index: at most one active trip per bus).
- `'completed'`: Bus reached terminus or driver ended trip.
- `'cancelled'`: Trip aborted due to mechanical or scheduling issues.

### 2.3 Transit Event Types (`bus_events.event_type`)
- `'trip_started'`: Driver or staff initiated route run.
- `'trip_ended'`: Trip formally concluded.
- `'stop_arrival'`: Bus entered within 30 meters of a route stop.
- `'stop_departure'`: Bus moved beyond 45 meters from a route stop.
- `'route_deviation'`: Bus moved beyond 100 meters from route polyline.
- `'status_changed'`: Administrative toggle or operational state shift.

### 2.4 Route Directions (`routes.direction`)
- `'loop'`: Continuous circular route returning to origin stop.
- `'forward'`: Standard linear route from first stop to last stop.
- `'reverse'`: Return linear route from last stop to first stop.

---

## 3. Coordinate Systems, Units, & Conventions

| Property | Standard Unit | Reference Frame / Format | Validation Bounds |
|---|---|---|---|
| **Latitude** | Decimal degrees | WGS 84 (`EPSG:4326`) | $11.200000 \le \text{lat} \le 11.450000$ |
| **Longitude** | Decimal degrees | WGS 84 (`EPSG:4326`) | $75.800000 \le \text{lon} \le 76.100000$ |
| **Velocity (Storage)** | km/h | Ground speed (floating-point) | $0.0 \le \text{speed} \le 120.0$ |
| **Velocity (ETA Engine)**| m/s | Converted in Dart (`speedKmH / 3.6`) | $0.0 \le \text{speed} \le 33.33$ |
| **Heading** | Degrees | Clockwise from True North | $0.0 \le \text{heading} < 360.0$ |
| **Accuracy** | Meters | Horizontal Dilution of Precision | $0.0 < \text{accuracy} \le 50.0$ |
| **Distance** | Meters | Great-circle Haversine distance | Non-negative floating-point |
| **Timestamps** | ISO 8601 UTC | `YYYY-MM-DDTHH:mm:ss.sssZ` | Max 60s future, max 7d past |

---

## 4. Canonical Error & Result Codes

| Result Code | HTTP Status | Source Component | Meaning |
|---|---|---|---|
| `SUCCESS` | 200 | PostgreSQL / Fastify | Request processed and state updated. |
| `DUPLICATE_PACKET` | 200 | PostgreSQL | Exact matching packet already ingested (idempotent retry). |
| `STALE_SEQUENCE` | 409 | PostgreSQL | Sequence number is less than current accepted sequence. |
| `SEQUENCE_REUSE_CONFLICT` | 409 | PostgreSQL | Sequence number was reused with conflicting coordinates/time. |
| `STALE_EPOCH` | 409 | PostgreSQL | Packet presents an older session epoch. |
| `FUTURE_EPOCH` | 409 | PostgreSQL | Packet presents an unnegotiated future epoch. |
| `INVALID_CREDENTIALS` | 401 | PostgreSQL / Fastify | Device secret verification failed. |
| `DEVICE_NOT_FOUND` | 401 | PostgreSQL / Fastify | Device ID not provisioned in database. |
| `DEVICE_INACTIVE` | 401 | PostgreSQL / Fastify | Device administratively disabled (`is_active = false`). |
| `INACTIVE_BUS` | 422 | PostgreSQL / Fastify | Associated vehicle is disabled. |
| `OUT_OF_BOUNDS` | 422 | Fastify | Coordinates outside NITC campus corridor. |
| `SPEED_TOO_HIGH` | 422 | Fastify / PostgreSQL | Implausible speed ($> 120\text{ km/h}$). |
| `RATE_LIMITED` | 429 | Fastify | Rate limit quota exceeded. |
