import { createHash } from "node:crypto";

import type { ProjectionDefensePointsAllowedDefinition } from "@laces-out/projections";
import { historicalRosChecksum } from "./first-party-ros-backtest.js";

export const ROS_DERIVED_PRODUCTION_PACKAGE_VERSION = "ros-derived-production-package-v1";
export const ROS_DERIVED_PRODUCTION_IDENTITY_VERSION = "ros-derived-production-role-v1";
const SHA = /^[a-f0-9]{64}$/u;
export const ROS_DERIVED_PRODUCTION_DEPENDENCIES = [
  "originalCorpus",
  "originalReference",
  "compatibilityAudit",
  "correctedNonDstFragment",
  "playerCertification",
  "correctedPlayerActuals",
  "playerComponentDelta",
  "equivalentPhysicalInputs",
  "nativeDstCorpus",
  "nativeDstReferences",
  "qualificationProtocol",
] as const;
type DependencyRole = (typeof ROS_DERIVED_PRODUCTION_DEPENDENCIES)[number];

export interface RosDerivedProductionFile {
  readonly filename: string;
  readonly sha256: string;
  readonly encoding: "json" | "gzip-json" | "utf8-text";
}
/** Files are content-addressed basenames below an independently configured artifact directory. */
export interface RosDerivedProductionPackage {
  readonly version: typeof ROS_DERIVED_PRODUCTION_PACKAGE_VERSION;
  readonly forecastSeason: 2026;
  readonly pointsAllowedDefinition: ProjectionDefensePointsAllowedDefinition;
  readonly originalCandidatePhysicalCorpus: string;
  readonly originalPreviousPhysicalCorpus: string;
  readonly correctedDstPhysicalCorpus: string;
  readonly nonDstFragmentIdentity: string;
  readonly originalAuditMembershipChecksum: string;
  readonly originalForecastSources: readonly Readonly<Record<string, unknown>>[];
  readonly observedSources: readonly Readonly<Record<string, unknown>>[];
  readonly candidateFrozenRevision: string;
  readonly dependencies: Readonly<Record<DependencyRole, string>>;
  /** Logical proof paths may be referenced by receipts, but never become filesystem paths. */
  readonly files: Readonly<Record<string, RosDerivedProductionFile>>;
  readonly retention: "protect-original-vectors-and-proof-files-for-package-lifetime";
  readonly noSimulation: true;
  readonly canAuthorizeRelease: false;
}
export function rosDerivedProductionRoleIdentity(
  packageIdentity: string,
  role: "candidate" | "retained-v12",
): string {
  if (!SHA.test(packageIdentity) || (role !== "candidate" && role !== "retained-v12"))
    throw new Error("Invalid derived production role identity");
  return historicalRosChecksum({
    version: ROS_DERIVED_PRODUCTION_IDENTITY_VERSION,
    packageIdentity,
    role,
  });
}

/** Metadata integrity only. Loading and authenticating every physical dependency is a separate step. */
export function parseRosDerivedProductionPackage(
  text: string,
  checksum: string,
): RosDerivedProductionPackage {
  function fail(): never {
    throw new Error("Invalid pinned derived production package");
  }
  if (
    typeof text !== "string" ||
    Buffer.byteLength(text) > 2 * 1_024 * 1_024 ||
    !SHA.test(checksum) ||
    createHash("sha256").update(text).digest("hex") !== checksum
  )
    fail();
  const value: unknown = JSON.parse(text);
  const object = (input: unknown): input is Record<string, unknown> =>
    input !== null && typeof input === "object" && !Array.isArray(input);
  if (!object(value)) fail();
  const keys = [
    "version",
    "forecastSeason",
    "pointsAllowedDefinition",
    "originalCandidatePhysicalCorpus",
    "originalPreviousPhysicalCorpus",
    "correctedDstPhysicalCorpus",
    "nonDstFragmentIdentity",
    "originalAuditMembershipChecksum",
    "originalForecastSources",
    "observedSources",
    "candidateFrozenRevision",
    "dependencies",
    "files",
    "retention",
    "noSimulation",
    "canAuthorizeRelease",
  ];
  if (
    Object.keys(value).sort().join() !== keys.sort().join() ||
    value.version !== ROS_DERIVED_PRODUCTION_PACKAGE_VERSION ||
    value.forecastSeason !== 2026 ||
    (value.pointsAllowedDefinition !== "yahoo-2022-v1" &&
      value.pointsAllowedDefinition !== "espn-2019-v1") ||
    value.retention !== "protect-original-vectors-and-proof-files-for-package-lifetime" ||
    value.noSimulation !== true ||
    value.canAuthorizeRelease !== false ||
    typeof value.candidateFrozenRevision !== "string" ||
    !/^[a-f0-9]{40}$/u.test(value.candidateFrozenRevision)
  )
    fail();
  for (const key of [
    "originalCandidatePhysicalCorpus",
    "originalPreviousPhysicalCorpus",
    "correctedDstPhysicalCorpus",
    "nonDstFragmentIdentity",
    "originalAuditMembershipChecksum",
  ])
    if (typeof value[key] !== "string" || !SHA.test(value[key])) fail();
  for (const key of ["originalForecastSources", "observedSources"]) {
    if (!Array.isArray(value[key]) || value[key].length !== 7) fail();
    for (const [index, source] of value[key].entries()) {
      if (!object(source) || source.season !== index + 2019 || Object.keys(source).length > 32)
        fail();
      for (const [field, item] of Object.entries(source))
        if (
          field !== "season" &&
          (typeof item !== "string" || !SHA.test(item)) &&
          (typeof item !== "number" || !Number.isFinite(item))
        )
          fail();
    }
  }
  if (
    !object(value.dependencies) ||
    Object.keys(value.dependencies).sort().join() !==
      [...ROS_DERIVED_PRODUCTION_DEPENDENCIES].sort().join() ||
    !object(value.files) ||
    Object.keys(value.files).length < ROS_DERIVED_PRODUCTION_DEPENDENCIES.length ||
    Object.keys(value.files).length > 256
  )
    fail();
  const filenames = new Set<string>();
  for (const [logicalPath, file] of Object.entries(value.files)) {
    if (
      logicalPath.length < 1 ||
      logicalPath.length > 512 ||
      !object(file) ||
      Object.keys(file).sort().join() !== "encoding,filename,sha256" ||
      typeof file.sha256 !== "string" ||
      !SHA.test(file.sha256) ||
      (file.encoding !== "json" &&
        file.encoding !== "gzip-json" &&
        file.encoding !== "utf8-text") ||
      file.filename !==
        `${file.sha256}.${file.encoding === "json" ? "json" : file.encoding === "utf8-text" ? "txt" : "json.gz"}`
    )
      fail();
    // Two logical proof paths may intentionally point at the same immutable bytes.
    filenames.add(String(file.filename));
  }
  if (filenames.size < ROS_DERIVED_PRODUCTION_DEPENDENCIES.length) fail();
  for (const role of ROS_DERIVED_PRODUCTION_DEPENDENCIES) {
    const logicalPath = value.dependencies[role];
    if (typeof logicalPath !== "string" || !Object.hasOwn(value.files, logicalPath)) fail();
  }
  const protocol = object(value.files[value.dependencies.qualificationProtocol as string])
    ? value.files[value.dependencies.qualificationProtocol as string]
    : null;
  if (!object(protocol) || protocol.encoding !== "utf8-text") fail();
  return value as unknown as RosDerivedProductionPackage;
}
