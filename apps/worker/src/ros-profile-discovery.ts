import { createHash } from "node:crypto";

import {
  firstPartyRosChampionArtifacts,
  firstPartyRosProfileValidations,
  leagues,
  leagueSeasons,
  scoringRules,
  type Database,
} from "@laces-out/db";
import type { RosProfileValidationJob } from "@laces-out/jobs";
import {
  firstPartyRosReleaseIdentity,
  deriveRosArtifactBlockers,
  type FirstPartyRosReleaseRail,
  LEAGUE_SCORING_NORMALIZATION_VERSION,
  normalizeLeagueScoringProfile,
  projectionScoringProfileKey,
  rosAvailableProjectionStatIds,
  rosProfileDefinitionFromKey,
  type FirstPartyRosChampionPolicy,
  type StoredLeagueScoringRule,
} from "@laces-out/projections";
import { and, desc, eq, inArray } from "drizzle-orm";

import { firstPartyRosChampionArtifactIsValid } from "./first-party-ros-publication.js";

/** Pure exact identity discovery: unsupported scoring never becomes a nearest-profile guess. */
export function discoverRosScoringProfiles(
  input: readonly {
    readonly leagueSeasonId: string;
    readonly rules: readonly StoredLeagueScoringRule[];
  }[],
) {
  const profiles = new Map<
    string,
    { definition: ReturnType<typeof rosProfileDefinitionFromKey>; leagueSeasonIds: string[] }
  >();
  const unsupportedLeagueSeasonIds: string[] = [];
  for (const league of input) {
    const normalized = normalizeLeagueScoringProfile({
      id: `league:${league.leagueSeasonId}`,
      version: LEAGUE_SCORING_NORMALIZATION_VERSION,
      rows: league.rules,
      availableStatIds: rosAvailableProjectionStatIds(),
    });
    if (
      normalized.state !== "available" ||
      normalized.positions.some(
        (position) =>
          !position.supported &&
          position.reasons.some((reason) => reason.code !== "NO_SUPPORTED_RULES"),
      )
    ) {
      unsupportedLeagueSeasonIds.push(league.leagueSeasonId);
      continue;
    }
    let definition: ReturnType<typeof rosProfileDefinitionFromKey>;
    try {
      definition = rosProfileDefinitionFromKey(projectionScoringProfileKey(normalized.profile));
    } catch {
      // One malformed or oversized provider identity must not block other leagues' proofs.
      unsupportedLeagueSeasonIds.push(league.leagueSeasonId);
      continue;
    }
    const entry = profiles.get(definition.digest) ?? { definition, leagueSeasonIds: [] };
    if (entry.definition.scoringProfileKey !== definition.scoringProfileKey) {
      throw new Error("ROS scoring profile digest collision");
    }
    entry.leagueSeasonIds.push(league.leagueSeasonId);
    profiles.set(definition.digest, entry);
  }
  return { profiles: [...profiles.values()], unsupportedLeagueSeasonIds };
}

/** Called after weekly input refresh. A failed dispatch remains pending for the next discovery. */
export class RosProfileDiscoveryService {
  constructor(
    private readonly input: {
      readonly database: Database;
      readonly releaseRail?: FirstPartyRosReleaseRail;
      readonly enqueueValidation: (job: RosProfileValidationJob) => Promise<string | null>;
      readonly enqueueProjectionRefresh: (season: number) => Promise<string | null>;
      readonly validationJobIsOutstanding?: (profileValidationId: string) => Promise<boolean>;
      readonly now?: () => Date;
    },
  ) {}

  async discover(season: number): Promise<void> {
    const db = this.input.database;
    const identity = firstPartyRosReleaseIdentity(this.input.releaseRail);
    const leagueRows = await db
      .select({ id: leagueSeasons.id, provider: leagueSeasons.provider })
      .from(leagueSeasons)
      .innerJoin(leagues, eq(leagues.id, leagueSeasons.leagueId))
      .where(and(eq(leagueSeasons.season, season), eq(leagues.archived, false)));
    if (leagueRows.length === 0) return;
    const rules = await db
      .select()
      .from(scoringRules)
      .where(
        inArray(
          scoringRules.leagueSeasonId,
          leagueRows.map((league) => league.id),
        ),
      );
    const rulesByLeague = new Map<string, typeof rules>();
    for (const rule of rules) {
      const rows = rulesByLeague.get(rule.leagueSeasonId) ?? [];
      rows.push(rule);
      rulesByLeague.set(rule.leagueSeasonId, rows);
    }
    const discovered = discoverRosScoringProfiles(
      leagueRows.map((league) => ({
        leagueSeasonId: league.id,
        rules: (rulesByLeague.get(league.id) ?? []).map((rule) => ({
          ...rule,
          provider: league.provider,
        })),
      })),
    );
    const publicationDemands: { id: string; digest: string }[] = [];
    for (const { definition, leagueSeasonIds } of discovered.profiles) {
      const match = and(
        eq(firstPartyRosProfileValidations.season, season),
        eq(firstPartyRosProfileValidations.modelVersion, identity.modelVersion),
        eq(firstPartyRosProfileValidations.policyVersion, identity.policyVersion),
        eq(firstPartyRosProfileValidations.calibrationVersion, identity.calibrationVersion),
        eq(firstPartyRosProfileValidations.scoringProfileDigest, definition.digest),
      );
      await db
        .insert(firstPartyRosProfileValidations)
        .values({
          season,
          ...identity,
          scoringProfileKey: definition.scoringProfileKey,
          scoringProfileDigest: definition.digest,
        })
        .onConflictDoNothing();
      const [row] = await db.select().from(firstPartyRosProfileValidations).where(match).limit(1);
      if (!row || row.scoringProfileKey !== definition.scoringProfileKey) {
        throw new Error("ROS scoring validation identity did not round-trip");
      }
      // Adopt independently admitted evidence only after checking its full checksum and identities.
      const [artifact] = await db
        .select()
        .from(firstPartyRosChampionArtifacts)
        .where(
          and(
            eq(firstPartyRosChampionArtifacts.season, season),
            eq(firstPartyRosChampionArtifacts.scoringProfileKey, definition.scoringProfileKey),
            eq(firstPartyRosChampionArtifacts.modelVersion, identity.modelVersion),
            eq(firstPartyRosChampionArtifacts.policyVersion, identity.policyVersion),
            eq(firstPartyRosChampionArtifacts.calibrationVersion, identity.calibrationVersion),
          ),
        )
        .orderBy(desc(firstPartyRosChampionArtifacts.admittedAt))
        .limit(1);
      if (
        artifact &&
        firstPartyRosChampionArtifactIsValid({
          ...artifact,
          policy: artifact.policy as unknown as FirstPartyRosChampionPolicy,
        })
      ) {
        const diagnostics = deriveRosArtifactBlockers(artifact);
        if (
          row.state !== "admitted" ||
          row.artifactId !== artifact.id ||
          JSON.stringify(row.blockers) !== JSON.stringify(diagnostics.effectiveBlockers)
        ) {
          await db
            .update(firstPartyRosProfileValidations)
            .set({
              state: "admitted",
              artifactId: artifact.id,
              completedAt: new Date(),
              updatedAt: new Date(),
              blockers: diagnostics.effectiveBlockers,
              report: {
                ...row.report,
                artifactDiagnostics: {
                  artifactChecksum: artifact.artifactChecksum,
                  rawBlockers: diagnostics.rawBlockers,
                  supersededIntervalDiagnostics: diagnostics.supersededIntervalDiagnostics,
                },
              },
            })
            .where(eq(firstPartyRosProfileValidations.id, row.id));
        }
        // Include admission identity and league membership so a newly linked league triggers ROS
        // even when its scoring proof was admitted long ago. Roster syncs leave this unchanged.
        const scopeDigest = createHash("sha256")
          .update(
            JSON.stringify({
              artifact: artifact.artifactChecksum,
              leagues: [...leagueSeasonIds].sort(),
            }),
          )
          .digest("hex");
        if (row.publicationScopeDigest !== scopeDigest)
          publicationDemands.push({ id: row.id, digest: scopeDigest });
      } else if (row.state === "pending") {
        await this.input.enqueueValidation({ profileValidationId: row.id });
      } else if (
        row.state === "validating" &&
        row.startedAt !== null &&
        (this.input.now?.() ?? new Date()).getTime() - row.startedAt.getTime() > 5 * 60_000 &&
        this.input.validationJobIsOutstanding &&
        !(await this.input.validationJobIsOutstanding(row.id))
      ) {
        // A SIGKILL on the final queue attempt cannot run the service's failure handler. Reconcile
        // that terminal orphan without automatically restarting an unbounded expensive proof.
        const now = this.input.now?.() ?? new Date();
        await db
          .update(firstPartyRosProfileValidations)
          .set({
            state: "failed",
            blockers: ["validation_job_lost"],
            completedAt: now,
            updatedAt: now,
          })
          .where(
            and(
              eq(firstPartyRosProfileValidations.id, row.id),
              eq(firstPartyRosProfileValidations.state, "validating"),
              eq(firstPartyRosProfileValidations.startedAt, row.startedAt),
            ),
          );
      }
    }
    if (publicationDemands.length > 0) {
      const jobId = await this.input.enqueueProjectionRefresh(season);
      // A coalesced job might already be simulating an older league scope. Leave demand outstanding
      // in that case, so a subsequent weekly discovery enqueues it after the singleton expires.
      if (jobId !== null) {
        for (const demand of publicationDemands) {
          await db
            .update(firstPartyRosProfileValidations)
            .set({
              publicationScopeDigest: demand.digest,
              updatedAt: new Date(),
            })
            .where(eq(firstPartyRosProfileValidations.id, demand.id));
        }
      }
    }
  }
}
