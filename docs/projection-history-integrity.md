# Projection history and scoring integrity

League scoring is applied to shared football projections. Linear rules can rescore the projected
stat components directly. Threshold bonuses and whole-group scoring require the corresponding
outcome distribution; scoring an average stat line is not equivalent to averaging its scores.
The shared ROS outcome corpus preserves those distributions so adding an ordinary scoring
profile does not require another physical simulation corpus.

## Observed zero games and position changes

The history builder already creates zero-production games when completed-game participation or
availability evidence establishes a zero game without a player-stat row. Such a game must retain
zero passing, rushing, and receiving touchdown totals and their nested 40+/50+ yard events,
regardless of the player's position at that time. A later position change must not turn a known
zero into missing evidence.

This distinction matters for a player who appeared as a quarterback before becoming a tight end.
The contextual model can use personal history across positions, while the recency baseline uses
history at the target position. Previously, position-specific synthetic zeros could leave only
one candidate missing receiving touchdown components, causing strict ROS validation to fail.

This correction applies only to already-established zero games. Real aggregate-only or partially
enriched source rows retain unknown touchdown-distance values. Missing observations are never
converted into observed zeros merely to make validation pass.

## Early checks and cache identity

The historical validation CLI checks the selected player cohorts across qualified cutoffs before
fitting or simulating. Its component check uses the same evidence guard as the weekly candidates.
`--preflight-only` performs this check without simulations or database writes. Passing preflight
is a source-coverage result, not a completed backtest, statistical admission, or publication.

`FIRST_PARTY_PLAYER_HISTORY_VERSION` identifies history-assembly semantics in weekly identities
and the shared ROS build protocol. A changed history also changes its forecast fingerprints and
simulation inputs. Existing outcome vectors are reusable only when their exact keys still match;
renaming vectors or retaining obsolete identities would invalidate the audit trail. In particular,
adding truthful zero fields changes the shared offensive history fingerprint even for forecasts
whose point estimates happen to remain unchanged. Independent unchanged D/ST inputs can retain
matching cache keys.

A release that changes history assembly therefore requires a compatible complete corpus and
exact-profile admission before publishing its ROS results. Ordinary league onboarding reuses
the compatible shared corpus and performs league scoring and validation against it.

The ROS champion policy is version 5 for this correction. It requires evidence built from player
history version 2. Older admitted artifacts and queued validation identities remain distinguishable
and cannot stand in for the corrected release. Physical model, random-seed, and outcome-cache
format versions are unchanged.
