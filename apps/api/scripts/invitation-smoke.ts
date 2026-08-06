import assert from "node:assert/strict";

import { loadEnvironment } from "@laces-out/config";
import {
  createDatabase,
  type Database,
  invitations,
  leagueMemberships,
  leagues,
  users,
} from "@laces-out/db";
import { and, eq } from "drizzle-orm";

import { DrizzleInvitationRepository } from "../src/invitation-repository.js";
import { deriveInvitationKeyring, InvitationError, InvitationService } from "../src/invitation.js";

interface SmokeResult {
  readonly createdUser: boolean;
  readonly membershipRole: string | null;
  readonly consumedOnce: boolean;
  readonly tokenStoredInPlaintext: false;
  readonly rolledBack: true;
}

class SmokeRollback extends Error {
  readonly result: SmokeResult;

  constructor(result: SmokeResult) {
    super("Roll back the invitation smoke transaction");
    this.name = "SmokeRollback";
    this.result = result;
  }
}

const environment = loadEnvironment();
const database = createDatabase(environment.DATABASE_URL, 1);
let smokeResult: SmokeResult | undefined;

try {
  await database.db.transaction(async (transaction) => {
    const smokeDatabase = transaction as unknown as Database;
    const [administrator] = await smokeDatabase
      .insert(users)
      .values({
        email: "invite-admin-smoke@fourthdown.local",
        displayName: "Invitation Admin Smoke",
        passwordHash: null,
        role: "admin",
      })
      .returning({ id: users.id });
    assert.ok(administrator);
    const [league] = await smokeDatabase
      .insert(leagues)
      .values({ ownerUserId: administrator.id, name: "Invitation Smoke League" })
      .returning({ id: leagues.id });
    assert.ok(league);

    const service = new InvitationService(
      new DrizzleInvitationRepository(smokeDatabase),
      deriveInvitationKeyring("invitation-smoke-secret-32-bytes-minimum"),
    );
    const created = await service.create({
      invitedByUserId: administrator.id,
      email: "invite-friend-smoke@fourthdown.local",
      scope: { leagueId: league.id, leagueRole: "manager" },
    });
    const inspection = await service.inspect(created.token);
    assert.equal(inspection.requiresAuthentication, false);
    const acceptance = await service.accept({
      token: created.token,
      displayName: "Invitation Friend Smoke",
      password: "a unique smoke password",
    });

    const [storedInvitation] = await smokeDatabase
      .select({ tokenHash: invitations.tokenHash })
      .from(invitations)
      .where(eq(invitations.id, created.id))
      .limit(1);
    assert.ok(storedInvitation);
    assert.notEqual(storedInvitation.tokenHash, created.token);
    const [membership] = await smokeDatabase
      .select({ role: leagueMemberships.role })
      .from(leagueMemberships)
      .where(
        and(
          eq(leagueMemberships.leagueId, league.id),
          eq(leagueMemberships.userId, acceptance.user.id),
        ),
      )
      .limit(1);
    assert.equal(membership?.role, "manager");

    let consumedOnce = false;
    try {
      await service.accept({
        token: created.token,
        displayName: "Invitation Friend Smoke",
        password: "a unique smoke password",
      });
    } catch (error) {
      consumedOnce = error instanceof InvitationError && error.code === "INVITATION_UNAVAILABLE";
    }
    assert.equal(consumedOnce, true);

    throw new SmokeRollback({
      createdUser: acceptance.createdUser,
      membershipRole: membership?.role ?? null,
      consumedOnce,
      tokenStoredInPlaintext: false,
      rolledBack: true,
    });
  });
} catch (error) {
  if (error instanceof SmokeRollback) smokeResult = error.result;
  else throw error;
} finally {
  await database.close();
}

assert.ok(smokeResult, "smoke transaction must finish through the expected rollback");
process.stdout.write(`${JSON.stringify(smokeResult)}\n`);
