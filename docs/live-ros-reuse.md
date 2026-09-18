# Durable live ROS reuse

A new league should not trigger fresh football simulations when its football inputs already exist.
Historical scoring validation and live publication are separate: a new exact profile still needs
its own admitted historical proof, but both can reuse scoring-independent football outcomes.

## Identities and publication

The live provider captures its selected observation versions and all six fact tables in one short
repeatable-read transaction. After that transaction closes, it canonicalizes rows for both assembly
and hashing. The physical generation includes source IDs/checksums (including absent feeds), actual
captured facts and resolved catalog positions, season/window, scenario counts, model/seed/history
versions, and the live assembly/calibration versions. It excludes league membership, scoring rules,
and provider aliases. The broader provider fingerprint still includes those publication inputs.

An immutable generation pin retains the original `asOfAt`. That timestamp remains in the existing
player input checksum and seed. A later league does not make the forecast look newer or acquire a
new random path merely by joining. Changes in actual football facts produce a new generation.

Training calibration has a separate digest over its actual training histories and schedules. A new
injury report or scoring profile does not refit unchanged historical calibration. Canonical target
templates are additionally keyed by the admitted artifact, exact profile, supported/matched
positions, and coverage. They contain no league identifiers or provider aliases. Every publication
applies current aliases and runs the existing artifact, completeness, convergence, and calibration
checks again.

## Outcome storage

`ROS_LIVE_OUTCOME_CACHE` enables the live-only persistent volume. It is separate from the historical
validation volume and cannot admit or modify historical evidence. Each forecast retains aligned
Float64 season component outcomes, games, and weekly availability. The live publication type
explicitly omits weekly point distributions, which ROS publication does not consume. Supported
weekly bonuses already normalize into additive per-path components before season aggregation.
Arbitrary raw threshold bonuses are rejected rather than incorrectly applied to season totals.
A new supported profile prices the same joint season outcomes without fitting or simulation; a
current exact-profile template avoids even that replay.

Entries retain the unchanged bounded, checksummed outcome encoding and atomic commit. Missing or
corrupt committed evidence fails closed; uncommitted work can be regenerated deterministically. A 128 MiB summary LRU prices
up to 32 profiles together after a vector load. It does not retain entire season corpora in memory.

All production live cache access holds one dedicated PostgreSQL session advisory lock around the
whole shared worker batch. A second kernel filesystem lock stays attached to the worker's open
file descriptor until that worker exits, including the gap between a database disconnect and worker
termination. The permanent lock inode must never be unlinked. The current physical generation is
retained; older live generation directories are pruned under those locks. Shared training calibration remains separate. Outcome writes enforce a
20 GiB live allowance and the existing 5 GiB filesystem reserve, including temporary write space.
These are operational limits, not reduced scenario counts or relaxed statistical checks. Published
database sets remain intact if a cache operation fails.

## Validation expectations

- Direct and cached projections must preserve seeds, component means and weekly availability
  exactly. Season score summaries must agree within 1e-9, allowing floating-point addition order
  when pricing aggregate columns; publication uses the existing decimal precision.
- A fresh process with a new profile must replay stored vectors with zero simulations.
- A new same-profile league must reuse calibration and canonical targets while applying its own
  aliases and current release checks.
- Changes to physical facts, catalog positions, window, or model identity must invalidate reuse.
- Missing/corrupt evidence, storage exhaustion, and lost leases must fail without publishing a
  partially assembled generation.

Small fixtures establish equivalence and failure behavior. They do not establish whole-league or
whole-server runtime or storage capacity; measure the live corpus before increasing operational
limits.
