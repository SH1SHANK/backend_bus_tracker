# Flutter Models & Contract Mapping

## 1. Domain Entities & DTO Reference

Every data structure consumed by the Flutter application is modeled as an immutable Dart class with strict nullability, JSON deserialization, equality overrides (`==` and `hashCode`), and copy constructors (`copyWith`).

---

### 1.1 `Bus` (`lib/data/transit/bus.dart`)
Represents an active or provisioned campus transit bus.

| Field Name | Dart Type | Nullable | Source Database Key | Description |
|---|---|---|---|---|
| `id` | `String` | No | `id` or `bus_id` | Bus UUID. |
| `numberPlate`| `String` | No | `number_plate` or `bus_number` | License / registration number. |
| `name` | `String` | No | `name` or `display_name` | Public display name (e.g. `'Campus Shuttle A'`). |
| `routeId` | `String?` | Yes | `route_id` | Active route UUID (NULL if unassigned). |
| `tripId` | `String?` | Yes | `active_trip_id` or `trip_id` | Active trip UUID (NULL if idling/off-duty). |
| `status` | `BusStatus`| No | `status` | Enum: `live`, `delayed`, `due`, `offline`. |
| `position` | `BusPosition` | No | Flattened columns (`latitude`, `longitude`, etc.) | Geographic telemetry object. |
| `occupancy` | `String` | No | `occupancy` | Default `'seats_available'`. |
| `lastUpdated`| `DateTime` | No | `last_updated`, `recorded_at`, `timestamp` | UTC parse of latest update. |
| `isStale` | `bool` | No | Derived / `is_stale` | True if telemetry $> 60\text{ seconds}$ old. |

---

### 1.2 `BusPosition` (`lib/data/transit/bus_position.dart`)
Represents the instantaneous kinematic fix of a bus.

| Field Name | Dart Type | Nullable | Source Database Key | Units / Semantic Meaning |
|---|---|---|---|---|
| `point` | `GeoPoint` | No | `latitude`, `longitude` | WGS 84 coordinate (`EPSG:4326`). |
| `heading` | `double` | No | `heading` | Degrees clockwise from True North ($0.0 \le \theta < 360.0$). |
| `speedKmH` | `double` | No | `speed_kmh` or `speed` | Speed in kilometers per hour. |
| `hasSpeed` | `bool` | No | Derived from presence of `speed` | True if valid GNSS Doppler speed available. |
| `accuracyMeters` | `double` | No | `accuracy` or `accuracy_meters` | Estimated horizontal error in meters. |
| `epoch` | `int?` | Yes | `epoch` | Session epoch counter. |
| `sequenceNumber` | `int?` | Yes | `seq` or `sequence` | Monotonic packet counter within epoch. |
| `timestamp` | `DateTime` | No | `recorded_at` or `timestamp` | UTC GPS fix time. |

*Derived Property:* `speedMetersPerSecond => speedKmH / 3.6`.

---

### 1.3 `Stop` (`lib/data/transit/stop.dart`)
Represents a physical campus bus stop.

| Field Name | Dart Type | Nullable | Source Database Key | Description |
|---|---|---|---|---|
| `id` | `String` | No | `id` | Stop UUID. |
| `name` | `String` | No | `name` | Stop name (e.g. `'Main Gate'`). |
| `code` | `String` | No | `code` | Short code (e.g. `'MAIN_GATE'`). |
| `location` | `GeoPoint` | No | `latitude`, `longitude` (or GeoJSON point) | WGS 84 coordinate. |
| `isCampus` | `bool` | No | `is_campus` (default `true`) | Distinguishes on-campus vs off-campus stops. |

---

### 1.4 `BusRoute` (`lib/data/transit/bus_route.dart`)
Represents a transit line.

| Field Name | Dart Type | Nullable | Source Database Key | Description |
|---|---|---|---|---|
| `id` | `String` | No | `id` | Route UUID. |
| `name` | `String` | No | `name` | Route name. |
| `routeCode`| `String` | No | `route_code` | Short identifier (e.g. `'CIRCULAR_1'`). |
| `description`| `String?` | Yes | `description` | Summary text. |
| `direction`| `String` | No | `direction` | `'loop'`, `'forward'`, `'reverse'`. |
| `path` | `List<GeoPoint>` | No | `path` (GeoJSON LineString) | Ordered road geometry polyline. |
| `stopOccurrences` | `List<RouteStopOccurrence>` | No | Joined `route_stops` | Ordered list of stops serving this route. |

---

### 1.5 `BusStopEvent` (`lib/data/transit/bus_stop_event.dart`)
Represents an observed arrival or departure event.

| Field Name | Dart Type | Source Database Key | Allowed Values / Semantic Meaning |
|---|---|---|---|
| `id` | `String` | `event_id` or `id` | Event UUID. |
| `tripId` | `String` | `trip_id` | Associated trip UUID. |
| `busId` | `String` | `bus_id` | Bus UUID. |
| `stopId` | `String` | `stop_id` | Stop UUID. |
| `stopCode`| `String` | `stop_code` | Stop code. |
| `stopName`| `String` | `stop_name` | Stop name. |
| `type` | `String` | `event_type` | `'arrived'` or `'departed'`. |
| `occurredAt` | `DateTime` | `occurred_at` | Timestamp event was confirmed. |

---

## 2. Universal Field-Mapping Matrix

The following table traces a telemetry coordinate across every transformation boundary in the system:

| Concept | Hardware Packet | Fastify Body | PostgreSQL RPC Arg | Database Column | Client RPC Output | Flutter Dart Model | UI Consumer |
|---|---|---|---|---|---|---|---|
| **Tracker ID** | `device_id` | `device_id` | `p_device_id text` | `devices.device_id` | `device_id` | `Bus.id` / `pos.id` | Debug badge |
| **Session Epoch** | `epoch` | `epoch` | `p_epoch int` | `bus_current_state.epoch` | `epoch` | `BusPosition.epoch`| Diagnostics |
| **Sequence** | `seq` | `seq` | `p_seq int` | `bus_current_state.seq` | `seq` | `BusPosition.sequenceNumber` | Diagnostics |
| **Latitude** | `lat` | `latitude` | `p_latitude float8`| `bus_current_state.latitude` | `latitude` | `GeoPoint.latitude`| Map Marker |
| **Longitude** | `lon` | `longitude` | `p_longitude float8`| `bus_current_state.longitude` | `longitude` | `GeoPoint.longitude`| Map Marker |
| **Velocity** | `speed` (km/h)| `speed` (km/h)| `p_speed numeric` | `bus_current_state.speed` | `speed` | `BusPosition.speedKmH`| ETA Engine |
| **Heading** | `heading` (deg)| `heading` | `p_heading numeric`| `bus_current_state.heading` | `heading` | `BusPosition.heading` | Bus Marker Icon Angle |
| **Fix Accuracy** | `accuracy` (m)| `accuracy` | `p_accuracy numeric`| `bus_current_state.accuracy`| `accuracy` | `BusPosition.accuracyMeters` | Geo Filter |
| **GPS Time** | `timestamp` | `timestamp` | `p_recorded_at tstz`| `bus_current_state.recorded_at` | `recorded_at` | `BusPosition.timestamp` | Freshness check |
| **Vehicle ID** | *(None)* | *(None)* | *(Resolved in RPC)*| `buses.id` | `bus_id` | `Bus.id` | Bus Selection |
| **Route ID** | *(None)* | *(None)* | *(Joined from trip)*| `trips.route_id` | `route_id` | `Bus.routeId` | Route Polyline Highlight |
| **Active Trip** | *(None)* | *(None)* | *(Joined from trip)*| `trips.id` | `active_trip_id` | `Bus.tripId` | Stop Progress Provider |
