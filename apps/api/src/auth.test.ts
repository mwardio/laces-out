import { describe, expect, it } from "vitest";

import {
  AuthService,
  hashOwnerPassword,
  type AuthRepository,
  type AuthUserRecord,
  type SessionRecord,
} from "./auth.js";

class MemoryAuthRepository implements AuthRepository {
  readonly users: AuthUserRecord[] = [];
  readonly sessions = new Map<string, { userId: string; expiresAt: Date; lastSeenAt: Date }>();

  async findUserByEmail(email: string): Promise<AuthUserRecord | undefined> {
    return this.users.find((user) => user.email === email);
  }

  async createSession(input: {
    readonly userId: string;
    readonly tokenHash: string;
    readonly expiresAt: Date;
  }): Promise<void> {
    this.sessions.set(input.tokenHash, {
      userId: input.userId,
      expiresAt: input.expiresAt,
      lastSeenAt: new Date("2026-07-16T12:00:00Z"),
    });
  }

  async findSession(tokenHash: string, now: Date): Promise<SessionRecord | undefined> {
    const session = this.sessions.get(tokenHash);
    const user = this.users.find((candidate) => candidate.id === session?.userId);
    if (!session || !user || session.expiresAt <= now) return undefined;
    return {
      user: { id: user.id, email: user.email, displayName: user.displayName, role: user.role },
      expiresAt: session.expiresAt,
      lastSeenAt: session.lastSeenAt,
    };
  }

  async touchSession(tokenHash: string, now: Date): Promise<void> {
    const session = this.sessions.get(tokenHash);
    if (session) session.lastSeenAt = now;
  }

  async deleteSession(tokenHash: string): Promise<void> {
    this.sessions.delete(tokenHash);
  }

  async deleteExpiredSessions(now: Date): Promise<void> {
    for (const [token, session] of this.sessions) {
      if (session.expiresAt < now) this.sessions.delete(token);
    }
  }

  async findUserById(userId: string): Promise<AuthUserRecord | undefined> {
    return this.users.find((user) => user.id === userId);
  }

  async updatePassword(userId: string, passwordHash: string): Promise<void> {
    const index = this.users.findIndex((user) => user.id === userId);
    const user = this.users[index];
    if (index >= 0 && user) this.users[index] = { ...user, passwordHash };
  }

  async deleteOtherSessions(userId: string, exceptTokenHash: string): Promise<void> {
    for (const [token, session] of this.sessions) {
      if (session.userId === userId && token !== exceptTokenHash) this.sessions.delete(token);
    }
  }

  async replacePasswordAndDeleteOtherSessions(
    userId: string,
    passwordHash: string,
    exceptTokenHash: string,
  ): Promise<void> {
    await this.updatePassword(userId, passwordHash);
    await this.deleteOtherSessions(userId, exceptTokenHash);
  }
}

describe("AuthService", () => {
  it("enforces the account password length and content policy", async () => {
    await expect(hashOwnerPassword("short")).rejects.toThrow("between 12 and 128");
    await expect(hashOwnerPassword(" ".repeat(12))).rejects.toThrow("non-whitespace");
    await expect(hashOwnerPassword(`valid length\u0000but unsafe`)).rejects.toThrow(
      "non-whitespace",
    );
  });

  it("creates, validates, and revokes a hashed database session", async () => {
    const repository = new MemoryAuthRepository();
    repository.users.push({
      id: "owner",
      email: "owner@example.com",
      displayName: "Owner",
      passwordHash: await hashOwnerPassword("a genuinely long password"),
      role: "admin",
    });
    const service = new AuthService(repository, () => new Date("2026-07-16T12:00:00Z"));

    const result = await service.login("OWNER@example.com", "a genuinely long password");
    expect(result?.token).toHaveLength(43);
    expect(repository.sessions.size).toBe(1);
    expect(await service.validate(result?.token)).toEqual({
      id: "owner",
      email: "owner@example.com",
      displayName: "Owner",
      role: "admin",
    });

    await service.logout(result?.token);
    expect(await service.validate(result?.token)).toBeUndefined();
  });

  it("rejects an invalid password", async () => {
    const repository = new MemoryAuthRepository();
    repository.users.push({
      id: "owner",
      email: "owner@example.com",
      displayName: "Owner",
      passwordHash: await hashOwnerPassword("a genuinely long password"),
      role: "admin",
    });
    const service = new AuthService(repository);
    expect(await service.login("owner@example.com", "wrong password")).toBeUndefined();
  });
});

describe("AuthService.changePassword", () => {
  async function seeded(): Promise<{
    readonly repository: MemoryAuthRepository;
    readonly service: AuthService;
    readonly token: string;
  }> {
    const repository = new MemoryAuthRepository();
    repository.users.push({
      id: "member",
      email: "member@example.com",
      displayName: "Member",
      passwordHash: await hashOwnerPassword("the original password"),
      role: "member",
    });
    const service = new AuthService(repository, () => new Date("2026-07-16T12:00:00Z"));
    const first = await service.login("member@example.com", "the original password");
    const second = await service.login("member@example.com", "the original password");
    if (!first || !second) throw new Error("expected two sessions");
    expect(repository.sessions.size).toBe(2);
    return { repository, service, token: first.token };
  }

  it("changes the password, keeps the caller signed in, and revokes other devices", async () => {
    const { repository, service, token } = await seeded();

    const result = await service.changePassword(
      "member",
      "the original password",
      "a brand new password",
      token,
    );

    expect(result).toEqual({ outcome: "changed", revokedOtherSessions: true });
    expect(repository.sessions.size).toBe(1);
    // The tab that made the change stays usable.
    expect(await service.validate(token)).toMatchObject({ id: "member" });
    expect(await service.login("member@example.com", "a brand new password")).toBeDefined();
    expect(await service.login("member@example.com", "the original password")).toBeUndefined();
  });

  it("rejects a wrong current password without touching sessions or the hash", async () => {
    const { repository, service, token } = await seeded();

    const result = await service.changePassword("member", "not it", "a brand new password", token);

    expect(result).toEqual({ outcome: "invalid-current-password" });
    expect(repository.sessions.size).toBe(2);
    expect(await service.login("member@example.com", "the original password")).toBeDefined();
  });

  it("enforces the shared password policy on the new password", async () => {
    const { service, token } = await seeded();

    await expect(
      service.changePassword("member", "the original password", "short", token),
    ).rejects.toThrow("between 12 and 128");
  });

  it("revokes every session when the caller presents no cookie", async () => {
    const { repository, service } = await seeded();

    await service.changePassword(
      "member",
      "the original password",
      "a brand new password",
      undefined,
    );

    expect(repository.sessions.size).toBe(0);
  });

  it("reports unsupported rather than failing on a repository without the methods", async () => {
    // A deployment whose repository predates self-service password changes.
    const legacy: AuthRepository = {
      findUserByEmail: () => Promise.resolve(undefined),
      createSession: () => Promise.resolve(),
      findSession: () => Promise.resolve(undefined),
      touchSession: () => Promise.resolve(),
      deleteSession: () => Promise.resolve(),
      deleteExpiredSessions: () => Promise.resolve(),
    };
    const service = new AuthService(legacy);

    expect(
      await service.changePassword("member", "the original password", "a brand new password", "t"),
    ).toEqual({ outcome: "unsupported" });
  });

  it("does not change a password for an unknown account", async () => {
    const { service } = await seeded();

    expect(
      await service.changePassword("ghost", "the original password", "a brand new password", "t"),
    ).toEqual({ outcome: "invalid-current-password" });
  });
});
