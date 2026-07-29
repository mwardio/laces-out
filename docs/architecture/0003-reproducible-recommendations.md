# ADR 0003: Deterministic, reproducible recommendation core

Status: accepted
Date: 2026-07-16

## Context

Lineup, waiver, trade, and draft advice must respect hard league rules and must be evaluable after the fact. Free-form model output is not a safe optimizer and cannot reliably explain stale or conflicting data.

## Decision

Use deterministic optimization and seeded simulation. Persist the exact settings, roster/projection/injury versions, algorithm version, input hash, and seed for every recommendation. Explanations are constructed from the factors and constraints returned by the engine.

An LLM may summarize or answer questions about already-computed results, but it cannot be the source of player values, legality, or action ranking.

## Consequences

- Results can be replayed, regression-tested, backtested, and compared with outcomes.
- Engine APIs must return intermediate factors and warnings, not only an ordered list.
- Stochastic algorithms require explicit seeded pseudo-randomness.
- Improvements can be promoted through shadow evaluation rather than intuition.
