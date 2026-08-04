import {
  dataSources,
  firstPartyRosChampionArtifacts,
  nflScheduleObservations,
  playerProjections,
  playerRosProjectionSummaries,
  projectionModelRuns,
  projectionObservations,
  projectionSets,
  scoringRules,
  syncRuns,
  leagueSeasons,
  type Database,
} from "@fantasy/db";
import {
  FIRST_PARTY_ROS_INTERVAL_CALIBRATION_VERSION,
  FIRST_PARTY_ROS_MODEL_VERSION,
  FIRST_PARTY_ROS_POLICY_VERSION,
  evaluateFirstPartyRosChampionPolicy,
  projectFirstPartyRestOfSeason,
  rosScoringProfile,
  type FirstPartyRosChampionPolicy,
  type FirstPartyRosHeldOutForecast,
  type FirstPartyRosLiveReleaseEvidence,
  type FirstPartyRosProjection,
  type ProjectionScoringProfile,
} from "@fantasy/projections";
import { describe, expect, it } from "vitest";

import {
  FirstPartyRosProjectionShadowService,
  type FirstPartyRosCandidateProvider,
  type FirstPartyRosPublicationTarget,
} from "./first-party-ros-projections.js";
import {
  firstPartyRosChampionArtifactChecksum,
  type FirstPartyRosChampionArtifactPayload,
} from "./first-party-ros-publication.js";
import type { ProjectionRefreshJob, WorkerJobContext } from "./jobs.js";

type Row = Record<string, unknown>;

const now = new Date("2026-12-01T12:00:00.000Z");
const fresh = new Date(now.getTime() - 5 * 60_000);

const scoringProfile: ProjectionScoringProfile = rosScoringProfile("full-ppr").profile;
// The admitted key IS the canonical rule JSON, which is what per-position matching recovers it from.
const SCORING_KEY = rosScoringProfile("full-ppr").scoringProfileKey;

function heldOutForecast(
  season: number,
  asOfWeek: number,
  playerId: string,
  scoringProfileKey: string = SCORING_KEY,
): FirstPartyRosHeldOutForecast {
  const actual = 100;
  const contextualMean = actual + 1;
  const recencyMean = actual + 8;
  return {
    playerId,
    position: "WR",
    contextualModelVersion: "contextual-v1",
    recencyModelVersion: "recency-v1",
    scoringProfileKey,
    intervalMethodVersion: "simulation-p15-p85-v1",
    forecastSeason: season,
    asOfWeek,
    windowStartWeek: asOfWeek + 1,
    windowEndWeek: 18,
    trainedThroughSeason: season - 1,
    inputChecksum: "b".repeat(64),
    evidence: {
      coverage: { contextual: 1, recency: 1 },
      availability: {
        scheduledGames: 18 - asOfWeek,
        actualGames: 17 - asOfWeek,
        contextualExpectedGames: 17 - asOfWeek,
        recencyExpectedGames: 16.5 - asOfWeek,
      },
      convergence: {
        contextual: { state: "converged", diagnosticChecksum: "c".repeat(64) },
        recency: { state: "converged", diagnosticChecksum: "d".repeat(64) },
      },
    },
    contextual: {
      meanPoints: contextualMean,
      p15Points: contextualMean - 15,
      p50Points: contextualMean,
      p85Points: contextualMean + 15,
    },
    recency: {
      meanPoints: recencyMean,
      p15Points: recencyMean - 25,
      p50Points: recencyMean,
      p85Points: recencyMean + 25,
    },
    actualPoints: actual,
  };
}

/** A champion policy that clears the strict default release gate for WR five-to-eight. */
function releasingPolicy(scoringProfileKey: string = SCORING_KEY): FirstPartyRosChampionPolicy {
  const seasons = [2023, 2024, 2025].map((season) => ({
    season,
    complete: true,
    forecasts: [10, 11, 12].flatMap((asOfWeek) =>
      Array.from({ length: 7 }, (_, index) =>
        heldOutForecast(season, asOfWeek, `${season}-${asOfWeek}-${index}`, scoringProfileKey),
      ),
    ),
  }));
  return evaluateFirstPartyRosChampionPolicy(seasons, {
    minimumHeldOutSeasons: 2,
    minimumBatches: 4,
    minimumSamples: 4,
    minimumCellSeasons: 2,
    minimumCellSamples: 4,
    minimumCellCutoffs: 2,
    minimumCellBatches: 4,
  }).livePolicy;
}

const liveEvidence: FirstPartyRosLiveReleaseEvidence = {
  contextualModelVersion: "contextual-v1",
  recencyModelVersion: "recency-v1",
  scoringProfileKey: SCORING_KEY,
  intervalMethodVersion: "simulation-p15-p85-v1",
  position: "WR",
  bucket: "five-to-eight",
  inputChecksum: "e".repeat(64),
  coverage: { contextual: 1, recency: 1 },
  availability: { scheduledGames: 6, contextualExpectedGames: 5.4, recencyExpectedGames: 5.2 },
  convergence: {
    contextual: { state: "converged", diagnosticChecksum: "c".repeat(64) },
    recency: { state: "converged", diagnosticChecksum: "d".repeat(64) },
  },
};

function releasedProjection(): FirstPartyRosProjection {
  const components = { receptions: 5, receiving_yards: 60, receiving_touchdowns: 0.4 };
  const elasticities = {
    receptions: { role: 1, production: 1 },
    receiving_yards: { role: 1, production: 1 },
    receiving_touchdowns: { role: 1, production: 1.2 },
  };
  const weeks = Array.from({ length: 6 }, (_, index) => ({
    season: 2026,
    week: 13 + index,
    scheduled: true,
    bye: false,
    contextualComponents: components,
    recencyComponents: components,
    componentElasticities: elasticities,
  }));
  return projectFirstPartyRestOfSeason({
    playerId: "11111111-1111-4111-8111-111111111111",
    position: "WR",
    season: 2026,
    asOfWeek: 12,
    asOfAt: "2026-11-30T18:00:00.000Z",
    windowStartWeek: 13,
    windowEndWeek: 18,
    strategy: "contextual",
    weeks,
    availability: {
      state: "active",
      newAbsenceProbability: 0.05,
      recoveryProbability: 0.5,
      reserveRecoveryProbability: 0.1,
      limitedRoleMultiplier: 0.85,
      returnRoleMultiplier: 0.75,
    },
    role: {
      currentMultiplier: 1,
      persistence: 0.8,
      innovationVolatility: 0.1,
      weeklyProductionVolatility: 0.4,
      minimumMultiplier: 0.2,
      maximumMultiplier: 3,
    },
    scoringProfile,
    inputChecksum: "f".repeat(64),
    weeklyModelVersion: "laces-ros-distribution-v4:contextual:laces-weekly-components-v7",
    seed: "release-test",
    scenarioCount: 256,
  });
}

function schedule(): readonly Row[] {
  const rows: Row[] = [];
  for (let week = 1; week <= 18; week += 1) {
    const completed = week <= 12;
    rows.push({
      week,
      kickoffAt: completed
        ? new Date(Date.UTC(2026, 8, week))
        : new Date(now.getTime() + week * 24 * 60 * 60 * 1_000),
      status: completed ? "final" : "scheduled",
      awayScore: completed ? 20 : null,
      homeScore: completed ? 23 : null,
      sourceAsOf: fresh,
      fetchedAt: fresh,
    });
  }
  return rows;
}

function artifactRow(overrides: Partial<FirstPartyRosChampionArtifactPayload> = {}): Row {
  const payload: FirstPartyRosChampionArtifactPayload = {
    season: 2026,
    scoringProfileKey: SCORING_KEY,
    modelVersion: FIRST_PARTY_ROS_MODEL_VERSION,
    policyVersion: FIRST_PARTY_ROS_POLICY_VERSION,
    calibrationVersion: FIRST_PARTY_ROS_INTERVAL_CALIBRATION_VERSION,
    evidenceThroughSeason: 2025,
    sourceChecksums: [{ key: "nflverse.schedules.2026", checksum: "a".repeat(64) }],
    policy: releasingPolicy(),
    releaseGate: { state: "release" },
    ...overrides,
  };
  return { ...payload, artifactChecksum: firstPartyRosChampionArtifactChecksum(payload) };
}

function fakeProvider(target: FirstPartyRosPublicationTarget): FirstPartyRosCandidateProvider {
  return {
    async sourceChecksum() {
      return "9".repeat(64);
    },
    async buildTargets() {
      return [target];
    },
  };
}

function countingProvider(target: FirstPartyRosPublicationTarget): {
  readonly provider: FirstPartyRosCandidateProvider;
  readonly calls: () => number;
} {
  let calls = 0;
  return {
    provider: {
      async sourceChecksum() {
        return "9".repeat(64);
      },
      async buildTargets() {
        calls += 1;
        return [target];
      },
    },
    calls: () => calls,
  };
}

function baseTarget(): FirstPartyRosPublicationTarget {
  return {
    leagueSeasonId: "22222222-2222-4222-8222-222222222222",
    leagueScoringProfileKey: SCORING_KEY,
    futureWindowComplete: true,
    evidence: [liveEvidence],
    convergence: {
      state: "converged",
      lowerScenarioCount: 2_048,
      referenceScenarioCount: 4_096,
      maxToleranceRatio: 0.3,
      diagnosticChecksum: "a".repeat(64),
    },
    released: [
      {
        playerId: "11111111-1111-4111-8111-111111111111",
        bucket: "five-to-eight",
        strategy: "contextual",
        projection: releasedProjection(),
      },
    ],
    sourceAsOf: fresh,
  };
}

class Harness {
  readonly inserts: { table: unknown; values: Row }[] = [];
  readonly sourceUpdates: Row[] = [];
  readonly #database: Database;
  readonly #artifacts: readonly Row[];
  readonly #candidateLastSuccessfulAt: Date | null;
  readonly #seenSyncKeys = new Set<string>();
  #syncCounter = 0;
  #setCounter = 0;

  constructor(input: {
    readonly artifact?: Row | null;
    readonly artifacts?: readonly Row[];
    readonly candidateLastSuccessfulAt?: Date | null;
  }) {
    this.#artifacts = input.artifacts ?? (input.artifact ? [input.artifact] : []);
    this.#candidateLastSuccessfulAt = input.candidateLastSuccessfulAt ?? fresh;
    const facade = {
      select: (selection: Row) =>
        new SelectQuery(selection, (table, sel) => this.#select(table, sel)),
      insert: (table: unknown) => new MutationQuery(table, (t, v) => this.#insert(t, v)),
      update: (table: unknown) => new MutationQuery(table, (t, v) => this.#update(t, v)),
      transaction: async <T>(callback: (transaction: Database) => Promise<T>) =>
        callback(this.#database),
    };
    this.#database = facade as unknown as Database;
  }

  get database(): Database {
    return this.#database;
  }

  countInserts(table: unknown): number {
    return this.inserts.filter((entry) => entry.table === table).length;
  }

  lastInsert(table: unknown): Row | undefined {
    return [...this.inserts].reverse().find((entry) => entry.table === table)?.values;
  }

  #select(table: unknown, selection: Row): readonly Row[] {
    if (table === dataSources) {
      if (Object.hasOwn(selection, "key")) {
        return [
          {
            id: "schedule-src",
            key: "nflverse.schedules.2026",
            enabled: true,
            lastChecksum: "a".repeat(64),
            lastSuccessfulAt: fresh,
            lastCheckedAt: fresh,
            lastChangedAt: null,
            consecutiveFailures: 0,
            checkIntervalMinutes: 60,
          },
          {
            id: "weekly-src",
            key: "laces-out.projections.first-party",
            enabled: true,
            lastChecksum: "b".repeat(64),
            lastSuccessfulAt: fresh,
            lastCheckedAt: fresh,
            lastChangedAt: null,
            consecutiveFailures: 0,
            checkIntervalMinutes: 60,
          },
          {
            id: "candidate-src",
            key: "nflverse.weekly-rosters.2026",
            enabled: true,
            lastChecksum: "c".repeat(64),
            lastSuccessfulAt: this.#candidateLastSuccessfulAt,
            // A recent check is not a successful verification. This stays fresh in the stale-input
            // test to prove publication keys freshness off `lastSuccessfulAt`.
            lastCheckedAt: fresh,
            lastChangedAt: null,
            consecutiveFailures: 0,
            checkIntervalMinutes: 60,
          },
        ];
      }
      return [{ metadata: {}, lastChecksum: null, consecutiveFailures: 0 }];
    }
    if (table === nflScheduleObservations) return schedule();
    if (table === firstPartyRosChampionArtifacts) return this.#artifacts;
    if (table === leagueSeasons || table === scoringRules) return [];
    if (table === syncRuns) return this.#seenSyncKeys.size > 0 ? [{ id: "existing" }] : [];
    if (table === projectionModelRuns) return [];
    if (table === projectionObservations) return [{ count: 0 }];
    return [];
  }

  #insert(table: unknown, values: unknown): readonly Row[] {
    const row = values as Row;
    this.inserts.push({ table, values: row });
    if (table === dataSources) {
      return [
        {
          id: "ros-shadow-src",
          key: "laces-out.projections.first-party-ros-shadow",
          enabled: true,
          lastChecksum: null,
          lastSuccessfulAt: null,
          lastCheckedAt: null,
          lastChangedAt: null,
          consecutiveFailures: 0,
          checkIntervalMinutes: 60,
        },
      ];
    }
    if (table === syncRuns) {
      const key = String(row.idempotencyKey);
      if (this.#seenSyncKeys.has(key)) return [];
      this.#seenSyncKeys.add(key);
      this.#syncCounter += 1;
      return [{ id: `sync-${this.#syncCounter}` }];
    }
    if (table === projectionSets) {
      this.#setCounter += 1;
      return [{ id: `set-${this.#setCounter}` }];
    }
    return [];
  }

  #update(table: unknown, values: unknown): readonly Row[] {
    if (table === dataSources) this.sourceUpdates.push(values as Row);
    return [];
  }
}

class SelectQuery implements PromiseLike<readonly Row[]> {
  #table: unknown;
  constructor(
    private readonly selection: Row,
    private readonly resolve: (table: unknown, selection: Row) => readonly Row[],
  ) {}
  from(table: unknown): this {
    this.#table = table;
    return this;
  }
  where(): this {
    return this;
  }
  innerJoin(): this {
    return this;
  }
  orderBy(): this {
    return this;
  }
  limit(): this {
    return this;
  }
  then<T1 = readonly Row[], T2 = never>(
    onfulfilled?: ((value: readonly Row[]) => T1 | PromiseLike<T1>) | null,
    onrejected?: ((reason: unknown) => T2 | PromiseLike<T2>) | null,
  ): Promise<T1 | T2> {
    return Promise.resolve(this.resolve(this.#table, this.selection)).then(onfulfilled, onrejected);
  }
}

class MutationQuery implements PromiseLike<readonly Row[]> {
  #values: unknown;
  #executed: Promise<readonly Row[]> | undefined;
  constructor(
    private readonly table: unknown,
    private readonly execute: (table: unknown, values: unknown) => readonly Row[],
  ) {}
  values(values: unknown): this {
    this.#values = values;
    return this;
  }
  set(values: unknown): this {
    this.#values = values;
    return this;
  }
  onConflictDoUpdate(): this {
    return this;
  }
  onConflictDoNothing(): this {
    return this;
  }
  returning(): this {
    return this;
  }
  where(): this {
    return this;
  }
  then<T1 = readonly Row[], T2 = never>(
    onfulfilled?: ((value: readonly Row[]) => T1 | PromiseLike<T1>) | null,
    onrejected?: ((reason: unknown) => T2 | PromiseLike<T2>) | null,
  ): Promise<T1 | T2> {
    this.#executed ??= Promise.resolve(this.execute(this.table, this.#values));
    return this.#executed.then(onfulfilled, onrejected);
  }
}

const job: ProjectionRefreshJob = { season: 2026 };
const context: WorkerJobContext = { signal: new AbortController().signal } as WorkerJobContext;

describe("first-party ROS shadow service publication rail", () => {
  it("records only the degraded shadow audit when no champion artifact exists", async () => {
    const harness = new Harness({ artifact: null });
    const service = new FirstPartyRosProjectionShadowService({
      database: harness.database,
      now: () => now,
      candidateProvider: fakeProvider(baseTarget()),
    });
    await service.refreshProjections(job, context);

    expect(harness.countInserts(projectionSets)).toBe(0);
    expect(harness.countInserts(playerRosProjectionSummaries)).toBe(0);
    const runs = harness.inserts.filter((entry) => entry.table === projectionModelRuns);
    expect(runs).toHaveLength(1);
    expect(runs[0]!.values).toMatchObject({
      horizon: "rest-of-season",
      qualityState: "degraded",
      playersPublished: 0,
    });
    expect(harness.sourceUpdates.at(-1)?.metadata).toMatchObject({
      result: "shadow_evidence_recorded",
    });
  });

  it("keeps an admitted artifact for a retired scoring identity off the live rail", async () => {
    const retiredKey = '[{"statId":"receptions","points":0.75,"bonuses":[]}]';
    const harness = new Harness({
      artifact: artifactRow({
        scoringProfileKey: retiredKey,
        policy: releasingPolicy(retiredKey),
      }),
    });
    const service = new FirstPartyRosProjectionShadowService({
      database: harness.database,
      now: () => now,
      candidateProvider: fakeProvider(baseTarget()),
    });
    await service.refreshProjections(job, context);

    expect(harness.countInserts(projectionSets)).toBe(0);
    expect(harness.countInserts(playerRosProjectionSummaries)).toBe(0);
    expect(harness.sourceUpdates.at(-1)?.metadata).toMatchObject({
      result: "shadow_evidence_recorded",
    });
  });

  it("persists one league-scoped ROS set on a valid artifact and gate release", async () => {
    const harness = new Harness({ artifact: artifactRow() });
    const service = new FirstPartyRosProjectionShadowService({
      database: harness.database,
      now: () => now,
      candidateProvider: fakeProvider(baseTarget()),
    });
    await service.refreshProjections(job, context);

    expect(harness.countInserts(projectionSets)).toBe(1);
    expect(harness.countInserts(playerProjections)).toBe(1);
    expect(harness.countInserts(playerRosProjectionSummaries)).toBe(1);
    const publishRun = harness.inserts.find(
      (entry) => entry.table === projectionModelRuns && entry.values.qualityState === "publishable",
    );
    expect(publishRun).toBeDefined();
    expect(publishRun!.values).toMatchObject({
      horizon: "rest-of-season",
      modelVersion: FIRST_PARTY_ROS_MODEL_VERSION,
      trainedThroughSeason: 2025,
    });
    const set = harness.lastInsert(projectionSets);
    expect(set).toMatchObject({
      horizon: "rest-of-season",
      identityState: "explicit",
      visibility: "league",
    });
    expect(harness.sourceUpdates.at(-1)?.metadata).toMatchObject({
      result: "released",
      publishedTargets: 1,
    });
  });

  it("withholds publication when the candidate roster was checked recently but not verified recently", async () => {
    const harness = new Harness({
      artifact: artifactRow(),
      candidateLastSuccessfulAt: new Date(now.getTime() - 4 * 60 * 60_000),
    });
    const service = new FirstPartyRosProjectionShadowService({
      database: harness.database,
      now: () => now,
      candidateProvider: fakeProvider(baseTarget()),
    });

    await service.refreshProjections(job, context);

    expect(harness.countInserts(projectionSets)).toBe(0);
    expect(harness.countInserts(playerRosProjectionSummaries)).toBe(0);
    expect(harness.sourceUpdates.at(-1)?.metadata).toMatchObject({
      result: "shadow_evidence_recorded",
    });
    const metadata = harness.sourceUpdates.at(-1)?.metadata as Record<string, unknown>;
    expect(String(metadata.diagnostics)).toContain("candidate_source_not_fresh");
  });

  it("is idempotent: a repeated run persists no new rows", async () => {
    const harness = new Harness({ artifact: artifactRow() });
    const counted = countingProvider(baseTarget());
    const service = new FirstPartyRosProjectionShadowService({
      database: harness.database,
      now: () => now,
      candidateProvider: counted.provider,
    });
    await service.refreshProjections(job, context);
    const setsAfterFirst = harness.countInserts(projectionSets);
    const publishRunsAfterFirst = harness.inserts.filter(
      (entry) => entry.table === projectionModelRuns && entry.values.qualityState === "publishable",
    ).length;
    await service.refreshProjections(job, context);
    expect(harness.countInserts(projectionSets)).toBe(setsAfterFirst);
    expect(
      harness.inserts.filter(
        (entry) =>
          entry.table === projectionModelRuns && entry.values.qualityState === "publishable",
      ).length,
    ).toBe(publishRunsAfterFirst);
    expect(counted.calls()).toBe(1);
    expect(harness.sourceUpdates.at(-1)?.metadata).toMatchObject({ result: "unchanged" });
  });

  it("forwards per-position matching and records withheld positions when the live gate releases", async () => {
    // SYNTHETIC EVIDENCE SHAPE, deliberately. `baseTarget()`'s live evidence carries the ARTIFACT's
    // key while `leagueScoringProfileKey` is overridden — a combination
    // `buildFirstPartyRosLeagueTarget` never produces, since it derives both from the same league
    // profile. Since 2026-07-29 the live release gate's evidence-identity comparison is
    // position-scoped (`evidenceIdentitiesMatchForPosition`,
    // `packages/projections/src/rest-of-season.ts`), so the production shape — league-key-stamped
    // evidence — also publishes its matched positions now; that end-to-end truth is pinned by
    // "publishes a partially matched league's matched positions in the production evidence shape"
    // in first-party-ros-publication.test.ts. The synthetic shape is kept here because byte-equal
    // keys hold the gate's identity comparison on its fast path, isolating the wiring under test.
    //
    // What this test pins is the SERVICE WIRING and nothing more: that `positionMatching` is
    // forwarded from the target, that per-league artifact arbitration keeps a target with its
    // arbitrated artifact, that the per-position gate — not the whole-profile key — decides
    // publication, and that withheld positions reach `metrics.cellDecisions`.
    const target = {
      ...baseTarget(),
      leagueScoringProfileKey: "different-profile:v1",
      leagueScoringProfile: scoringProfile,
      supportedPositions: ["RB", "WR", "TE"] as const,
    };
    const harness = new Harness({ artifact: artifactRow() });
    const service = new FirstPartyRosProjectionShadowService({
      database: harness.database,
      now: () => now,
      candidateProvider: fakeProvider(target),
    });
    await service.refreshProjections(job, context);

    expect(harness.countInserts(projectionSets)).toBe(1);
    const publishRun = harness.inserts.find(
      (entry) => entry.table === projectionModelRuns && entry.values.qualityState === "publishable",
    );
    const metrics = publishRun!.values.metrics as {
      readonly cellDecisions: readonly Record<string, unknown>[];
      readonly preservePriorGoodSet: boolean;
      readonly withheldReasons: readonly string[];
    };
    expect(metrics.withheldReasons).toContain("ros_scoring_profile_position_withheld");
    expect(metrics.preservePriorGoodSet).toBe(true);
    expect(metrics.cellDecisions).toContainEqual({
      position: "QB",
      bucket: "nine-plus",
      state: "withhold",
      reasons: ["position-unsupported"],
    });
    expect(metrics.cellDecisions).toContainEqual({
      position: "K",
      bucket: "one-to-four",
      state: "withhold",
      reasons: ["position-unsupported"],
    });
    expect(metrics.cellDecisions).toContainEqual({
      position: "WR",
      bucket: "five-to-eight",
      state: "release",
      reasons: [],
    });
  });

  it("arbitrates a league matching two artifacts to exactly one and records the skip", async () => {
    // Position-scoped identity is what makes double publication possible: the D/ST-augmented
    // artifact's offense-scoped keys equal the league's, so its own live gate would release the
    // same league the whole-key artifact publishes. Arbitration must keep the whole-key winner even
    // though the other artifact is newer, and the skipped pass must be visible in the run record
    // rather than silent.
    const alternateProfile = rosScoringProfile("standard");
    const dstAugmentedKey = alternateProfile.scoringProfileKey;
    const wholeKeyArtifact = artifactRow();
    const dstAugmentedArtifact = artifactRow({
      scoringProfileKey: dstAugmentedKey,
      policy: releasingPolicy(dstAugmentedKey),
    });
    const target = {
      ...baseTarget(),
      leagueScoringProfile: scoringProfile,
      supportedPositions: ["QB", "RB", "WR", "TE", "K"] as const,
    };
    const harness = new Harness({
      artifacts: [
        { ...wholeKeyArtifact, admittedAt: new Date("2026-07-01T00:00:00.000Z") },
        { ...dstAugmentedArtifact, admittedAt: new Date("2026-07-23T00:00:00.000Z") },
      ],
    });
    const service = new FirstPartyRosProjectionShadowService({
      database: harness.database,
      now: () => now,
      candidateProvider: fakeProvider(target),
    });
    await service.refreshProjections(job, context);

    // Exactly one set publishes, under the whole-key artifact (tie-break rule 1).
    expect(harness.countInserts(projectionSets)).toBe(1);
    const publishRun = harness.inserts.find(
      (entry) => entry.table === projectionModelRuns && entry.values.qualityState === "publishable",
    );
    expect(
      (publishRun!.values.configuration as { championArtifactChecksum: string })
        .championArtifactChecksum,
    ).toBe(wholeKeyArtifact.artifactChecksum);
    const metadata = harness.sourceUpdates.at(-1)?.metadata as Record<string, unknown>;
    expect(metadata).toMatchObject({
      result: "released",
      publishedTargets: 1,
      arbitrationSkippedTargets: 1,
    });
    expect(String(metadata.diagnostics)).toContain("ros_artifact_arbitration_skipped_targets");
  });

  it("withholds and preserves the prior good set on a scoring-profile mismatch", async () => {
    const target = { ...baseTarget(), leagueScoringProfileKey: "different-profile:v1" };
    const harness = new Harness({ artifact: artifactRow() });
    const service = new FirstPartyRosProjectionShadowService({
      database: harness.database,
      now: () => now,
      candidateProvider: fakeProvider(target),
    });
    await service.refreshProjections(job, context);

    expect(harness.countInserts(projectionSets)).toBe(0);
    expect(harness.countInserts(playerRosProjectionSummaries)).toBe(0);
    expect(harness.sourceUpdates.at(-1)?.metadata).toMatchObject({
      result: "shadow_evidence_recorded",
    });
  });

  it("withholds on an invalid artifact checksum and on an incomplete future window", async () => {
    const invalidChecksum = new Harness({
      artifact: { ...artifactRow(), artifactChecksum: "0".repeat(64) },
    });
    const invalidService = new FirstPartyRosProjectionShadowService({
      database: invalidChecksum.database,
      now: () => now,
      candidateProvider: fakeProvider(baseTarget()),
    });
    await invalidService.refreshProjections(job, context);
    expect(invalidChecksum.countInserts(projectionSets)).toBe(0);

    const incomplete = new Harness({ artifact: artifactRow() });
    const incompleteService = new FirstPartyRosProjectionShadowService({
      database: incomplete.database,
      now: () => now,
      candidateProvider: fakeProvider({ ...baseTarget(), futureWindowComplete: false }),
    });
    await incompleteService.refreshProjections(job, context);
    expect(incomplete.countInserts(projectionSets)).toBe(0);
    expect(incomplete.sourceUpdates.at(-1)?.metadata).toMatchObject({
      result: "shadow_evidence_recorded",
    });
  });
});
