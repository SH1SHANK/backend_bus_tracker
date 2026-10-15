# System Topology Diagram

```mermaid
flowchart TB
    subgraph Trackers ["Hardware Tier (Physical Buses)"]
        ESP1["ESP32 Bus Tracker #1<br/>ID: NITC-BUS-001<br/>- GNSS Satellite Fix<br/>- Flash NVS Buffer<br/>- Monotonic seq counter"]
        ESP2["ESP32 Bus Tracker #2<br/>ID: NITC-BUS-002<br/>- GNSS Satellite Fix<br/>- Flash NVS Buffer<br/>- Monotonic seq counter"]
    end

    subgraph FastifyCluster ["Telemetry Gateway (Render Cloud)"]
        FastifyApp["Fastify HTTP Server (Node.js 22 LTS)<br/>Repository: backend_bus_tracker (stable)<br/>- Helmet & CORS Headers<br/>- HS256 JWT Authentication Hook<br/>- TypeBox Request Validation<br/>- Rate Limiting (10/min auth, 300/min telem)<br/>- NITC Geo Corridor Sanity Check<br/>- Prometheus Metrics (/metrics)"]
    end

    subgraph DatabaseEngine ["Authoritative Storage Engine (Supabase Cloud)"]
        Postgres["PostgreSQL 17.11 (fnngudikrvelpuhngtlw)<br/>- PostGIS 3.4 Spatial Engine<br/>- Advisory Locks (Namespace 1001 & 1002)<br/>- Ingestion RPC: ingest_telemetry_packet()<br/>- Session Reset RPC: reset_device_sequence()<br/>- Projection RPC: get_active_bus_positions_v2()"]
        
        subgraph InternalTables ["Relational & Spatial Tables"]
            HistTable[("bus_positions (History)")]
            StateTable[("bus_current_state (Live)")]
            TripTable[("trips & bus_events")]
            StaticTable[("routes, stops, route_stops")]
        end
    end

    subgraph MobileClients ["Rider Client Tier (Flutter)"]
        RiderApp1["Student Phone #1<br/>(Flutter Android / Web)<br/>- Riverpod State Management<br/>- Supabase Flutter SDK (anon key)<br/>- Client-side ETA Calculation<br/>- 15s Resilient Polling Fallback"]
        RiderApp2["Student Phone #2<br/>(Flutter Android / Web)<br/>- Riverpod State Management<br/>- Supabase Flutter SDK (anon key)<br/>- Client-side ETA Calculation<br/>- 15s Resilient Polling Fallback"]
    end

    %% Network flows
    ESP1 -->|HTTPS POST /auth/reset-session & /telemetry| FastifyApp
    ESP2 -->|HTTPS POST /auth/reset-session & /telemetry| FastifyApp

    FastifyApp -->|PostgreSQL RPC (service_role client)| Postgres
    Postgres --> HistTable
    Postgres --> StateTable
    Postgres --> TripTable
    Postgres --> StaticTable

    RiderApp1 -->|PostgREST & RPC (anon key)| Postgres
    RiderApp2 -->|PostgREST & RPC (anon key)| Postgres
```
