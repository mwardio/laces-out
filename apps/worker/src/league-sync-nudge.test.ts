import { describe, expect, it } from "vitest";

import type { EmailMessage, EmailTransport } from "@fantasy/email";

import {
  LeagueSyncNudgeService,
  NUDGE_DELAY_DAYS,
  NUDGE_WINDOW_DAYS,
  type LeagueSyncNudgeRepository,
  type NudgeCandidate,
} from "./league-sync-nudge.js";
import type { EmailSweepJob } from "./jobs.js";

const now = new Date("2026-08-06T16:10:00.000Z");
const job: EmailSweepJob = { kind: "league-sync-nudge", reason: "scheduled" };

const candidate: NudgeCandidate = {
  userId: "00000000-0000-4000-8000-000000000001",
  email: "member@example.com",
  displayName: "Member",
};

function repositoryWith(
  candidates: readonly NudgeCandidate[],
  options: { readonly alreadyClaimed?: ReadonlySet<string> } = {},
) {
  const claims = new Set(options.alreadyClaimed ?? []);
  const releases: string[] = [];
  const windows: { registeredBefore: Date; registeredAfter: Date }[] = [];
  const repository: LeagueSyncNudgeRepository = {
    listCandidates: (input) => {
      windows.push({
        registeredBefore: input.registeredBefore,
        registeredAfter: input.registeredAfter,
      });
      return Promise.resolve(candidates);
    },
    claim: (_userId, idempotencyKey) => {
      if (claims.has(idempotencyKey)) return Promise.resolve(false);
      claims.add(idempotencyKey);
      return Promise.resolve(true);
    },
    releaseClaim: (idempotencyKey) => {
      claims.delete(idempotencyKey);
      releases.push(idempotencyKey);
      return Promise.resolve();
    },
  };
  return { repository, claims, releases, windows };
}

function transportWith(outcomes: readonly ("sent" | "failed")[]) {
  const messages: EmailMessage[] = [];
  let index = 0;
  const transport: EmailTransport = {
    send: (message) => {
      messages.push(message);
      const outcome = outcomes[Math.min(index, outcomes.length - 1)] ?? "sent";
      index += 1;
      return Promise.resolve(outcome);
    },
  };
  return { transport, messages };
}

describe("LeagueSyncNudgeService", () => {
  it("completes as a stated no-op without SMTP configuration", async () => {
    const { repository, windows } = repositoryWith([candidate]);
    const service = new LeagueSyncNudgeService({
      repository,
      webUrl: "https://lacesout.app",
      now: () => now,
    });

    const result = await service.sweep(job);

    expect(result).toEqual({
      considered: 0,
      sent: 0,
      duplicates: 0,
      failures: 0,
      skipped: "smtp-not-configured",
    });
    expect(windows).toHaveLength(0);
  });

  it("asks for members registered between the delay and the window edge", async () => {
    const { repository, windows } = repositoryWith([]);
    const { transport } = transportWith(["sent"]);
    const service = new LeagueSyncNudgeService({
      repository,
      transport,
      webUrl: "https://lacesout.app",
      now: () => now,
    });

    await service.sweep(job);

    const dayMilliseconds = 24 * 60 * 60 * 1000;
    expect(windows).toEqual([
      {
        registeredBefore: new Date(now.getTime() - NUDGE_DELAY_DAYS * dayMilliseconds),
        registeredAfter: new Date(now.getTime() - NUDGE_WINDOW_DAYS * dayMilliseconds),
      },
    ]);
  });

  it("claims before sending, once per member, forever", async () => {
    const { repository, claims } = repositoryWith([candidate]);
    const { transport, messages } = transportWith(["sent"]);
    const service = new LeagueSyncNudgeService({
      repository,
      transport,
      webUrl: "https://lacesout.app",
      now: () => now,
    });

    const first = await service.sweep(job);
    const second = await service.sweep(job);

    expect(first).toMatchObject({ considered: 1, sent: 1, duplicates: 0, failures: 0 });
    // The candidate query would normally exclude a claimed member; even if it does not, the
    // claim makes the second sweep a duplicate rather than a second email.
    expect(second).toMatchObject({ considered: 1, sent: 0, duplicates: 1 });
    expect(messages).toHaveLength(1);
    expect(messages[0]?.to).toBe(candidate.email);
    expect(messages[0]?.subject).toBe("One step left: sync your league");
    expect(messages[0]?.html).toContain("https://lacesout.app/connections");
    expect(claims.has(`league-sync-nudge:${candidate.userId}`)).toBe(true);
  });

  it("releases the claim on a transport failure so tomorrow's sweep can retry", async () => {
    const { repository, claims, releases } = repositoryWith([candidate]);
    const { transport } = transportWith(["failed"]);
    const service = new LeagueSyncNudgeService({
      repository,
      transport,
      webUrl: "https://lacesout.app",
      now: () => now,
    });

    const result = await service.sweep(job);

    expect(result).toMatchObject({ considered: 1, sent: 0, failures: 1 });
    expect(releases).toEqual([`league-sync-nudge:${candidate.userId}`]);
    expect(claims.size).toBe(0);
  });

  it("keeps sweeping the batch when one member's send fails", async () => {
    const second: NudgeCandidate = {
      userId: "00000000-0000-4000-8000-000000000002",
      email: "friend@example.com",
      displayName: "Friend",
    };
    const { repository } = repositoryWith([candidate, second]);
    const { transport, messages } = transportWith(["failed", "sent"]);
    const service = new LeagueSyncNudgeService({
      repository,
      transport,
      webUrl: "https://lacesout.app",
      now: () => now,
    });

    const result = await service.sweep(job);

    expect(result).toMatchObject({ considered: 2, sent: 1, failures: 1 });
    expect(messages.map((message) => message.to)).toEqual([candidate.email, second.email]);
  });
});
