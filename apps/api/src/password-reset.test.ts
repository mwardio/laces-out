import { describe, expect, it } from "vitest";

import { hashSessionToken } from "./auth.js";
import {
  PasswordResetService,
  passwordResetTokenLifetimeMinutes,
  type PasswordResetRepository,
  type PasswordResetUserRecord,
} from "./password-reset.js";

const user: PasswordResetUserRecord = {
  id: "00000000-0000-4000-8000-000000000001",
  email: "member@example.com",
  displayName: "Member",
};

const fixedToken = "t".repeat(43);

interface StoredToken {
  readonly userId: string;
  readonly tokenHash: string;
  readonly expiresAt: Date;
  usedAt: Date | null;
}

function repositoryWith(existingUser: PasswordResetUserRecord | undefined) {
  const tokens: StoredToken[] = [];
  const redeemed: { tokenHash: string; newPasswordHash: string }[] = [];
  const repository: PasswordResetRepository = {
    findUserByEmail: (email) =>
      Promise.resolve(existingUser && email === existingUser.email ? existingUser : undefined),
    replaceOutstandingToken: (input) => {
      for (let index = tokens.length - 1; index >= 0; index -= 1) {
        if (tokens[index]?.userId === input.userId && tokens[index]?.usedAt === null) {
          tokens.splice(index, 1);
        }
      }
      tokens.push({ ...input, usedAt: null });
      return Promise.resolve();
    },
    redeemToken: (input) => {
      const token = tokens.find((candidate) => candidate.tokenHash === input.tokenHash);
      if (!token || token.usedAt !== null || token.expiresAt.getTime() <= input.now.getTime()) {
        return Promise.resolve("invalid" as const);
      }
      token.usedAt = input.now;
      redeemed.push({ tokenHash: input.tokenHash, newPasswordHash: input.newPasswordHash });
      return Promise.resolve("reset" as const);
    },
  };
  return { repository, tokens, redeemed };
}

function serviceWith(options: {
  readonly repository: PasswordResetRepository;
  readonly sends?: unknown[];
  readonly now?: () => Date;
}) {
  return new PasswordResetService({
    repository: options.repository,
    delivery: {
      sendPasswordResetEmail: (input) => {
        options.sends?.push(input);
        return Promise.resolve();
      },
    },
    webUrl: "https://lacesout.app/",
    now: options.now ?? (() => new Date("2026-08-06T12:00:00.000Z")),
    tokenFactory: () => fixedToken,
  });
}

describe("PasswordResetService.requestReset", () => {
  it("stores only a token digest and emails a canonical-origin link", async () => {
    const { repository, tokens } = repositoryWith(user);
    const sends: { resetUrl?: string; email?: string; expiresMinutes?: number }[] = [];
    await serviceWith({ repository, sends }).requestReset("Member@Example.com ");

    expect(tokens).toHaveLength(1);
    expect(tokens[0]?.tokenHash).toBe(hashSessionToken(fixedToken));
    expect(tokens[0]?.expiresAt).toEqual(
      new Date(Date.parse("2026-08-06T12:00:00.000Z") + passwordResetTokenLifetimeMinutes * 60_000),
    );
    expect(sends).toEqual([
      {
        email: "member@example.com",
        displayName: "Member",
        resetUrl: `https://lacesout.app/reset-password#${fixedToken}`,
        expiresMinutes: passwordResetTokenLifetimeMinutes,
      },
    ]);
  });

  it("does nothing for an unknown or malformed address", async () => {
    const { repository, tokens } = repositoryWith(user);
    const sends: unknown[] = [];
    const service = serviceWith({ repository, sends });
    await service.requestReset("stranger@example.com");
    await service.requestReset("not-an-email");
    await service.requestReset("has a space@example.com");
    expect(tokens).toHaveLength(0);
    expect(sends).toHaveLength(0);
  });

  it("supersedes the previous link when asked again", async () => {
    const { repository, tokens } = repositoryWith(user);
    const service = serviceWith({ repository, sends: [] });
    await service.requestReset(user.email);
    await service.requestReset(user.email);
    expect(tokens).toHaveLength(1);
  });
});

describe("PasswordResetService.resetPassword", () => {
  it("redeems a live token exactly once", async () => {
    const { repository, redeemed } = repositoryWith(user);
    const service = serviceWith({ repository, sends: [] });
    await service.requestReset(user.email);

    await expect(service.resetPassword(fixedToken, "a brand new password")).resolves.toBe("reset");
    expect(redeemed).toHaveLength(1);
    expect(redeemed[0]?.newPasswordHash).toMatch(/^\$argon2id\$/u);
    await expect(service.resetPassword(fixedToken, "a brand new password")).resolves.toBe(
      "invalid",
    );
  });

  it("rejects an expired token", async () => {
    const { repository } = repositoryWith(user);
    let now = new Date("2026-08-06T12:00:00.000Z");
    const service = new PasswordResetService({
      repository,
      delivery: { sendPasswordResetEmail: () => Promise.resolve() },
      webUrl: "https://lacesout.app",
      now: () => now,
      tokenFactory: () => fixedToken,
    });
    await service.requestReset(user.email);
    now = new Date(now.getTime() + (passwordResetTokenLifetimeMinutes + 1) * 60_000);
    await expect(service.resetPassword(fixedToken, "a brand new password")).resolves.toBe(
      "invalid",
    );
  });

  it("rejects malformed tokens and policy-violating passwords without touching storage", async () => {
    const { repository, redeemed } = repositoryWith(user);
    const service = serviceWith({ repository, sends: [] });
    await service.requestReset(user.email);

    await expect(service.resetPassword("short-token", "a brand new password")).resolves.toBe(
      "invalid",
    );
    await expect(service.resetPassword(fixedToken, "too short")).resolves.toBe("invalid");
    expect(redeemed).toHaveLength(0);
  });
});
