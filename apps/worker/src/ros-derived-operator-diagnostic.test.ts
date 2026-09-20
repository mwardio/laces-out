import { AssertionError } from "node:assert";
import { expect, it } from "vitest";
import { rosDerivedOperatorDiagnostic } from "./ros-derived-operator-diagnostic.js";
it("distinguishes pinned-byte and assertion failures without exposing compared values", () => {
  const error = new AssertionError({
    message: "Derived dependency byte pin mismatch",
    actual: "private-token",
    expected: "other-secret",
    operator: "strictEqual",
  });
  error.stack =
    "Error: private-token\n    at readPinned (/private/project/apps/worker/src/ros-derived-package-loader.ts:88:2)";
  expect(rosDerivedOperatorDiagnostic(error, "proof-graph")).toEqual({
    stage: "proof-graph",
    code: "ERR_ASSERTION",
    reason: "Derived dependency byte pin mismatch",
    assertion: "strictEqual",
    sourceFrame: "ros-derived-package-loader.ts:88:2",
  });
});
it.each(["ENOENT", "ENOSPC", "ELOOP"] as const)(
  "retains %s without forwarding OS paths or credentials",
  (code) => {
    const error = Object.assign(
      new Error("postgres://user:private-password@database/private-config"),
      { code },
    );
    const diagnostic = rosDerivedOperatorDiagnostic(error, "artifact-copy");
    expect(diagnostic).toMatchObject({ stage: "artifact-copy", code });
    expect(JSON.stringify(diagnostic)).not.toContain("private");
  },
);
it("keeps unknown errors and dynamically appended proof paths closed", () => {
  expect(rosDerivedOperatorDiagnostic(new Error("token-supersecret"), "environment")).toMatchObject(
    {
      stage: "environment",
      code: "operation_failed",
    },
  );
  expect(
    rosDerivedOperatorDiagnostic(
      new Error("Unretained proof dependency /private/config.json"),
      "proof-graph",
    ),
  ).toMatchObject({
    stage: "proof-graph",
    code: "operation_failed",
    reason: "Unretained proof dependency",
  });
});

it("preserves a dependency wrapper's safe root cause without forwarding private text", () => {
  const cause = Object.assign(new Error("ENOENT /private/key-config"), { code: "ENOENT" });
  const wrapper = new Error("dependency corrupt", { cause });
  expect(rosDerivedOperatorDiagnostic(wrapper, "physical-replay")).toMatchObject({
    stage: "physical-replay",
    code: "ENOENT",
  });
  expect(JSON.stringify(rosDerivedOperatorDiagnostic(wrapper, "physical-replay"))).not.toContain(
    "private",
  );
});

it("identifies incomplete historical labels without forwarding player identifiers or stat values", () => {
  const cause = new TypeError(
    "ROS historical actual components unavailable for private-player at 2022:5; missing=private-stat; invalid=private-value",
  );
  const diagnostic = rosDerivedOperatorDiagnostic(
    new Error("dependency corrupt", { cause }),
    "physical-replay",
  );
  expect(diagnostic).toMatchObject({
    reason: "ROS historical actual components unavailable",
    code: "operation_failed",
  });
  expect(JSON.stringify(diagnostic)).not.toContain("private");
});
