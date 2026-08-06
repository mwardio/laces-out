import type { DraftMarketBaseline } from "@laces-out/contracts";
import {
  adpObservations,
  dataSources,
  drafts,
  leagueMemberships,
  leagueSeasons,
  rosterSlotRules,
  scoringRules,
  type AdpScoringFormat,
  type Database,
  type JsonPrimitive,
} from "@laces-out/db";
import { and, desc, eq } from "drizzle-orm";

const supportedTeamCounts = new Set([8, 10, 12, 14]);
const staleAfterMilliseconds = 72 * 60 * 60 * 1_000;

export interface DraftMarketScoringRule {
  readonly statKey: string;
  readonly operation: string;
  readonly points: string;
}

export interface DraftMarketRosterRule {
  readonly count: number;
  readonly eligiblePositions: readonly string[];
  readonly isStarter: boolean;
}

export function inferDraftMarketScoringFormat(
  rules: readonly DraftMarketScoringRule[],
): AdpScoringFormat | null {
  if (rules.length === 0) return null;
  const receptionRules = rules.filter(
    (rule) =>
      rule.operation.toLowerCase() === "multiply" &&
      /(^|[^a-z])receptions?([^a-z]|$)/u.test(rule.statKey.toLowerCase()),
  );
  if (receptionRules.length === 0) return "standard";
  if (receptionRules.length !== 1) return null;
  const points = Number(receptionRules[0]?.points);
  if (Math.abs(points - 1) < 0.0001) return "ppr";
  if (Math.abs(points - 0.5) < 0.0001) return "half-ppr";
  if (Math.abs(points) < 0.0001) return "standard";
  return null;
}

export function supportsOneQuarterbackRoster(
  rules: readonly DraftMarketRosterRule[],
): boolean | null {
  const starters = rules.filter((rule) => rule.isStarter && rule.count > 0);
  if (starters.length === 0) return null;
  let quarterbackSlots = 0;
  for (const rule of starters) {
    const eligible = new Set(rule.eligiblePositions.map((position) => position.toUpperCase()));
    if (!eligible.has("QB")) continue;
    if (eligible.size > 1) return false;
    quarterbackSlots += rule.count;
  }
  return quarterbackSlots === 1;
}

function metadataNumber(metadata: Record<string, JsonPrimitive>, key: string): number | null {
  const value = metadata[key];
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

function unavailable(
  reason: Extract<DraftMarketBaseline, { state: "unavailable" }>["reason"],
  detail: string,
): DraftMarketBaseline {
  return { state: "unavailable", reason, detail };
}

export class DraftMarketService {
  readonly #database: Database;
  readonly #now: () => Date;

  constructor(database: Database, now: () => Date = () => new Date()) {
    this.#database = database;
    this.#now = now;
  }

  async getBaseline(userId: string, draftId: string): Promise<DraftMarketBaseline> {
    const [scope] = await this.#database
      .select({
        season: leagueSeasons.season,
        teamCount: leagueSeasons.teamCount,
        leagueSeasonId: leagueSeasons.id,
      })
      .from(drafts)
      .innerJoin(leagueSeasons, eq(drafts.leagueSeasonId, leagueSeasons.id))
      .innerJoin(
        leagueMemberships,
        and(
          eq(leagueMemberships.leagueId, leagueSeasons.leagueId),
          eq(leagueMemberships.userId, userId),
        ),
      )
      .where(eq(drafts.id, draftId))
      .limit(1);
    if (!scope) {
      return unavailable("draft-not-found", "The draft does not exist or is not available to you.");
    }
    if (!supportedTeamCounts.has(scope.teamCount)) {
      return unavailable(
        "unsupported-team-count",
        `The current ADP source does not publish a ${scope.teamCount}-team context.`,
      );
    }

    const [storedScoringRules, storedRosterRules] = await Promise.all([
      this.#database
        .select({
          statKey: scoringRules.statKey,
          operation: scoringRules.operation,
          points: scoringRules.points,
        })
        .from(scoringRules)
        .where(eq(scoringRules.leagueSeasonId, scope.leagueSeasonId)),
      this.#database
        .select({
          count: rosterSlotRules.count,
          eligiblePositions: rosterSlotRules.eligiblePositions,
          isStarter: rosterSlotRules.isStarter,
        })
        .from(rosterSlotRules)
        .where(eq(rosterSlotRules.leagueSeasonId, scope.leagueSeasonId)),
    ]);
    const scoringFormat = inferDraftMarketScoringFormat(storedScoringRules);
    if (!scoringFormat) {
      return unavailable(
        "unknown-scoring",
        "Reception scoring is not explicit enough to select a compatible ADP context.",
      );
    }
    if (supportsOneQuarterbackRoster(storedRosterRules) !== true) {
      return unavailable(
        "unsupported-roster-format",
        "The current ADP source is limited to leagues with one dedicated starting quarterback slot.",
      );
    }

    const key = `ffc.adp.${scope.season}.${scoringFormat}.${scope.teamCount}`;
    const [source] = await this.#database
      .select({
        id: dataSources.id,
        key: dataSources.key,
        name: dataSources.name,
        attribution: dataSources.attribution,
        attributionUrl: dataSources.attributionUrl,
        lastSuccessfulAt: dataSources.lastSuccessfulAt,
        metadata: dataSources.metadata,
      })
      .from(dataSources)
      .where(and(eq(dataSources.key, key), eq(dataSources.enabled, true)))
      .limit(1);
    if (!source?.lastSuccessfulAt) {
      return unavailable(
        "source-not-ready",
        "A compatible draft-market baseline has not completed its first refresh.",
      );
    }
    if (source.metadata.publishable !== true) {
      return unavailable(
        "identity-coverage-low",
        "The latest draft-market file did not clear the player-identity coverage threshold.",
      );
    }

    const [latest] = await this.#database
      .select({
        sourceAsOf: adpObservations.sourceAsOf,
        fetchedAt: adpObservations.fetchedAt,
        inputChecksum: adpObservations.inputChecksum,
      })
      .from(adpObservations)
      .where(
        and(
          eq(adpObservations.sourceId, source.id),
          eq(adpObservations.season, scope.season),
          eq(adpObservations.scoringFormat, scoringFormat),
          eq(adpObservations.teamCount, scope.teamCount),
          eq(adpObservations.rosterFormat, "one-qb"),
        ),
      )
      .orderBy(desc(adpObservations.sourceAsOf), desc(adpObservations.fetchedAt))
      .limit(1);
    if (!latest) {
      return unavailable("source-not-ready", "No compatible draft-market observations are stored.");
    }
    const latestRows = await this.#database
      .select({
        playerId: adpObservations.playerId,
        overallAdp: adpObservations.overallAdp,
        sourceRank: adpObservations.sourceRank,
        positionRank: adpObservations.positionRank,
        standardDeviation: adpObservations.standardDeviation,
        sampleSize: adpObservations.sampleSize,
      })
      .from(adpObservations)
      .where(
        and(
          eq(adpObservations.sourceId, source.id),
          eq(adpObservations.sourceAsOf, latest.sourceAsOf),
          eq(adpObservations.inputChecksum, latest.inputChecksum),
        ),
      )
      .orderBy(adpObservations.sourceRank)
      .limit(1_000);
    const matchRate = metadataNumber(source.metadata, "matchRate") ?? 0;
    const warnings =
      this.#now().getTime() - source.lastSuccessfulAt.getTime() > staleAfterMilliseconds
        ? ["Draft-market data is older than 72 hours; Laces Out is using the last good file."]
        : [];
    return {
      state: "available",
      context: {
        season: scope.season,
        scoringFormat,
        teamCount: scope.teamCount,
        rosterFormat: "one-qb",
      },
      source: {
        key: source.key,
        name: source.name,
        attribution: source.attribution,
        attributionUrl: source.attributionUrl,
        sourceAsOf: latest.sourceAsOf.toISOString(),
        fetchedAt: latest.fetchedAt.toISOString(),
        checksumSha256: latest.inputChecksum,
        stale: warnings.length > 0,
        matchRate,
      },
      players: latestRows.flatMap((row) =>
        row.playerId
          ? [
              {
                playerId: row.playerId,
                overallAdp: Number(row.overallAdp),
                sourceRank: row.sourceRank,
                positionRank: row.positionRank,
                standardDeviation:
                  row.standardDeviation === null ? null : Number(row.standardDeviation),
                sampleSize: row.sampleSize,
              },
            ]
          : [],
      ),
      warnings,
    };
  }
}
