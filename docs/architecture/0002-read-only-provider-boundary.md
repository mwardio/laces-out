# ADR 0002: Read-only provider integrations first

Status: accepted
Date: 2026-07-16

## Context

The product's core value is analysis. Yahoo now grants read-only Fantasy API access by default and separately reviews writes. ESPN has no current public Fantasy OAuth/API, and undocumented writes would add account, terms, and accidental-transaction risk.

## Decision

Connectors advertise granular capabilities and default every write flag to false. Initial releases sync state, calculate recommendations, and deep-link to Yahoo or ESPN for execution.

Yahoo write support may be considered only after explicit approval, stable read reconciliation, an action preview, user confirmation, an idempotency key, a provider receipt, and shadow-mode evidence. ESPN writes are out of scope while no supported integration exists.

## Consequences

- A leaked or broken initial connector cannot submit a waiver claim or corrupt a lineup.
- The recommendation experience must make provider execution convenient.
- Read and write DTOs cannot be conflated.
- Capability truth is visible in the connection and data-health UI.
