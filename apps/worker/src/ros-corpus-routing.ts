import {
  rosProfileDefinitionFromKey,
  type FirstPartyRosReleaseRail,
  type ProjectionDefensePointsAllowedDefinition,
} from "@laces-out/projections";
import { rosHistoricalProfilePointsAllowedDefinition } from "./ros-historical-corpus.js";
import { createRosMarginalCorpusBundleResolver } from "./ros-marginal-corpus-bundle.js";
import type { RosMarginalCorpusBundle } from "./ros-profile-marginal-evidence.js";
import {
  rosSharedCorpusRequest,
  ROS_SHARED_CORPUS_REFERENCE_POINTS_ALLOWED_DEFINITION,
} from "./ros-shared-corpus-runner.js";

export const ROS_CORPUS_POINTS_ALLOWED_DEFINITIONS = ["yahoo-2022-v1", "espn-2019-v1"] as const;
export type RosProfileCorpusReadiness = (
  season: number,
  signal: AbortSignal,
  scoringProfileKey: string,
) => Promise<{ readonly requestIdentity: string; readonly corpusIdentity: string | null }>;
export type RosProfileMarginalCorpusResolver = (
  season: number,
  signal: AbortSignal,
  scoringProfileKey: string,
) => Promise<{
  readonly bundle: RosMarginalCorpusBundle;
  readonly pointsAllowedDefinition: ProjectionDefensePointsAllowedDefinition;
}>;

export function rosCorpusDefinitionForProfileKey(key: string) {
  return rosHistoricalProfilePointsAllowedDefinition(rosProfileDefinitionFromKey(key).profile);
}

/** Unknown/legacy active PA must be diagnosed by profile validation, never bootstrap a default. */
export function rosCorpusDemandGroups(
  rows: readonly { readonly season: number; readonly scoringProfileKey: string }[],
) {
  const groups = new Map<
    string,
    {
      season: number;
      pointsAllowedDefinition: ProjectionDefensePointsAllowedDefinition;
      scoringProfileKey: string;
    }
  >();
  let invalidProfiles = 0;
  for (const row of rows) {
    try {
      const definition =
        rosCorpusDefinitionForProfileKey(row.scoringProfileKey) ??
        ROS_SHARED_CORPUS_REFERENCE_POINTS_ALLOWED_DEFINITION;
      const request = rosSharedCorpusRequest(row.season, definition);
      groups.set(request.identity, {
        season: row.season,
        pointsAllowedDefinition: definition,
        scoringProfileKey: row.scoringProfileKey,
      });
    } catch {
      invalidProfiles += 1;
    }
  }
  return { groups: [...groups.values()], invalidProfiles };
}

/** Each config pin is checked against the corpus definition, not merely its filename/checksum. */
export function createRosDefinitionAwareMarginalResolver(options: {
  readonly directory: string;
  readonly bundleChecksums: Partial<
    Readonly<Record<ProjectionDefensePointsAllowedDefinition, string>>
  >;
}): RosProfileMarginalCorpusResolver {
  const resolvers = new Map(
    ROS_CORPUS_POINTS_ALLOWED_DEFINITIONS.map((definition) => [
      definition,
      createRosMarginalCorpusBundleResolver({
        directory: options.directory,
        bundleChecksum: options.bundleChecksums[definition],
        pointsAllowedDefinition: definition,
      }),
    ]),
  );
  return async (season, signal, scoringProfileKey) => {
    signal.throwIfAborted();
    const requested = rosCorpusDefinitionForProfileKey(scoringProfileKey);
    if (requested !== null)
      return {
        bundle: await resolvers.get(requested)!(season, signal),
        pointsAllowedDefinition: requested,
      };
    // A no-PA profile may use either verified group. Failure of an unrelated group is isolated.
    const failures: unknown[] = [];
    for (const definition of ROS_CORPUS_POINTS_ALLOWED_DEFINITIONS) {
      try {
        return {
          bundle: await resolvers.get(definition)!(season, signal),
          pointsAllowedDefinition: definition,
        };
      } catch (error) {
        signal.throwIfAborted();
        failures.push(error);
      }
    }
    throw failures[0];
  };
}

export function createRosDefinitionAwareReadiness(options: {
  readonly releaseRail: FirstPartyRosReleaseRail;
  readonly ensure: (
    season: number,
    signal: AbortSignal,
    definition: ProjectionDefensePointsAllowedDefinition,
  ) => Promise<string | null>;
  readonly ready: (
    season: number,
    signal: AbortSignal,
    definition: ProjectionDefensePointsAllowedDefinition,
  ) => Promise<string | null>;
  readonly marginal: RosProfileMarginalCorpusResolver;
}): RosProfileCorpusReadiness {
  return async (season, signal, scoringProfileKey) => {
    signal.throwIfAborted();
    const requested = rosCorpusDefinitionForProfileKey(scoringProfileKey);
    let definition = requested ?? ROS_SHARED_CORPUS_REFERENCE_POINTS_ALLOWED_DEFINITION;
    if (options.releaseRail === "marginal-v8") {
      const selected = await options.marginal(season, signal, scoringProfileKey);
      // Bundle resolution has already checked the profile and all dependency definitions. For a
      // no-PA profile the selected bundle identity is sufficient; no physical build is scheduled.
      return {
        requestIdentity: rosSharedCorpusRequest(season, selected.pointsAllowedDefinition).identity,
        corpusIdentity: selected.bundle.candidateCorpusIdentity,
      };
    }
    if (requested === null) {
      const errors: unknown[] = [];
      const empty: ProjectionDefensePointsAllowedDefinition[] = [];
      let available = false;
      for (const candidate of ROS_CORPUS_POINTS_ALLOWED_DEFINITIONS) {
        try {
          if (await options.ready(season, signal, candidate)) {
            definition = candidate;
            available = true;
            break;
          }
          empty.push(candidate);
        } catch (error) {
          signal.throwIfAborted();
          errors.push(error);
        }
      }
      if (!available) {
        if (empty.length > 0) definition = empty[0]!;
        else if (errors.length > 0) throw errors[0];
      }
    }
    return {
      requestIdentity: rosSharedCorpusRequest(season, definition).identity,
      corpusIdentity: await options.ensure(season, signal, definition),
    };
  };
}
