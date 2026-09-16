# Adversarial logic review — September 16, 2026

The lineup and recap incident fixes were committed in `eeda6ce`. The remaining previously
implemented sync, projection-history, and ROS snapshot work was committed in `ac9a4c4`.
That baseline was pushed and deployed to the API, web, ordinary worker, and ROS worker before
the additional fixes below were released.

## Scope and method

Reviewed the recommendation boundary, lineup/waiver/trade engines, projection admission and
freshness, draft legality and auction gates, analytics/playoff inputs, AI adapters and tool
execution, recap lifecycle and browser state, authentication/account boundaries, provider
ingestion/persistence, and worker refresh/publication paths. Prioritized reproducible wrong
answers, illegal actions, lost state, incorrect accounting, and unnecessary invalidation.
This is a review of these application paths, not a claim that every possible model or provider
failure has been eliminated.

## Additional fixes

| Failure                                                                                                                                             | Correction and evidence                                                                                                                                                                                                                                                                                               |
| --------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| IR/taxi players could become recommended starters or inflate trade value. Empty reserve slots could hide a required trade drop.                     | Use ordinary starter/bench rosters consistently for lineup, waiver, and trade evaluation. Missing reserve forecasts no longer withhold a complete active-roster forecast. Integration regressions cover reserve aliases, both sides of a trade, and forced drops.                                                     |
| Independently legal starter and full-roster assignments could disagree when bench slots restrict positions.                                         | Share one residual-bench legality check across lineup, waiver, and trade. Trade drop search retains another legal candidate when available; impossible advice is withheld.                                                                                                                                            |
| Gemini used a stored interaction ID while explicitly requesting `store:false`.                                                                      | Replay complete stateless step history, including thought signatures and function results. Privacy and provider routing remain unchanged. A two-turn adapter regression rejects the old request shape.                                                                                                                |
| A later tool/provider failure could leave an earlier successful AI turn pending with zero recorded tokens.                                          | Finalize each successful turn immediately. Provider failure handling surrounds only the provider call; internal tool/ledger failures cannot invalidate a working key or finalize the same reservation twice.                                                                                                          |
| Deleting a personal key cleared its usage FK, making its historical usage look like included usage.                                                 | Included quota excludes rows explicitly marked BYOK. Legacy rows without access-mode metadata retain conservative accounting. Disposable PostgreSQL tests exercise deletion and subsequent included reservation.                                                                                                      |
| Login used a pattern match for email, so literal `_` and `%` could select another account.                                                          | Use exact case-insensitive equality, covered against disposable PostgreSQL.                                                                                                                                                                                                                                           |
| One new ESPN `FAILED_*` transaction reason rejected the whole supplemental snapshot.                                                                | Accept bounded, syntactically valid failure reasons while preserving raw status and rejecting malformed/unknown outcomes. Mixed successful/failed fixtures remain readable.                                                                                                                                           |
| ESPN supplemental and Yahoo A→B→A changes collided with historical deduplication.                                                                   | Identify each transition by its current predecessor. Immediate retries remain idempotent. Yahoo rejects older captures and conflicting equal-time captures before changing state; another authorized account still obtains its membership. Disposable PostgreSQL tests inspect persisted results.                     |
| Late recap reads/generation responses could overwrite a different selected week or league.                                                          | Gate responses by request identity, validate response league/week, remount on league changes, and disable generation until the selected recap state is loaded. Fourteen browser checks passed at 390px/1280px; all fourteen defects reproduced against the baseline, even with transport aborts deliberately ignored. |
| Playoff odds could treat a truncated schedule or partially synchronized league as complete, include postseason games, or drop unscored final games. | Require a known qualification cutoff, the full team count, every regular-season period's participants, and complete final-score evidence. Use regular-season records, scoring means, and snapshot identity only. Withhold unsupported median-game odds explicitly.                                                    |

The Gemini correction follows Google's documented
[stateless function-calling contract](https://ai.google.dev/gemini-api/docs/function-calling).
The lineup changes bump recommendation replay identity to `in-season-decisions-v7` and trade
builder identity to `trade-builder-v2`; stored earlier recommendations cannot be reused as
results from the revised logic. No projection weights or model admission thresholds changed.

## Validation and release evidence

Focused regression tests include real disposable PostgreSQL for the usage ledger, literal-email
lookup, provider recurrence/ordering, and previously pending persistence work. Browser race
evidence is in `/tmp/laces-audit-release-20260916/recap-browser-results.json`; the executable
harness and screenshots are alongside it. Consolidated test/build/release logs are in the same
directory. The Mini was unreachable, so validation ran on Linux with one worker for focused tests and at most two for the final suite.

The initial baseline passed 319 targeted tests and a full production build. The final release
also requires consolidated tests, TypeScript, ESLint, formatting, a production build, and live
readiness/contract checks. The release manifest records the exact source revision, runtime
image IDs, and rollback images.

## Explicit limits

- For uncommon constrained benches, lineup advice is withheld when the preferred starter plan
  leaves an illegal bench. This patch does not redesign the optimizer to search every lower
  scoring full-roster arrangement.
- Fantasy bye/missing-participant evidence and median-result simulations are not modeled. Their
  incomplete/unsupported playoff inputs produce an explanation rather than a probability.
- Projection uncertainty remains uncertainty: source disagreement and overlapping outcome ranges
  are disclosed; these fixes do not certify one weekly player outcome in advance.
- Read-only worker inspection found no stuck active ROS simulation. The apparent long process
  CPU values were lifetime averages; instantaneous worker usage was low. Two historical ROS
  dead letters were retained. A complete authorized Yahoo read and normalization dry-run also passed with credential refresh
  and persistence disabled. Historical generic Yahoo errors remain unclassified; no current
  parser defect reproduced, and no extra fix was added without evidence.

Included spicy recap routing remains the Grok/OpenRouter policy introduced by commit `6b192c7`
on August 5, 2026. This review did not change that default.
