import { createHash, randomUUID } from "node:crypto";
import { constants } from "node:fs";
import { link, mkdir, open, rm } from "node:fs/promises";
import path from "node:path";

import {
  rosProfileDefinitionFromKey,
  type ProjectionDefensePointsAllowedDefinition,
} from "@laces-out/projections";

import type { FirstPartyRosMarginalAdmissionInput } from "./first-party-ros-marginal-admission.js";
import { assertRosCacheHeadroom } from "./ros-cache-disk-space.js";
import {
  ROS_HISTORICAL_ACTUAL_DEFINITION_VERSION,
  rosHistoricalProfilePointsAllowedDefinition,
} from "./ros-historical-corpus.js";
import {
  createPinnedRosProfileValidationRunner,
  ROS_PROFILE_VALIDATION_MAXIMUM_DIAGNOSTIC_BYTES,
  type PinnedRosProfileValidationReport,
  type PinnedRosProfileValidationRunner,
  type RosProfileValidationRunInput,
  type RosProfileValidationRunnerOptions,
} from "./ros-profile-validation-runner.js";

import {
  RosMarginalDependencyError,
  type RosMarginalDependency,
} from "./ros-marginal-dependency.js";

const SHA256 = /^[a-f0-9]{64}$/u;
export const ROS_MARGINAL_CORPUS_BUNDLE_VERSION = "ros-marginal-corpus-bundle-v1";

/** Trusted shared preparation supplies immutable dependencies; profile jobs only rescore them. */
export interface RosMarginalCorpusBundle {
  readonly version: typeof ROS_MARGINAL_CORPUS_BUNDLE_VERSION;
  readonly forecastSeason: number;
  readonly candidateCorpusIdentity: string;
  readonly previousCorpusIdentity: string;
  readonly intervalTrainingCorpusIdentity?: string;
  readonly qualificationProtocolText: string;
  readonly qualificationProtocolChecksum: string;
}

export interface RosMarginalProfileEvidence extends Omit<
  FirstPartyRosMarginalAdmissionInput,
  "forecastSeason" | "scoringProfile"
> {
  readonly provenance: {
    readonly version: typeof ROS_MARGINAL_CORPUS_BUNDLE_VERSION;
    readonly forecastSeason: number;
    readonly scoringProfileKey: string;
    readonly candidateCorpusIdentity: string;
    readonly previousCorpusIdentity: string;
    readonly intervalTrainingCorpusIdentity?: string;
    readonly qualificationProtocolChecksum: string;
    readonly candidateReportChecksum: string;
    readonly previousReportChecksum: string;
    readonly intervalTrainingReportChecksum?: string;
  };
}

export type RosMarginalProfileValidationRunner = (
  input: RosProfileValidationRunInput,
) => Promise<RosMarginalProfileEvidence>;

/** Recheck lineage at the service boundary before storing a compact ledger receipt. */
export function assertRosMarginalProfileEvidenceIdentity(
  evidence: RosMarginalProfileEvidence,
  input: RosProfileValidationRunInput,
): void {
  const provenance = evidence.provenance;
  if (
    !object(provenance) ||
    provenance.scoringProfileKey !== input.scoringProfileKey ||
    provenance.candidateReportChecksum !== evidence.candidateReportChecksum ||
    provenance.previousReportChecksum !== evidence.previousReportChecksum ||
    provenance.intervalTrainingReportChecksum !== evidence.intervalTrainingReportChecksum ||
    provenance.qualificationProtocolChecksum !== evidence.qualificationProtocolChecksum ||
    (provenance.intervalTrainingCorpusIdentity === undefined) !==
      (evidence.intervalTrainingReportJson === undefined) ||
    (evidence.intervalTrainingReportJson === undefined) !==
      (evidence.intervalTrainingReportChecksum === undefined)
  )
    throw new Error("ROS marginal evidence provenance does not match its reports");
  assertBundle(
    {
      version: provenance.version,
      forecastSeason: provenance.forecastSeason,
      candidateCorpusIdentity: provenance.candidateCorpusIdentity,
      previousCorpusIdentity: provenance.previousCorpusIdentity,
      ...(provenance.intervalTrainingCorpusIdentity === undefined
        ? {}
        : { intervalTrainingCorpusIdentity: provenance.intervalTrainingCorpusIdentity }),
      qualificationProtocolText: evidence.qualificationProtocolText,
      qualificationProtocolChecksum: evidence.qualificationProtocolChecksum,
    },
    input,
  );
  let pointsAllowedDefinition: ProjectionDefensePointsAllowedDefinition | undefined;
  for (const [reportJson, reportChecksum, identity] of [
    [
      evidence.candidateReportJson,
      evidence.candidateReportChecksum,
      provenance.candidateCorpusIdentity,
    ],
    [
      evidence.previousReportJson,
      evidence.previousReportChecksum,
      provenance.previousCorpusIdentity,
    ],
    ...(evidence.intervalTrainingReportJson === undefined
      ? []
      : [
          [
            evidence.intervalTrainingReportJson,
            evidence.intervalTrainingReportChecksum!,
            provenance.intervalTrainingCorpusIdentity!,
          ],
        ]),
  ]) {
    const definition = assertReport(
      { reportJson: reportJson!, reportChecksum: reportChecksum!, report: {} },
      identity!,
      input.scoringProfileKey,
    );
    if (pointsAllowedDefinition !== undefined && pointsAllowedDefinition !== definition)
      throw new Error("ROS marginal reports disagree on points-allowed definition");
    pointsAllowedDefinition = definition;
  }
}

function checksum(value: string | Buffer): string {
  return createHash("sha256").update(value).digest("hex");
}

function object(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function assertBundle(bundle: RosMarginalCorpusBundle, input: RosProfileValidationRunInput): void {
  const required = [
    "version",
    "forecastSeason",
    "candidateCorpusIdentity",
    "previousCorpusIdentity",
    "qualificationProtocolText",
    "qualificationProtocolChecksum",
  ];
  const allowed = new Set([...required, "intervalTrainingCorpusIdentity"]);
  if (
    !object(bundle) ||
    required.some((key) => !Object.hasOwn(bundle, key)) ||
    Object.keys(bundle).some((key) => !allowed.has(key)) ||
    bundle.version !== ROS_MARGINAL_CORPUS_BUNDLE_VERSION ||
    bundle.forecastSeason !== input.season ||
    !Number.isSafeInteger(bundle.forecastSeason) ||
    ![
      bundle.candidateCorpusIdentity,
      bundle.previousCorpusIdentity,
      ...(bundle.intervalTrainingCorpusIdentity === undefined
        ? []
        : [bundle.intervalTrainingCorpusIdentity]),
    ].every((value) => typeof value === "string" && SHA256.test(value)) ||
    bundle.candidateCorpusIdentity === bundle.previousCorpusIdentity ||
    bundle.intervalTrainingCorpusIdentity === bundle.candidateCorpusIdentity ||
    bundle.intervalTrainingCorpusIdentity === bundle.previousCorpusIdentity ||
    typeof bundle.qualificationProtocolText !== "string" ||
    !bundle.qualificationProtocolText.trim() ||
    Buffer.byteLength(bundle.qualificationProtocolText) > 1024 * 1024 ||
    !SHA256.test(bundle.qualificationProtocolChecksum) ||
    checksum(bundle.qualificationProtocolText) !== bundle.qualificationProtocolChecksum ||
    !input.requiredReadyCorpusIdentity ||
    input.requiredReadyCorpusIdentity !== bundle.candidateCorpusIdentity ||
    (input.replayCorpusIdentity !== undefined &&
      input.replayCorpusIdentity !== bundle.candidateCorpusIdentity) ||
    (input.replayModel !== undefined && input.replayModel !== "current") ||
    (input.replayScope !== undefined && input.replayScope !== "audit")
  )
    throw new Error("ROS marginal evidence dependencies do not match the pinned profile job");
}

function assertReport(
  value: PinnedRosProfileValidationReport,
  corpusIdentity: string,
  scoringProfileKey: string,
  dependency?: RosMarginalDependency,
): ProjectionDefensePointsAllowedDefinition {
  if (
    typeof value.reportJson !== "string" ||
    Buffer.byteLength(value.reportJson) > ROS_PROFILE_VALIDATION_MAXIMUM_DIAGNOSTIC_BYTES ||
    !SHA256.test(value.reportChecksum) ||
    checksum(value.reportJson) !== value.reportChecksum
  )
    throw new Error("ROS marginal report byte pin is invalid");
  // Parse the captured bytes again at the boundary; an injected runner's parsed object is not proof.
  const report: unknown = JSON.parse(value.reportJson);
  if (
    dependency &&
    object(report) &&
    Object.keys(report).sort().join() === "reason,state" &&
    report.state === "ros-replay-dependency-unavailable-v1" &&
    (report.reason === "missing" || report.reason === "corrupt" || report.reason === "incompatible")
  )
    throw new RosMarginalDependencyError({ dependency, reason: report.reason });
  if (
    !object(report) ||
    !Object.hasOwn(report, "actualDefinitionVersion") ||
    report.actualDefinitionVersion !== ROS_HISTORICAL_ACTUAL_DEFINITION_VERSION ||
    report.outcomeCorpusIdentity !== corpusIdentity ||
    !object(report.identityAudit) ||
    report.identityAudit.scoringProfileKey !== scoringProfileKey ||
    !object(report.diagnostics)
  )
    throw new Error(
      "ROS marginal report omitted its current actual definition, pinned corpus, scoring or diagnostics",
    );
  const definition = report.pointsAllowedDefinition;
  const requested = rosHistoricalProfilePointsAllowedDefinition(
    rosProfileDefinitionFromKey(scoringProfileKey).profile,
  );
  if (
    !Object.hasOwn(report, "pointsAllowedDefinition") ||
    (definition !== "yahoo-2022-v1" && definition !== "espn-2019-v1") ||
    (requested !== null && requested !== definition)
  )
    throw new Error(
      "ROS marginal report omitted or mismatched its explicit points-allowed definition",
    );
  return definition;
}

/** Exclusive content-addressed writes retain the exact bytes used by admission across restarts. */
async function archiveReport(
  directory: string,
  report: PinnedRosProfileValidationReport,
  signal: AbortSignal,
): Promise<void> {
  signal.throwIfAborted();
  await mkdir(directory, { recursive: true, mode: 0o700 });
  await assertRosCacheHeadroom(directory, Buffer.byteLength(report.reportJson), signal);
  const destination = path.join(directory, `${report.reportChecksum}.json`);
  const temporary = path.join(directory, `${report.reportChecksum}.${randomUUID()}.partial`);
  try {
    const handle = await open(temporary, "wx", 0o444);
    try {
      await handle.writeFile(report.reportJson, "utf8");
      await handle.sync();
    } finally {
      await handle.close();
    }
    signal.throwIfAborted();
    try {
      await link(temporary, destination);
      const folder = await open(directory, "r");
      try {
        await folder.sync();
      } finally {
        await folder.close();
      }
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
      const existing = await open(destination, constants.O_RDONLY | constants.O_NOFOLLOW);
      try {
        const stat = await existing.stat();
        if (
          !stat.isFile() ||
          stat.size !== Buffer.byteLength(report.reportJson) ||
          (await existing.readFile("utf8")) !== report.reportJson
        )
          throw new Error("Archived ROS evidence conflicts with its immutable checksum");
      } finally {
        await existing.close();
      }
    }
  } finally {
    await rm(temporary, { force: true });
  }
}

/** Sequential cache-only replay keeps the per-profile memory/CPU bound independent of league count. */
export function createRosMarginalProfileValidationRunner(options: {
  readonly resolveCorpora: (
    season: number,
    signal: AbortSignal,
    scoringProfileKey: string,
  ) => Promise<RosMarginalCorpusBundle>;
  readonly reportDirectory: string;
  readonly runnerOptions?: RosProfileValidationRunnerOptions;
  readonly reportRunner?: PinnedRosProfileValidationRunner;
}): RosMarginalProfileValidationRunner {
  const runner =
    options.reportRunner ??
    createPinnedRosProfileValidationRunner({ ...options.runnerOptions, diagnostics: true });
  return async (input) => {
    input.signal.throwIfAborted();
    const profile = rosProfileDefinitionFromKey(input.scoringProfileKey);
    rosHistoricalProfilePointsAllowedDefinition(profile.profile);
    const bundle = await options.resolveCorpora(
      input.season,
      input.signal,
      input.scoringProfileKey,
    );
    assertBundle(bundle, input);
    let pointsAllowedDefinition: ProjectionDefensePointsAllowedDefinition | undefined;
    async function replay(
      identity: string,
      model: "current" | "retained-v12",
      scope: "audit" | "full-defense-training",
    ) {
      input.signal.throwIfAborted();
      const result = await runner({
        ...input,
        requiredReadyCorpusIdentity: identity,
        replayCorpusIdentity: identity,
        replayModel: model,
        replayScope: scope,
      });
      input.signal.throwIfAborted();
      const definition = assertReport(
        result,
        identity,
        profile.scoringProfileKey,
        model === "retained-v12"
          ? "previous"
          : scope === "full-defense-training"
            ? "training"
            : "candidate",
      );
      if (pointsAllowedDefinition !== undefined && pointsAllowedDefinition !== definition)
        throw new Error("ROS marginal reports disagree on points-allowed definition");
      pointsAllowedDefinition = definition;
      await archiveReport(options.reportDirectory, result, input.signal);
      // Drop the separately parsed diagnostic tree before reading the next large report.
      return { reportJson: result.reportJson, reportChecksum: result.reportChecksum };
    }
    const candidate = await replay(bundle.candidateCorpusIdentity, "current", "audit");
    const previous = await replay(bundle.previousCorpusIdentity, "retained-v12", "audit");
    const training =
      bundle.intervalTrainingCorpusIdentity === undefined
        ? undefined
        : await replay(bundle.intervalTrainingCorpusIdentity, "current", "full-defense-training");
    return {
      candidateReportJson: candidate.reportJson,
      candidateReportChecksum: candidate.reportChecksum,
      previousReportJson: previous.reportJson,
      previousReportChecksum: previous.reportChecksum,
      qualificationProtocolText: bundle.qualificationProtocolText,
      qualificationProtocolChecksum: bundle.qualificationProtocolChecksum,
      ...(training === undefined
        ? {}
        : {
            intervalTrainingReportJson: training.reportJson,
            intervalTrainingReportChecksum: training.reportChecksum,
          }),
      provenance: {
        version: bundle.version,
        forecastSeason: bundle.forecastSeason,
        scoringProfileKey: profile.scoringProfileKey,
        candidateCorpusIdentity: bundle.candidateCorpusIdentity,
        previousCorpusIdentity: bundle.previousCorpusIdentity,
        ...(bundle.intervalTrainingCorpusIdentity === undefined
          ? {}
          : { intervalTrainingCorpusIdentity: bundle.intervalTrainingCorpusIdentity }),
        qualificationProtocolChecksum: bundle.qualificationProtocolChecksum,
        candidateReportChecksum: candidate.reportChecksum,
        previousReportChecksum: previous.reportChecksum,
        ...(training === undefined
          ? {}
          : { intervalTrainingReportChecksum: training.reportChecksum }),
      },
    };
  };
}
