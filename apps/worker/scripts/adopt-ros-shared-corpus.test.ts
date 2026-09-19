import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const dependencies = vi.hoisted(() => ({
  loadEnvironment: vi.fn(),
  createLock: vi.fn(),
  adopt: vi.fn(),
  recordAdoption: vi.fn(),
  close: vi.fn(),
}));

vi.mock("@laces-out/config", () => ({ loadEnvironment: dependencies.loadEnvironment }));
vi.mock("@laces-out/db", () => ({
  createDatabase: () => ({ db: "fixture-db", close: dependencies.close }),
}));
vi.mock("../src/ros-corpus-bootstrap.js", () => ({
  recordVerifiedRosCorpusAdoption: dependencies.recordAdoption,
}));
vi.mock("../src/ros-corpus-lock.js", () => ({
  createPostgresRosCorpusLock: dependencies.createLock,
}));
vi.mock("../src/ros-shared-corpus-runner.js", () => ({
  adoptRosSharedCorpus: dependencies.adopt,
}));

const corpusIdentity = "a".repeat(64);
const requestIdentity = "b".repeat(64);
const args = ["--season=2026", `--corpus=${corpusIdentity}`, "--outcome-cache=/tmp/ros-outcomes"];
const originalArgv = process.argv;
const originalExitCode = process.exitCode;

beforeEach(() => {
  vi.resetModules();
  vi.resetAllMocks();
  process.argv = ["node", "adopt-ros-shared-corpus.ts", ...args];
  process.exitCode = undefined;
  dependencies.loadEnvironment.mockReturnValue({ DATABASE_URL: "postgres://private-secret" });
  dependencies.createLock.mockReturnValue("fixture-lock");
  dependencies.adopt.mockResolvedValue({ state: "adopted", corpusIdentity, requestIdentity });
});

afterEach(() => {
  process.argv = originalArgv;
  process.exitCode = originalExitCode;
  vi.restoreAllMocks();
});

describe("ROS corpus adoption CLI", () => {
  it.each([
    [],
    args.slice(1),
    ["--season=2026.0", ...args.slice(1)],
    ["--season=2006", ...args.slice(1)],
    [args[0]!, `--corpus=${"A".repeat(64)}`, args[2]!],
    [args[0]!, "--corpus=short", args[2]!],
    [...args.slice(0, 2), "--outcome-cache=relative/path"],
    [...args, "--season=2027"],
    [...args, "--unknown=private-secret"],
    [...args, "--points-allowed-definition=unknown"],
  ])("rejects malformed arguments before loading configuration: %j", async (...selected) => {
    process.argv = ["node", "adopt-ros-shared-corpus.ts", ...selected];
    const stdout = vi.spyOn(process.stdout, "write").mockReturnValue(true);
    const stderr = vi.spyOn(process.stderr, "write").mockReturnValue(true);

    await import("./adopt-ros-shared-corpus.js");

    expect(process.exitCode).toBe(1);
    expect(dependencies.loadEnvironment).not.toHaveBeenCalled();
    expect(dependencies.createLock).not.toHaveBeenCalled();
    expect(dependencies.adopt).not.toHaveBeenCalled();
    expect(stdout).not.toHaveBeenCalled();
    expect(stderr).toHaveBeenCalledWith(expect.stringContaining('"state":"invalid-arguments"'));
    expect(stderr.mock.calls.flat().join("")).not.toContain("private-secret");
  });

  it("passes the exact operator identities to the locked adoption helper and prints only safe fields", async () => {
    const stdout = vi.spyOn(process.stdout, "write").mockReturnValue(true);
    dependencies.adopt.mockResolvedValue({
      state: "adopted",
      corpusIdentity,
      requestIdentity,
      unexpectedPrivateData: "private-secret",
    });

    await import("./adopt-ros-shared-corpus.js");

    expect(dependencies.createLock).toHaveBeenCalledWith("postgres://private-secret");
    expect(dependencies.adopt).toHaveBeenCalledWith({
      season: 2026,
      corpusIdentity,
      directory: "/tmp/ros-outcomes",
      pointsAllowedDefinition: "yahoo-2022-v1",
      lock: "fixture-lock",
      signal: expect.any(AbortSignal) as AbortSignal,
    });
    expect(stdout).toHaveBeenCalledExactlyOnceWith(
      `${JSON.stringify({ state: "adopted", requestIdentity, corpusIdentity })}\n`,
    );
    expect(process.exitCode).toBeUndefined();
  });

  it("binds ESPN adoption and its durable ready record to the same explicit definition", async () => {
    process.argv.push("--points-allowed-definition=espn-2019-v1");
    vi.spyOn(process.stdout, "write").mockReturnValue(true);
    await import("./adopt-ros-shared-corpus.js");
    expect(dependencies.adopt).toHaveBeenCalledWith(
      expect.objectContaining({ pointsAllowedDefinition: "espn-2019-v1" }),
    );
    expect(dependencies.recordAdoption).toHaveBeenCalledExactlyOnceWith(
      "fixture-db",
      2026,
      corpusIdentity,
      expect.any(Date),
      "espn-2019-v1",
    );
    expect(process.exitCode).toBeUndefined();
  });

  it("does not expose credentials from an adoption failure", async () => {
    const stderr = vi.spyOn(process.stderr, "write").mockReturnValue(true);
    dependencies.adopt.mockRejectedValue(
      new Error("Unable to connect to postgres://private-secret"),
    );

    await import("./adopt-ros-shared-corpus.js");

    expect(process.exitCode).toBe(1);
    expect(stderr).toHaveBeenCalledWith(expect.stringContaining('"state":"failed"'));
    expect(stderr.mock.calls.flat().join("")).not.toContain("private-secret");
  });

  it.each([
    ["SIGINT", 130],
    ["SIGTERM", 143],
  ] as const)(
    "cancels adoption on %s and removes its signal handlers",
    async (signal, exitCode) => {
      const stderr = vi.spyOn(process.stderr, "write").mockReturnValue(true);
      const priorHandlers = process.listenerCount(signal);
      dependencies.adopt.mockImplementation(({ signal: cancellation }: { signal: AbortSignal }) => {
        process.emit(signal);
        cancellation.throwIfAborted();
      });

      await import("./adopt-ros-shared-corpus.js");

      expect(process.exitCode).toBe(exitCode);
      expect(stderr).toHaveBeenCalledWith(expect.stringContaining('"state":"interrupted"'));
      expect(process.listenerCount(signal)).toBe(priorHandlers);
    },
  );
});
