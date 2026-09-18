import { leagues, leagueSeasons, type Database } from "@laces-out/db";
import { and, asc, eq, isNotNull, or } from "drizzle-orm";

const MAXIMUM_DEMANDS_PER_DISPATCH = 100;

export interface ProjectionRefreshDemand {
  readonly leagueSeasonId: string;
  readonly demandId: string;
}

export interface ProjectionRefreshDemandRepository {
  capture(season: number, limit: number): Promise<readonly ProjectionRefreshDemand[]>;
  acknowledge(demands: readonly ProjectionRefreshDemand[]): Promise<void>;
}

export class DrizzleProjectionRefreshDemandRepository implements ProjectionRefreshDemandRepository {
  constructor(private readonly database: Database) {}

  async capture(season: number, limit: number): Promise<readonly ProjectionRefreshDemand[]> {
    const rows = await this.database
      .select({
        leagueSeasonId: leagueSeasons.id,
        demandId: leagueSeasons.projectionRefreshDemandId,
      })
      .from(leagueSeasons)
      .innerJoin(leagues, eq(leagues.id, leagueSeasons.leagueId))
      .where(
        and(
          eq(leagueSeasons.season, season),
          eq(leagues.archived, false),
          isNotNull(leagueSeasons.projectionRefreshDemandId),
        ),
      )
      .orderBy(asc(leagueSeasons.id))
      .limit(limit);
    return rows.flatMap((row) =>
      row.demandId === null ? [] : [{ ...row, demandId: row.demandId }],
    );
  }

  async acknowledge(demands: readonly ProjectionRefreshDemand[]): Promise<void> {
    if (demands.length === 0) return;
    await this.database
      .update(leagueSeasons)
      .set({ projectionRefreshDemandId: null })
      .where(
        or(
          ...demands.map((demand) =>
            and(
              eq(leagueSeasons.id, demand.leagueSeasonId),
              eq(leagueSeasons.projectionRefreshDemandId, demand.demandId),
            ),
          ),
        ),
      );
  }
}

/**
 * Delivers committed provider changes at least once. Capture precedes enqueue, so a newly queued
 * worker can read every captured change. A coalesced older job may have loaded its facts already:
 * only a new durable queue ID acknowledges demand. A crash before acknowledgement is retryable.
 */
export class ProjectionRefreshDemandDispatcher {
  constructor(
    private readonly input: {
      readonly repository: ProjectionRefreshDemandRepository;
      readonly enqueue: (season: number) => Promise<string | null>;
    },
  ) {}

  async dispatch(
    season: number,
    options: {
      /** Preserve explicit/manual refresh requests even without a new provider change. */
      readonly enqueueWithoutDemand?: boolean;
      readonly signal?: AbortSignal;
    } = {},
  ): Promise<string | null> {
    if (!Number.isInteger(season) || season < 2000 || season > 2100)
      throw new RangeError("Invalid projection demand season");
    options.signal?.throwIfAborted();
    const demands = await this.input.repository.capture(season, MAXIMUM_DEMANDS_PER_DISPATCH);
    options.signal?.throwIfAborted();
    if (demands.length === 0 && !options.enqueueWithoutDemand) return null;
    const jobId = await this.input.enqueue(season);
    if (jobId !== null) {
      options.signal?.throwIfAborted();
      await this.input.repository.acknowledge(demands);
    }
    return jobId;
  }
}
