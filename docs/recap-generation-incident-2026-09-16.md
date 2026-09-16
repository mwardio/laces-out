# Recap generation incident — September 16, 2026

The Android's Dungeon could load the recap panel but every attempted generation ended with
“The request could not be completed.” Production failures at 23:01–23:02 UTC showed the same
database error under included Grok and a personal OpenRouter configuration.

## Confirmed failures

1. `reserveDailyRequest` inserted an AI usage reservation before calling the provider, but the
   ledger's original append-only trigger rejected `finalizeUsage`. Success recording ran inside
   the provider-error catch, so a local persistence failure was then misclassified as a provider
   failure and a second rejected update obscured the original error.
2. Once recording worked, a live Week 1 retry produced a Week 2 unavailability explanation.
   Recaps shared the current dashboard, Decision Desk and full analytics prompt. Large context
   could truncate away the historical awards; the depth bound also removed nested opponent names.
   Current-week matchup information remained, anchoring the model to the wrong week. Any nonempty
   response could previously become the stored recap.

## Corrections

- Migration `0048_finalize_ai_usage_reservations` permits only one pristine reservation-to-terminal
  transition. Completed usage remains immutable. Identity, model, metadata, cost and reservation
  date remain fixed; FK anonymization still works. The exception deliberately recognizes existing
  pristine reservations so the incident records can be finalized without deletion.
- Provider errors are caught only around provider execution. Usage persistence errors do not
  overwrite successful usage or mark a personal key as faulty. Recap prompt dependencies load
  before an allowance is reserved. Finishing after midnight preserves the original admission day.
- Typed recap errors retain their controlled explanation and code. Unexpected server errors and
  raw provider responses remain sanitized.
- Recaps use only the selected week's validated awards, associated matchup scores, league identity
  and optional League Intel. The award evidence is flattened to preserve names and scores through
  bounded serialization. They no longer depend on the current dashboard or Decision Desk.
- The model returns an explicit week/status/body envelope. Unavailable, malformed or wrong-week
  output is rejected before persistence, with actual token usage retained. Validation checks the
  envelope and body bounds; it is not a complete factual verifier of natural-language prose.

## Incident recovery

The two exact reservations identified in the production error logs were finalized with
`AI_USAGE_RECORDING_FAILED`. Only that operator-confirmed incident code is excluded from daily
allowance counts; ordinary provider errors still count. Audit rows were retained.

The first verification response exposed the context defect and was saved as a 413-character
unavailability explanation. A subsequent repair verifies that exact saved response and timestamp
before replacing it through normal recap generation. The repair permits one additional included
call in its isolated operator process; it does not change the production allowance or provider
settings, and the first verification call's completed usage remains intact.

## Included-provider history

Commit `6b192c7` (“Route spicy recaps through managed Grok”), August 5, 2026, introduced included
Medium/Scorched routing to `x-ai/grok-4.3` through OpenRouter. Mild uses included Gemini. These are
server defaults independent of personal provider settings; this repair does not change them.

## Validation

134 targeted tests across six suites passed, including nine tests against fully migrated disposable
PostgreSQL. Coverage includes completion, concurrency, replay protection, midnight accounting,
incident refunds, selected-week context retention, output rejection and route error sanitization.
Workspace type checking, changed-file lint, formatting and the API build passed on Linux.
The Mini doctor timed out, so no Darwin/ARM64 validation is claimed.

Migration 0048 was applied using the normal migration runner. API images, the previous trigger,
and live verification metadata are retained in `/tmp/laces-recap-release-20260916`.

At 23:14:59 UTC, the corrected included Grok path generated a 937-character Week 1 recap for
Android's Dungeon. A subsequent authorized service read retrieved the same saved recap and
validated its response contract. The live text described the completed Week 1 games and awards,
rather than an unavailable current-week forecast. Public API readiness passed after deployment.
