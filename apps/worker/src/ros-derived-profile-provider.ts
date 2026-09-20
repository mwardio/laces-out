import { createHash } from "node:crypto";
import {
  projectionScoringProfileKey,
  rosProfileDefinitionFromKey,
  type FirstPartyRosOutcomeScore,
  type ProjectionDefensePointsAllowedDefinition,
} from "@laces-out/projections";
import {
  historicalRosChecksum,
  type HistoricalRosBacktestProgress,
} from "./first-party-ros-backtest.js";
import {
  rosHistoricalProfilePointsAllowedDefinition,
  type RosHistoricalCorpus,
} from "./ros-historical-corpus.js";
import {
  RosMarginalDependencyError,
  type RosMarginalDependency,
} from "./ros-marginal-dependency.js";
import {
  ROS_MARGINAL_CORPUS_BUNDLE_VERSION,
  type RosDerivedMarginalProfileReports,
  type RosMarginalCorpusBundle,
} from "./ros-profile-marginal-evidence.js";
import type { RosProfileValidationRunInput } from "./ros-profile-validation-runner.js";
import {
  ROS_DERIVED_EVALUATION_VERSION,
  validateRosDerivedEvaluation,
} from "./ros-derived-evaluation.js";
import {
  loadVerifiedRosDerivedPackage,
  type RosDerivedSourceRoots,
  type VerifiedRosDerivedPackage,
} from "./ros-derived-package-loader.js";
import { rosDerivedProductionRoleIdentity } from "./ros-derived-production-package.js";
import {
  replayRosDerivedPopulation,
  type RosDerivedPopulationReplayInput,
} from "./ros-derived-population-replay.js";
import { buildRosDerivedReplayReport } from "./ros-derived-replay-report.js";

const sha = (value: string) => createHash("sha256").update(value).digest("hex");
const pin = (value: unknown) => {
  const reportJson = `${JSON.stringify(value)}\n`;
  return { reportJson, reportChecksum: sha(reportJson) };
};
const rowIdentity = (row: RosHistoricalCorpus["forecasts"][number]) =>
  `${row.forecast.forecastSeason}:${row.forecast.asOfWeek}:${row.forecast.position}:${row.forecast.playerId === "DST:LA" ? "DST:LAR" : row.forecast.playerId}`;

/** Every standard exact scoring key is repriced from retained vectors; no report/profile whitelist. */
export function createRosDerivedProfileProvider(options: {
  readonly directory: string;
  readonly packageChecksums: Partial<
    Readonly<Record<ProjectionDefensePointsAllowedDefinition, string>>
  >;
  readonly sourceRoots: RosDerivedSourceRoots;
  readonly onProgress?: (
    event: HistoricalRosBacktestProgress & {
      readonly population:
        "original-candidate" | "original-previous" | "training" | "candidate" | "previous";
    },
  ) => void;
}) {
  const pins = { ...options.packageChecksums };
  const roots = {
    ...options.sourceRoots,
    "expanded-dst-v13": { ...options.sourceRoots["expanded-dst-v13"] },
  };
  // Only metadata can survive a call; vector payloads are never retained. Weak ownership lets a
  // quiet provider release its package before another definition needs the validation worker.
  const cached = new Map<
    ProjectionDefensePointsAllowedDefinition,
    WeakRef<VerifiedRosDerivedPackage>
  >();
  const loading = new Map<
    ProjectionDefensePointsAllowedDefinition,
    Promise<VerifiedRosDerivedPackage>
  >();
  function definitionFor(key: string): ProjectionDefensePointsAllowedDefinition {
    const requested = rosHistoricalProfilePointsAllowedDefinition(
      rosProfileDefinitionFromKey(key).profile,
    );
    const definition =
      requested ??
      (["yahoo-2022-v1", "espn-2019-v1"] as const).find(
        (candidate) => pins[candidate] !== undefined,
      );
    if (!definition || !pins[definition])
      throw new RosMarginalDependencyError({ dependency: "bundle", reason: "unconfigured" });
    return definition;
  }
  async function load(season: number, signal: AbortSignal, scoringProfileKey: string) {
    signal.throwIfAborted();
    if (season !== 2026)
      throw new RosMarginalDependencyError({ dependency: "bundle", reason: "incompatible" });
    const definition = definitionFor(scoringProfileKey);
    const previous = cached.get(definition)?.deref();
    if (previous) return previous;
    const active = loading.get(definition);
    if (active) {
      const verified = await active;
      signal.throwIfAborted();
      return verified;
    }
    const pending = (async () => {
      try {
        const verified = await loadVerifiedRosDerivedPackage({
          directory: options.directory,
          packageChecksum: pins[definition]!,
          pointsAllowedDefinition: definition,
          sourceRoots: roots,
          signal,
        });
        cached.set(definition, new WeakRef(verified));
        return verified;
      } catch (error) {
        signal.throwIfAborted();
        const dependencyError = new RosMarginalDependencyError({
          dependency: "bundle",
          reason: (error as NodeJS.ErrnoException)?.code === "ENOENT" ? "missing" : "corrupt",
        });
        Object.defineProperty(dependencyError, "cause", { value: error });
        throw dependencyError;
      } finally {
        loading.delete(definition);
      }
    })();
    loading.set(definition, pending);
    return pending;
  }

  function bundleFor(verified: VerifiedRosDerivedPackage): RosMarginalCorpusBundle {
    return {
      version: ROS_MARGINAL_CORPUS_BUNDLE_VERSION,
      forecastSeason: 2026,
      candidateCorpusIdentity: rosDerivedProductionRoleIdentity(
        verified.packageChecksum,
        "candidate",
      ),
      previousCorpusIdentity: rosDerivedProductionRoleIdentity(
        verified.packageChecksum,
        "retained-v12",
      ),
      intervalTrainingCorpusIdentity: verified.manifest.correctedDstPhysicalCorpus,
      qualificationProtocolText: verified.qualificationProtocolText,
      qualificationProtocolChecksum: sha(verified.qualificationProtocolText),
    };
  }
  return {
    async resolveCorpora(season: number, signal: AbortSignal, scoringProfileKey: string) {
      const verified = await load(season, signal, scoringProfileKey);
      return {
        bundle: bundleFor(verified),
        pointsAllowedDefinition: verified.manifest.pointsAllowedDefinition,
      };
    },
    async derivedEvidenceProvider(
      input: RosProfileValidationRunInput,
      bundle: RosMarginalCorpusBundle,
    ): Promise<RosDerivedMarginalProfileReports> {
      const verified = await load(input.season, input.signal, input.scoringProfileKey);
      if (
        historicalRosChecksum(bundle) !== historicalRosChecksum(bundleFor(verified)) ||
        input.requiredReadyCorpusIdentity !== bundle.candidateCorpusIdentity
      )
        throw new Error("Derived profile job bundle differs from its pinned ready package");
      const profile = rosProfileDefinitionFromKey(input.scoringProfileKey);
      const legacy = rosProfileDefinitionFromKey(
        projectionScoringProfileKey({
          id: "retained-numeric-rules",
          rules: profile.profile.rules.map(({ statDefinition, ...rule }) => {
            void statDefinition;
            return rule;
          }),
        }),
      );
      const memo = new Map<string, FirstPartyRosOutcomeScore>();
      const common = { signal: input.signal, sourceForKey: verified.sourceForKey, scoreMemo: memo };
      async function replay(
        dependency: RosMarginalDependency,
        request: RosDerivedPopulationReplayInput,
      ) {
        try {
          const population = request.originalDstObservedSemantics
            ? request.retainedV12
              ? "original-previous"
              : "original-candidate"
            : dependency === "training"
              ? "training"
              : request.retainedV12
                ? "previous"
                : "candidate";
          return await replayRosDerivedPopulation({
            ...request,
            ...(options.onProgress
              ? {
                  onProgress: (event: HistoricalRosBacktestProgress) =>
                    options.onProgress?.({ ...event, population }),
                }
              : {}),
          });
        } catch (error) {
          input.signal.throwIfAborted();
          const dependencyError = new RosMarginalDependencyError({
            dependency,
            reason: (error as NodeJS.ErrnoException)?.code === "ENOENT" ? "missing" : "corrupt",
          });
          Object.defineProperty(dependencyError, "cause", { value: error });
          throw dependencyError;
        }
      }
      const originalCandidate = await replay("candidate", {
        ...common,
        corpus: verified.originalCandidate,
        cache: verified.originalCandidateCache,
        scoringProfile: legacy.profile,
        originalDstObservedSemantics: "archived-missing-components-as-zero",
      });
      const originalPrevious = await replay("previous", {
        ...common,
        corpus: verified.original,
        cache: verified.originalCache,
        scoringProfile: legacy.profile,
        originalDstObservedSemantics: "archived-missing-components-as-zero",
        retainedV12: true,
      });
      const training = await replay("training", {
        ...common,
        corpus: verified.training,
        cache: verified.trainingCache,
        scoringProfile: profile.profile,
      });
      const candidate = await replay("candidate", {
        ...common,
        corpus: verified.currentCandidate,
        cache: verified.currentCandidateCache,
        scoringProfile: profile.profile,
      });
      const truth = new Map(
        verified.currentCandidate.forecasts.map((row) => [rowIdentity(row), row]),
      );
      const previousCorpus: RosHistoricalCorpus = {
        ...verified.original,
        forecasts: verified.original.forecasts.map((row) => {
          const observed = truth.get(rowIdentity(row));
          if (
            !observed ||
            row.actualGames !== observed.actualGames ||
            row.scheduledGames !== observed.scheduledGames
          )
            throw new Error(
              "Corrected benchmark game support differs from frozen physical forecast",
            );
          return { ...row, actualComponents: observed.actualComponents };
        }),
      };
      const previous = await replay("previous", {
        ...common,
        corpus: previousCorpus,
        cache: verified.originalCache,
        scoringProfile: profile.profile,
        retainedV12: true,
      });
      memo.clear();
      function report(
        result: typeof candidate.result,
        corpus: RosHistoricalCorpus,
        corpusIdentity: string,
        original: boolean,
        trainingOnly = false,
      ) {
        const value = buildRosDerivedReplayReport({
          result,
          positions: trainingOnly ? ["DST"] : undefined,
          scoringProfile: original ? legacy : profile,
          coverage: corpus.coverage,
          sourceAudit: corpus.sourceAudit,
          outcomeCorpusIdentity: corpusIdentity,
          pointsAllowedDefinition: verified.manifest.pointsAllowedDefinition,
        });
        if (original) {
          // These archived forecasts retain their original observed PA semantics and source pins.
          // They do not claim the new native actual-definition marker.
          delete value.actualDefinitionVersion;
          delete value.pointsAllowedDefinition;
        }
        return value;
      }
      const oldCandidate = pin(
        report(
          originalCandidate.result,
          verified.originalCandidate,
          verified.manifest.originalCandidatePhysicalCorpus,
          true,
        ),
      );
      const oldPrevious = pin(
        report(
          originalPrevious.result,
          verified.original,
          verified.manifest.originalPreviousPhysicalCorpus,
          true,
        ),
      );
      const currentTraining = pin(
        report(
          training.result,
          verified.training,
          verified.manifest.correctedDstPhysicalCorpus,
          false,
          true,
        ),
      );
      const raw = (result: typeof candidate.result) =>
        result.heldOutSeasons.flatMap((season) => season.forecasts);
      const manifest = {
        version: ROS_DERIVED_EVALUATION_VERSION,
        profile: profile.scoringProfileKey,
        legacyProfileDigest: legacy.digest,
        pointsAllowedDefinition: verified.manifest.pointsAllowedDefinition,
        observedActualDefinitionVersion: "complete-player-ledger-actuals-v1",
        observedSources: verified.manifest.observedSources,
        nonDstFragmentIdentity: verified.manifest.nonDstFragmentIdentity,
        originalCandidateReportSha256: oldCandidate.reportChecksum,
        originalPreviousReportSha256: oldPrevious.reportChecksum,
        nativeTrainingReportSha256: currentTraining.reportChecksum,
        originalCandidatePhysicalCorpus: verified.manifest.originalCandidatePhysicalCorpus,
        originalPreviousPhysicalCorpus: verified.manifest.originalPreviousPhysicalCorpus,
        correctedDstPhysicalCorpus: verified.manifest.correctedDstPhysicalCorpus,
        originalCandidateForecastSources: verified.manifest.originalForecastSources,
        originalPreviousForecastSources: verified.manifest.originalForecastSources,
        correctedDstForecastSources: verified.manifest.observedSources,
        candidateRowsChecksum: historicalRosChecksum(raw(candidate.result)),
        previousRowsChecksum: historicalRosChecksum(raw(previous.result)),
        convergenceBindings: candidate.bindings.filter(
          (binding) => binding.stratum.split(":")[1] === "DST",
        ),
        originalAuditMembershipPreserved: true,
        originalPreviousRawPredictionsPreserved: true,
        previousSelectionAndCalibrationRecomputedAgainstCorrectedObservations: true,
        noSimulation: true,
        canAuthorizeRelease: false,
      };
      const manifestIdentity = historicalRosChecksum(manifest);
      const manifestPin = pin({ identity: manifestIdentity, payload: manifest });
      function derived(result: typeof candidate.result, role: "candidate" | "retained-v12") {
        const value = report(
          result,
          verified.currentCandidate,
          rosDerivedProductionRoleIdentity(verified.packageChecksum, role),
          false,
        );
        return pin({
          ...value,
          actualDefinitionVersion: "complete-player-ledger-actuals-v1",
          correctedComparison: {
            version: ROS_DERIVED_EVALUATION_VERSION,
            manifestIdentity,
            role,
            sourceSemantics:
              "sources identify corrected observed truth; original forecast source identities are retained in the comparison manifest",
            actualDefinitionVersion: "complete-player-ledger-actuals-v1",
          },
          canAuthorizeRelease: false,
        });
      }
      const candidatePin = derived(candidate.result, "candidate"),
        previousPin = derived(previous.result, "retained-v12");
      const output = {
        candidateReportJson: candidatePin.reportJson,
        candidateReportChecksum: candidatePin.reportChecksum,
        previousReportJson: previousPin.reportJson,
        previousReportChecksum: previousPin.reportChecksum,
        intervalTrainingReportJson: currentTraining.reportJson,
        intervalTrainingReportChecksum: currentTraining.reportChecksum,
        derivedEvaluation: {
          comparisonManifestJson: manifestPin.reportJson,
          comparisonManifestChecksum: manifestPin.reportChecksum,
          originalCandidateReportJson: oldCandidate.reportJson,
          originalCandidateReportChecksum: oldCandidate.reportChecksum,
          originalPreviousReportJson: oldPrevious.reportJson,
          originalPreviousReportChecksum: oldPrevious.reportChecksum,
          productionPackageJson: verified.packageJson,
          productionPackageChecksum: verified.packageChecksum,
        },
      };
      validateRosDerivedEvaluation({ input: output.derivedEvaluation, ...output });
      input.signal.throwIfAborted();
      return output;
    },
  };
}
