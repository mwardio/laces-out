import { objectValue } from "./ai-bounded-text.js";
import type { AiToolLoopCall } from "./ai-tool-loop.js";

/**
 * Renders an answer from tool results with no model involved at all.
 *
 * This is the §2.5 guarantee made concrete: when the daily budget runs out, or the loop hits its
 * turn or wall-clock ceiling, the member still gets the deterministic recommendation. It is a pure
 * function over the engine's own output — it ranks nothing, values nothing, and adds no number that
 * the engine did not produce.
 */

function numberValue(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

function playerName(value: unknown): string | undefined {
  const player = objectValue(value);
  return typeof player?.name === "string" && player.name.length > 0 ? player.name : undefined;
}

function describeChange(change: unknown): string | undefined {
  const record = objectValue(change);
  if (!record) return undefined;
  const slot = typeof record.slotLabel === "string" ? record.slotLabel : "the affected slot";
  const add = playerName(record.add);
  const remove = playerName(record.remove);
  const delta = numberValue(record.projectedPointDelta);
  const gain = delta === undefined ? "" : ` (${delta > 0 ? "+" : ""}${delta} projected points)`;
  const assessment = objectValue(record.assessment);
  const caveat = typeof assessment?.explanation === "string" ? ` ${assessment.explanation}` : "";
  if (add && remove)
    return `- ${assessment?.strength === "close-call" ? "Close call: the model leans toward" : "Start"} ${add} over ${remove} at ${slot}${gain}.${caveat}`;
  if (add) return `- Start ${add} at ${slot}${gain}.`;
  if (remove) return `- Bench ${remove} from ${slot}${gain}.`;
  return undefined;
}

function lineupAnswer(data: unknown): string | undefined {
  const lineup = objectValue(objectValue(data)?.lineup);
  if (!lineup || lineup.state !== "available") return undefined;
  const changes = Array.isArray(lineup.changes) ? lineup.changes : [];
  const lines = changes
    .map((change) => describeChange(change))
    .filter((line): line is string => Boolean(line));
  const current = numberValue(lineup.currentProjectedPoints);
  const optimal = numberValue(lineup.optimalProjectedPoints);
  const freshness = objectValue(objectValue(data)?.projectionFreshness);
  const cutoff = typeof freshness?.label === "string" ? ` ${freshness.label}.` : "";
  const notes = Array.isArray(lineup.notes)
    ? lineup.notes.filter((note): note is string => typeof note === "string").join(" ")
    : "";
  const qualifications = `${cutoff}${notes ? `\n\n${notes}` : ""}`;
  const totals =
    current !== undefined && optimal !== undefined
      ? ` Your current lineup projects ${current}; the proposed one projects ${optimal}.`
      : "";
  if (lines.length === 0) {
    return `Your starters have the highest total under these projections.${totals}${qualifications}`;
  }
  return `The lineup model suggests these changes:\n\n${lines.join("\n")}\n${totals}${qualifications}`.trim();
}

function unavailableAnswer(outcome: AiToolLoopCall["outcome"]): string | undefined {
  if (outcome.state === "unavailable") {
    return `The deterministic lineup result is unavailable: ${outcome.message}`;
  }
  if (outcome.state === "denied") {
    return "The deterministic lineup result could not be read for this league in the current session.";
  }
  return undefined;
}

const FALLBACK =
  "The AI summary could not be completed for this request, and no deterministic lineup result was retrieved. Open Decision Desk for the full engine output.";

export function deterministicFeatureAnswer(toolResults: readonly AiToolLoopCall[]): string {
  for (const call of toolResults) {
    if (call.name !== "get_lineup_recommendation") continue;
    if (call.outcome.state === "ok") {
      const answer = lineupAnswer(call.outcome.data);
      if (answer) return answer;
    }
    const unavailable = unavailableAnswer(call.outcome);
    if (unavailable) return unavailable;
  }
  return FALLBACK;
}
