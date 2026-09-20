import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { constants, type BigIntStats } from "node:fs";
import { lstat, open, realpath } from "node:fs/promises";
import path from "node:path";
import { gunzipSync } from "node:zlib";
import { NFL_TEAMS } from "@laces-out/domain";
import type { ProjectionDefensePointsAllowedDefinition } from "@laces-out/projections";
import { historicalRosChecksum } from "./first-party-ros-backtest.js";
import {
  retainedV12RosHistoricalCorpusIdentity,
  rosHistoricalCorpusIdentity,
  snapshotRetainedV12RosHistoricalCorpus,
  snapshotRosHistoricalCorpus,
  requireCurrentRosHistoricalActualDefinition,
  requireRosHistoricalPointsAllowedDefinition,
  type RosHistoricalCorpus,
  type RosHistoricalCorpusForecast,
} from "./ros-historical-corpus.js";
import {
  createRosDerivedOutcomeCache,
  createRosDerivedOutcomeRecord,
  type RosDerivedOutcomeDependencies,
  type RosDerivedOutcomeRecord,
  type RosDerivedOutcomeSource,
} from "./ros-derived-outcome-cache.js";
import { createRosDerivedRetainedOutcomeCache } from "./ros-derived-retained-cache.js";
import { completeVerifiedEmptyRosPlayerLabels } from "./ros-derived-empty-player-labels.js";
import {
  parseRosDerivedProductionPackage,
  type RosDerivedProductionPackage,
} from "./ros-derived-production-package.js";
import type { RosOutcomeCache } from "./ros-outcome-cache.js";
import {
  hasRosHistoricalCorpusReleaseThresholds,
  hasCurrentRosHistoricalCoverageThresholds,
} from "./ros-historical-corpus-protocol.js";

export interface RosDerivedSourceRoots {
  readonly "original-v12": string;
  readonly "native-dst-v13": string;
  readonly "expanded-dst-v13": Partial<
    Readonly<Record<ProjectionDefensePointsAllowedDefinition, string>>
  >;
}
export interface VerifiedRosDerivedPackage {
  readonly packageJson: string;
  readonly packageChecksum: string;
  readonly manifest: RosDerivedProductionPackage;
  readonly qualificationProtocolText: string;
  readonly original: RosHistoricalCorpus;
  readonly originalCandidate: RosHistoricalCorpus;
  readonly currentCandidate: RosHistoricalCorpus;
  readonly training: RosHistoricalCorpus;
  readonly originalCache: RosOutcomeCache;
  readonly originalCandidateCache: RosOutcomeCache;
  readonly currentCandidateCache: RosOutcomeCache;
  readonly trainingCache: RosOutcomeCache;
  readonly sourceForKey: ReadonlyMap<string, RosDerivedOutcomeSource>;
}
const MAX_DOCUMENT = 128 * 1_024 * 1_024;
const sha = (bytes: string | Uint8Array) => createHash("sha256").update(bytes).digest("hex");
function object(value: unknown): Record<string, unknown> {
  assert(
    value !== null && typeof value === "object" && !Array.isArray(value),
    "Derived dependency object required",
  );
  return value as Record<string, unknown>;
}
function list(value: unknown, length: number): readonly unknown[] {
  assert(Array.isArray(value) && value.length === length, "Derived dependency population mismatch");
  return value;
}
/** Reference/corpus documents use ordinal canonicalization, unlike historical report checksums. */
export function rosDerivedDocumentChecksum(value: unknown): string {
  let nodes = 0;
  const digest = createHash("sha256");
  function write(input: unknown, depth: number): void {
    assert(++nodes <= 8_000_000 && depth <= 32, "Derived document complexity exceeded");
    if (Array.isArray(input)) {
      assert(input.length <= 20_000);
      digest.update("[");
      input.forEach((child, index) => {
        if (index > 0) digest.update(",");
        write(child, depth + 1);
      });
      digest.update("]");
    } else if (input !== null && typeof input === "object") {
      const row = object(input),
        keys = Object.keys(row).sort();
      assert(keys.length <= 20_000);
      digest.update("{");
      keys.forEach((key, index) => {
        if (index > 0) digest.update(",");
        digest.update(`${JSON.stringify(key)}:`);
        write(row[key], depth + 1);
      });
      digest.update("}");
    } else {
      assert(
        input === null ||
          typeof input === "string" ||
          typeof input === "boolean" ||
          (typeof input === "number" && Number.isFinite(input)),
        "Non-JSON derived dependency",
      );
      digest.update(JSON.stringify(input));
    }
  }
  write(value, 0);
  return digest.digest("hex");
}
function same(left: unknown, right: unknown, reason: string): void {
  assert.equal(rosDerivedDocumentChecksum(left), rosDerivedDocumentChecksum(right), reason);
}
const id = (row: RosHistoricalCorpusForecast) =>
  `${row.forecast.forecastSeason}:${row.forecast.asOfWeek}:${row.forecast.position}:${row.forecast.playerId === "DST:LA" ? "DST:LAR" : row.forecast.playerId}`;
const vectorId = (key: { readonly modelVersion: string; readonly identity: string }) =>
  `${key.modelVersion}:${key.identity}`;

/** Bounded descriptor read, never follows roots, ancestors or files supplied through symlinks. */
export async function readPinnedRosDerivedArtifact(
  directory: string,
  filename: string,
  checksum: string,
  maximum: number,
  signal: AbortSignal,
): Promise<Buffer> {
  signal.throwIfAborted();
  assert(
    path.isAbsolute(directory) &&
      path.resolve(directory) === directory &&
      path.basename(filename) === filename &&
      /^[a-f0-9]{64}$/u.test(checksum),
  );
  assert.equal(await realpath(directory), directory, "Derived artifact root is a symlink");
  const root = await lstat(directory, { bigint: true });
  assert(root.isDirectory());
  const file = path.join(directory, filename);
  const handle = await open(file, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
  const stamp = (value: BigIntStats) =>
    `${value.dev}:${value.ino}:${value.size}:${value.mtimeNs}:${value.ctimeNs}`;
  try {
    const initial = await handle.stat({ bigint: true });
    assert(
      initial.isFile() && initial.size > 0n && initial.size <= BigInt(maximum),
      "Derived artifact size/type exceeded bounds",
    );
    const buffer = Buffer.alloc(Number(initial.size));
    let offset = 0;
    while (offset < buffer.length) {
      signal.throwIfAborted();
      const read = await handle.read(
        buffer,
        offset,
        Math.min(1_024 * 1_024, buffer.length - offset),
        offset,
      );
      assert(read.bytesRead > 0, "Truncated derived dependency");
      offset += read.bytesRead;
    }
    assert.equal(sha(buffer), checksum, "Derived dependency byte pin mismatch");
    assert.equal(
      stamp(await handle.stat({ bigint: true })),
      stamp(initial),
      "Derived dependency changed during read",
    );
    const current = await lstat(file, { bigint: true });
    assert(current.isFile() && !current.isSymbolicLink());
    assert.equal(stamp(current), stamp(initial), "Derived dependency path changed");
    const finalRoot = await lstat(directory, { bigint: true });
    assert.equal(await realpath(directory), directory);
    assert(
      root.dev === finalRoot.dev && root.ino === finalRoot.ino,
      "Derived artifact root changed",
    );
    signal.throwIfAborted();
    return buffer;
  } finally {
    await handle.close();
  }
}
export function verifyRosDerivedCorpusScope(corpus: RosHistoricalCorpus, training: boolean): void {
  assert.equal(corpus.forecasts.length, training ? 2176 : 3264);
  assert.equal(corpus.options.playersPerPosition, training ? 32 : 8);
  assert.equal(corpus.options.maximumForecasts, 6000);
  assert.equal(corpus.skippedForecasts, 0);
  assert.equal(corpus.coverage.state, "qualified");
  assert(hasRosHistoricalCorpusReleaseThresholds(corpus.options));
  assert(hasCurrentRosHistoricalCoverageThresholds(corpus.coverage.thresholds));
  same(corpus.options.heldOutSeasons, [2022, 2023, 2024, 2025], "Locked heldouts");
  same(
    corpus.options.asOfWeeks,
    Array.from({ length: 17 }, (_, i) => i + 1),
    "Locked cutoffs",
  );
  same(
    [...corpus.options.positions].sort(),
    training ? ["DST"] : ["DST", "K", "QB", "RB", "TE", "WR"],
    "Locked positions",
  );
  const groups = new Map<string, Set<string>>();
  for (const row of corpus.forecasts) {
    const f = row.forecast;
    assert(
      [2022, 2023, 2024, 2025].includes(f.forecastSeason) &&
        Number.isInteger(f.asOfWeek) &&
        f.asOfWeek >= 1 &&
        f.asOfWeek <= 17 &&
        f.windowStartWeek === f.asOfWeek + 1 &&
        f.windowEndWeek === 18 &&
        f.trainedThroughSeason === f.forecastSeason - 1,
    );
    const key = `${f.forecastSeason}:${f.asOfWeek}:${f.position}`,
      players = groups.get(key) ?? new Set<string>();
    const player = f.playerId === "DST:LA" ? "DST:LAR" : f.playerId;
    assert(!players.has(player));
    players.add(player);
    groups.set(key, players);
  }
  assert.equal(groups.size, 4 * 17 * (training ? 1 : 6));
  for (const players of groups.values()) {
    assert.equal(players.size, training ? 32 : 8);
    if (training) assert(NFL_TEAMS.every((team) => players.has(`DST:${team}`)));
  }
}

/** Authenticates all package artifacts before exposing any replay cache; never builds or simulates. */
export async function loadVerifiedRosDerivedPackage(options: {
  readonly directory: string;
  readonly packageChecksum: string;
  /** Only explicit preparation may validate before publishing the ready manifest. */
  readonly unpublishedPackageJson?: string;
  readonly pointsAllowedDefinition: ProjectionDefensePointsAllowedDefinition;
  readonly sourceRoots: RosDerivedSourceRoots;
  readonly signal: AbortSignal;
}): Promise<VerifiedRosDerivedPackage> {
  const { signal } = options;
  const packageBytes =
    options.unpublishedPackageJson === undefined
      ? await readPinnedRosDerivedArtifact(
          path.join(options.directory, "marginal-bundles"),
          `${options.packageChecksum}.json`,
          options.packageChecksum,
          2 * 1_024 * 1_024,
          signal,
        )
      : Buffer.from(options.unpublishedPackageJson);
  const packageJson = new TextDecoder("utf-8", { fatal: true }).decode(packageBytes);
  const manifest = parseRosDerivedProductionPackage(packageJson, options.packageChecksum);
  assert.equal(manifest.pointsAllowedDefinition, options.pointsAllowedDefinition);
  const documents = new Map<string, unknown>(),
    textByPath = new Map<string, string>();
  let totalBytes = 0;
  for (const [logicalPath, file] of Object.entries(manifest.files)) {
    const compressed = await readPinnedRosDerivedArtifact(
      path.join(options.directory, "derived-artifacts"),
      file.filename,
      file.sha256,
      MAX_DOCUMENT,
      signal,
    );
    const bytes =
      file.encoding === "gzip-json"
        ? gunzipSync(compressed, { maxOutputLength: MAX_DOCUMENT })
        : compressed;
    totalBytes += bytes.length;
    assert(totalBytes <= 384 * 1_024 * 1_024, "Derived package dependency bytes exceeded bounds");
    const text = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
    const document: unknown = file.encoding === "utf8-text" ? text : JSON.parse(text);
    if (file.encoding === "utf8-text")
      assert(bytes.length <= 1_024 * 1_024, "Protocol text exceeded bounds");
    else rosDerivedDocumentChecksum(document);
    documents.set(logicalPath, document);
    if (logicalPath === manifest.dependencies.qualificationProtocol)
      textByPath.set(logicalPath, text);
  }
  const get = (role: keyof RosDerivedProductionPackage["dependencies"]) =>
    documents.get(manifest.dependencies[role]);
  function checkPins(value: unknown): void {
    for (const [logicalPath, checksum] of Object.entries(object(value))) {
      assert.equal(
        manifest.files[logicalPath]?.sha256,
        checksum,
        `Unretained proof dependency ${logicalPath}`,
      );
      assert(documents.has(logicalPath));
    }
  }
  const originalEnvelope = object(get("originalCorpus"));
  const original = snapshotRetainedV12RosHistoricalCorpus(
    originalEnvelope.corpus as RosHistoricalCorpus,
  );
  assert.equal(
    retainedV12RosHistoricalCorpusIdentity(original),
    manifest.originalPreviousPhysicalCorpus,
  );
  assert.equal(originalEnvelope.identity, manifest.originalPreviousPhysicalCorpus);
  verifyRosDerivedCorpusScope(original, false);
  const referenceEnvelope = object(get("originalReference")),
    reference = object(referenceEnvelope.payload);
  assert.equal(reference.version, "ros-compatible-reference-corpus-v1");
  assert.equal(rosDerivedDocumentChecksum(reference), referenceEnvelope.identity);
  const originalCandidate = reference.targetCorpus as RosHistoricalCorpus;
  assert.equal(
    rosDerivedDocumentChecksum(originalCandidate),
    manifest.originalCandidatePhysicalCorpus,
  );
  verifyRosDerivedCorpusScope(originalCandidate, false);
  assert.equal(
    object(reference.generation).originalCorpusIdentity,
    manifest.originalPreviousPhysicalCorpus,
  );
  const originalRecords = list(reference.records, 6528) as readonly RosDerivedOutcomeRecord[];
  const originalById = new Map(original.forecasts.map((row) => [id(row), row]));
  const oldCandidateById = new Map(originalCandidate.forecasts.map((row) => [id(row), row]));
  same(
    original.forecasts.map(id),
    originalCandidate.forecasts.map(id),
    "Original ordered audit changed",
  );
  assert.equal(
    historicalRosChecksum(original.forecasts.map(id)),
    manifest.originalAuditMembershipChecksum,
  );
  same(original.sourceAudit, manifest.originalForecastSources, "Original retained source audit");
  same(
    originalCandidate.sourceAudit,
    manifest.originalForecastSources,
    "Original reference source audit",
  );
  const audit = object(get("compatibilityAudit"));
  assert.equal(audit.state, "verified-input-seed-window-and-archived-payload-identity");
  assert.equal(audit.originalCorpusIdentity, manifest.originalPreviousPhysicalCorpus);
  const vectors = list(audit.vectorChecks, 5440).map(object);
  const auditById = new Map(
    vectors.map((vector) => [
      `${String(vector.forecastIdentity)}:${String(vector.strategy)}`,
      vector,
    ]),
  );
  assert.equal(auditById.size, 5440);
  const fragmentEnvelope = object(get("correctedNonDstFragment")),
    fragment = object(fragmentEnvelope.payload);
  assert.equal(rosDerivedDocumentChecksum(fragment), manifest.nonDstFragmentIdentity);
  assert.equal(fragmentEnvelope.identity, manifest.nonDstFragmentIdentity);
  assert.equal(fragment.originalReferenceIdentity, referenceEnvelope.identity);
  assert.equal(fragment.dependencyRoot, reference.dependencyRoot);
  assert.equal(fragment.candidateFrozenRevision, manifest.candidateFrozenRevision);
  assert.equal(fragment.version, "corrected-source-nondst-reference-fragment-v1");
  assert.equal(fragment.actualDefinitionVersion, "complete-player-ledger-actuals-v1");
  assert.equal(fragment.physicalGenerationModelVersion, "laces-ros-distribution-v12");
  assert.equal(fragment.compatibleCandidateModelVersion, "laces-ros-distribution-v13");
  for (const flag of [
    "noOriginalWrites",
    "noSimulation",
    "noCalibrationRefit",
    "noNewModelVersionLabelOnPhysicalBytes",
    "requiresReferencePayloadValidationOnUse",
    "requiresRecomputedPooledCalibrationAndGates",
  ])
    assert.equal(fragment[flag], true);
  assert.equal(fragment.canAuthorizeRelease, false);
  assert.equal(fragment.isNativeCorpus, false);
  checkPins(fragment.proofPins);
  same(
    fragment.originalSourceAudit,
    originalCandidate.sourceAudit,
    "Certified original source audit changed",
  );
  same(
    fragment.originalSourceChecksums,
    originalCandidate.sourceChecksums,
    "Certified original source checksums changed",
  );
  same(fragment.coverage, originalCandidate.coverage, "Certified original coverage changed");
  same(fragment.seasons, originalCandidate.seasons, "Certified original seasons changed");
  const certification = object(get("playerCertification"));
  assert.equal(certification.version, "corrected-source-nondst-functional-equivalence-v1");
  assert.equal(
    certification.state,
    "non-dst-physical-input-and-observed-window-equivalence-established",
  );
  assert.equal(certification.frozenCandidateRevision, manifest.candidateFrozenRevision);
  assert.equal(certification.observedActualDefinitionVersion, fragment.actualDefinitionVersion);
  checkPins(certification.pins);
  const delta = object(get("playerComponentDelta"));
  assert.equal(delta.completed, 2720);
  same(delta.unexpected, [], "Unexpected player label correction");
  const correctedPlayers = list(fragment.forecasts, 2720) as readonly RosHistoricalCorpusForecast[];
  const fragmentRecords = list(
    fragment.vectorReferences,
    5440,
  ) as readonly RosDerivedOutcomeRecord[];
  same(
    fragmentRecords,
    originalRecords.filter((entry) => entry.kind === "compatible-v12-nondst"),
    "Changed certified physical vector references",
  );
  const correctedById = new Map(correctedPlayers.map((row) => [id(row), row]));
  assert.equal(correctedById.size, 2720);
  const actuals = list(get("correctedPlayerActuals"), 2720).map(object);
  const actualById = new Map(actuals.map((row) => [String(row.identity), row]));
  assert.equal(actualById.size, 2720);
  for (const row of correctedPlayers) {
    assert(row.forecast.position !== "DST");
    const originalRow = oldCandidateById.get(id(row)),
      actual = actualById.get(id(row));
    assert(originalRow && actual);
    same(
      { ...row, actualComponents: originalRow.actualComponents },
      originalRow,
      "Player physical forecast changed during label certification",
    );
    same(row.actualComponents, actual.actualComponents, "Certified actual ledger differs");
    assert.equal(rosDerivedDocumentChecksum(row.actualComponents), actual.actualComponentsChecksum);
    assert.equal(row.actualGames, actual.persistedActualGames);
    assert.equal(row.scheduledGames, actual.scheduledGames);
    // The correction is completeness-only: new keys explicitly prove zero, existing values persist.
    for (const [name, value] of Object.entries(row.actualComponents))
      assert.equal(value, originalRow.actualComponents[name] ?? 0);
    for (const [name, value] of Object.entries(originalRow.actualComponents))
      assert.equal(row.actualComponents[name], value);
  }
  const certifiedProof = (basename: string): unknown => {
    const paths = Object.keys(object(certification.pins)).filter(
      (logicalPath) => path.basename(logicalPath) === basename,
    );
    assert.equal(paths.length, 1, `Unique certified proof required: ${basename}`);
    return documents.get(paths[0]!);
  };
  const completedPlayers = completeVerifiedEmptyRosPlayerLabels({
    forecasts: correctedPlayers,
    corpus: originalCandidate,
    certification,
    zeroEvidence: certifiedProof("zero-production-evidence.json"),
    actualVerification: certifiedProof("current-actuals-verification.json"),
  });
  const completedPlayerById = new Map(completedPlayers.map((row) => [id(row), row]));
  const equivalence = object(get("equivalentPhysicalInputs"));
  assert.equal(equivalence.version, "current-input-functional-equivalence-map-v1");
  const equivalentById = new Map(
    list(equivalence.vectors, 5440)
      .map(object)
      .map((vector) => [`${String(vector.forecastIdentity)}:${String(vector.strategy)}`, vector]),
  );
  assert.equal(equivalentById.size, 5440);
  for (const vector of vectors) {
    const equivalent = equivalentById.get(
      `${String(vector.forecastIdentity)}:${String(vector.strategy)}`,
    );
    assert(equivalent);
    same(equivalent.originalKey, vector.originalKey, "Equivalent original key changed");
    same(
      equivalent.currentEquivalentKey,
      vector.currentProposedKey,
      "Equivalent current key changed",
    );
    assert.equal(equivalent.canonicalCompleteInputSha256, vector.currentCanonicalFullInputSha256);
    assert.equal(equivalent.originalFileSha256, vector.originalFileSha256);
    assert.equal(equivalent.originalFile, vector.originalCacheFile);
    assert.equal(equivalent.originalManifestChecksum, vector.originalManifestChecksum);
    assert.equal(equivalent.seedHash, object(vector.originalProvenance).seedHash);
  }
  const trainingEnvelope = object(get("nativeDstCorpus"));
  const training = snapshotRosHistoricalCorpus(trainingEnvelope.corpus as RosHistoricalCorpus);
  assert.equal(rosHistoricalCorpusIdentity(training), manifest.correctedDstPhysicalCorpus);
  assert.equal(trainingEnvelope.identity, manifest.correctedDstPhysicalCorpus);
  requireCurrentRosHistoricalActualDefinition(training);
  assert.equal(
    requireRosHistoricalPointsAllowedDefinition(training),
    manifest.pointsAllowedDefinition,
  );
  verifyRosDerivedCorpusScope(training, true);
  same(training.sourceAudit, manifest.observedSources, "Current native source audit");
  same(training.options.heldOutSeasons, original.options.heldOutSeasons, "Shared heldout years");
  const trainingById = new Map(training.forecasts.map((row) => [id(row), row]));
  const trainingSources = list(
    get("nativeDstReferences"),
    4352,
  ) as readonly RosDerivedOutcomeSource[];
  const sourcesByKey = new Map(trainingSources.map((source) => [vectorId(source.key), source]));
  assert.equal(sourcesByKey.size, 4352);
  const sourceForKey = new Map<string, RosDerivedOutcomeSource>();
  function registerSource(
    key: RosDerivedOutcomeSource["key"],
    source: RosDerivedOutcomeSource,
  ): void {
    const identity = vectorId(key),
      existing = sourceForKey.get(identity);
    if (existing) {
      assert.equal(existing.sha256, source.sha256, "Conflicting physical bytes for scoring key");
      assert.equal(
        existing.manifestChecksum,
        source.manifestChecksum,
        "Conflicting physical manifest for scoring key",
      );
      same(existing.key, source.key, "Conflicting original key for scoring reference");
    } else sourceForKey.set(identity, source);
  }
  const roots = {
    "original-v12": options.sourceRoots["original-v12"],
    "native-dst-v13": options.sourceRoots["native-dst-v13"],
    "expanded-dst-v13": options.sourceRoots["expanded-dst-v13"][manifest.pointsAllowedDefinition],
  };
  assert(roots["expanded-dst-v13"], "Configured current native source root is missing");
  const referenceDependencies: RosDerivedOutcomeDependencies[] = originalRecords.map((entry) => {
    const key = `${entry.originalForecast.forecastSeason}:${entry.originalForecast.asOfWeek}:${entry.originalForecast.position}:${entry.originalForecast.playerId === "DST:LA" ? "DST:LAR" : entry.originalForecast.playerId}`;
    const targetRow = oldCandidateById.get(key);
    assert(targetRow);
    const sourceRow = entry.kind === "native-v13" ? targetRow : originalById.get(key);
    assert(sourceRow);
    registerSource(entry.targetKey, entry.source);
    registerSource(entry.source.key, entry.source);
    return {
      sourceRow,
      targetRow,
      strategy: entry.strategy,
      source: entry.source,
      sourceCorpusIdentity:
        entry.kind === "native-v13"
          ? String(object(reference.generation).nativeCorpusIdentity)
          : manifest.originalPreviousPhysicalCorpus,
      auditVector: entry.kind === "native-v13" ? null : auditById.get(`${key}:${entry.strategy}`)!,
    };
  });
  const originalCandidateCache = createRosDerivedOutcomeCache({
    records: originalRecords,
    dependencies: referenceDependencies,
    sourceRoots: roots as Record<"original-v12" | "native-dst-v13" | "expanded-dst-v13", string>,
  });
  const nativeDependencies: RosDerivedOutcomeDependencies[] = training.forecasts.flatMap((row) =>
    (["contextual", "availability-aware-recency"] as const).map((strategy) => {
      const source = sourcesByKey.get(
        vectorId(strategy === "contextual" ? row.contextualKey : row.recencyKey),
      );
      assert(source && source.namespace === "expanded-dst-v13");
      registerSource(source.key, source);
      return {
        sourceRow: row,
        targetRow: row,
        strategy,
        source,
        sourceCorpusIdentity: manifest.correctedDstPhysicalCorpus,
        auditVector: null,
      };
    }),
  );
  const nativeRecords = nativeDependencies.map(createRosDerivedOutcomeRecord);
  const trainingCache = createRosDerivedOutcomeCache({
    records: nativeRecords,
    dependencies: nativeDependencies,
    sourceRoots: roots as Record<"original-v12" | "native-dst-v13" | "expanded-dst-v13", string>,
  });
  const nativeRecordByKey = new Map(
    nativeRecords.map((entry, index) => [
      vectorId(entry.targetKey),
      { record: entry, dependency: nativeDependencies[index]! },
    ]),
  );
  const oldRecordByKey = new Map(
    originalRecords.map((entry, index) => [
      vectorId(entry.targetKey),
      { record: entry, dependency: referenceDependencies[index]! },
    ]),
  );
  const candidateRows = originalCandidate.forecasts.map((row) => {
    const next =
      row.forecast.position === "DST"
        ? trainingById.get(id(row))
        : completedPlayerById.get(id(row));
    assert(next);
    assert.equal(next.actualGames, row.actualGames);
    assert.equal(next.scheduledGames, row.scheduledGames);
    return next;
  });
  const candidateEntries = candidateRows.flatMap((row) =>
    [row.contextualKey, row.recencyKey].map((key) => {
      const entry = (row.forecast.position === "DST" ? nativeRecordByKey : oldRecordByKey).get(
        vectorId(key),
      );
      assert(entry);
      return entry;
    }),
  );
  const currentCandidateCache = createRosDerivedOutcomeCache({
    records: candidateEntries.map((entry) => entry.record),
    dependencies: candidateEntries.map((entry) => entry.dependency),
    sourceRoots: roots as Record<"original-v12" | "native-dst-v13" | "expanded-dst-v13", string>,
  });
  const retainedSources = [
    ...originalRecords
      .filter((entry) => entry.kind === "compatible-v12-nondst")
      .map((entry) => entry.source),
    ...(list(reference.benchmarkSources, 1088) as RosDerivedOutcomeSource[]),
  ];
  for (const source of retainedSources) registerSource(source.key, source);
  const originalCache = createRosDerivedRetainedOutcomeCache({
    corpus: original,
    expectedCorpusIdentity: manifest.originalPreviousPhysicalCorpus,
    sources: retainedSources,
    directory: roots["original-v12"],
  });
  // Original missing player fields are certified zero additions, without changing old DST truth.
  const completePlayerLabels = (corpus: RosHistoricalCorpus): RosHistoricalCorpus => ({
    ...corpus,
    forecasts: corpus.forecasts.map((row) =>
      row.forecast.position === "DST"
        ? row
        : { ...row, actualComponents: completedPlayerById.get(id(row))!.actualComponents },
    ),
  });
  return {
    packageJson,
    packageChecksum: options.packageChecksum,
    manifest,
    qualificationProtocolText: textByPath.get(manifest.dependencies.qualificationProtocol)!,
    original: completePlayerLabels(original),
    originalCandidate: completePlayerLabels(originalCandidate),
    currentCandidate: {
      ...originalCandidate,
      sourceAudit: training.sourceAudit,
      sourceChecksums: training.sourceChecksums,
      forecasts: candidateRows,
      kickerFamilyAudit: originalCandidate.kickerFamilyAudit,
    },
    training,
    originalCache,
    originalCandidateCache,
    currentCandidateCache,
    trainingCache,
    sourceForKey,
  };
}
