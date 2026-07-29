import {
  aiToolArgumentsSchema,
  aiToolProvenanceSchema,
  lineupRecommendationTool,
  type AiToolDefinition,
  type AiToolDenialCode,
  type AiToolName,
  type AiToolOutcome,
  type AiToolProvenance,
} from "@fantasy/contracts";
import { boundedValue, neutralizeLeagueDataDelimiters, objectValue } from "./ai-bounded-text.js";
import { AI_TOOL_LOOP_LIMITS } from "./ai-tool-loop.js";

/**
 * Executable, server-authorized tools.
 *
 * The registry lives in `apps/api` rather than in a package because authorization is not a pure
 * function: every execution calls the same league-scoped service the HTTP route calls, which runs
 * the same `findMembership(userId, leagueId)`. There is deliberately no fourth copy of that query
 * here — the tools reuse the services that already own it.
 */

/**
 * The scope a call runs in. Every field comes from the server: `userId` from the authenticated
 * session, `leagueId` from the member's own request body. None of it is ever model-supplied, and
 * none of it is ever cached across turns.
 */
export interface AiToolContext {
  readonly userId: string;
  readonly leagueId: string;
  readonly draftId: string | null;
  readonly now: Date;
}

export interface AiExecutableTool {
  readonly definition: AiToolDefinition;
  execute(context: AiToolContext, rawArguments: unknown): Promise<AiToolOutcome>;
}

/**
 * Structurally identical to `AiSnapshotPort` in `ai-service.ts`, declared here so the registry does
 * not import the service that constructs it.
 */
export interface AiToolSnapshotPort {
  getSnapshot(userId: string, leagueId: string): Promise<unknown>;
}

export interface AiToolServices {
  readonly decisions: AiToolSnapshotPort;
}

function denied(code: AiToolDenialCode, message: string): AiToolOutcome {
  return { state: "denied", code, message };
}

/**
 * A member who is not in the league and a league that does not exist produce the same answer, the
 * same way `league-analytics-routes.ts` and `draft-session.ts` already collapse them. A tool that
 * distinguished them would be a league-existence oracle reachable through a language model.
 */
const NOT_AUTHORIZED_MESSAGE =
  "No accessible league decision snapshot for the signed-in member in this request's scope.";

function text(value: unknown): string | null {
  return typeof value === "string" && value.length > 0 ? value : null;
}

/**
 * The ADR 0003 provenance of a decision-snapshot-backed tool result.
 *
 * Both fields are the snapshot's own — `InSeasonDecisionSnapshot.provenance` now carries the
 * algorithm version and the canonical `inputChecksum` that `decisionSnapshotInputChecksum` computes
 * with `recommendation_runs.input_hash`'s own function. The registry passes them through and
 * recomputes nothing: a tool that derived a narrower digest over the fields it happened to see would
 * report weaker provenance than the deterministic surface it wraps, which is the inversion ADR 0003
 * exists to prevent.
 *
 * `checksumScope` stays, and stays `decision-snapshot-provenance`: the digest is the on-demand
 * snapshot's, computed under the `decision-snapshot` scope, so it is still a different digest from
 * any per-kind `recommendation_runs.input_hash` over the same league. Naming which one a caller is
 * holding is exactly what the field is for, and the enum is what a second tool over a different
 * deterministic surface will extend.
 */
function decisionProvenance(snapshot: Record<string, unknown>): AiToolProvenance | undefined {
  const provenance = objectValue(snapshot.provenance);
  const algorithmVersion = text(provenance?.algorithmVersion);
  const inputChecksum = text(provenance?.inputChecksum);
  // Never synthesized. A snapshot that cannot state its own reproducibility does not get provenance
  // invented on its behalf; the call reports itself unavailable instead.
  if (!algorithmVersion || !inputChecksum || !/^[0-9a-f]{64}$/u.test(inputChecksum)) {
    return undefined;
  }
  const freshness = objectValue(provenance?.projectionFreshness);
  const warnings: string[] = [];
  if (!provenance?.projectionSet) {
    warnings.push("projection-set-absent: the decision snapshot names no projection set");
  }
  const freshnessState = text(freshness?.state);
  if (freshnessState && freshnessState !== "fresh") {
    warnings.push(`projection-freshness: ${freshnessState}`);
  }
  if (!text(provenance?.leagueLastSyncedAt)) {
    warnings.push("league-sync-unknown: the decision snapshot records no last league sync");
  }
  return aiToolProvenanceSchema.parse({
    algorithmVersion,
    inputChecksum,
    checksumScope: "decision-snapshot-provenance",
    generatedAt: text(snapshot.generatedAt),
    warnings,
  } satisfies AiToolProvenance);
}

/**
 * Serialize a projection, neutralize any forged delimiter inside it, and hard-cap the result.
 *
 * Returning the parsed-back value rather than the string keeps the outcome inspectable by tests and
 * by the loop while guaranteeing the loop can never be handed an over-budget payload.
 */
function boundedProjection(value: unknown): unknown {
  const bounded = boundedValue(value);
  const serialized = neutralizeLeagueDataDelimiters(JSON.stringify(bounded) ?? "null");
  if (serialized.length <= AI_TOOL_LOOP_LIMITS.maxToolResultChars) {
    return JSON.parse(serialized) as unknown;
  }
  const compact = neutralizeLeagueDataDelimiters(
    JSON.stringify(boundedValue(value, 0, 4)) ?? "null",
  );
  if (compact.length <= AI_TOOL_LOOP_LIMITS.maxToolResultChars) {
    return JSON.parse(compact) as unknown;
  }
  return {
    resultTruncated: true,
    notice: "The deterministic result exceeded the per-tool character budget.",
    excerpt: compact.slice(0, AI_TOOL_LOOP_LIMITS.maxToolResultChars - 200),
  };
}

/**
 * An `unavailable` engine section becomes an `unavailable` tool outcome carrying the engine's own
 * reason code. It never becomes a blank answer the model is free to fill in.
 */
function unavailableFromSection(section: Record<string, unknown>): AiToolOutcome | undefined {
  if (section.state !== "unavailable") return undefined;
  const reasons = Array.isArray(section.reasons) ? section.reasons : [];
  const first = objectValue(reasons[0]);
  return {
    state: "unavailable",
    code: (text(first?.code) ?? "SECTION_UNAVAILABLE").slice(0, 120),
    message: (
      text(first?.message) ?? "The deterministic engine could not produce this section."
    ).slice(0, 500),
  };
}

class LineupRecommendationTool implements AiExecutableTool {
  readonly definition = lineupRecommendationTool;
  readonly #decisions: AiToolSnapshotPort;

  constructor(decisions: AiToolSnapshotPort) {
    this.#decisions = decisions;
  }

  async execute(context: AiToolContext, rawArguments: unknown): Promise<AiToolOutcome> {
    // Parse first, and touch no service if it fails. An argument the schema does not declare is a
    // model widening its own scope, not a harmless extra.
    const parsed = aiToolArgumentsSchema("get_lineup_recommendation").safeParse(rawArguments ?? {});
    if (!parsed.success) {
      return denied(
        "INVALID_ARGUMENTS",
        "get_lineup_recommendation accepts an optional NFL week and nothing else. The league, team, and member are supplied by the server.",
      );
    }

    // Authorization is re-run here, on every call, by the same service the HTTP route uses.
    const snapshot = objectValue(
      await this.#decisions.getSnapshot(context.userId, context.leagueId),
    );
    if (!snapshot) return denied("NOT_AUTHORIZED", NOT_AUTHORIZED_MESSAGE);

    const lineup = objectValue(snapshot.lineup);
    if (!lineup || typeof lineup.state !== "string") {
      return {
        state: "unavailable",
        code: "SECTION_UNREADABLE",
        message: "The decision snapshot contains no readable lineup section.",
      };
    }
    const unavailable = unavailableFromSection(lineup);
    if (unavailable) return unavailable;

    const toolProvenance = decisionProvenance(snapshot);
    if (!toolProvenance) {
      return {
        state: "unavailable",
        code: "PROVENANCE_UNREADABLE",
        message:
          "The decision snapshot did not state the algorithm version and input checksum its recommendation was computed under.",
      };
    }

    const provenance = objectValue(snapshot.provenance);
    const league = objectValue(snapshot.league);
    const requestedWeek = parsed.data.week;
    const snapshotWeek = typeof league?.week === "number" ? league.week : null;
    const data = boundedProjection({
      // Only the section this tool wraps. Waivers, trades, FAAB, and every other team's roster are
      // out of scope for this tool and are not projected at any depth.
      lineup,
      season: typeof league?.season === "number" ? league.season : null,
      week: snapshotWeek,
      ...(requestedWeek !== undefined && requestedWeek !== snapshotWeek
        ? {
            requestedWeekIgnored: requestedWeek,
            note: "The deterministic snapshot is scoped to its own week; the requested week was not used.",
          }
        : {}),
      projectionFreshness: provenance?.projectionFreshness ?? null,
      projectionSet: provenance?.projectionSet ?? null,
    });

    return { state: "ok", data, provenance: toolProvenance };
  }
}

export function createAiToolRegistry(
  services: AiToolServices,
): ReadonlyMap<AiToolName, AiExecutableTool> {
  return new Map<AiToolName, AiExecutableTool>([
    ["get_lineup_recommendation", new LineupRecommendationTool(services.decisions)],
  ]);
}
