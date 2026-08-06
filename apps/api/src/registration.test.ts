import { describe, expect, it } from "vitest";

import {
  RegistrationService,
  type PendingRegistrationRepository,
  type RegisteredUserRecord,
  type RegistrationRepository,
} from "./registration.js";

const rootSecret = "s".repeat(32);
const sharedCode = "laces-out-friends-2026";
const sessionToken = "t".repeat(43);

class MemoryRegistrationRepository implements RegistrationRepository {
  readonly inputs: Array<{
    readonly email: string;
    readonly displayName: string;
    readonly passwordHash: string;
    readonly tokenHash: string;
    readonly expiresAt: Date;
  }> = [];
  conflict = false;

  async createMemberWithSession(
    input: (typeof this.inputs)[number],
  ): Promise<RegisteredUserRecord | undefined> {
    this.inputs.push(input);
    if (this.conflict) return undefined;
    return {
      id: "00000000-0000-4000-8000-000000000501",
      email: input.email,
      displayName: input.displayName,
      role: "member",
    };
  }
}

class MemoryPendingRepository implements PendingRegistrationRepository {
  readonly inputs: Array<{
    readonly email: string;
    readonly displayName: string;
    readonly passwordHash: string;
    readonly verificationTokenHash: string;
    readonly verificationExpiresAt: Date;
    readonly now: Date;
  }> = [];
  verifiedConflict = false;

  async createOrRotatePendingMember(
    input: (typeof this.inputs)[number],
  ): Promise<RegisteredUserRecord | undefined> {
    this.inputs.push(input);
    if (this.verifiedConflict) return undefined;
    return {
      id: "00000000-0000-4000-8000-000000000601",
      email: input.email,
      displayName: input.displayName,
      role: "member",
    };
  }
}

function service(repository: MemoryRegistrationRepository): RegistrationService {
  return new RegistrationService(repository, rootSecret, sharedCode, {
    now: () => new Date("2026-07-16T12:00:00.000Z"),
    tokenFactory: () => sessionToken,
  });
}

describe("RegistrationService", () => {
  it("creates an account without a code in open-registration mode", async () => {
    const repository = new MemoryRegistrationRepository();
    const openService = new RegistrationService(repository, rootSecret, undefined, {
      now: () => new Date("2026-07-16T12:00:00.000Z"),
      tokenFactory: () => sessionToken,
    });

    await expect(
      openService.register({
        email: "friend@example.com",
        displayName: "Fantasy Friend",
        password: "a genuinely long password",
      }),
    ).resolves.toMatchObject({
      status: "active",
      user: { email: "friend@example.com", role: "member" },
    });
    expect(repository.inputs).toHaveLength(1);
  });

  it("normalizes identity data and creates an Argon2id-backed member session", async () => {
    const repository = new MemoryRegistrationRepository();
    const result = await service(repository).register({
      inviteCode: `  ${sharedCode}  `,
      email: "  FRIEND@Example.COM ",
      displayName: "  Fantasy   Friend  ",
      password: "a genuinely long password",
    });

    expect(result).toMatchObject({
      status: "active",
      token: sessionToken,
      expiresAt: new Date("2026-08-15T12:00:00.000Z"),
      user: {
        email: "friend@example.com",
        displayName: "Fantasy Friend",
        role: "member",
      },
    });
    expect(repository.inputs).toHaveLength(1);
    expect(repository.inputs[0]?.passwordHash).toMatch(/^\$argon2id\$/u);
    expect(repository.inputs[0]?.passwordHash).not.toContain("a genuinely long password");
    expect(repository.inputs[0]?.tokenHash).not.toBe(sessionToken);
    expect(JSON.stringify(repository.inputs)).not.toContain(sharedCode);
  });

  it("rejects the wrong shared code without touching persistence", async () => {
    const repository = new MemoryRegistrationRepository();
    await expect(
      service(repository).register({
        inviteCode: "wrong-shared-code-value",
        email: "friend@example.com",
        displayName: "Fantasy Friend",
        password: "a genuinely long password",
      }),
    ).resolves.toBeUndefined();
    expect(repository.inputs).toHaveLength(0);
  });

  it("rejects a missing code in shared-code mode", async () => {
    const repository = new MemoryRegistrationRepository();
    await expect(
      service(repository).register({
        email: "friend@example.com",
        displayName: "Fantasy Friend",
        password: "a genuinely long password",
      }),
    ).resolves.toBeUndefined();
    expect(repository.inputs).toHaveLength(0);
  });

  it("does not distinguish a normalized-email conflict from a rejected registration", async () => {
    const repository = new MemoryRegistrationRepository();
    repository.conflict = true;
    await expect(
      service(repository).register({
        inviteCode: sharedCode,
        email: "friend@example.com",
        displayName: "Fantasy Friend",
        password: "a genuinely long password",
      }),
    ).resolves.toBeUndefined();
  });

  it("refuses weak deployment codes at startup", () => {
    const repository = new MemoryRegistrationRepository();
    expect(() => new RegistrationService(repository, rootSecret, "too-short")).toThrow(
      "Registration invite code must be",
    );
  });
});

describe("RegistrationService with confirmation", () => {
  function confirmService(options: {
    readonly pending: MemoryPendingRepository;
    readonly sends?: unknown[];
    readonly failDelivery?: boolean;
    readonly deliveryErrors?: unknown[];
  }) {
    return new RegistrationService(new MemoryRegistrationRepository(), rootSecret, undefined, {
      now: () => new Date("2026-08-06T12:00:00.000Z"),
      tokenFactory: () => sessionToken,
      confirmation: {
        repository: options.pending,
        delivery: {
          sendConfirmationEmail: (input) => {
            options.sends?.push(input);
            return options.failDelivery
              ? Promise.reject(new Error("Confirmation email transport failed"))
              : Promise.resolve();
          },
        },
        webUrl: "https://lacesout.app/",
        onDeliveryError: (error) => {
          options.deliveryErrors?.push(error);
        },
      },
    });
  }

  it("creates a dormant account with no session and emails the activation link", async () => {
    const pending = new MemoryPendingRepository();
    const sends: { confirmUrl?: string; email?: string; expiresHours?: number }[] = [];
    const result = await confirmService({ pending, sends }).register({
      email: "Friend@Example.com",
      displayName: "Fantasy Friend",
      password: "a genuinely long password",
    });

    expect(result).toEqual({ status: "pending" });
    expect(pending.inputs).toHaveLength(1);
    expect(pending.inputs[0]?.email).toBe("friend@example.com");
    expect(pending.inputs[0]?.passwordHash).toMatch(/^\$argon2id\$/u);
    // Only a digest is persisted; the raw token travels solely inside the emailed link.
    expect(pending.inputs[0]?.verificationTokenHash).not.toBe(sessionToken);
    expect(pending.inputs[0]?.verificationExpiresAt).toEqual(new Date("2026-08-07T12:00:00.000Z"));
    expect(sends).toEqual([
      {
        email: "friend@example.com",
        displayName: "Fantasy Friend",
        confirmUrl: `https://lacesout.app/verify-email#${sessionToken}`,
        expiresHours: 24,
      },
    ]);
  });

  it("answers a verified-email conflict with the same generic rejection", async () => {
    const pending = new MemoryPendingRepository();
    pending.verifiedConflict = true;
    const sends: unknown[] = [];
    await expect(
      confirmService({ pending, sends }).register({
        email: "taken@example.com",
        displayName: "Fantasy Friend",
        password: "a genuinely long password",
      }),
    ).resolves.toBeUndefined();
    expect(sends).toHaveLength(0);
  });

  it("keeps the pending account when the confirmation send fails", async () => {
    const pending = new MemoryPendingRepository();
    const deliveryErrors: unknown[] = [];
    const result = await confirmService({ pending, failDelivery: true, deliveryErrors }).register({
      email: "friend@example.com",
      displayName: "Fantasy Friend",
      password: "a genuinely long password",
    });

    // Registering again resends; a lost email must not fail the registration.
    expect(result).toEqual({ status: "pending" });
    expect(pending.inputs).toHaveLength(1);
    expect(deliveryErrors).toHaveLength(1);
  });
});
