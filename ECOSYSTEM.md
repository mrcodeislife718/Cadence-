# Cadence ecosystem role

Cadence is the Cannon backend/web framework: the ecosystem's Cannon-native answer to the responsibility served by frameworks such as Express, FastAPI and Django.

## Intent

Cadence owns HTTP application composition: routing, middleware, request/response handling, validation, sessions, cookies, authentication integration, streaming, uploads, WebSockets, RPC/server functions and generated API documentation.

The target is simple composition plus strong validation/documentation and official batteries without middleware sprawl or monolithic lock-in.

## Relationships

- Cannon/Cannon+ are the application languages.
- Nova supplies semantic/type/inference information and diagnostics.
- Parallel supplies HTTP/TLS, networking, streams and runtime execution.
- Syncio can provide first-party realtime/data integration without making Cadence database-specific.
- Velocity composes Cadence into full-stack application workflows.
- Chronos builds and deploys Cadence applications.
- Cortex provides the integrated development/debugging surface.

## Boundary

Cadence is the backend framework, not the runtime or deployment cloud. Real HTTP routes, middleware, validation, WebSockets and streaming require real integration tests before being claimed.
