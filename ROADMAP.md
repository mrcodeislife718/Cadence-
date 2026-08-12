# Cadence Roadmap

Cadence is the Cannon backend/web framework.

## Product contract

Cadence owns HTTP application composition: routing, middleware, request/response handling, validation, sessions, cookies, authentication integration, streaming, uploads, WebSockets, RPC/server functions, and generated API documentation.

## Design sources

Cadence combines Express simplicity, FastAPI validation/documentation, and Django's official batteries while avoiding unstructured middleware sprawl and monolithic framework lock-in.

## Implementation order

1. HTTP server integration on Parallel.
2. Router with parameters and method dispatch.
3. Middleware pipeline.
4. Typed/Infer-assisted request validation.
5. Error handling and structured diagnostics.
6. WebSockets and streaming.
7. Official auth/session/file modules.
8. OpenAPI generation and Syncio integration.

## Proof gates

All routes and middleware require real HTTP integration tests. Validation requires success/failure tests. WebSocket and streaming support require real connection tests.

## Commercial boundary

Cadence core should drive adoption. Revenue belongs in managed hosting, enterprise modules, observability, support, Chronos deployment, and Syncio-backed services.
