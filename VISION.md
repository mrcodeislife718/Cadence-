# Cadence Vision

## Product identity

Cadence is the Cannon-native backend and web framework.

Its goal is to make backend development simple, cohesive, productive, and powerful without inheriting the recurring complexity and lock-in problems of existing frameworks.

## Primary comparison set

Cadence is our answer to lessons drawn from:

- Express
- FastAPI
- Django

It should preserve Express-style simplicity, FastAPI-style validation/documentation ergonomics, and Django-style useful official batteries while avoiding unstructured middleware sprawl and monolithic framework lock-in.

## Strengths to preserve

- Simple routing and application composition.
- Middleware where it provides clear value.
- Request/response handling.
- Validation and strong developer feedback.
- Sessions, cookies, authentication integration.
- Streaming and uploads.
- WebSockets.
- RPC/server functions where they reduce unnecessary plumbing.
- Generated API documentation.
- Sensible first-party capabilities without forcing one architecture for every application.

## Weaknesses to eliminate

- middleware chains that become impossible to reason about;
- configuration and extension sprawl;
- weak validation and undocumented API behavior;
- monolithic framework coupling;
- hidden runtime behavior that makes debugging difficult;
- forcing applications into managed infrastructure to access the framework's best features.

## Independent ceiling

Cadence should become a strong backend/web framework in its own right. It must not be reduced to a thin convenience wrapper around Parallel or Velocity.

## Ecosystem role

Parallel supplies runtime primitives such as networking, HTTP/TLS, streams, processes, and permissions. Nova supplies language/compiler intelligence. Velocity composes Cadence into local and universal application workflows. Chronos can build and deploy Cadence applications. Cortex provides integrated editing, debugging, and systems visibility.

## Architectural invariant

**Cadence owns backend application semantics. Parallel owns runtime execution. Velocity owns application-development workflow. Chronos owns production lifecycle. Integration must strengthen Cadence without collapsing these boundaries.**
