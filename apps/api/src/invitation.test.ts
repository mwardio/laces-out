import { verify } from "@node-rs/argon2";
import { describe, expect, it } from "vitest";

import type { ApplicationRole, LeagueMembershipRole } from "@laces-out/db";

import { hashSessionToken } from "./auth.js";
import {
  deriveInvitationKeyring,
  hashInvitationEmail,
  hashInvitationToken,
  InvitationError,
  type AcceptInvitationRepositoryResult,
  type CreateInvitationRepositoryResult,
  type InvitationAcceptanceIdentity,
  type InvitationRepository,
  InvitationService,
  type InvitableLeagueRole,
  type PendingInvitationRecord,
  type RevokeInvitationRepositoryResult,
} from "./invitation.js";

const ADMIN_ID = "10000000-0000-4000-8000-000000000001";
const MEMBER_ID = "10000000-0000-4000-8000-000000000002";
const OTHER_ID = "10000000-0000-4000-8000-000000000003";
const LEAGUE_ID = "20000000-0000-4000-8000-000000000001";
const NOW = new Date("2026-07-16T12:00:00.000Z");
const KEYRING = deriveInvitationKeyring(Buffer.alloc(32, 17));

interface MemoryInvitation extends PendingInvitationRecord {
  readonly tokenHash: string;
  readonly emailHash: string;
  acceptedAt: Date | null;
  revokedAt: Date | null;
}

interface MemoryUser {
  readonly id: string;
  readonly email: string;
  readonly displayName: string;
  passwordHash: string | null;
  role: ApplicationRole;
}

function roleRank(role: LeagueMembershipRole): number {
  return { member: 0, commissioner: 1, owner: 2 }[role];
}

class MemoryInvitationRepository implements InvitationRepository {
  readonly adminIds = new Set([ADMIN_ID]);
  readonly leagueIds = new Set([LEAGUE_ID]);
  readonly invitations = new Map<string, MemoryInvitation>();
  readonly users = new Map<string, MemoryUser>();
  readonly memberships = new Map<string, LeagueMembershipRole>();
  readonly verificationTokens = new Map<
    string,
    { readonly userId: string; readonly expiresAt: Date }
  >();
  #sequence = 10;
  #acceptTail: Promise<void> = Promise.resolve();

  async create(input: {
    readonly invitedByUserId: string;
    readonly tokenHash: string;
    readonly email: string;
    readonly emailHash: string;
    readonly role: ApplicationRole;
    readonly leagueId: string | null;
    readonly leagueRole: InvitableLeagueRole | null;
    readonly expiresAt: Date;
    readonly now: Date;
  }): Promise<CreateInvitationRepositoryResult> {
    if (!this.adminIds.has(input.invitedByUserId)) return { status: "forbidden" };
    if (input.leagueId && !this.leagueIds.has(input.leagueId)) {
      return { status: "scope_not_found" };
    }
    if (this.invitations.has(input.tokenHash)) return { status: "token_conflict" };
    for (const invitation of this.invitations.values()) {
      if (
        invitation.emailHash === input.emailHash &&
        invitation.leagueId === input.leagueId &&
        invitation.acceptedAt === null &&
        invitation.revokedAt === null &&
        invitation.expiresAt > input.now
      ) {
        invitation.revokedAt = input.now;
      }
    }
    this.#sequence += 1;
    const id = `30000000-0000-4000-8000-${String(this.#sequence).padStart(12, "0")}`;
    const existingUserId = this.findUserByEmail(input.email)?.id ?? null;
    const invitation: MemoryInvitation = {
      id,
      tokenHash: input.tokenHash,
      emailHash: input.emailHash,
      email: input.email,
      invitedByUserId: input.invitedByUserId,
      role: input.role,
      leagueId: input.leagueId,
      leagueName: input.leagueId ? "League of Extraordinary Friends" : null,
      leagueRole: input.leagueRole,
      existingUserId,
      expiresAt: input.expiresAt,
      acceptedAt: null,
      revokedAt: null,
    };
    this.invitations.set(input.tokenHash, invitation);
    return { status: "created", invitation };
  }

  async findActiveByTokenHash(
    tokenHash: string,
    now: Date,
  ): Promise<PendingInvitationRecord | undefined> {
    const invitation = this.invitations.get(tokenHash);
    if (
      !invitation ||
      invitation.acceptedAt ||
      invitation.revokedAt ||
      invitation.expiresAt <= now
    ) {
      return undefined;
    }
    return {
      ...invitation,
      existingUserId: this.findUserByEmail(invitation.email)?.id ?? null,
    };
  }

  async accept(input: {
    readonly tokenHash: string;
    readonly identity: InvitationAcceptanceIdentity;
    readonly now: Date;
  }): Promise<AcceptInvitationRepositoryResult> {
    let release = (): void => undefined;
    const predecessor = this.#acceptTail;
    this.#acceptTail = new Promise<void>((resolve) => {
      release = resolve;
    });
    await predecessor;
    try {
      const invitation = this.invitations.get(input.tokenHash);
      if (
        !invitation ||
        invitation.acceptedAt ||
        invitation.revokedAt ||
        invitation.expiresAt <= input.now
      ) {
        return { status: "unavailable" };
      }
      let user = this.findUserByEmail(invitation.email);
      let createdUser = false;
      if (input.identity.kind === "existing_user") {
        if (!user || user.id !== input.identity.userId) return { status: "identity_conflict" };
      } else {
        if (user) return { status: "identity_conflict" };
        user = {
          id: `40000000-0000-4000-8000-${String(this.users.size + 1).padStart(12, "0")}`,
          email: invitation.email,
          displayName: input.identity.displayName,
          passwordHash: input.identity.passwordHash,
          role: invitation.role,
        };
        this.users.set(user.id, user);
        if (input.identity.verification) {
          this.verificationTokens.set(input.identity.verification.tokenHash, {
            userId: user.id,
            expiresAt: input.identity.verification.expiresAt,
          });
        }
        createdUser = true;
      }
      if (invitation.role === "admin") user.role = "admin";
      invitation.acceptedAt = input.now;

      let membership: { readonly leagueId: string; readonly role: LeagueMembershipRole } | null =
        null;
      if (invitation.leagueId && invitation.leagueRole) {
        const key = `${invitation.leagueId}:${user.id}`;
        const existingRole = this.memberships.get(key);
        const persistedRole =
          existingRole && roleRank(existingRole) > roleRank(invitation.leagueRole)
            ? existingRole
            : invitation.leagueRole;
        this.memberships.set(key, persistedRole);
        membership = { leagueId: invitation.leagueId, role: persistedRole };
      }
      return {
        status: "accepted",
        acceptance: {
          invitationId: invitation.id,
          user: { id: user.id, email: user.email, displayName: user.displayName },
          createdUser,
          verificationRequired:
            createdUser &&
            input.identity.kind === "new_user" &&
            input.identity.verification !== undefined,
          membership,
        },
      };
    } finally {
      release();
    }
  }

  async revoke(input: {
    readonly invitationId: string;
    readonly revokedByUserId: string;
    readonly now: Date;
  }): Promise<RevokeInvitationRepositoryResult> {
    if (!this.adminIds.has(input.revokedByUserId)) return { status: "forbidden" };
    const invitation = [...this.invitations.values()].find(
      (candidate) => candidate.id === input.invitationId,
    );
    if (!invitation || invitation.acceptedAt || invitation.revokedAt) {
      return { status: "unavailable" };
    }
    invitation.revokedAt = input.now;
    return { status: "revoked", invitationId: invitation.id };
  }

  findUserByEmail(email: string): MemoryUser | undefined {
    return [...this.users.values()].find(
      (user) => user.email.toLowerCase() === email.toLowerCase(),
    );
  }
}

function service(repository: InvitationRepository, now: () => Date = () => NOW): InvitationService {
  return new InvitationService(repository, KEYRING, { now });
}

function expectInvitationError(error: unknown, code: string): void {
  expect(error).toBeInstanceOf(InvitationError);
  expect(error).toMatchObject({ code });
  expect(String(error)).not.toMatch(/example\.com|[A-Za-z0-9_-]{43}/u);
}

describe("invitation secrets", () => {
  it("domain-separates stable keyed hashes for tokens and normalized emails", () => {
    const token = Buffer.alloc(32, 4).toString("base64url");
    const tokenHash = hashInvitationToken(token, KEYRING);
    const emailHash = hashInvitationEmail(" Friend@Example.com ", KEYRING);
    expect(tokenHash).toHaveLength(43);
    expect(emailHash).toHaveLength(43);
    expect(tokenHash).not.toBe(token);
    expect(emailHash).toBe(hashInvitationEmail("friend@example.com", KEYRING));
    expect(KEYRING.tokenHmacKey).not.toEqual(KEYRING.emailHmacKey);
  });

  it("rejects root secrets that are too short", () => {
    expect(() => deriveInvitationKeyring("short secret")).toThrow(/32 bytes/u);
  });
});

describe("InvitationService", () => {
  it("creates an admin-authorized, normalized, league-scoped invite without persisting plaintext", async () => {
    const repository = new MemoryInvitationRepository();
    const invitations = service(repository);
    const created = await invitations.create({
      invitedByUserId: ADMIN_ID,
      email: "  FRIEND@Example.com ",
      scope: { leagueId: LEAGUE_ID, leagueRole: "member" },
    });

    expect(created.token).toHaveLength(43);
    expect(created.email).toBe("friend@example.com");
    expect(created.scope).toEqual({ leagueId: LEAGUE_ID, leagueRole: "member" });
    expect([...repository.invitations.keys()]).not.toContain(created.token);
    expect(JSON.stringify([...repository.invitations.values()])).not.toContain(created.token);

    await expect(invitations.inspect(created.token)).resolves.toMatchObject({
      emailHint: "f*****@example.com",
      requiresAuthentication: false,
      scope: {
        leagueId: LEAGUE_ID,
        leagueName: "League of Extraordinary Friends",
        leagueRole: "member",
      },
    });
  });

  it("enforces global admin creation and returns an audit-safe error", async () => {
    const invitations = service(new MemoryInvitationRepository());
    await expect(
      invitations.create({ invitedByUserId: MEMBER_ID, email: "friend@example.com" }),
    ).rejects.toSatisfy((error: unknown) => {
      expectInvitationError(error, "INVITATION_FORBIDDEN");
      return true;
    });
  });

  it("reissues by revoking the previous active capability for the same email and scope", async () => {
    const repository = new MemoryInvitationRepository();
    const invitations = service(repository);
    const first = await invitations.create({
      invitedByUserId: ADMIN_ID,
      email: "friend@example.com",
      scope: { leagueId: LEAGUE_ID, leagueRole: "member" },
    });
    const second = await invitations.create({
      invitedByUserId: ADMIN_ID,
      email: "friend@example.com",
      scope: { leagueId: LEAGUE_ID, leagueRole: "commissioner" },
    });

    await expect(invitations.inspect(first.token)).rejects.toMatchObject({
      code: "INVITATION_UNAVAILABLE",
    });
    await expect(invitations.inspect(second.token)).resolves.toMatchObject({
      scope: { leagueRole: "commissioner" },
    });
  });

  it("rejects removed legacy league roles", async () => {
    const invitations = service(new MemoryInvitationRepository());
    await expect(
      invitations.create({
        invitedByUserId: ADMIN_ID,
        email: "legacy-role@example.com",
        scope: {
          leagueId: LEAGUE_ID,
          leagueRole: "manager" as InvitableLeagueRole,
        },
      }),
    ).rejects.toMatchObject({ code: "INVITATION_INVALID_INPUT" });
  });

  it("upgrades members to commissioner without downgrading commissioner or owner memberships", async () => {
    const repository = new MemoryInvitationRepository();
    repository.users.set(MEMBER_ID, {
      id: MEMBER_ID,
      email: "member@example.com",
      displayName: "Existing Member",
      passwordHash: "existing-password-hash",
      role: "member",
    });
    repository.users.set(OTHER_ID, {
      id: OTHER_ID,
      email: "owner@example.com",
      displayName: "Existing Owner",
      passwordHash: "existing-password-hash",
      role: "member",
    });
    repository.memberships.set(`${LEAGUE_ID}:${MEMBER_ID}`, "member");
    repository.memberships.set(`${LEAGUE_ID}:${OTHER_ID}`, "owner");
    const invitations = service(repository);

    const commissionerInvite = await invitations.create({
      invitedByUserId: ADMIN_ID,
      email: "member@example.com",
      scope: { leagueId: LEAGUE_ID, leagueRole: "commissioner" },
    });
    await expect(
      invitations.accept({ token: commissionerInvite.token, authenticatedUserId: MEMBER_ID }),
    ).resolves.toMatchObject({ membership: { role: "commissioner" } });

    const memberInvite = await invitations.create({
      invitedByUserId: ADMIN_ID,
      email: "member@example.com",
      scope: { leagueId: LEAGUE_ID, leagueRole: "member" },
    });
    await expect(
      invitations.accept({ token: memberInvite.token, authenticatedUserId: MEMBER_ID }),
    ).resolves.toMatchObject({ membership: { role: "commissioner" } });

    const ownerInvite = await invitations.create({
      invitedByUserId: ADMIN_ID,
      email: "owner@example.com",
      scope: { leagueId: LEAGUE_ID, leagueRole: "commissioner" },
    });
    await expect(
      invitations.accept({ token: ownerInvite.token, authenticatedUserId: OTHER_ID }),
    ).resolves.toMatchObject({ membership: { role: "owner" } });
  });

  it("accepts once, creates a normalized-email user with Argon2id, and grants membership", async () => {
    const repository = new MemoryInvitationRepository();
    const invitations = service(repository);
    const created = await invitations.create({
      invitedByUserId: ADMIN_ID,
      email: "new.friend@example.com",
      scope: { leagueId: LEAGUE_ID, leagueRole: "member" },
    });
    const acceptance = await invitations.accept({
      token: created.token,
      displayName: "  New   Friend  ",
      password: "a long unique password",
    });

    expect(acceptance.createdUser).toBe(true);
    expect(acceptance.verificationRequired).toBe(false);
    expect(acceptance.user).toMatchObject({
      email: "new.friend@example.com",
      displayName: "New Friend",
    });
    expect(acceptance.membership).toEqual({ leagueId: LEAGUE_ID, role: "member" });
    const persistedUser = repository.findUserByEmail("NEW.FRIEND@example.com");
    expect(persistedUser?.passwordHash).not.toBe("a long unique password");
    expect(await verify(persistedUser?.passwordHash ?? "", "a long unique password")).toBe(true);
    await expect(invitations.inspect(created.token)).rejects.toMatchObject({
      code: "INVITATION_UNAVAILABLE",
    });
  });

  it("preserves invitation membership while a new account awaits confirmation", async () => {
    const repository = new MemoryInvitationRepository();
    const verificationToken = "v".repeat(43);
    const sends: unknown[] = [];
    const invitations = new InvitationService(repository, KEYRING, {
      now: () => NOW,
      confirmation: {
        webUrl: "https://lacesout.app",
        tokenFactory: () => verificationToken,
        delivery: {
          sendConfirmationEmail: (input) => {
            sends.push(input);
            return Promise.resolve();
          },
        },
      },
    });
    const created = await invitations.create({
      invitedByUserId: ADMIN_ID,
      email: "new.friend@example.com",
      scope: { leagueId: LEAGUE_ID, leagueRole: "member" },
    });

    const acceptance = await invitations.accept({
      token: created.token,
      displayName: "New Friend",
      password: "a long unique password",
    });

    expect(acceptance).toMatchObject({
      createdUser: true,
      verificationRequired: true,
      membership: { leagueId: LEAGUE_ID, role: "member" },
    });
    expect(repository.verificationTokens.get(hashSessionToken(verificationToken))).toEqual({
      userId: acceptance.user.id,
      expiresAt: new Date("2026-07-17T12:00:00.000Z"),
    });
    expect(sends).toEqual([
      {
        email: "new.friend@example.com",
        displayName: "New Friend",
        confirmUrl: `https://lacesout.app/verify-email#${verificationToken}`,
        expiresHours: 24,
      },
    ]);
  });

  it("keeps the accepted invitation recoverable when confirmation delivery fails", async () => {
    const repository = new MemoryInvitationRepository();
    const deliveryErrors: unknown[] = [];
    const invitations = new InvitationService(repository, KEYRING, {
      now: () => NOW,
      confirmation: {
        webUrl: "https://lacesout.app",
        tokenFactory: () => "v".repeat(43),
        delivery: {
          sendConfirmationEmail: () => Promise.reject(new Error("transport unavailable")),
        },
        onDeliveryError: (error) => deliveryErrors.push(error),
      },
    });
    const created = await invitations.create({
      invitedByUserId: ADMIN_ID,
      email: "delivery.failure@example.com",
      scope: { leagueId: LEAGUE_ID, leagueRole: "member" },
    });

    const acceptance = await invitations.accept({
      token: created.token,
      displayName: "Delivery Failure",
      password: "a long unique password",
    });

    expect(acceptance).toMatchObject({
      verificationRequired: true,
      membership: { leagueId: LEAGUE_ID, role: "member" },
    });
    expect(repository.verificationTokens.size).toBe(1);
    expect(deliveryErrors).toHaveLength(1);
    await expect(invitations.inspect(created.token)).rejects.toMatchObject({
      code: "INVITATION_UNAVAILABLE",
    });
  });

  it("requires the invited existing account to authenticate before linking access", async () => {
    const repository = new MemoryInvitationRepository();
    repository.users.set(MEMBER_ID, {
      id: MEMBER_ID,
      email: "member@example.com",
      displayName: "Existing Member",
      passwordHash: "existing-hash-is-not-overwritten",
      role: "member",
    });
    const invitations = service(repository);
    const created = await invitations.create({
      invitedByUserId: ADMIN_ID,
      email: "MEMBER@example.com",
      scope: { leagueId: LEAGUE_ID, leagueRole: "member" },
    });
    await expect(invitations.inspect(created.token)).resolves.toMatchObject({
      requiresAuthentication: true,
    });

    await expect(invitations.accept({ token: created.token })).rejects.toMatchObject({
      code: "INVITATION_AUTHENTICATION_REQUIRED",
    });
    await expect(
      invitations.accept({ token: created.token, authenticatedUserId: OTHER_ID }),
    ).rejects.toMatchObject({ code: "INVITATION_ACCOUNT_MISMATCH" });
    const acceptance = await invitations.accept({
      token: created.token,
      authenticatedUserId: MEMBER_ID,
    });
    expect(acceptance.createdUser).toBe(false);
    expect(acceptance.user.id).toBe(MEMBER_ID);
    expect(repository.users.get(MEMBER_ID)?.passwordHash).toBe("existing-hash-is-not-overwritten");
  });

  it("allows exactly one winner when the same invite is accepted concurrently", async () => {
    const repository = new MemoryInvitationRepository();
    const invitations = service(repository);
    const created = await invitations.create({
      invitedByUserId: ADMIN_ID,
      email: "race@example.com",
    });
    const attempts = await Promise.allSettled([
      invitations.accept({
        token: created.token,
        displayName: "Race Winner",
        password: "a sufficiently long password",
      }),
      invitations.accept({
        token: created.token,
        displayName: "Race Winner",
        password: "a sufficiently long password",
      }),
    ]);

    expect(attempts.filter((attempt) => attempt.status === "fulfilled")).toHaveLength(1);
    const rejected = attempts.find((attempt) => attempt.status === "rejected");
    expect(rejected).toMatchObject({
      reason: { code: "INVITATION_UNAVAILABLE" },
    });
    expect(
      [...repository.users.values()].filter((user) => user.email === "race@example.com"),
    ).toHaveLength(1);
  });

  it("revokes a pending invite once and does not disclose its prior state", async () => {
    const repository = new MemoryInvitationRepository();
    const invitations = service(repository);
    const created = await invitations.create({
      invitedByUserId: ADMIN_ID,
      email: "revoked@example.com",
    });

    await expect(invitations.revoke(ADMIN_ID, created.id)).resolves.toEqual({ id: created.id });
    await expect(invitations.inspect(created.token)).rejects.toMatchObject({
      code: "INVITATION_UNAVAILABLE",
    });
    await expect(invitations.revoke(ADMIN_ID, created.id)).rejects.toMatchObject({
      code: "INVITATION_UNAVAILABLE",
    });
  });

  it("treats invalid, expired, accepted, and revoked capabilities as unavailable", async () => {
    const repository = new MemoryInvitationRepository();
    let now = NOW;
    const invitations = service(repository, () => now);
    await expect(invitations.inspect("not-a-token")).rejects.toMatchObject({
      code: "INVITATION_UNAVAILABLE",
    });
    const created = await invitations.create({
      invitedByUserId: ADMIN_ID,
      email: "expired@example.com",
      expiresAt: new Date(NOW.getTime() + 15 * 60 * 1000),
    });
    now = new Date(NOW.getTime() + 15 * 60 * 1000);
    await expect(invitations.inspect(created.token)).rejects.toMatchObject({
      code: "INVITATION_UNAVAILABLE",
    });
  });
});
