import { expect, it } from "vitest";
import {
  hash,
  pin,
  rosDerivedProductionEvaluationFixture,
} from "./ros-derived-evaluation.test-fixtures.js";
import {
  parseRosDerivedProductionPackage,
  rosDerivedProductionRoleIdentity,
} from "./ros-derived-production-package.js";
const fixture = rosDerivedProductionEvaluationFixture().productionPackage;
it("pins every physical/source role independently of runtime scoring, with exact raw protocol bytes metadata", () => {
  const pinned = pin(fixture);
  const parsed = parseRosDerivedProductionPackage(pinned.text, pinned.checksum);
  expect(parsed).toEqual(fixture);
  expect(parsed.files[parsed.dependencies.qualificationProtocol]).toEqual({
    filename: `${hash("qualificationProtocol")}.txt`,
    sha256: hash("qualificationProtocol"),
    encoding: "utf8-text",
  });
  const candidate = rosDerivedProductionRoleIdentity(pinned.checksum, "candidate"),
    previous = rosDerivedProductionRoleIdentity(pinned.checksum, "retained-v12");
  expect(candidate).not.toBe(previous);
  expect(rosDerivedProductionRoleIdentity(pinned.checksum, "candidate")).toBe(candidate);
  const other = pin({ ...fixture, pointsAllowedDefinition: "espn-2019-v1" });
  expect(rosDerivedProductionRoleIdentity(other.checksum, "candidate")).not.toBe(candidate);
});
it.each([
  "pin",
  "path",
  "encoding",
  "authority",
  "version",
  "role",
  "extra",
  "source-audit",
] as const)("rejects malformed %s package", (kind) => {
  const input = structuredClone(fixture);
  if (kind === "path")
    Object.assign(input.files[input.dependencies.originalCorpus]!, { filename: "../source.json" });
  if (kind === "encoding") {
    const role = input.files[input.dependencies.qualificationProtocol]!;
    Object.assign(role, { filename: `${role.sha256}.json`, encoding: "json" });
  }
  if (kind === "authority") Object.assign(input, { canAuthorizeRelease: true });
  if (kind === "version") Object.assign(input, { version: "native-corpus-v2" });
  if (kind === "role")
    Object.assign(input.dependencies, { nativeDstReferences: "unretained/file" });
  if (kind === "extra") Object.assign(input, { scoringProfile: "hidden-report-whitelist" });
  if (kind === "source-audit")
    Object.assign(input, { observedSources: input.observedSources.slice(1) });
  const pinned = pin(input);
  expect(() =>
    parseRosDerivedProductionPackage(pinned.text, kind === "pin" ? hash("wrong") : pinned.checksum),
  ).toThrow(/Invalid pinned/);
});
it("rejects oversized metadata and invalid role identifiers before any filesystem access", () => {
  const text = " ".repeat(2 * 1024 * 1024 + 1);
  expect(() => parseRosDerivedProductionPackage(text, hash(text))).toThrow();
  expect(() => rosDerivedProductionRoleIdentity("../path", "candidate")).toThrow();
  expect(() => rosDerivedProductionRoleIdentity(hash("x"), "training" as "candidate")).toThrow();
});
