import { createHash } from "node:crypto";

import type { ChangeEventKind } from "@fantasy/contracts";
import { canonicalJson } from "@fantasy/rankings";

/**
 * The deduplication half of `change_events_source_deduplication_unique`.
 *
 * `source` names the producer; this key names the **transition**. A replay of the same transition
 * collapses on the partial unique index, while a later genuine recurrence of the same *state* still
 * fires. Those requirements pull in opposite directions, so what
 * makes each kind's recurrence distinct is recorded here rather than left to be re-derived:
 *
 * | kind                     | what collapses a replay                | what makes a later recurrence distinct                                                                                                  |
 * | ------------------------ | -------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------- |
 * | `league.sync.completed`  | the same admitted artifact             | `artifactId` — a different accepted snapshot is a different artifact. A replayed artifact never reaches the emit (`state: "unchanged"`).  |
 * | `roster.changed`         | the same artifact and the same diff    | `artifactId` — an A→B→A→B cycle produces two `A→B` transitions under two different sync runs, so both fire.                              |
 * | `player.injury.changed`  | the same observed state key            | `nextStateKey` — `injuryReportStateKey` hashes `dateModified` alongside the report and practice fields, so a second questionable report is |
 * |                          |                                        | a different state than the first. `leagueId` is included so two managers rostering one player in two leagues each get an event; the       |
 * |                          |                                        | ingestion's `inputChecksum` is deliberately **excluded**, or an artifact refresh touching an unrelated row would re-fire an unchanged     |
 * |                          |                                        | player.                                                                                                                                   |
 * | `recommendation.changed` | the same persisted run                 | `inputChecksum` — the run's `recommendation_runs.input_hash`, which is the persisted ADR 0003 replay identity. A replayed recompute       |
 * |                          |                                        | resolves to the same stored run and therefore the same key.                                                                               |
 *
 * `artifactId` is the identity of the admitted provider artifact: a content checksum where the
 * producer holds one (ESPN bridge) and the `sync_runs.id` otherwise (Yahoo). Both are one-to-one
 * with an accepted snapshot, which is the only property the key needs.
 *
 * Every key is `` `${kind}:${sha256hex(canonicalJson(parts))}` `` — a legible prefix, a bounded
 * length (≤ 87 characters, well inside anything a future check constraint would impose), and stable
 * under key reordering because `canonicalJson` sorts object keys recursively.
 */

export type ChangeEventDeduplicationInput =
  | {
      readonly kind: "league.sync.completed";
      readonly provider: string;
      readonly leagueSeasonId: string;
      readonly artifactId: string;
    }
  | {
      readonly kind: "roster.changed";
      readonly teamId: string;
      readonly season: number;
      readonly week: number | null;
      readonly priorRosterChecksum: string;
      readonly nextRosterChecksum: string;
      readonly artifactId: string;
    }
  | {
      readonly kind: "player.injury.changed";
      readonly playerId: string;
      readonly leagueId: string;
      readonly season: number;
      readonly week: number;
      readonly priorStateKey: string | null;
      readonly nextStateKey: string;
    }
  | {
      readonly kind: "recommendation.changed";
      readonly leagueSeasonId: string;
      readonly fantasyTeamId: string;
      readonly userId: string;
      readonly priorFingerprint: string | null;
      readonly nextFingerprint: string;
      readonly inputChecksum: string;
    };

export function changeEventDeduplicationKey(input: ChangeEventDeduplicationInput): string {
  const digest = createHash("sha256").update(canonicalJson(input), "utf8").digest("hex");
  return `${input.kind satisfies ChangeEventKind}:${digest}`;
}
