import { and, asc, eq, gt, inArray, isNull, ne, sql, type SQL } from "drizzle-orm";
import {
  type ApplicationRole,
  type Database,
  invitations,
  leagueMemberships,
  leagues,
  users,
} from "@fantasy/db";

import type {
  AcceptInvitationRepositoryResult,
  CreateInvitationRepositoryResult,
  InvitationAcceptanceIdentity,
  InvitationRepository,
  InvitableLeagueRole,
  PendingInvitationRecord,
  RevokeInvitationRepositoryResult,
} from "./invitation.js";

class ConsumeRollback extends Error {
  constructor() {
    super("Invitation could not be consumed");
    this.name = "ConsumeRollback";
  }
}

function databaseErrorCode(error: unknown): string | undefined {
  let cursor: unknown = error;
  for (let depth = 0; depth < 6 && cursor && typeof cursor === "object"; depth += 1) {
    if ("code" in cursor && typeof cursor.code === "string") return cursor.code;
    cursor = "cause" in cursor ? cursor.cause : undefined;
  }
  return undefined;
}

function membershipRoleUpgrade(invitedRole: InvitableLeagueRole): SQL {
  switch (invitedRole) {
    case "commissioner":
      return sql`case when ${leagueMemberships.role} = 'owner' then 'owner' else 'commissioner' end`;
    case "manager":
      return sql`case when ${leagueMemberships.role} in ('owner', 'commissioner') then ${leagueMemberships.role} else 'manager' end`;
    case "viewer":
      return sql`${leagueMemberships.role}`;
  }
}

function isActive(
  invitation: {
    readonly acceptedAt: Date | null;
    readonly revokedAt: Date | null;
    readonly expiresAt: Date;
  },
  now: Date,
): boolean {
  return (
    invitation.acceptedAt === null &&
    invitation.revokedAt === null &&
    invitation.expiresAt.getTime() > now.getTime()
  );
}

/** PostgreSQL implementation of the invitation persistence boundary. */
export class DrizzleInvitationRepository implements InvitationRepository {
  readonly #database: Database;

  constructor(database: Database) {
    this.#database = database;
  }

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
    try {
      return await this.#database.transaction(async (transaction) => {
        const [actor] = await transaction
          .select({ role: users.role })
          .from(users)
          .where(eq(users.id, input.invitedByUserId))
          .limit(1);
        if (actor?.role !== "admin") return { status: "forbidden" } as const;

        if ((input.leagueId === null) !== (input.leagueRole === null)) {
          return { status: "scope_not_found" } as const;
        }

        let leagueName: string | null = null;
        if (input.leagueId) {
          const [league] = await transaction
            .select({ name: leagues.name })
            .from(leagues)
            .where(eq(leagues.id, input.leagueId))
            .limit(1);
          if (!league) return { status: "scope_not_found" } as const;
          leagueName = league.name;
        }

        const [existingUser] = await transaction
          .select({ id: users.id })
          .from(users)
          .where(sql`lower(${users.email}) = ${input.email}`)
          .limit(1);

        const [created] = await transaction
          .insert(invitations)
          .values({
            tokenHash: input.tokenHash,
            email: input.email,
            emailHash: input.emailHash,
            invitedByUserId: input.invitedByUserId,
            role: input.role,
            leagueId: input.leagueId,
            leagueRole: input.leagueRole,
            expiresAt: input.expiresAt,
          })
          .returning({
            id: invitations.id,
            email: invitations.email,
            invitedByUserId: invitations.invitedByUserId,
            role: invitations.role,
            leagueId: invitations.leagueId,
            leagueRole: invitations.leagueRole,
            expiresAt: invitations.expiresAt,
          });
        if (!created) throw new Error("Invitation insert returned no record");

        // A reissue invalidates older active capabilities for the same email and
        // scope. Inserting first makes a token collision roll the whole transaction
        // back without accidentally revoking the prior invitation.
        const matchingScope = input.leagueId
          ? eq(invitations.leagueId, input.leagueId)
          : isNull(invitations.leagueId);
        await transaction
          .update(invitations)
          .set({ revokedAt: input.now })
          .where(
            and(
              eq(invitations.emailHash, input.emailHash),
              matchingScope,
              ne(invitations.id, created.id),
              isNull(invitations.acceptedAt),
              isNull(invitations.revokedAt),
              gt(invitations.expiresAt, input.now),
            ),
          );

        return {
          status: "created",
          invitation: {
            ...created,
            leagueName,
            existingUserId: existingUser?.id ?? null,
          },
        } as const;
      });
    } catch (error) {
      if (databaseErrorCode(error) === "23505") return { status: "token_conflict" };
      throw error;
    }
  }

  async findActiveByTokenHash(
    tokenHash: string,
    now: Date,
  ): Promise<PendingInvitationRecord | undefined> {
    const [record] = await this.#database
      .select({
        id: invitations.id,
        email: invitations.email,
        invitedByUserId: invitations.invitedByUserId,
        role: invitations.role,
        leagueId: invitations.leagueId,
        leagueName: leagues.name,
        leagueRole: invitations.leagueRole,
        existingUserId: users.id,
        expiresAt: invitations.expiresAt,
      })
      .from(invitations)
      .leftJoin(leagues, eq(leagues.id, invitations.leagueId))
      .leftJoin(users, sql`lower(${users.email}) = lower(${invitations.email})`)
      .where(
        and(
          eq(invitations.tokenHash, tokenHash),
          isNull(invitations.acceptedAt),
          isNull(invitations.revokedAt),
          gt(invitations.expiresAt, now),
        ),
      )
      .limit(1);
    return record;
  }

  async accept(input: {
    readonly tokenHash: string;
    readonly identity: InvitationAcceptanceIdentity;
    readonly now: Date;
  }): Promise<AcceptInvitationRepositoryResult> {
    try {
      return await this.#database.transaction(async (transaction) => {
        // Discovery is deliberately non-locking. It tells us which parent rows must be locked
        // before the invitation child row; the invitation is reselected and revalidated below.
        const [discoveredInvitation] = await transaction
          .select({
            id: invitations.id,
            email: invitations.email,
            invitedByUserId: invitations.invitedByUserId,
            role: invitations.role,
            leagueId: invitations.leagueId,
            leagueRole: invitations.leagueRole,
            expiresAt: invitations.expiresAt,
            acceptedAt: invitations.acceptedAt,
            revokedAt: invitations.revokedAt,
          })
          .from(invitations)
          .where(eq(invitations.tokenHash, input.tokenHash))
          .limit(1);
        if (!discoveredInvitation || !isActive(discoveredInvitation, input.now)) {
          return { status: "unavailable" } as const;
        }

        // Account deletion takes the same parent-before-child order: user, owned league, then
        // invitation. Lock every existing user dependency in UUID order, including the inviter
        // whose FK is copied into a league membership during acceptance.
        const dependencyUserIds = [
          discoveredInvitation.invitedByUserId,
          ...(input.identity.kind === "existing_user" ? [input.identity.userId] : []),
        ].filter((id, index, values) => values.indexOf(id) === index);
        const lockedUsers = await transaction
          .select({
            id: users.id,
            email: users.email,
            displayName: users.displayName,
            role: users.role,
          })
          .from(users)
          .where(inArray(users.id, dependencyUserIds))
          .orderBy(asc(users.id))
          .for("update");
        if (!lockedUsers.some((user) => user.id === discoveredInvitation.invitedByUserId)) {
          return { status: "unavailable" } as const;
        }

        if (discoveredInvitation.leagueId) {
          const [league] = await transaction
            .select({ id: leagues.id })
            .from(leagues)
            .where(eq(leagues.id, discoveredInvitation.leagueId))
            .limit(1)
            .for("key share");
          if (!league) return { status: "unavailable" } as const;
        }

        const [invitation] = await transaction
          .select({
            id: invitations.id,
            email: invitations.email,
            invitedByUserId: invitations.invitedByUserId,
            role: invitations.role,
            leagueId: invitations.leagueId,
            leagueRole: invitations.leagueRole,
            expiresAt: invitations.expiresAt,
            acceptedAt: invitations.acceptedAt,
            revokedAt: invitations.revokedAt,
          })
          .from(invitations)
          .where(eq(invitations.id, discoveredInvitation.id))
          .limit(1)
          .for("update");
        if (
          !invitation ||
          !isActive(invitation, input.now) ||
          invitation.email !== discoveredInvitation.email ||
          invitation.invitedByUserId !== discoveredInvitation.invitedByUserId ||
          invitation.role !== discoveredInvitation.role ||
          invitation.leagueId !== discoveredInvitation.leagueId ||
          invitation.leagueRole !== discoveredInvitation.leagueRole
        ) {
          return { status: "unavailable" } as const;
        }

        let acceptedUser:
          | {
              readonly id: string;
              readonly email: string;
              readonly displayName: string;
              readonly role: ApplicationRole;
            }
          | undefined;
        let createdUser = false;
        if (input.identity.kind === "existing_user") {
          const existingUserId = input.identity.userId;
          const existingUser = lockedUsers.find((user) => user.id === existingUserId);
          if (
            !existingUser ||
            existingUser.email.toLowerCase() !== invitation.email.toLowerCase()
          ) {
            return { status: "identity_conflict" } as const;
          }
          acceptedUser = existingUser;
        } else {
          const [existingUser] = await transaction
            .select({ id: users.id })
            .from(users)
            .where(sql`lower(${users.email}) = lower(${invitation.email})`)
            .limit(1);
          if (existingUser) return { status: "identity_conflict" } as const;
          const [created] = await transaction
            .insert(users)
            .values({
              email: invitation.email,
              displayName: input.identity.displayName,
              passwordHash: input.identity.passwordHash,
              role: invitation.role,
              updatedAt: input.now,
            })
            // Handles two different invitations for the same normalized email.
            .onConflictDoNothing()
            .returning({
              id: users.id,
              email: users.email,
              displayName: users.displayName,
              role: users.role,
            });
          if (!created) return { status: "identity_conflict" } as const;
          acceptedUser = created;
          createdUser = true;
        }

        if (invitation.role === "admin" && acceptedUser.role !== "admin") {
          await transaction
            .update(users)
            .set({ role: "admin", updatedAt: input.now })
            .where(eq(users.id, acceptedUser.id));
        }

        const [consumed] = await transaction
          .update(invitations)
          .set({ acceptedAt: input.now, acceptedByUserId: acceptedUser.id })
          .where(
            and(
              eq(invitations.id, invitation.id),
              isNull(invitations.acceptedAt),
              isNull(invitations.revokedAt),
              gt(invitations.expiresAt, input.now),
            ),
          )
          .returning({ id: invitations.id });
        if (!consumed) throw new ConsumeRollback();

        let membership: {
          readonly leagueId: string;
          readonly role: "owner" | InvitableLeagueRole;
        } | null = null;
        if (invitation.leagueId && invitation.leagueRole) {
          await transaction
            .insert(leagueMemberships)
            .values({
              leagueId: invitation.leagueId,
              userId: acceptedUser.id,
              role: invitation.leagueRole,
              invitedByUserId: invitation.invitedByUserId,
              joinedAt: input.now,
              updatedAt: input.now,
            })
            .onConflictDoUpdate({
              target: [leagueMemberships.leagueId, leagueMemberships.userId],
              set: {
                role: membershipRoleUpgrade(invitation.leagueRole),
                invitedByUserId: invitation.invitedByUserId,
                updatedAt: input.now,
              },
            });
          const [persistedMembership] = await transaction
            .select({ leagueId: leagueMemberships.leagueId, role: leagueMemberships.role })
            .from(leagueMemberships)
            .where(
              and(
                eq(leagueMemberships.leagueId, invitation.leagueId),
                eq(leagueMemberships.userId, acceptedUser.id),
              ),
            )
            .limit(1);
          if (!persistedMembership) throw new Error("Invitation membership was not persisted");
          membership = persistedMembership;
        }

        return {
          status: "accepted",
          acceptance: {
            invitationId: invitation.id,
            user: {
              id: acceptedUser.id,
              email: acceptedUser.email,
              displayName: acceptedUser.displayName,
            },
            createdUser,
            membership,
          },
        } as const;
      });
    } catch (error) {
      if (error instanceof ConsumeRollback) return { status: "unavailable" };
      // A normalized-email race between two different invite transactions is
      // surfaced as a retryable identity conflict without consuming either token.
      if (databaseErrorCode(error) === "23505") return { status: "identity_conflict" };
      throw error;
    }
  }

  async revoke(input: {
    readonly invitationId: string;
    readonly revokedByUserId: string;
    readonly now: Date;
  }): Promise<RevokeInvitationRepositoryResult> {
    return this.#database.transaction(async (transaction) => {
      const [actor] = await transaction
        .select({ role: users.role })
        .from(users)
        .where(eq(users.id, input.revokedByUserId))
        .limit(1);
      if (actor?.role !== "admin") return { status: "forbidden" } as const;

      const [revoked] = await transaction
        .update(invitations)
        .set({ revokedAt: input.now })
        .where(
          and(
            eq(invitations.id, input.invitationId),
            isNull(invitations.acceptedAt),
            isNull(invitations.revokedAt),
          ),
        )
        .returning({ id: invitations.id });
      return revoked
        ? ({ status: "revoked", invitationId: revoked.id } as const)
        : ({ status: "unavailable" } as const);
    });
  }
}
