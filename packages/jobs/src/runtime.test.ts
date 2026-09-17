import { readFile } from "node:fs/promises";
import { describe, expect, it, vi } from "vitest";
import { createJobQueue } from "./runtime.js";

const options = { connectionString: "postgres://user:secret@postgres/laces" };
const logger = () => ({ error: vi.fn(), warn: vi.fn() });
const slowQueryMessage =
  "Warning: slow query. Your queues and/or database server should be reviewed";
const backlogMessage = "Warning: large queue backlog. Your queue should be reviewed";
const clockSkewMessage =
  "Warning: Clock skew between this instance and the database server. This will not break scheduling, but is emitted any time the skew exceeds 60 seconds.";

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

  it.each([
    {
      message: slowQueryMessage,
      data: { elapsed: 40.25, sql: "private SQL", values: [options.connectionString] },
      fields: { warningClass: "slow_query", elapsedSeconds: 40.25 },
    },
    {
      message: backlogMessage,
      data: {
        name: "ros-profile-validation",
        queuedCount: 12,
        warningQueueSize: 10,
        token: "private",
      },
      fields: {
        warningClass: "queue_backlog",
        queue: "ros-profile-validation",
        queuedCount: 12,
        warningQueueSize: 10,
      },
    },
    {
      message: clockSkewMessage,
      data: { seconds: 60.125, direction: "slower", token: "private" },
      fields: { warningClass: "clock_skew", clockSkewSeconds: 60.125, clockDirection: "slower" },
    },
    {
      message: "Failed to start LISTEN/NOTIFY listener. Continuing with polling only.",
      data: { type: "listen_notify_unavailable", error: options.connectionString },
      fields: { warningClass: "listen_notify_unavailable" },
    },
  ])(
    "classifies $fields.warningClass with only allowlisted diagnostic fields",
    ({ message, data, fields }) => {
      const log = logger();
      const boss = createJobQueue(options, log);
      boss.emit("warning", { message, data });
      expect(log.warn).toHaveBeenCalledWith(
        { event: "job-queue-warning", transient: false, suppressedSincePreviousLog: 0, ...fields },
        "job queue background warning",
      );
      expect(JSON.stringify(log.warn.mock.calls)).not.toMatch(/private|secret|postgres:|Warning:/u);
    },
  );

  it("preserves distinct warning classes and queues while bounding repeated unknown warnings", () => {
    let at = 100;
    const log = logger();
    const boss = createJobQueue(options, log, () => at);
    const backlog = {
      message: backlogMessage,
      data: { name: "ros-profile-validation", queuedCount: 12 },
    };
    for (let index = 0; index < 100; index += 1) boss.emit("warning", backlog);
    boss.emit("warning", { message: slowQueryMessage, data: { elapsed: 31 } });
    boss.emit("warning", {
      message: backlogMessage,
      data: { name: "league-sync", queuedCount: 21 },
    });
    for (let index = 0; index < 100; index += 1) {
      boss.emit("warning", { message: `unknown-${index}`, data: { name: `unknown-${index}` } });
    }
    expect(log.warn).toHaveBeenCalledTimes(4);
    at += 30_000;
    boss.emit("warning", backlog);
    expect(log.warn).toHaveBeenLastCalledWith(
      expect.objectContaining({
        warningClass: "queue_backlog",
        queue: "ros-profile-validation",
        suppressedSincePreviousLog: 99,
      }),
      expect.any(String),
    );
    boss.emit("warning", { message: "another unknown", data: {} });
    expect(log.warn).toHaveBeenLastCalledWith(
      expect.objectContaining({ warningClass: "unknown", suppressedSincePreviousLog: 99 }),
      expect.any(String),
    );
  });

  it("drops arbitrary names, malformed numeric metrics, directions, and unrecognized messages", () => {
    const log = logger();
    const boss = createJobQueue(options, log);
    boss.emit("warning", {
      message: backlogMessage,
      data: { name: "private", queuedCount: "9000", warningQueueSize: 1.5 },
    });
    boss.emit("warning", { message: slowQueryMessage, data: { elapsed: Infinity } });
    boss.emit("warning", {
      message: clockSkewMessage,
      data: { seconds: -1, direction: "private" },
    });
    boss.emit("warning", {
      message: `${slowQueryMessage} private`,
      data: { elapsed: 45, type: "private" },
    });
    const fields = log.warn.mock.calls.map(
      ([entry]) => JSON.parse(JSON.stringify(entry)) as unknown,
    );
    expect(fields).toEqual(
      ["queue_backlog", "slow_query", "clock_skew", "unknown"].map((warningClass) => ({
        event: "job-queue-warning",
        transient: false,
        warningClass,
        suppressedSincePreviousLog: 0,
      })),
    );
  });

  it("does not coerce metric objects or retain unbounded warning data", () => {
    const log = logger();
    const boss = createJobQueue(options, log);
    const hostile = {
      valueOf: () => {
        throw new Error("private");
      },
    };
    expect(() =>
      boss.emit("warning", {
        message: slowQueryMessage,
        data: { elapsed: hostile, sql: "private".repeat(100_000) },
      }),
    ).not.toThrow();
    expect(JSON.stringify(log.warn.mock.calls).length).toBeLessThan(300);
    expect(JSON.stringify(log.warn.mock.calls)).not.toMatch(/private/u);
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
