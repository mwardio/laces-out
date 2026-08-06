import { describe, expect, it } from "vitest";

import { hashSessionToken } from "./auth.js";
import {
  EmailVerificationService,
  emailVerificationTokenLifetimeHours,
  type EmailVerificationRepository,
  type PendingVerificationUserRecord,
} from "./email-verification.js";

const fixedToken = "v".repeat(43);
const now = new Date("2026-08-06T12:00:00.000Z");

const pendingUser: PendingVerificationUserRecord = {
  id: "00000000-0000-4000-8000-000000000001",
  email: "member@example.com",
  displayName: "Member",
};

function repositoryWith(options: {
  readonly redeemable?: string;
  readonly unverifiedUser?: PendingVerificationUserRecord;
}) {
  const redeemed: string[] = [];
  const replaced: { userId: string; tokenHash: string; expiresAt: Date }[] = [];
  const repository: EmailVerificationRepository = {
    redeemToken: (input) => {
      if (options.redeemable !== undefined && input.tokenHash === options.redeemable) {
        redeemed.push(input.tokenHash);
        return Promise.resolve({ userId: pendingUser.id });
      }
      return Promise.resolve(undefined);
    },
    findUnverifiedUserByEmail: (email) =>
      Promise.resolve(
        options.unverifiedUser && email === options.unverifiedUser.email
          ? options.unverifiedUser
          : undefined,
      ),
    replaceOutstandingToken: (input) => {
      replaced.push(input);
      return Promise.resolve();
    },
  };
  return { repository, redeemed, replaced };
}

function serviceWith(repository: EmailVerificationRepository, sends: unknown[] = []) {
  return new EmailVerificationService({
    repository,
    delivery: {
      sendConfirmationEmail: (input) => {
        sends.push(input);
        return Promise.resolve();
      },
    },
    webUrl: "https://lacesout.app/",
    now: () => now,
    tokenFactory: () => fixedToken,
  });
}

describe("EmailVerificationService.verifyEmail", () => {
  it("redeems a live token by its digest only", async () => {
    const { repository, redeemed } = repositoryWith({ redeemable: hashSessionToken(fixedToken) });
    await expect(serviceWith(repository).verifyEmail(fixedToken)).resolves.toEqual({
      userId: pendingUser.id,
    });
    expect(redeemed).toEqual([hashSessionToken(fixedToken)]);
  });

  it("rejects malformed tokens without touching storage", async () => {
    const { repository, redeemed } = repositoryWith({ redeemable: hashSessionToken(fixedToken) });
    await expect(serviceWith(repository).verifyEmail("nope")).resolves.toBeUndefined();
    expect(redeemed).toHaveLength(0);
  });
});

describe("EmailVerificationService.requestResend", () => {
  it("replaces the outstanding link and emails a fresh one for a pending account", async () => {
    const { repository, replaced } = repositoryWith({ unverifiedUser: pendingUser });
    const sends: { confirmUrl?: string; email?: string }[] = [];
    await serviceWith(repository, sends).requestResend(" Member@Example.com ");

    expect(replaced).toEqual([
      {
        userId: pendingUser.id,
        tokenHash: hashSessionToken(fixedToken),
        expiresAt: new Date(now.getTime() + emailVerificationTokenLifetimeHours * 60 * 60 * 1000),
        createdAt: now,
      },
    ]);
    expect(sends).toEqual([
      {
        email: pendingUser.email,
        displayName: pendingUser.displayName,
        confirmUrl: `https://lacesout.app/verify-email#${fixedToken}`,
        expiresHours: emailVerificationTokenLifetimeHours,
      },
    ]);
  });

  it("does nothing for unknown, verified, or malformed addresses", async () => {
    const { repository, replaced } = repositoryWith({});
    const sends: unknown[] = [];
    const service = serviceWith(repository, sends);
    await service.requestResend("stranger@example.com");
    await service.requestResend("not-an-email");
    expect(replaced).toHaveLength(0);
    expect(sends).toHaveLength(0);
  });
});
