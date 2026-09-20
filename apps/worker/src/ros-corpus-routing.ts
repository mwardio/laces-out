import {
  rosProfileDefinitionFromKey,
  type FirstPartyRosReleaseRail,
  type ProjectionDefensePointsAllowedDefinition,
} from "@laces-out/projections";
import { rosHistoricalProfilePointsAllowedDefinition } from "./ros-historical-corpus.js";
import { createRosMarginalCorpusBundleResolver } from "./ros-marginal-corpus-bundle.js";
import {
  createRosMarginalProfileValidationRunner,
  type RosDerivedMarginalProfileReports,
  type RosMarginalCorpusBundle,
  type RosMarginalProfileValidationRunner,
} from "./ros-profile-marginal-evidence.js";
import { RosMarginalDependencyError } from "./ros-marginal-dependency.js";
import {
  ROS_DERIVED_PRODUCTION_PACKAGE_VERSION,
  rosDerivedProductionRoleIdentity,
} from "./ros-derived-production-package.js";
import type {
  PinnedRosProfileValidationRunner,
  RosProfileValidationRunInput,
  RosProfileValidationRunnerOptions,
} from "./ros-profile-validation-runner.js";
import {
  rosSharedCorpusRequest,
  ROS_SHARED_CORPUS_REFERENCE_POINTS_ALLOWED_DEFINITION,
} from "./ros-shared-corpus-runner.js";

export const ROS_CORPUS_POINTS_ALLOWED_DEFINITIONS = ["yahoo-2022-v1", "espn-2019-v1"] as const;
const NATIVE_BUNDLE_FORMAT = "laces-ros-marginal-ready-bundle-v1";
const MAX_BUNDLE_BYTES = 2 * 1024 * 1024;
const SHA256 = /^[a-f0-9]{64}$/u;
export type RosDerivedProfileEvidenceProvider = (
  input: RosProfileValidationRunInput,
  bundle: RosMarginalCorpusBundle,
) => Promise<RosDerivedMarginalProfileReports>;
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
  readonly derivedEvidenceProvider?: RosDerivedProfileEvidenceProvider;
}>;

export interface RosDerivedProfileRoute {
  readonly resolveCorpora: RosProfileMarginalCorpusResolver;
  readonly derivedEvidenceProvider: RosDerivedProfileEvidenceProvider;
}

/** Pins select one explicit envelope version; a failed derived read is never a native fallback. */
async function marginalBundleKind(
  directory: string,
  checksum: string | undefined,
  signal: AbortSignal,
): Promise<"native" | "derived"> {
  signal.throwIfAborted();
  const fail = (reason: "missing" | "corrupt" | "incompatible" | "unconfigured"): never => {
    throw new RosMarginalDependencyError({ dependency: "bundle", reason });
  };
  if (checksum === undefined) return fail("unconfigured");
  if (!SHA256.test(checksum)) return fail("corrupt");
  let handle;
  try {
    handle = await open(
      path.join(directory, "marginal-bundles", `${checksum}.json`),
      constants.O_RDONLY | constants.O_NOFOLLOW,
    );
  } catch (error) {
    signal.throwIfAborted();
    return fail((error as NodeJS.ErrnoException).code === "ENOENT" ? "missing" : "corrupt");
  }
  let envelope: unknown;
  try {
    const stat = await handle.stat();
    if (!stat.isFile() || stat.size > MAX_BUNDLE_BYTES) return fail("corrupt");
    const bytes = Buffer.alloc(MAX_BUNDLE_BYTES + 1);
    let length = 0;
    while (length < bytes.length) {
      signal.throwIfAborted();
      const read = await handle.read(bytes, length, bytes.length - length);
      if (read.bytesRead === 0) break;
      length += read.bytesRead;
    }
    signal.throwIfAborted();
    const captured = bytes.subarray(0, length);
    if (
      length > MAX_BUNDLE_BYTES ||
      createHash("sha256").update(captured).digest("hex") !== checksum
    )
      return fail("corrupt");
    try {
      envelope = JSON.parse(
        new TextDecoder("utf-8", { fatal: true, ignoreBOM: true }).decode(captured),
      );
    } catch {
      return fail("corrupt");
    }
  } finally {
    await handle.close();
  }
  if (envelope === null || typeof envelope !== "object" || Array.isArray(envelope))
    return fail("corrupt");
  const value = envelope as Record<string, unknown>;
  if (value.format === NATIVE_BUNDLE_FORMAT && !Object.hasOwn(value, "version")) return "native";
  if (value.version === ROS_DERIVED_PRODUCTION_PACKAGE_VERSION && !Object.hasOwn(value, "format"))
    return "derived";
  return fail("incompatible");
}

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
  readonly derivedProviderFactory?: (
    definition: ProjectionDefensePointsAllowedDefinition,
    packageChecksum: string,
  ) => RosDerivedProfileRoute;
}): RosProfileMarginalCorpusResolver {
  const bundleChecksums = Object.freeze({ ...options.bundleChecksums });
  const resolvers = new Map(
    ROS_CORPUS_POINTS_ALLOWED_DEFINITIONS.map((definition) => [
      definition,
      createRosMarginalCorpusBundleResolver({
        directory: options.directory,
        bundleChecksum: bundleChecksums[definition],
        pointsAllowedDefinition: definition,
      }),
    ]),
  );
  const derivedProviders = new Map<
    ProjectionDefensePointsAllowedDefinition,
    RosDerivedProfileRoute
  >();
  const resolve = async (
    definition: ProjectionDefensePointsAllowedDefinition,
    season: number,
    signal: AbortSignal,
    scoringProfileKey: string,
  ) => {
    const configuredChecksum = bundleChecksums[definition];
    const kind = await marginalBundleKind(options.directory, configuredChecksum, signal);
    if (kind === "native")
      return {
        bundle: await resolvers.get(definition)!(season, signal),
        pointsAllowedDefinition: definition,
      };
    let provider = derivedProviders.get(definition);
    if (provider === undefined) {
      if (options.derivedProviderFactory === undefined)
        throw new RosMarginalDependencyError({ dependency: "bundle", reason: "incompatible" });
      provider = options.derivedProviderFactory(definition, configuredChecksum!);
      if (
        typeof provider?.resolveCorpora !== "function" ||
        typeof provider.derivedEvidenceProvider !== "function"
      )
        throw new RosMarginalDependencyError({ dependency: "bundle", reason: "incompatible" });
      derivedProviders.set(definition, provider);
    }
    const selected = await provider.resolveCorpora(season, signal, scoringProfileKey);
    signal.throwIfAborted();
    if (
      selected.pointsAllowedDefinition !== definition ||
      selected.bundle.forecastSeason !== season ||
      selected.bundle.candidateCorpusIdentity !==
        rosDerivedProductionRoleIdentity(configuredChecksum!, "candidate") ||
      selected.bundle.previousCorpusIdentity !==
        rosDerivedProductionRoleIdentity(configuredChecksum!, "retained-v12")
    )
      throw new RosMarginalDependencyError({ dependency: "bundle", reason: "incompatible" });
    return {
      bundle: selected.bundle,
      pointsAllowedDefinition: definition,
      derivedEvidenceProvider: provider.derivedEvidenceProvider,
    };
  };
  return async (season, signal, scoringProfileKey) => {
    signal.throwIfAborted();
    const requested = rosCorpusDefinitionForProfileKey(scoringProfileKey);
    if (requested !== null) return resolve(requested, season, signal, scoringProfileKey);
    // A no-PA profile may use either verified group. Failure of an unrelated group is isolated.
    const failures: unknown[] = [];
    for (const definition of ROS_CORPUS_POINTS_ALLOWED_DEFINITIONS) {
      try {
        return await resolve(definition, season, signal, scoringProfileKey);
      } catch (error) {
        signal.throwIfAborted();
        failures.push(error);
      }
    }
    throw failures[0];
  };
}

/** The ready selection and its replay route stay paired for the entire profile job. */
export function createRosDefinitionAwareMarginalValidationRunner(options: {
  readonly resolveSelection: RosProfileMarginalCorpusResolver;
  readonly reportDirectory: string;
  readonly runnerOptions?: RosProfileValidationRunnerOptions;
  readonly reportRunner?: PinnedRosProfileValidationRunner;
}): RosMarginalProfileValidationRunner {
  return async (input) => {
    input.signal.throwIfAborted();
    const selection = await options.resolveSelection(
      input.season,
      input.signal,
      input.scoringProfileKey,
    );
    input.signal.throwIfAborted();
    return createRosMarginalProfileValidationRunner({
      resolveCorpora: () => Promise.resolve(selection.bundle),
      reportDirectory: options.reportDirectory,
      ...(options.runnerOptions === undefined ? {} : { runnerOptions: options.runnerOptions }),
      ...(options.reportRunner === undefined ? {} : { reportRunner: options.reportRunner }),
      ...(selection.derivedEvidenceProvider === undefined
        ? {}
        : {
            derivedEvidenceProvider: selection.derivedEvidenceProvider,
          }),
    })(input);
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
    if (options.releaseRail === "marginal-v8" || options.releaseRail === "point-v1") {
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
import { createHash } from "node:crypto";
import { constants } from "node:fs";
import { open } from "node:fs/promises";
import path from "node:path";
