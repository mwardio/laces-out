import { createHash } from "node:crypto";

import {
  draftAnalysisResponseSchema,
  type DraftAnalysisMarketProvenance,
  type DraftAnalysisProjectionUnavailableReason,
  type DraftAnalysisResponse,
  type DraftMarketBaseline,
} from "@laces-out/contracts";
import { leagueSeasons, playerProjections, projectionSets, type Database } from "@laces-out/db";
import { playerId } from "@laces-out/domain";
import {
  analyzeDraft,
  DRAFT_ANALYZER_ALGORITHM_VERSION,
  type DraftAnalysisMarket,
  type DraftAnalysisMarketPlayer,
  type DraftAnalysisProjection,
  type DraftAnalysisProjectionSet,
  type DraftConfig,
  type DraftEvent,
} from "@laces-out/engine-draft";

import { and, asc, desc, eq, inArray, sql } from "drizzle-orm";

import type { DraftSessionEventRecord, DraftSessionSnapshot } from "./draft-session.js";
import { currentManagedProjectionProfileKey } from "./managed-projection-profile.js";

/**
 * Translates the stored event ledger into the exact list `analyzeDraft` consumes.
 *
 * `DraftSessionEventRecord.event` is already the engine's own branded `DraftEvent`, so nothing is
 * renamed or widened here. The mapper exists to fail loudly instead of quietly:
 *
 * - a future eighth `DraftEvent` variant becomes a compile error at the `never` assignment below,
 *   rather than reaching an analyzer that does not model it;
 * - `DRAFT_EVENT_REVERTED` is forwarded, never filtered — `analyzeDraft` resolves the live
 *   acquisitions through `reduceDraft`, so dropping reverts would resurrect undone picks;
 * - a stream with a sequence gap is refused rather than analyzed as if it were whole.
 */
export function analyzerEventsFrom(
  records: readonly DraftSessionEventRecord[],
): readonly DraftEvent[] {
  const events: DraftEvent[] = [];
  for (const [index, record] of records.entries()) {
    if (record.sequence !== index + 1) {
      throw new Error(
        `Draft analysis requires a contiguous event stream; expected sequence ${index + 1} but found ${record.sequence}`,
      );
    }
    switch (record.event.type) {
      case "SNAKE_PLAYER_SELECTED":
      case "SNAKE_KEEPER_ASSIGNED":
      case "AUCTION_KEEPER_ASSIGNED":
      case "AUCTION_NOMINATION_STARTED":
      case "AUCTION_BID_PLACED":
      case "AUCTION_PLAYER_SOLD":
      case "DRAFT_EVENT_REVERTED":
        events.push(record.event);
        break;
      default: {
        const unmodelled: never = record.event;
        throw new Error(
          `Draft analysis cannot model event type ${String((unmodelled as { readonly type: string }).type)}`,
        );
      }
    }
  }
  return events;
}

export interface AnalyzerMarketMapping {
  /** Absent whenever the admitted baseline cannot be handed to the analyzer as-is. */
  readonly market?: DraftAnalysisMarket;
  readonly provenance: DraftAnalysisMarketProvenance;
}

/**
 * Maps the already-authorized draft-market read onto the analyzer's admitted-market input.
 *
 * `analyzeDraft` throws on a market row it cannot reconcile with the draft pool, so every
 * structural gap is resolved here and counted rather than allowed to fail the whole report. The
 * baseline publishes ADP only: no `tier`, no `auctionValue`. Neither is derived, because the
 * analyzer's contract treats this input as source-admitted and inventing a value would manufacture
 * an admission that no source actually made.
 */
export function analyzerMarketFrom(
  baseline: DraftMarketBaseline,
  config: DraftConfig,
): AnalyzerMarketMapping {
  if (baseline.state === "unavailable") {
    return {
      provenance: { state: "unavailable", reason: baseline.reason, detail: baseline.detail },
    };
  }

  const pool = new Set(config.players.map((player) => String(player.id)));
  const seen = new Set<string>();
  const players: DraftAnalysisMarketPlayer[] = [];
  let notInPool = 0;
  let duplicate = 0;
  let invalidAdp = 0;

  for (const row of baseline.players) {
    if (seen.has(row.playerId)) {
      // A repeat inside the draft pool is an integrity failure, not a row to skip: the file
      // disagrees with itself about a player this report would grade.
      if (pool.has(row.playerId)) {
        return {
          provenance: {
            state: "unavailable",
            reason: "market-integrity",
            detail: `The admitted draft-market file repeats player ${row.playerId}, so reach and value analysis is withheld rather than graded against an ambiguous baseline.`,
          },
        };
      }
      duplicate += 1;
      continue;
    }
    seen.add(row.playerId);
    if (!pool.has(row.playerId)) {
      notInPool += 1;
      continue;
    }
    if (!Number.isFinite(row.overallAdp) || row.overallAdp <= 0) {
      invalidAdp += 1;
      continue;
    }
    players.push({ playerId: playerId(row.playerId), adp: row.overallAdp });
  }

  if (players.length === 0) {
    // An empty `players` list would still satisfy `input.market !== undefined` and would silently
    // suppress the analyzer's own NO_ADMITTED_MARKET_BASELINE warning.
    return {
      provenance: {
        state: "unavailable",
        reason: "no-pool-overlap",
        detail: `None of the ${baseline.players.length} admitted market rows matched the ${pool.size} players in this draft pool, so there is nothing to grade against.`,
      },
    };
  }

  return {
    market: {
      admissionStatus: "ADMITTED",
      source: baseline.source.key,
      sourceVersion: baseline.source.checksumSha256,
      asOf: baseline.source.sourceAsOf,
      players,
    },
    provenance: {
      state: "available",
      source: baseline.source,
      coveredPlayers: players.length,
      poolPlayers: pool.size,
      droppedRows: { notInPool, duplicate, invalidAdp },
      auctionValuesPublished: players.some((row) => row.auctionValue !== undefined),
    },
  };
}

/**
 * A compatible set may not predate the draft by more than this. A months-old preseason forecast is
 * a different opinion about the season than the one the room was drafting against.
 */
export const DRAFT_PROJECTION_MAX_AGE_DAYS = 45;

/** Draft grading is a season-long question, so a week or rest-of-season set is not a substitute. */
const DRAFT_PROJECTION_HORIZON = "full-season";
const dayInMilliseconds = 24 * 60 * 60 * 1_000;

export interface DraftProjectionCandidate {
  readonly id: string;
  readonly source: string;
  readonly version: string;
  readonly season: number;
  readonly horizon: "week" | "rest-of-season" | "full-season";
  readonly windowStartWeek: number;
  readonly asOfWeek: number;
  readonly fetchedAt: string;
  readonly scoringProfileKey: string | null;
}

export type DraftProjectionSelection =
  | {
      readonly status: "SELECTED";
      readonly candidate: DraftProjectionCandidate;
      readonly leagueScoringProfileId: string;
    }
  | {
      readonly status: "UNAVAILABLE";
      readonly reason: DraftAnalysisProjectionUnavailableReason;
      readonly detail: string;
      readonly candidatesConsidered: number;
    };

export interface DraftProjectionSelectionInput {
  readonly leagueScoringProfileId: string | null;
  readonly season: number;
  readonly draftStartedAt: string;
  readonly candidates: readonly DraftProjectionCandidate[];
}

/**
 * Picks the one projection set this draft may honestly be graded against, or states why none may.
 *
 * "Latest row" is not a compatibility policy. A set qualifies only when its season, horizon,
 * window, vantage, and scoring profile all match the league exactly, and only when it was published
 * before the room started drafting — grading a manager against numbers released afterwards is
 * hindsight, not analysis. There is no cross-profile and no cross-horizon fallback.
 */
export function selectDraftProjectionSet(
  input: DraftProjectionSelectionInput,
): DraftProjectionSelection {
  const considered = input.candidates.length;
  const profile = input.leagueScoringProfileId;
  if (profile === null || profile.trim() === "") {
    return {
      status: "UNAVAILABLE",
      reason: "NO_LEAGUE_SCORING_PROFILE",
      detail:
        "This league's scoring rules do not normalize to a projection scoring profile, so no projection set can be verified as compatible.",
      candidatesConsidered: considered,
    };
  }

  const draftStartedAtMs = Date.parse(input.draftStartedAt);
  const compatible = input.candidates.filter(
    (row) =>
      row.season === input.season &&
      row.horizon === DRAFT_PROJECTION_HORIZON &&
      row.windowStartWeek === 1 &&
      row.asOfWeek === 0 &&
      row.scoringProfileKey === profile &&
      Number.isFinite(Date.parse(row.fetchedAt)),
  );
  if (compatible.length === 0 || !Number.isFinite(draftStartedAtMs)) {
    return {
      status: "UNAVAILABLE",
      reason: "NO_COMPATIBLE_SET",
      detail: `No ${DRAFT_PROJECTION_HORIZON} projection set scored under ${profile} for ${input.season} is available to this draft.`,
      candidatesConsidered: considered,
    };
  }

  const published = compatible.filter((row) => Date.parse(row.fetchedAt) <= draftStartedAtMs);
  if (published.length === 0) {
    return {
      status: "UNAVAILABLE",
      reason: "PUBLISHED_AFTER_DRAFT_START",
      detail: `Every ${DRAFT_PROJECTION_HORIZON} projection set scored under ${profile} was published after this draft started, so grading against it would be hindsight rather than analysis.`,
      candidatesConsidered: considered,
    };
  }

  const oldestAllowedMs = draftStartedAtMs - DRAFT_PROJECTION_MAX_AGE_DAYS * dayInMilliseconds;
  const fresh = published.filter((row) => Date.parse(row.fetchedAt) >= oldestAllowedMs);
  if (fresh.length === 0) {
    return {
      status: "UNAVAILABLE",
      reason: "STALE_BEFORE_DRAFT",
      detail: `The newest ${DRAFT_PROJECTION_HORIZON} projection set scored under ${profile} predates this draft by more than ${DRAFT_PROJECTION_MAX_AGE_DAYS} days.`,
      candidatesConsidered: considered,
    };
  }

  // Ties break on id so the same stored rows always select the same set, whatever order the
  // database returned them in.
  const selected = [...fresh].sort(
    (left, right) =>
      Date.parse(right.fetchedAt) - Date.parse(left.fetchedAt) || left.id.localeCompare(right.id),
  )[0]!;
  return { status: "SELECTED", candidate: selected, leagueScoringProfileId: profile };
}

/** Fixed rather than inherited from the engine default so the checksum describes a real decision. */
const MISSED_ALTERNATIVE_LIMIT = 3;

export interface BuildDraftAnalysisInput {
  readonly session: DraftSessionSnapshot;
  readonly baseline: DraftMarketBaseline;
  readonly projections: DraftProjectionSelection;
  readonly projectionRows: readonly {
    readonly playerId: string;
    readonly projectedPoints: number;
  }[];
  readonly generatedAt: string;
}

function analyzerProjectionsFrom(
  selection: DraftProjectionSelection,
  config: DraftConfig,
  rows: readonly { readonly playerId: string; readonly projectedPoints: number }[],
): DraftAnalysisProjectionSet | undefined {
  if (selection.status !== "SELECTED") return undefined;
  const pool = new Set(config.players.map((player) => String(player.id)));
  const seen = new Set<string>();
  const players: DraftAnalysisProjection[] = [];
  for (const row of rows) {
    if (!pool.has(row.playerId) || seen.has(row.playerId)) continue;
    if (!Number.isFinite(row.projectedPoints)) continue;
    seen.add(row.playerId);
    players.push({ playerId: playerId(row.playerId), projectedPoints: row.projectedPoints });
  }
  return {
    source: selection.candidate.source,
    sourceVersion: selection.candidate.version,
    asOf: selection.candidate.fetchedAt,
    horizon: selection.candidate.horizon,
    scoringProfileId: selection.leagueScoringProfileId,
    players,
  };
}

/**
 * Assembles the analyzer input from one authorized snapshot and returns the wire envelope.
 *
 * Both analyzer inputs are optional by design, which is what lets this ship before any
 * draft-timed projection set exists: with no projections the report still carries roster
 * construction and ADP-relative reach and value, and says plainly why team strength is withheld.
 * That is a degraded state with a stated reason, never an error.
 *
 * A `DraftInvariantError` or `RangeError` out of `analyzeDraft` is allowed to propagate. It means
 * the stored stream disagrees with the stored config, which the session repository already treats
 * as a corrupt stream; masking it as a warning would present a wrong report as a right one.
 */
export function buildDraftAnalysis(input: BuildDraftAnalysisInput): DraftAnalysisResponse {
  const { session, projections: selection } = input;
  const events = analyzerEventsFrom(session.events);
  const { market, provenance } = analyzerMarketFrom(input.baseline, session.config);
  const projectionSet = analyzerProjectionsFrom(selection, session.config, input.projectionRows);

  // `exactOptionalPropertyTypes` is on, so an absent input is an absent key rather than `undefined`.
  const report = analyzeDraft({
    config: session.config,
    events,
    missedAlternativeLimit: MISSED_ALTERNATIVE_LIMIT,
    ...(market ? { market } : {}),
    ...(projectionSet && selection.status === "SELECTED"
      ? {
          projections: projectionSet,
          leagueScoringProfileId: selection.leagueScoringProfileId,
        }
      : {}),
  });

  const envelopeWarnings: { readonly code: string; readonly message: string }[] = [];
  if (provenance.state === "unavailable") {
    envelopeWarnings.push({
      code: "MARKET_UNAVAILABLE",
      message: `The admitted draft-market baseline is unavailable (${provenance.reason}): ${provenance.detail} Roster construction is unaffected.`,
    });
  }
  if (
    session.config.mode === "AUCTION" &&
    provenance.state === "available" &&
    !provenance.auctionValuesPublished
  ) {
    envelopeWarnings.push({
      code: "AUCTION_BASELINE_UNAVAILABLE",
      message: `${provenance.source.name} publishes average draft position only, with no auction values, so price and value grades are withheld rather than derived. Budget, pace, bid legality, and roster construction are unaffected.`,
    });
  }
  if (selection.status === "UNAVAILABLE") {
    envelopeWarnings.push({
      code: "PROJECTIONS_UNAVAILABLE",
      message: `${selection.detail} Roster construction and ADP-relative reach and value are unaffected; only projection-derived team strength is withheld.`,
    });
  }

  // The envelope's own reasons are strictly richer than the engine's — they name the league scoring
  // profile and the exact source — so where both speak to the same code, the envelope's wins.
  const envelopeCodes = new Set(envelopeWarnings.map((warning) => warning.code));
  const warnings = [
    ...report.warnings.filter((warning) => !envelopeCodes.has(warning.code)),
    ...envelopeWarnings,
  ];

  // An explicit ordered array, never `JSON.stringify` of an object: key order is not a contract.
  const inputChecksum = createHash("sha256")
    .update(
      JSON.stringify([
        DRAFT_ANALYZER_ALGORITHM_VERSION,
        session.id,
        session.sequence,
        session.config.mode,
        events.map((event) => String(event.id)),
        market?.sourceVersion ?? null,
        selection.status === "SELECTED" ? selection.candidate.id : null,
        MISSED_ALTERNATIVE_LIMIT,
      ]),
    )
    .digest("hex");

  const envelope = {
    draftId: session.id,
    sequence: session.sequence,
    generatedAt: input.generatedAt,
    algorithmVersion: report.algorithmVersion,
    inputChecksum,
    mode: report.mode,
    draftStatus: report.draftStatus,
    market: provenance,
    projections:
      selection.status === "SELECTED"
        ? {
            state: "available",
            setId: selection.candidate.id,
            source: selection.candidate.source,
            version: selection.candidate.version,
            horizon: selection.candidate.horizon,
            scoringProfileId: selection.leagueScoringProfileId,
            asOf: selection.candidate.fetchedAt,
            coveredPlayers: projectionSet?.players.length ?? 0,
          }
        : {
            state: "unavailable",
            reason: selection.reason,
            detail: selection.detail,
            candidatesConsidered: selection.candidatesConsidered,
          },
    teams: report.teams,
    warnings,
  };

  // Parsed rather than cast: the engine owns these shapes, so a future engine field would otherwise
  // reach the browser unvalidated. This is also where the readonly engine types become the wire type.
  const parsed = draftAnalysisResponseSchema.safeParse(envelope);
  if (!parsed.success) {
    throw new Error("Draft analysis produced a response the wire contract rejects", {
      cause: parsed.error,
    });
  }
  return parsed.data;
}

/** Bounded reads: a draft pool is a few hundred players and a league keeps a handful of sets. */
const DRAFT_PROJECTION_CANDIDATE_LIMIT = 25;
const DRAFT_PROJECTION_ROW_LIMIT = 600;

export interface DraftProjectionRow {
  readonly playerId: string;
  readonly projectedPoints: number;
}

export interface DraftProjectionSource {
  /** Null when the league's scoring rules do not normalize to a projection scoring profile. */
  leagueScoringProfileId(leagueSeasonId: string): Promise<string | null>;
  season(leagueSeasonId: string): Promise<number | null>;
  listCandidates(
    leagueSeasonId: string,
    season: number,
    limit: number,
  ): Promise<readonly DraftProjectionCandidate[]>;
  listRows(
    projectionSetId: string,
    playerIds: readonly string[],
    limit: number,
  ): Promise<readonly DraftProjectionRow[]>;
}

export interface DraftAnalysisSessionReader {
  getSession(userId: string, draftId: string): Promise<DraftSessionSnapshot>;
}

export interface DraftAnalysisMarketReader {
  getBaseline(userId: string, draftId: string): Promise<DraftMarketBaseline>;
}

export class DraftAnalysisService {
  readonly #sessions: DraftAnalysisSessionReader;
  readonly #market: DraftAnalysisMarketReader;
  readonly #projections: DraftProjectionSource;
  readonly #now: () => Date;

  constructor(
    sessions: DraftAnalysisSessionReader,
    market: DraftAnalysisMarketReader,
    projections: DraftProjectionSource,
    now: () => Date = () => new Date(),
  ) {
    this.#sessions = sessions;
    this.#market = market;
    this.#projections = projections;
    this.#now = now;
  }

  async getAnalysis(userId: string, draftId: string): Promise<DraftAnalysisResponse> {
    // Authorization happens here and only here, and before any other read, so an unknown or
    // inaccessible draft answers exactly as `GET /v1/drafts/:draftId` does.
    const session = await this.#sessions.getSession(userId, draftId);

    const [baseline, leagueScoringProfileId, season] = await Promise.all([
      // The market read inner-joins memberships while the session read honors league ownership, so
      // an owner with no membership row can be authorized here yet unknown there. That degrades the
      // market section with a stated reason; it is never read back as an authorization signal.
      this.#market.getBaseline(userId, draftId),
      this.#projections.leagueScoringProfileId(session.leagueSeasonId),
      this.#projections.season(session.leagueSeasonId),
    ]);

    // Grading against numbers published after the room started is hindsight, so the vantage is the
    // first recorded event, or room creation for a draft that has recorded nothing yet.
    const draftStartedAt = session.events[0]?.occurredAt ?? session.createdAt;
    const selection = await this.#selectProjections({
      leagueSeasonId: session.leagueSeasonId,
      leagueScoringProfileId,
      season,
      draftStartedAt,
    });

    const projectionRows =
      selection.status === "SELECTED"
        ? await this.#projections.listRows(
            selection.candidate.id,
            session.config.players.map((player) => String(player.id)),
            DRAFT_PROJECTION_ROW_LIMIT,
          )
        : [];

    return buildDraftAnalysis({
      session,
      baseline,
      projections: selection,
      projectionRows,
      generatedAt: this.#now().toISOString(),
    });
  }

  async #selectProjections(input: {
    readonly leagueSeasonId: string;
    readonly leagueScoringProfileId: string | null;
    readonly season: number | null;
    readonly draftStartedAt: string;
  }): Promise<DraftProjectionSelection> {
    if (input.season === null) {
      return {
        status: "UNAVAILABLE",
        reason: "NO_COMPATIBLE_SET",
        detail:
          "This draft is not attached to a recorded league season, so no projection set can be matched to it.",
        candidatesConsidered: 0,
      };
    }
    const candidates =
      input.leagueScoringProfileId === null
        ? []
        : await this.#projections.listCandidates(
            input.leagueSeasonId,
            input.season,
            DRAFT_PROJECTION_CANDIDATE_LIMIT,
          );
    return selectDraftProjectionSet({
      leagueScoringProfileId: input.leagueScoringProfileId,
      season: input.season,
      draftStartedAt: input.draftStartedAt,
      candidates,
    });
  }
}

/**
 * Reads projection-set candidates for one league season.
 *
 * League-visible sets only. A private import belongs to the member who created it, and this route
 * authorizes a draft room rather than a projection set, so it must not widen anyone's view of
 * another member's work. Compatibility itself is decided by `selectDraftProjectionSet`, not here,
 * so the policy stays pure and testable.
 */
export class DrizzleDraftProjectionSource implements DraftProjectionSource {
  readonly #database: Database;

  constructor(database: Database) {
    this.#database = database;
  }

  // Unlike the other three `currentManagedProjectionProfileKey` call sites, a null return here is
  // NOT silent: `selectDraftProjectionSet` (above) already turns it into a distinct wire reason,
  // `NO_LEAGUE_SCORING_PROFILE`, separate from `NO_COMPATIBLE_SET` (key present, nothing published
  // yet under it) — so "scoring unsupported" and "no managed set for this profile yet" are already
  // told apart at the wire. What is still lost is WHY the key is null (bounded-read sentinel vs.
  // zero supported positions vs. which positions specifically) — `currentManagedProjectionProfile`
  // (`./managed-projection-profile.js`) carries that detail if a future pass wants a richer
  // `NO_LEAGUE_SCORING_PROFILE` detail message.
  leagueScoringProfileId(leagueSeasonId: string): Promise<string | null> {
    return currentManagedProjectionProfileKey(this.#database, leagueSeasonId);
  }

  async season(leagueSeasonId: string): Promise<number | null> {
    const [row] = await this.#database
      .select({ season: leagueSeasons.season })
      .from(leagueSeasons)
      .where(eq(leagueSeasons.id, leagueSeasonId))
      .limit(1);
    return row?.season ?? null;
  }

  async listCandidates(
    leagueSeasonId: string,
    season: number,
    limit: number,
  ): Promise<readonly DraftProjectionCandidate[]> {
    const rows = await this.#database
      .select({
        id: projectionSets.id,
        source: projectionSets.source,
        version: projectionSets.version,
        season: projectionSets.season,
        horizon: projectionSets.horizon,
        windowStartWeek: projectionSets.windowStartWeek,
        asOfWeek: projectionSets.asOfWeek,
        fetchedAt: projectionSets.fetchedAt,
        scoringProfileKey: sql<string | null>`${projectionSets.metadata}->>'scoringProfileKey'`,
      })
      .from(projectionSets)
      .where(
        and(
          eq(projectionSets.leagueSeasonId, leagueSeasonId),
          eq(projectionSets.season, season),
          eq(projectionSets.horizon, DRAFT_PROJECTION_HORIZON),
          eq(projectionSets.visibility, "league"),
        ),
      )
      .orderBy(
        desc(projectionSets.fetchedAt),
        desc(projectionSets.createdAt),
        desc(projectionSets.id),
      )
      .limit(limit);
    return rows.map((row) => ({ ...row, fetchedAt: row.fetchedAt.toISOString() }));
  }

  async listRows(
    projectionSetId: string,
    playerIds: readonly string[],
    limit: number,
  ): Promise<readonly DraftProjectionRow[]> {
    if (playerIds.length === 0) return [];
    const rows = await this.#database
      .select({
        playerId: playerProjections.playerId,
        meanPoints: playerProjections.meanPoints,
      })
      .from(playerProjections)
      .where(
        and(
          eq(playerProjections.projectionSetId, projectionSetId),
          inArray(playerProjections.playerId, [...playerIds]),
        ),
      )
      .orderBy(asc(playerProjections.playerId))
      .limit(limit);
    return rows.flatMap((row) => {
      const projectedPoints = Number(row.meanPoints);
      return Number.isFinite(projectedPoints) ? [{ playerId: row.playerId, projectedPoints }] : [];
    });
  }
}
