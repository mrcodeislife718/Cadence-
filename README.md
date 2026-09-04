# Cadence

Cadence is the Cannon backend/web framework.

It is the Cannon-native application layer for HTTP services and full-stack backends: routing, middleware, request/response handling, validation, sessions, cookies, authentication integration, streaming, uploads, WebSockets, RPC/server functions, and generated API documentation.

## Role in the Cannon developer ecosystem

```text
Cannon / Cannon+ ──► Nova ──► Parallel
                              │
                              ▼
                           Cadence
                              │
                    ┌─────────┴─────────┐
                    ▼                   ▼
                 Syncio              Velocity
                    │                   │
                    └─────────► Chronos ◄┘
```

- **Nova** supplies semantic/type/inference information and diagnostics.
- **Parallel** supplies execution, networking, HTTP/TLS, and streams.
- **Syncio** can provide first-party realtime/data integration without making Cadence database-specific.
- **Velocity** composes Cadence into local full-stack application workflows.
- **Chronos** can reproducibly build and deploy Cadence applications.
- **Cortex** provides the integrated editing/debugging surface.

## Current implementation

Canonical `main` contains a real Cadence application/router foundation plus additional server and module infrastructure. The earlier `implementation/runtime-v1` router/middleware/validation work has been semantically preserved in main rather than replacing newer main code with the older branch snapshot.

Core implementation lives under `src/`, with automated coverage under `test/` and `tests/`.

## Design direction

Cadence combines Express-style simplicity, FastAPI-style validation/documentation, and Django-style official batteries while avoiding unstructured middleware sprawl and monolithic lock-in.

## Proof standard

Routes and middleware require real HTTP integration tests. Validation requires success and failure coverage. WebSocket and streaming support require real connection tests before they are represented as supported.

## Commercial boundary

Cadence core is adoption infrastructure. Commercial value can be built through managed hosting, enterprise modules, observability, support, Chronos deployment, and Syncio-backed services.

See [ECOSYSTEM.md](./ECOSYSTEM.md) and [ROADMAP.md](./ROADMAP.md).
