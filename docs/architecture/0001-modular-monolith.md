# ADR 0001: TypeScript modular monolith with separate processes

Status: accepted
Date: 2026-07-16

## Context

The application serves an invite-only group across multiple leagues, but provider synchronization,
future active-draft polling, and projection ingestion should not share a request lifecycle with
interactive pages. The implemented browser-local ESPN companion also benefits from a stable HTTP
contract.

## Decision

Use one TypeScript workspace and one PostgreSQL database with three processes:

- Next.js web/PWA;
- Fastify REST API, with authorized SSE retained as future work;
- pg-boss worker.

Business logic lives in provider-neutral packages. Providers and persistence depend inward on the domain; recommendation engines do not depend on either.

## Consequences

- One language, lockfile, schema, and deployment remain approachable for a personal system.
- Worker failures and slow providers do not consume API request capacity.
- REST provides an honest boundary for a browser bridge or future native client.
- PostgreSQL supplies transactions and durable jobs without a Redis dependency.
- Cross-package discipline is necessary; imports will be checked during review and build.
- This decision should be revisited only if measured workloads or deployment limits make separate scaling necessary.
