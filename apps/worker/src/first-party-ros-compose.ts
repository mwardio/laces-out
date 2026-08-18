import { createHash } from "node:crypto";

import {
  firstPartyRosChampionPolicyChecksum,
  firstPartyRosChampionPolicyIsPublicationReady,
} from "./first-party-ros-publication.js";

const POSITIONS = ["QB", "RB", "WR", "TE", "K", "DST"] as const;
type Position = (typeof POSITIONS)[number];
const BUCKETS = ["one-to-four", "five-to-eight", "nine-plus"] as const;

export interface FirstPartyRosValidationSlice {
  readonly id: string;
  readonly sha256: string;
  readonly report: unknown;
}

export interface FirstPartyRosSourceEquivalence {
  readonly id: string;
  readonly sha256: string;
  readonly audit: unknown;
}

export interface ComposeFirstPartyRosValidationInput {
  readonly base: FirstPartyRosValidationSlice;
  readonly slices: readonly FirstPartyRosValidationSlice[];
  readonly sourceEquivalences?: readonly FirstPartyRosSourceEquivalence[];
  readonly composedAt: string;
}

function object(value: unknown, path: string): Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new TypeError(`${path} must be an object`);
  }
  return value as Record<string, unknown>;
}

function array(value: unknown, path: string): unknown[] {
  if (!Array.isArray(value)) throw new TypeError(`${path} must be an array`);
  return value;
}

function string(value: unknown, path: string): string {
  if (typeof value !== "string" || value === "") throw new TypeError(`${path} must be a string`);
  return value;
}

function boolean(value: unknown, path: string): boolean {
  if (typeof value !== "boolean") throw new TypeError(`${path} must be a boolean`);
  return value;
}

function safeInteger(value: unknown, path: string): number {
  if (!Number.isSafeInteger(value) || (value as number) < 0) {
    throw new TypeError(`${path} must be a nonnegative safe integer`);
  }
  return value as number;
}

function position(value: unknown, path: string): Position {
  const candidate = string(value, path);
  if (!POSITIONS.includes(candidate as Position)) {
    throw new RangeError(`${path} must be one of ${POSITIONS.join(", ")}`);
  }
  return candidate as Position;
}

function canonical(value: unknown): string {
  return JSON.stringify(value);
}

function requireSame(left: unknown, right: unknown, path: string): void {
  if (canonical(left) !== canonical(right)) {
    throw new Error(`Validation slice disagrees with base at ${path}`);
  }
}

function sha256(value: unknown, path: string): string {
  const checksum = string(value, path);
  if (!/^[a-f0-9]{64}$/u.test(checksum)) {
    throw new TypeError(`${path} must be a SHA-256 checksum`);
  }
  return checksum;
}

function positiveInteger(value: unknown, path: string): number {
  const integer = safeInteger(value, path);
  if (integer === 0) throw new TypeError(`${path} must be positive`);
  return integer;
}

function clone<T>(value: T): T {
  return structuredClone(value);
}

function entriesForPosition(value: unknown, path: string, target: Position): unknown[] {
  return array(value, path).filter(
    (entry) => position(object(entry, `${path}[]`).position, `${path}[].position`) === target,
  );
}

function replacePositionEntries(
  base: unknown,
  replacement: unknown,
  path: string,
  target: Position,
): unknown[] {
  const replacementEntries = entriesForPosition(replacement, path, target);
  if (replacementEntries.length === 0) {
    throw new Error(`Validation slice has no ${target} entries at ${path}`);
  }
  return [
    ...array(base, path).filter(
      (entry) => position(object(entry, `${path}[]`).position, `${path}[].position`) !== target,
    ),
    ...replacementEntries,
  ].sort((left, right) => {
    const leftObject = object(left, `${path}[]`);
    const rightObject = object(right, `${path}[]`);
    const leftPosition = POSITIONS.indexOf(position(leftObject.position, `${path}[].position`));
    const rightPosition = POSITIONS.indexOf(position(rightObject.position, `${path}[].position`));
    if (leftPosition !== rightPosition) return leftPosition - rightPosition;
    const leftBucket = BUCKETS.indexOf(leftObject.bucket as (typeof BUCKETS)[number]);
    const rightBucket = BUCKETS.indexOf(rightObject.bucket as (typeof BUCKETS)[number]);
    if (leftBucket !== rightBucket) return leftBucket - rightBucket;
    return canonical(left).localeCompare(canonical(right));
  });
}

function blockerBelongsToPosition(value: string, target: Position): boolean {
  return new RegExp(`^(?:cell|champion|calibration)_${target}_`, "u").test(value);
}

function reportPositions(scope: Record<string, unknown>, path: string): readonly Position[] {
  const positions = array(scope.positions, `${path}.positions`).map((value, index) =>
    position(value, `${path}.positions[${index}]`),
  );
  if (new Set(positions).size !== positions.length) {
    throw new Error(`${path}.positions contains a duplicate`);
  }
  return positions;
}

interface ValidatedScheduleEquivalence {
  readonly id: string;
  readonly sha256: string;
  readonly baseChecksum: string;
  readonly sliceChecksum: string;
  readonly seasons: readonly number[];
  readonly seasonTypes: readonly string[];
  readonly selectedRows: number;
  readonly selectedRowsChecksum: string;
  readonly observations: number;
}

function validateScheduleEquivalence(
  source: FirstPartyRosSourceEquivalence,
): ValidatedScheduleEquivalence {
  if (!/^[a-f0-9]{64}$/u.test(source.sha256)) {
    throw new Error(`Source equivalence ${source.id} has an invalid SHA-256`);
  }
  const audit = object(source.audit, `source-equivalence:${source.id}`);
  if (safeInteger(audit.version, `source-equivalence:${source.id}.version`) !== 1) {
    throw new Error(`Source equivalence ${source.id} has an unsupported version`);
  }
  requireSame(audit.sourceKey, "nflverse.schedules", `source-equivalence:${source.id}.sourceKey`);
  requireSame(audit.field, "scheduleChecksum", `source-equivalence:${source.id}.field`);
  const seasons = array(audit.seasons, `source-equivalence:${source.id}.seasons`).map(
    (value, index) => positiveInteger(value, `source-equivalence:${source.id}.seasons[${index}]`),
  );
  if (new Set(seasons).size !== seasons.length) {
    throw new Error(`Source equivalence ${source.id} has duplicate seasons`);
  }
  const seasonTypes = array(audit.seasonTypes, `source-equivalence:${source.id}.seasonTypes`).map(
    (value, index) => string(value, `source-equivalence:${source.id}.seasonTypes[${index}]`),
  );
  requireSame(seasonTypes, ["REG"], `source-equivalence:${source.id}.seasonTypes`);
  const selectedRows = positiveInteger(
    audit.selectedRows,
    `source-equivalence:${source.id}.selectedRows`,
  );
  const selectedRowsChecksum = sha256(
    audit.selectedRowsChecksum,
    `source-equivalence:${source.id}.selectedRowsChecksum`,
  );
  const observations = array(audit.observations, `source-equivalence:${source.id}.observations`);
  if (observations.length < 2) {
    throw new Error(`Source equivalence ${source.id} requires at least two observations`);
  }
  for (const [index, value] of observations.entries()) {
    const observation = object(value, `source-equivalence:${source.id}.observations[${index}]`);
    if (!/^[a-f0-9]{40}$/u.test(string(observation.commit, `observation[${index}].commit`))) {
      throw new Error(`Source equivalence ${source.id} has an invalid upstream commit`);
    }
    if (
      !Number.isFinite(
        Date.parse(string(observation.committedAt, `observation[${index}].committedAt`)),
      )
    ) {
      throw new Error(`Source equivalence ${source.id} has an invalid commit timestamp`);
    }
    requireSame(observation.selectedRows, selectedRows, `observation[${index}].selectedRows`);
    requireSame(
      observation.selectedRowsChecksum,
      selectedRowsChecksum,
      `observation[${index}].selectedRowsChecksum`,
    );
  }
  return {
    id: source.id,
    sha256: source.sha256,
    baseChecksum: sha256(audit.baseChecksum, `source-equivalence:${source.id}.baseChecksum`),
    sliceChecksum: sha256(audit.sliceChecksum, `source-equivalence:${source.id}.sliceChecksum`),
    seasons,
    seasonTypes,
    selectedRows,
    selectedRowsChecksum,
    observations: observations.length,
  };
}

function requireSourcesSameOrAudited(input: {
  readonly base: unknown;
  readonly slice: unknown;
  readonly equivalences: readonly ValidatedScheduleEquivalence[];
  readonly sourceId: string;
}): readonly ValidatedScheduleEquivalence[] {
  const baseSources = array(input.base, "base.sources");
  const sliceSources = array(input.slice, `slice:${input.sourceId}.sources`);
  if (baseSources.length !== sliceSources.length) {
    throw new Error("Validation slice disagrees with base at sources");
  }
  const sourceSeasons = baseSources.map((value, index) =>
    positiveInteger(
      object(value, `base.sources[${index}]`).season,
      `base.sources[${index}].season`,
    ),
  );
  const used = new Map<string, ValidatedScheduleEquivalence>();
  for (let index = 0; index < baseSources.length; index += 1) {
    const baseSource = clone(object(baseSources[index], `base.sources[${index}]`));
    const sliceSource = clone(
      object(sliceSources[index], `slice:${input.sourceId}.sources[${index}]`),
    );
    const baseScheduleChecksum = sha256(
      baseSource.scheduleChecksum,
      `base.sources[${index}].scheduleChecksum`,
    );
    const sliceScheduleChecksum = sha256(
      sliceSource.scheduleChecksum,
      `slice:${input.sourceId}.sources[${index}].scheduleChecksum`,
    );
    delete baseSource.scheduleChecksum;
    delete sliceSource.scheduleChecksum;
    requireSame(baseSource, sliceSource, `sources[${index}]`);
    if (baseScheduleChecksum === sliceScheduleChecksum) continue;
    const equivalence = input.equivalences.find(
      (candidate) =>
        candidate.baseChecksum === baseScheduleChecksum &&
        candidate.sliceChecksum === sliceScheduleChecksum,
    );
    if (!equivalence) throw new Error("Validation slice disagrees with base at sources");
    requireSame(equivalence.seasons, sourceSeasons, `source-equivalence:${equivalence.id}.seasons`);
    used.set(equivalence.id, equivalence);
  }
  return [...used.values()];
}

function requireProportionalCount(input: {
  readonly base: unknown;
  readonly slice: unknown;
  readonly targets: number;
  readonly path: string;
}): void {
  const baseCount = safeInteger(input.base, `base.${input.path}`);
  const sliceCount = safeInteger(input.slice, `slice.${input.path}`);
  if (baseCount % POSITIONS.length !== 0) {
    throw new Error(`Base ${input.path} cannot be partitioned evenly by position`);
  }
  if (sliceCount !== (baseCount / POSITIONS.length) * input.targets) {
    throw new Error(`Validation slice has an unexpected ${input.path}`);
  }
}

function normalizeChoiceGlobalEvidence(
  value: unknown,
  path: string,
  evidence: { readonly batches: number; readonly samples: number; readonly seasons: number },
): unknown[] {
  return array(value, path).map((entry, index) => ({
    ...object(entry, `${path}[${index}]`),
    globalBatches: evidence.batches,
    globalSamples: evidence.samples,
    globalSeasons: evidence.seasons,
  }));
}

/**
 * Replaces independently validated position cells in a complete report without re-running other
 * positions. Source lineage and every model/validation identity must match byte-for-byte. The
 * resulting policy checksum is rebuilt from the merged executable policy; a sliced report itself
 * is never marked complete or admissible.
 */
export function composeFirstPartyRosValidationReport(
  input: ComposeFirstPartyRosValidationInput,
): Record<string, unknown> {
  if (input.slices.length === 0) throw new Error("At least one validation slice is required");
  if (!Number.isFinite(Date.parse(input.composedAt))) {
    throw new Error("composedAt must be an ISO timestamp");
  }
  if (!/^[a-f0-9]{64}$/u.test(input.base.sha256)) {
    throw new Error("Base report has an invalid SHA-256");
  }

  const base = clone(object(input.base.report, "base"));
  const baseBody = object(base.report, "base.report");
  const baseChampion = object(base.champion, "base.champion");
  const basePolicy = object(base.publicationPolicy, "base.publicationPolicy");
  const baseScope =
    base.validationScope === undefined
      ? { positions: [...POSITIONS], completePortfolio: true }
      : object(base.validationScope, "base.validationScope");
  if (!boolean(baseScope.completePortfolio, "base.validationScope.completePortfolio")) {
    throw new Error("Base validation report is not a complete portfolio");
  }
  requireSame(reportPositions(baseScope, "base.validationScope"), POSITIONS, "validationScope");
  const sourceEquivalences = (input.sourceEquivalences ?? []).map(validateScheduleEquivalence);

  const replaced = new Set<Position>();
  const compositionSlices: Array<Record<string, unknown>> = [];
  const usedSourceEquivalences = new Map<string, ValidatedScheduleEquivalence>();
  for (const source of input.slices) {
    if (!/^[a-f0-9]{64}$/u.test(source.sha256)) {
      throw new Error(`Slice ${source.id} has an invalid SHA-256`);
    }
    const slice = object(source.report, `slice:${source.id}`);
    const sliceScope = object(slice.validationScope, `slice:${source.id}.validationScope`);
    if (boolean(sliceScope.completePortfolio, `slice:${source.id}.completePortfolio`)) {
      throw new Error(`Slice ${source.id} is marked as a complete portfolio`);
    }
    const targets = reportPositions(sliceScope, `slice:${source.id}.validationScope`);
    if (targets.length === 0) throw new Error(`Slice ${source.id} has no positions`);

    for (const path of ["validationMode", "sourcePolicy", "scoringProfile", "coverage"] as const) {
      requireSame(base[path], slice[path], path);
    }
    const sliceBody = object(slice.report, `slice:${source.id}.report`);
    const sliceChampion = object(slice.champion, `slice:${source.id}.champion`);
    const slicePolicy = object(slice.publicationPolicy, `slice:${source.id}.publicationPolicy`);
    for (const path of [
      "seasons",
      "playersPerPosition",
      "maximumForecasts",
      "availabilityCalibrationVersion",
      "roleCalibrationVersion",
      "kickerCalibrationVersion",
      "leakagePolicy",
      "selectionPolicy",
    ] as const) {
      requireSame(baseBody[path], sliceBody[path], `report.${path}`);
    }
    for (const equivalence of requireSourcesSameOrAudited({
      base: base.sources,
      slice: slice.sources,
      equivalences: sourceEquivalences,
      sourceId: source.id,
    })) {
      usedSourceEquivalences.set(equivalence.id, equivalence);
    }
    for (const path of [
      "policyVersion",
      "modelVersion",
      "evidenceThroughSeason",
      "evidenceIdentity",
      "minimumHeldOutSeasons",
      "minimumBatches",
      "minimumSamples",
      "minimumCellSamples",
      "minimumCellSeasons",
      "minimumCellCutoffs",
      "minimumCellBatches",
      "minimumModelImprovement",
    ] as const) {
      requireSame(basePolicy[path], slicePolicy[path], `publicationPolicy.${path}`);
    }
    requireSame(baseBody.batches, sliceBody.batches, "report.batches");
    requireProportionalCount({
      base: baseBody.forecasts,
      slice: sliceBody.forecasts,
      targets: targets.length,
      path: "report.forecasts",
    });
    requireProportionalCount({
      base: baseBody.diagnosedPairs,
      slice: sliceBody.diagnosedPairs,
      targets: targets.length,
      path: "report.diagnosedPairs",
    });
    const baseIdentity = object(base.identityAudit, "base.identityAudit");
    const sliceIdentity = object(slice.identityAudit, `slice:${source.id}.identityAudit`);
    for (const path of [
      "scoringProfileKey",
      "contextualModelVersion",
      "recencyModelVersion",
      "intervalMethodVersion",
    ] as const) {
      requireSame(baseIdentity[path], sliceIdentity[path], `identityAudit.${path}`);
    }
    for (const path of [
      "inputChecksums",
      "contextualConvergenceChecksums",
      "recencyConvergenceChecksums",
    ] as const) {
      requireProportionalCount({
        base: baseIdentity[path],
        slice: sliceIdentity[path],
        targets: targets.length,
        path: `identityAudit.${path}`,
      });
    }

    for (const target of targets) {
      if (replaced.has(target)) throw new Error(`Position ${target} appears in multiple slices`);
      replaced.add(target);
      base.availabilityAudit = replacePositionEntries(
        base.availabilityAudit,
        slice.availabilityAudit,
        "availabilityAudit",
        target,
      );
      baseBody.cells = replacePositionEntries(
        baseBody.cells,
        sliceBody.cells,
        "report.cells",
        target,
      );
      baseBody.convergenceAudit = replacePositionEntries(
        baseBody.convergenceAudit,
        sliceBody.convergenceAudit,
        "report.convergenceAudit",
        target,
      );
      baseChampion.choices = replacePositionEntries(
        baseChampion.choices,
        sliceChampion.choices,
        "champion.choices",
        target,
      );
      basePolicy.choices = replacePositionEntries(
        basePolicy.choices,
        slicePolicy.choices,
        "publicationPolicy.choices",
        target,
      );

      const baseBlockers = array(baseBody.blockers, "base.report.blockers").map((value, index) =>
        string(value, `base.report.blockers[${index}]`),
      );
      const sliceBlockers = array(sliceBody.blockers, `slice:${source.id}.report.blockers`).map(
        (value, index) => string(value, `slice:${source.id}.report.blockers[${index}]`),
      );
      baseBody.blockers = [
        ...baseBlockers.filter((blocker) => !blockerBelongsToPosition(blocker, target)),
        ...sliceBlockers.filter((blocker) => blockerBelongsToPosition(blocker, target)),
      ];
      const unsupported = new Set(
        array(baseBody.unsupportedPositions, "base.report.unsupportedPositions").map(
          (value, index) => position(value, `base.report.unsupportedPositions[${index}]`),
        ),
      );
      unsupported.delete(target);
      if (
        array(
          sliceBody.unsupportedPositions,
          `slice:${source.id}.report.unsupportedPositions`,
        ).some(
          (value, index) =>
            position(value, `slice:${source.id}.report.unsupportedPositions[${index}]`) === target,
        )
      ) {
        unsupported.add(target);
      }
      baseBody.unsupportedPositions = POSITIONS.filter((candidate) => unsupported.has(candidate));
      if (target === "K") baseBody.kickerFamilyAudit = clone(sliceBody.kickerFamilyAudit);
    }
    compositionSlices.push({ id: source.id, sha256: source.sha256, positions: targets });
  }

  const blockers = array(baseBody.blockers, "base.report.blockers").map((value, index) =>
    string(value, `base.report.blockers[${index}]`),
  );
  const uniqueBlockers = [...new Set(blockers)];
  baseBody.blockers = uniqueBlockers;
  baseBody.state = uniqueBlockers.length === 0 ? "evidence-ready" : "insufficient";
  baseBody.diagnosedPairs =
    array(baseBody.convergenceAudit, "base.report.convergenceAudit").length / 2;
  if (!Number.isSafeInteger(baseBody.diagnosedPairs)) {
    throw new Error("Composed convergence audit has an invalid pair count");
  }
  const globalEvidence = {
    batches: safeInteger(basePolicy.globalBatches, "base.publicationPolicy.globalBatches"),
    samples: safeInteger(basePolicy.globalSamples, "base.publicationPolicy.globalSamples"),
    seasons: new Set(array(baseBody.seasons, "base.report.seasons")).size,
  };
  basePolicy.choices = normalizeChoiceGlobalEvidence(
    basePolicy.choices,
    "base.publicationPolicy.choices",
    globalEvidence,
  );
  baseChampion.choices = normalizeChoiceGlobalEvidence(
    baseChampion.choices,
    "base.champion.choices",
    globalEvidence,
  );
  base.publicationPolicy = basePolicy;
  if (!firstPartyRosChampionPolicyIsPublicationReady(basePolicy)) {
    throw new Error("Composed publication policy is not structurally valid");
  }
  baseChampion.publicationPolicyChecksum = firstPartyRosChampionPolicyChecksum(basePolicy);
  base.champion = baseChampion;
  base.report = baseBody;
  base.generatedAt = input.composedAt;
  base.validationScope = {
    positions: [...POSITIONS],
    completePortfolio: true,
    composedFromPositionSlices: true,
  };
  base.composition = {
    version: 1,
    composedAt: input.composedAt,
    base: { id: input.base.id, sha256: input.base.sha256 },
    slices: compositionSlices,
    sourceEquivalences: [...usedSourceEquivalences.values()],
  };
  delete base.diagnostics;
  return base;
}

export function sha256Text(value: string): string {
  return createHash("sha256").update(value, "utf8").digest("hex");
}
