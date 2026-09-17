import { readFile } from "node:fs/promises";
import { describe, expect, it, vi } from "vitest";
import { createJobQueue } from "./runtime.js";

const options = { connectionString: "postgres://user:secret@postgres/laces" };
const logger = () => ({ error: vi.fn(), warn: vi.fn() });

describe("job queue runtime errors", () => {
  it("handles the real PgBoss error event before startup without terminating active work", () => {
    const log = logger();
    const boss = createJobQueue(options, log);
    const stop = vi.spyOn(boss, "stop");
    const failure = Object.assign(new Error("getaddrinfo EAI_AGAIN postgres"), {
      code: "EAI_AGAIN",
      syscall: "getaddrinfo",
    });
    expect(() => boss.emit("error", failure)).not.toThrow();
    expect(log.error).toHaveBeenCalledWith(
      expect.objectContaining({
        event: "job-queue-error",
        code: "EAI_AGAIN",
        syscall: "getaddrinfo",
        transient: true,
      }),
      "job queue background operation failed",
    );
    expect(stop).not.toHaveBeenCalled();
  });

  it("bounds repeated outage logs and reports the suppressed count when polling continues", () => {
    let at = 100;
    const log = logger();
    const boss = createJobQueue(options, log, () => at);
    const failure = Object.assign(new Error("connection reset"), { code: "ECONNRESET" });
    for (let index = 0; index < 100; index += 1) boss.emit("error", failure);
    expect(log.error).toHaveBeenCalledTimes(1);
    at += 30_000;
    boss.emit("error", failure);
    expect(log.error).toHaveBeenLastCalledWith(
      expect.objectContaining({
        suppressedSincePreviousLog: 99,
      }),
      expect.any(String),
    );
  });

  it("keeps warnings and separate queue processes independently observable", () => {
    const log = logger();
    const boss = createJobQueue(options, log);
    boss.emit("warning", { message: "warning", data: {} });
    boss.emit("error", new Error("failure"));
    createJobQueue(options, log).emit("error", new Error("failure"));
    expect(log.warn).toHaveBeenCalledTimes(1);
    expect(log.error).toHaveBeenCalledTimes(2);
  });

  it("logs unknown failures without exposing SQL, job payloads, credentials, or unbounded strings", () => {
    const log = logger();
    const boss = createJobQueue(options, log);
    boss.emit(
      "error",
      Object.assign(new Error(options.connectionString), {
        code: "x".repeat(100_000),
        syscall: "secret with spaces",
        sql: "password secret",
        data: { token: "private" },
        stack: "private",
      }),
    );
    const encoded = JSON.stringify(log.error.mock.calls);
    expect(encoded.length).toBeLessThan(300);
    expect(encoded).not.toMatch(/secret|private|password|postgres:/u);
    expect(log.error).toHaveBeenCalledWith(
      expect.objectContaining({ transient: false }),
      expect.any(String),
    );
  });

  it("preserves rejected startup and dispatch operations", async () => {
    const failure = Object.assign(new Error("database unavailable"), { code: "ECONNREFUSED" });
    const boss = createJobQueue({ db: { executeSql: () => Promise.reject(failure) } }, logger());
    await expect(boss.start()).rejects.toBe(failure);
    await expect(boss.send("test-job", {})).rejects.toBe(failure);
  });

  it("does not let a broken logging transport kill the queue retry loop", () => {
    const boss = createJobQueue(options, {
      error: () => {
        throw new Error("log sink closed");
      },
      warn: () => {
        throw new Error("log sink closed");
      },
    });
    const failure = Object.assign(new Error("DNS unavailable"), { code: "EAI_AGAIN" });
    expect(() => boss.emit("error", failure)).not.toThrow();
    expect(() => boss.emit("warning", { message: "warning", data: {} })).not.toThrow();
  });

  it("requires every queue-owning process to use the protected constructor", async () => {
    const paths = [
      "apps/api/src/server.ts",
      "apps/worker/src/worker.ts",
      "apps/worker/src/ros-worker.ts",
      "apps/worker/src/ros-validation-worker.ts",
    ];
    for (const path of paths) {
      const source = await readFile(new URL(`../../../${path}`, import.meta.url), "utf8");
      expect(source, path).toMatch(/createJobQueue\(/u);
      expect(source, path).not.toMatch(/new PgBoss\(/u);
    }
  });
});
