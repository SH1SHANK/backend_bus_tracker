# NITC Bus Tracking System ("Tracklet") — Canonical Architecture Documentation

## 1. Documentation Overview

Welcome to the canonical technical architecture documentation for the **National Institute of Technology Calicut (NITC) Campus Bus Tracking Platform ("Tracklet")**. 

This documentation suite serves as the authoritative, implementation-grounded technical reference for system design, firmware protocols, API specifications, database schemas, stored procedures, client applications, security boundaries, and operational procedures. It is written to serve developers, system architects, security auditors, and AI coding agents.

---

## 2. Canonical Source-of-Truth & Synchronization Hierarchy

To prevent documentation drift across separate git repositories, the following rules govern this documentation:

```
                      [CANONICAL DOCUMENTATION ROOT]
                  NITC_BUS_TRACKING_APP/docs/architecture/
                                     │
                     (Propagate on change via rsync / git)
                                     ▼
                      [MIRRORED DEVELOPER REFERENCE]
                  backend_bus_tracker/docs/architecture/
```

### 2.1 Synchronization Rules
1. **Canonical Root:** The `NITC_BUS_TRACKING_APP/docs/` directory is the **primary, authoritative source of truth** for platform architecture, spanning the mobile client, shared Supabase database migrations, and telemetry contracts.
2. **Propagation Protocol:** Any architectural changes, schema updates, or API contract revisions must be authored and reviewed in `NITC_BUS_TRACKING_APP/docs/` first. Once approved, the changes are mirrored to `backend_bus_tracker/docs/`.
3. **AI Agent Invariant:** AI coding agents must never create conflicting versions of documentation in `backend_bus_tracker`. If drift is detected, `NITC_BUS_TRACKING_APP/docs/` takes precedence.

---

## 3. Repositories and Inspection Targets

1. **Backend Telemetry API:**
   - **Repository:** `https://github.com/gamehackerever/backend_bus_tracker`
   - **Checked-out Path:** `/Users/shashankmergu/Desktop/backend_bus_tracker`
   - **Authoritative Branch:** `stable` (Authoritative commit: `4a77fd13cc83ef0166cdedb32eac7111c7bda12f`)
   - *Rule:* The `stable` branch is the sole authority for backend implementation. The `development` branch or unmerged PRs must not be assumed to reflect live production behavior.
2. **Mobile & Web Client:**
   - **Repository:** `https://github.com/gamehackerever/NITC_BUS_TRACKING_APP`
   - **Checked-out Path:** `/Users/shashankmergu/Desktop/NITC_BUS_TRACKING_APP`
   - **Authoritative Branch:** `main` (Authoritative commit: `9c5751bafbf296d6f9d15db8ca17a96ae2ba6d3e`)
3. **Database Project:**
   - **Project Reference:** `fnngudikrvelpuhngtlw` (Region: `ap-northeast-1`, Engine: PostgreSQL 17.11.0.003)
   - **Migrations Source:** `NITC_BUS_TRACKING_APP/supabase/migrations/`
   - *Note:* The backend repository contains abandoned legacy migrations (`0001_schema.sql`, `0002_functions.sql`). Schema truth resides in `NITC_BUS_TRACKING_APP` and the deployed database catalog.

---

## 4. Documentation Index

The documentation is organized into modular, deep-dive specifications under [`docs/architecture/`](file:///Users/shashankmergu/Desktop/NITC_BUS_TRACKING_APP/docs/architecture/):

| Document | Subject Area & Content Summary |
|---|---|
| [1. System Overview](file:///Users/shashankmergu/Desktop/NITC_BUS_TRACKING_APP/docs/architecture/overview.md) | High-level system topology, bifurcated client/telemetry architecture, component responsibilities, and trust boundaries. |
| [2. Hardware & Device Architecture](file:///Users/shashankmergu/Desktop/NITC_BUS_TRACKING_APP/docs/architecture/hardware.md) | ESP32 microcontroller, GNSS modules, power systems, cellular transport, firmware requirements, and hardware failure modes. |
| [3. Telemetry Protocol Specification](file:///Users/shashankmergu/Desktop/NITC_BUS_TRACKING_APP/docs/architecture/telemetry-protocol.md) | Device boot, Bcrypt secret authentication, session epochs, monotonic sequence counters, idempotent retries, and offline buffering. |
| [4. Fastify Backend API](file:///Users/shashankmergu/Desktop/NITC_BUS_TRACKING_APP/docs/architecture/backend-api.md) | Fastify routes, TypeBox schemas, authentication hooks, rate limiting, Prometheus metrics, and error code translation. |
| [5. Database Schema & Data Dictionary](file:///Users/shashankmergu/Desktop/NITC_BUS_TRACKING_APP/docs/architecture/database-schema.md) | 15 deployed PostgreSQL tables, PostGIS geometries, foreign keys, constraints, spatial and B-tree indexes, and RLS policies. |
| [6. Database Functions & Stored Procedures](file:///Users/shashankmergu/Desktop/NITC_BUS_TRACKING_APP/docs/architecture/database-functions.md) | Catalog of 22 deployed functions, execution privileges, security contexts, advisory locks, and canonical vs legacy status. |
| [7. Telemetry Lifecycle & Ingestion Engine](file:///Users/shashankmergu/Desktop/NITC_BUS_TRACKING_APP/docs/architecture/telemetry-lifecycle.md) | Step-by-step trace of a GPS fix: hardware sampling $\to$ HTTP validation $\to$ RPC advisory lock $\to$ state upsert $\to$ stop geofence $\to$ Flutter UI. |
| [8. Flutter Application Architecture](file:///Users/shashankmergu/Desktop/NITC_BUS_TRACKING_APP/docs/architecture/flutter-app.md) | Layered architecture (`core/`, `data/`, `services/`, `features/`), Riverpod state management, Supabase repository integration, and offline caching. |
| [9. Flutter Models & Contract Mapping](file:///Users/shashankmergu/Desktop/NITC_BUS_TRACKING_APP/docs/architecture/flutter-models.md) | Dart domain entities, JSON serialization, nullability, precision conversions, and the complete hardware-to-UI field mapping matrix. |
| [10. Realtime, Maps, & Freshness Policy](file:///Users/shashankmergu/Desktop/NITC_BUS_TRACKING_APP/docs/architecture/realtime-and-location.md) | Supabase Realtime CDC vs 15-second polling, route geometry projection, map matching, stop proximity, and stale bus degradation. |
| [11. Security & Threat Modeling](file:///Users/shashankmergu/Desktop/NITC_BUS_TRACKING_APP/docs/architecture/security.md) | Threat matrix, Bcrypt salt invariants, JWT validation, service-role isolation, RLS audits, and abuse mitigation. |
| [12. Deployment, Hosting, & Configuration](file:///Users/shashankmergu/Desktop/NITC_BUS_TRACKING_APP/docs/architecture/deployment-and-configuration.md) | Render web service, Supabase project configuration, environment variables, migration management, and rollback protocols. |
| [13. Testing & Troubleshooting](file:///Users/shashankmergu/Desktop/NITC_BUS_TRACKING_APP/docs/architecture/testing-and-troubleshooting.md) | Vitest test suites, Flutter unit tests, simulated telemetry workflows, common failure modes, and runbooks. |
| [14. Canonical Data Dictionary](file:///Users/shashankmergu/Desktop/NITC_BUS_TRACKING_APP/docs/architecture/data-dictionary.md) | Universal glossary of terms, status enums, event types, coordinate frames, measurement units, and identifier formats. |
| [15. Known Limitations & Technical Debt](file:///Users/shashankmergu/Desktop/NITC_BUS_TRACKING_APP/docs/architecture/known-limitations.md) | Verified defects, inconsistencies, technical debt, missing information, unresolved audit findings, and unimplemented features. |
| [16. AI Agent Reference & Operating Guide](file:///Users/shashankmergu/Desktop/NITC_BUS_TRACKING_APP/docs/architecture/agent-reference.md) | Concise rules, invariant checklists, commands, and boundaries for future AI coding agents working on this project. |
| [17. Architecture Diagrams Catalog](file:///Users/shashankmergu/Desktop/NITC_BUS_TRACKING_APP/docs/architecture/diagrams/) | Standalone Mermaid diagrams for system topology, telemetry sequences, session reset, ER models, and Flutter data flow. |

---

## 5. Verification & Classification Standards

Every statement, contract, and diagram across this documentation is classified under one of four epistemic tiers:

- **Confirmed / Verified:** Directly inspected and verified in source code, database dumps, configuration, or automated test output.
- **Inferred:** Logically deduced from implementation patterns but lacking explicit runtime assertion or documentation.
- **Proposed / Planned:** Architectural recommendations or fixes that have been designed but not yet applied to production.
- **Unknown / Unverified:** Hardware or operational details that cannot be confirmed from existing software repositories alone.

### Known Documentation & Source Gaps
1. **Physical Hardware & Firmware Repository:** The physical ESP32 C++ firmware source code, pinouts, and PCB schematics reside in an external repository. Software timing and payload contracts are verified via Fastify gateway schemas.
2. **Architecture Reference Diagram (`nitc_bus_tracking_app.excalidraw`):** This file was not present in local repositories; all system diagrams were synthesized directly from inspected code.
