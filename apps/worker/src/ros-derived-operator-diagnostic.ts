/** Source locations and closed diagnostic names only; never forward provider/DB/OS messages. */
export function rosDerivedOperatorDiagnostic(error: unknown, stage: string) {
  let selected = error;
  // Dependency wrappers keep the original exception for this bounded sanitized operator view.
  // Runtime ledger classification continues to expose only its closed dependency/reason enum.
  for (let depth = 0; depth < 4; depth++) {
    if (
      selected === null ||
      typeof selected !== "object" ||
      !("cause" in selected) ||
      selected.cause === undefined
    )
      break;
    selected = selected.cause;
  }
  const object =
    selected !== null && typeof selected === "object"
      ? (selected as {
          code?: unknown;
          name?: unknown;
          message?: unknown;
          stack?: unknown;
          operator?: unknown;
        })
      : {};
  const codes = new Set([
    "ENOENT",
    "ELOOP",
    "EACCES",
    "ENOSPC",
    "ENOTDIR",
    "EEXIST",
    "ERR_ASSERTION",
    "insufficient_disk_space",
    "disk_space_check_failed",
  ]);
  const code =
    typeof object.code === "string" && codes.has(object.code) ? object.code : "operation_failed";
  const reasons = [
    "Derived dependency byte pin mismatch",
    "Derived artifact root is a symlink",
    "Derived dependency changed during read",
    "Derived dependency path changed",
    "Derived artifact root changed",
    "Derived artifact size/type exceeded bounds",
    "Derived package dependency bytes exceeded bounds",
    "Derived dependency population mismatch",
    "Derived document complexity exceeded",
    "Invalid pinned derived production package",
    "Exact artifact closure required",
    "Unretained proof dependency",
    "Original source file hash",
    "Original real-codec validation failed",
    "Source path changed during read",
    "Source root changed during read",
    "Independent record reconstruction",
    "Complete unique physical vector closure required",
    "Missing retained derived vector",
    "Conflicting physical bytes for scoring key",
    "Certified actual ledger differs",
    "Player physical forecast changed during label certification",
    "ROS corpus build lock was lost",
    "ROS corpus build lock connection closed",
  ];
  const message = typeof object.message === "string" ? object.message : "";
  const reason = reasons.find((known) => message.startsWith(known));
  const sourceFrame =
    typeof object.stack === "string"
      ? object.stack
          .split("\n")
          .slice(1)
          .map(
            (line) =>
              line.match(/(?:src|dist|scripts)\/([a-zA-Z0-9_.-]+\.(?:ts|js):\d+:\d+)/u)?.[1],
          )
          .find(Boolean)
      : undefined;
  const operators = new Set([
    "==",
    "===",
    "strictEqual",
    "deepEqual",
    "deepStrictEqual",
    "fail",
    "throws",
    "ifError",
  ]);
  return {
    stage,
    code,
    ...(reason ? { reason } : {}),
    ...(typeof object.operator === "string" && operators.has(object.operator)
      ? { assertion: object.operator }
      : {}),
    ...(sourceFrame ? { sourceFrame } : {}),
  };
}
