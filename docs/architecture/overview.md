# System Architecture & Topology

## 1. Executive Summary

Tracklet is a fixed-campus college transit tracking platform developed specifically for the **National Institute of Technology Calicut (NITC)**. The campus environment is geographic and geographically constrained, with fixed campus boundaries, fixed roads, predefined circular and linear shuttle routes, designated campus bus stops, and a small, dedicated fleet of campus buses.

The platform architecture is designed around a **strict bifurcation of responsibilities**:
- **Telemetry Ingestion & Device Control Plane:** High-throughput, low-latency, resilient hardware communication handled by a Node.js Fastify API server and privileged PostgreSQL functions.
- **Rider Presentation Plane:** Lightweight, secure, offline-first mobile client application built in Flutter, reading directly from Supabase via Row-Level Security (RLS) policies and PostgREST.

---

## 2. High-Level System Topology

```mermaid
flowchart TB
    subgraph HardwareLayer ["Hardware Tracker Tier"]
        ESP32["ESP32 Cellular Tracker (On-Bus)<br/>- GNSS Receiver (NMEA $GPRMC)<br/>- Flash NVS Buffer (Offline queue)<br/>- GSM/LTE Modem (SIM800/SIM7600)<br/>- Bcrypt Hardware Secret"]
    end

    subgraph FastifyGateway ["Telemetry Gateway Tier (Node.js 22 on Render)"]
        Fastify["Fastify Telemetry Server<br/>(backend_bus_tracker: stable)<br/>- Rate Limiting (10/min auth, 300/min telem)<br/>- JWT HS256 Authenticator<br/>- TypeBox Schema Validation<br/>- NITC Bounding Box & Anomaly Filter<br/>- Prometheus /metrics Exporter"]
    end

    subgraph DatabaseTier ["Authoritative Storage & Compute Tier (Supabase)"]
        PG["PostgreSQL 17.11 (fnngudikrvelpuhngtlw)<br/>- PostGIS Spatial Extension<br/>- Advisory Locks (Namespace 1001 & 1002)<br/>- Canonical Ingestion RPC (ingest_telemetry_packet)<br/>- Session Negotiation RPC (reset_device_sequence)<br/>- Row-Level Security (RLS)"]
        
        subgraph Tables ["PostgreSQL Tables"]
            HistTable[("bus_positions (History)")]
            StateTable[("bus_current_state (Live)")]
            MetaTables[("buses / devices / trips / routes / stops")]
            EventsTable[("bus_events (Stop / Deviation)")]
        end
    end

    subgraph ClientTier ["Mobile Client Tier (Flutter)"]
        FlutterApp["Tracklet Mobile App (NITC_BUS_TRACKING_APP: main)<br/>- Riverpod State Management<br/>- Flutter Map (MapLibre / OSM)<br/>- Client-side ETA & Progress Engine<br/>- 15-second Resilient Polling Fallback<br/>- Supabase Flutter SDK (anon key)"]
    end

    %% Ingestion Data Flow
    ESP32 -->|1. HTTPS POST /auth/reset-session (Bcrypt Secret)| Fastify
    ESP32 -->|2. HTTPS POST /telemetry (Bearer JWT, Epoch, Seq, Fix)| Fastify
    Fastify -->|3. Supabase RPC reset_device_sequence() (service_role)| PG
    Fastify -->|4. Supabase RPC ingest_telemetry_packet() (service_role)| PG
    PG --> HistTable
    PG --> StateTable
    PG --> EventsTable

    %% Rider Data Flow
    FlutterApp -->|5. PostgREST SELECT (routes, stops, timings, buildings)| PG
    FlutterApp -->|6. Supabase RPC get_active_bus_positions_v2()| PG
    FlutterApp -->|7. Supabase RPC get_active_trip_stop_events(trip_id)| PG
```

---

## 3. Component Responsibilities & Trust Boundaries

The system is partitioned into four explicit trust domains:

| Domain | Entities | Trust Level | Credentials Held | Ingress Access | Egress Access |
|---|---|---|---|---|---|
| **Hardware Trackers** | Physical ESP32 hardware | Low / Hostile Physical Environment | Device ID (`NITC-BUS-001`), Pre-shared 16+ char secret, short-lived JWT | None (client only) | HTTPS to Fastify API Gateway only |
| **Fastify API Server** | Node.js process on Render | Trusted Infrastructure | Supabase `service_role` secret, Fastify JWT signing secret (`JWT_SECRET`) | Public HTTPS from Internet (Trackers, Admins, Health checks) | PostgreSQL connection / HTTPS PostgREST to Supabase |
| **Database Server** | Supabase Managed PostgreSQL | Authoritative Root of Trust | Database superuser, `service_role` full bypass, RLS enforcement engine | Connection pooler, PostgREST API gateway | None (inbound only) |
| **Flutter Mobile App** | Student & Driver phones | Untrusted Public Environment | Supabase `anon` public key, user Auth session JWT | None (client only) | HTTPS to Supabase PostgREST & WebSocket Realtime |

### 3.1 Architectural Invariant: Client Isolation from Fastify
*Verified Fact:* The Flutter mobile app contains **zero** network calls, configuration keys, or references to the Fastify API server. 
- Fastify is **not** a general mobile backend for Tracklet.
- Fastify is strictly a **hardware telemetry ingestion gateway, session coordinator, and administrative control plane**.
- Flutter communicates directly with Supabase via `supabase_flutter`.

---

## 4. End-to-End Data Flows

### 4.1 Telemetry Ingestion Path
1. **Acquisition:** The bus tracker's GNSS module acquires satellite lock and emits an NMEA `$GPRMC` sentence at 1 Hz (or configured interval).
2. **Buffering & Packaging:** Microcontroller firmware extracts latitude, longitude, speed, heading, and accuracy, assigns the next monotonic sequence number `seq`, and formats a JSON telemetry payload.
3. **Gateway Ingress:** Packet is transmitted over HTTPS to Fastify `POST /api/v1/telemetry` with HTTP Bearer authentication.
4. **Gateway Pre-filtering:** Fastify validates JWT signature (`HS256`), verifies that `devices.is_active = true`, checks spatial coordinates against the NITC bounding box, verifies speed $\le 120\text{ km/h}$, and flags temporal anomaly jumps.
5. **Database Transaction:** Fastify invokes `public.ingest_telemetry_packet(...)` using the Supabase `service_role` client.
6. **Advisory Locking & Dedup:** PostgreSQL acquires a transaction-scoped advisory lock on `hashtext(device_id)`, checks for sequence conflicts within the current epoch, inserts into `bus_positions`, and upserts `bus_current_state`.
7. **Spatial Analytics:** The RPC evaluates spatial geofences around route stops (`ST_DWithin`) to detect stop arrivals and departures, debounces stationary dwell, checks route corridor deviation, and records transit events into `bus_events`.

### 4.2 Rider Live Tracking Path
1. **Initialization:** On app startup, Flutter loads static transit infrastructure (`routes`, `stops`, `route_stops`, `bus_timings`) from Supabase PostgREST. These tables have RLS policies permitting public `SELECT`.
2. **Active Bus Polling:** Every 15 seconds, Flutter calls `supabase.rpc('get_active_bus_positions_v2')`. This returns all buses currently active with their latest latitude, longitude, heading, speed, active trip ID, route ID, epoch, sequence, and staleness indicator.
3. **Stop Event Synchronization:** If an active bus has an associated `trip_id`, Flutter calls `supabase.rpc('get_active_trip_stop_events', { 'p_trip_id': tripId })` to retrieve all stop arrival/departure records for the trip.
4. **Client-Side Progress & ETA:** Flutter's transit engine (`bus_eta.dart` and `bus_stop_progress.dart`) projects the bus's coordinate onto the route polyline, determines the current and next stop, and calculates an arrival estimate in minutes without placing analytical computational load on PostgreSQL.
