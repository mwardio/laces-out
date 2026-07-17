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
