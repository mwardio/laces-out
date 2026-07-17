import { describe, expect, it } from "vitest";

import {
  RegistrationService,
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

function service(repository: MemoryRegistrationRepository): RegistrationService {
  return new RegistrationService(repository, rootSecret, sharedCode, {
    now: () => new Date("2026-07-16T12:00:00.000Z"),
    tokenFactory: () => sessionToken,
  });
}

describe("RegistrationService", () => {
  it("normalizes identity data and creates an Argon2id-backed member session", async () => {
    const repository = new MemoryRegistrationRepository();
    const result = await service(repository).register({
      inviteCode: `  ${sharedCode}  `,
      email: "  FRIEND@Example.COM ",
      displayName: "  Fantasy   Friend  ",
      password: "a genuinely long password",
    });

    expect(result).toMatchObject({
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
