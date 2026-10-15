# Trip Lifecycle Sequence Diagram

> [!IMPORTANT]
> **Implementation Status Note:**  
> The diagrams below contrast the **current production defect** (multiple sequential HTTP requests in Fastify `src/routes/trips.ts`) against the **proposed atomic RPC target** (`start_bus_trip` and `end_bus_trip`). The atomic RPCs are recommendations under review and have **not yet been applied to production**.

---

## 1. Current Production Implementation (Vulnerable to Partial Failures)

```mermaid
sequenceDiagram
    autonumber
    participant STF as Driver / Staff
    participant FST as Fastify Server (src/routes/trips.ts)
    participant PG as PostgreSQL (Supabase)

    Note over STF,PG: Current Trip Start Flow
    STF->>+FST: POST /api/v1/trips/start { bus_id, route_id }
    FST->>PG: Step 1: INSERT INTO trips (status: 'active')
    alt Network timeout or process crash occurs here
        Note over PG: CRITICAL DEFECT: Active trip exists, but bus_events & bus_current_state are NOT updated! Live map desynchronizes and future trip starts are blocked.
    end
    FST->>PG: Step 2: Promise.all([ INSERT INTO bus_events, UPDATE bus_current_state ])
    FST-->>-STF: HTTP 201 { id: trip_id, status: 'active' }

    Note over STF,PG: Current Trip End Flow
    STF->>+FST: POST /api/v1/trips/:id/end
    FST->>PG: Step 1: UPDATE trips SET status = 'completed' WHERE id = :id
    alt Network timeout or process crash occurs here
        Note over PG: CRITICAL DEFECT: Trip marked completed, but bus_current_state.trip_id remains dangling and bus_events lacks trip_ended!
    end
    FST->>PG: Step 2: Promise.all([ INSERT INTO bus_events, UPDATE bus_current_state SET trip_id = NULL ])
    FST-->>-STF: HTTP 200 { id: trip_id, status: 'completed' }
```

---

## 2. Proposed Target Architecture (Atomic Database Transactions)

```mermaid
sequenceDiagram
    autonumber
    participant STF as Driver / Staff
    participant FST as Fastify Server
    participant PG as PostgreSQL (Supabase)

    Note over STF,PG: Proposed Atomic Trip Start (Single RPC Transaction)
    STF->>+FST: POST /api/v1/trips/start { bus_id, route_id }
    FST->>+PG: SELECT start_bus_trip(p_bus_id, p_route_id)
    Note over PG: BEGIN TRANSACTION<br/>1. Advisory Lock 1002 (bus_id)<br/>2. Assert bus & route are active<br/>3. Assert no existing active trip for bus<br/>4. INSERT INTO trips (status: 'active')<br/>5. INSERT INTO bus_events ('trip_started')<br/>6. UPDATE bus_current_state SET trip_id = trip.id<br/>COMMIT
    PG-->>-FST: { ok: true, trip_id: uuid, status: 'active' }
    FST-->>-STF: HTTP 201 { id: trip_id, status: 'active' }

    Note over STF,PG: Proposed Atomic Trip End (Single RPC Transaction)
    STF->>+FST: POST /api/v1/trips/:id/end
    FST->>+PG: SELECT end_bus_trip(p_trip_id)
    Note over PG: BEGIN TRANSACTION<br/>1. SELECT trips WHERE id = p_trip_id FOR UPDATE<br/>2. Advisory Lock 1002 (bus_id)<br/>3. UPDATE trips SET status = 'completed'<br/>4. INSERT INTO bus_events ('trip_ended')<br/>5. UPDATE bus_current_state SET trip_id = NULL<br/>COMMIT
    PG-->>-FST: { ok: true, trip_id: uuid, status: 'completed' }
    FST-->>-STF: HTTP 200 { id: trip_id, status: 'completed' }
```
