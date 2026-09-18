import { describe, expect, it } from "vitest";

import { describeRosBootstrapHealth } from "./ros-bootstrap-health.js";
import { rosSharedCorpusRequest } from "./ros-shared-corpus-runner.js";

type Input = Parameters<typeof describeRosBootstrapHealth>[0];
type Row = NonNullable<Input["row"]>;
const now = new Date("2026-09-18T12:00:00.000Z");
const old = new Date(now.getTime() - 3_600_000);
const request = rosSharedCorpusRequest(2026);
const corpus = "a".repeat(64);
function row(overrides: Partial<Row> = {}): Row {
  return {
    requestIdentity: request.identity,
    season: 2026,
    protocol: request.protocol,
    state: "pending",
    attempt: 1,
    corpusIdentity: null,
    requestedAt: old,
    updatedAt: old,
    startedAt: null,
    completedAt: null,
    nextAttemptAt: null,
    verifiedAt: null,
    dispatchReservationId: null,
    dispatchClaimedAt: null,
    jobId: null,
    reasonCode: null,
    diagnostic: {},
    sourceSnapshotId: null,
    sourceSnapshotState: null,
    sourceSnapshotCreatedAt: null,
    sourceSnapshotQualifiedAt: null,
    ...overrides,
  };
}
function health(overrides: Partial<Input> = {}) {
  return describeRosBootstrapHealth({
    row: row(),
    request,
    now,
    readyCorpusIdentity: null,
    pointerFailed: false,
    outstandingJobs: 0,
    firstRequestedAt: old,
    ...overrides,
  });
}

describe("read-only ROS bootstrap health", () => {
  it("distinguishes no demand, registration grace, and abandoned demand", () => {
    expect(health({ row: null, firstRequestedAt: null })).toMatchObject({
      attention: false,
      reason: "no-current-demand",
    });
    expect(health({ row: null, firstRequestedAt: now })).toMatchObject({
      attention: false,
      reason: "bootstrap-not-registered",
    });
    expect(health({ row: null })).toMatchObject({
      attention: true,
      reason: "bootstrap-not-registered",
    });
  });

  it("reports ready only for the retained verified current request", () => {
    const ready = row({ state: "ready", corpusIdentity: corpus, verifiedAt: now });
    expect(health({ row: ready, readyCorpusIdentity: corpus })).toMatchObject({
      attention: false,
      reason: "ready-pointer-verified",
    });
    for (const value of [null, "b".repeat(64)]) {
      expect(health({ row: ready, readyCorpusIdentity: value }).attention).toBe(true);
    }
    expect(
      health({
        row: { ...ready, protocol: rosSharedCorpusRequest(2027).protocol },
        readyCorpusIdentity: corpus,
      }),
    ).toMatchObject({ attention: true, reason: "request-ledger-mismatch" });
  });

  it("never treats corrupt or explicitly blocked history as a healthy retry", () => {
    expect(health({ pointerFailed: true }).attention).toBe(true);
    expect(
      health({
        row: row({ state: "blocked-integrity" }),
        outstandingJobs: 1,
        readyCorpusIdentity: corpus,
      }),
    ).toMatchObject({ attention: true, reason: "stored-history-needs-repair" });
  });

  it.each(["retry-wait", "waiting-source"] as const)(
    "keeps scheduled %s quiet but identifies overdue recovery",
    (state) => {
      const pending = row({ state, nextAttemptAt: new Date(now.getTime() + 60_000) });
      expect(health({ row: pending })).toMatchObject({ attention: false, reason: state });
      expect(health({ row: { ...pending, nextAttemptAt: old } })).toMatchObject({
        attention: true,
        reason: "bootstrap-retry-overdue",
      });
      expect(
        health({ row: { ...pending, nextAttemptAt: old }, outstandingJobs: 1 }).attention,
      ).toBe(false);
      expect(health({ row: { ...pending, nextAttemptAt: null } }).attention).toBe(true);
    },
  );

  it("uses the durable job state to distinguish active work from a lost job", () => {
    expect(
      health({ row: row({ state: "building", startedAt: old }), outstandingJobs: 1 }).attention,
    ).toBe(false);
    expect(health({ row: row({ state: "building", startedAt: old }) })).toMatchObject({
      attention: true,
      reason: "bootstrap-job-missing",
    });
    expect(health({ row: row({ updatedAt: now }) }).attention).toBe(false);
  });
});
