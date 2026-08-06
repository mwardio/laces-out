import assert from "node:assert/strict";

import { loadEnvironment } from "@fantasy/config";
import {
  createDatabase,
  emailVerificationTokens,
  type Database,
  sessions,
  users,
} from "@fantasy/db";
import { eq } from "drizzle-orm";

import { hashSessionToken } from "../src/auth.js";
import { DrizzlePasswordResetRepository } from "../src/password-reset-repository.js";
import { DrizzleRegistrationRepository } from "../src/registration-repository.js";
import { RegistrationService } from "../src/registration.js";

interface SmokeResult {
  readonly normalizedEmail: true;
  readonly memberRole: true;
  readonly passwordHashed: true;
  readonly sessionHashed: true;
  readonly duplicateRejected: true;
  readonly wrongCodeRejected: true;
  readonly pendingIdentityPreserved: true;
  readonly pendingHasNoSession: true;
  readonly verificationRotated: true;
  readonly resetDoesNotVerify: true;
  readonly rolledBack: true;
}

class SmokeRollback extends Error {
  readonly result: SmokeResult;

  constructor(result: SmokeResult) {
    super("Roll back the registration smoke transaction");
    this.name = "SmokeRollback";
    this.result = result;
  }
}

const environment = loadEnvironment();
const database = createDatabase(environment.DATABASE_URL, 1);
const sharedCode = "laces-out-registration-smoke";
const sessionToken = "q".repeat(43);
let smokeResult: SmokeResult | undefined;

try {
  await database.db.transaction(async (transaction) => {
    const smokeDatabase = transaction as unknown as Database;
    const service = new RegistrationService(
      new DrizzleRegistrationRepository(smokeDatabase),
      "registration-smoke-root-secret-32-bytes",
      sharedCode,
      { tokenFactory: () => sessionToken },
    );
    const registration = await service.register({
      inviteCode: sharedCode,
      email: "  REGISTRATION-SMOKE@LacesOut.Local ",
      displayName: " Registration   Smoke ",
      password: "a unique registration smoke password",
    });
    assert.ok(registration);
    // The smoke service configures no confirmation delivery, so registration activates directly.
    if (registration.status !== "active") throw new Error("Expected an active registration");
    assert.equal(registration.user.email, "registration-smoke@lacesout.local");
    assert.equal(registration.user.role, "member");

    const [storedUser] = await smokeDatabase
      .select({ passwordHash: users.passwordHash, role: users.role })
      .from(users)
      .where(eq(users.id, registration.user.id))
      .limit(1);
    assert.ok(storedUser);
    assert.ok(storedUser.passwordHash?.startsWith("$argon2id$"));
    assert.notEqual(storedUser.passwordHash, "a unique registration smoke password");
    assert.equal(storedUser.role, "member");

    const [storedSession] = await smokeDatabase
      .select({ tokenHash: sessions.tokenHash })
      .from(sessions)
      .where(eq(sessions.userId, registration.user.id))
      .limit(1);
    assert.ok(storedSession);
    assert.notEqual(storedSession.tokenHash, sessionToken);

    const duplicate = await service.register({
      inviteCode: sharedCode,
      email: "registration-smoke@LACESOUT.local",
      displayName: "Another Account",
      password: "another unique registration password",
    });
    assert.equal(duplicate, undefined);

    const wrongCode = await service.register({
      inviteCode: "wrong-registration-smoke-code",
      email: "unused-registration-smoke@lacesout.local",
      displayName: "Unused Account",
      password: "another unique registration password",
    });
    assert.equal(wrongCode, undefined);

    const pendingRepository = new DrizzleRegistrationRepository(smokeDatabase);
    const confirmationTokens = ["p".repeat(43), "v".repeat(43)];
    let confirmationTokenIndex = 0;
    const confirmationLinks: string[] = [];
    const pendingService = new RegistrationService(
      pendingRepository,
      "registration-smoke-root-secret-32-bytes",
      undefined,
      {
        tokenFactory: () => confirmationTokens[confirmationTokenIndex++] ?? "x".repeat(43),
        confirmation: {
          repository: pendingRepository,
          delivery: {
            sendConfirmationEmail: (input) => {
              confirmationLinks.push(input.confirmUrl);
              return Promise.resolve();
            },
          },
          webUrl: "https://lacesout.app",
        },
      },
    );
    const pendingEmail = "pending-registration-smoke@lacesout.local";
    const firstPending = await pendingService.register({
      email: pendingEmail,
      displayName: "Original Pending Member",
      password: "the original pending registration password",
    });
    assert.deepEqual(firstPending, { status: "pending" });
    const [originalPendingUser] = await smokeDatabase
      .select({
        id: users.id,
        displayName: users.displayName,
        passwordHash: users.passwordHash,
        emailVerifiedAt: users.emailVerifiedAt,
      })
      .from(users)
      .where(eq(users.email, pendingEmail))
      .limit(1);
    assert.ok(originalPendingUser);
    assert.equal(originalPendingUser.emailVerifiedAt, null);

    const repeatedPending = await pendingService.register({
      email: pendingEmail,
      displayName: "Attempted Replacement",
      password: "a completely different pending password",
    });
    assert.deepEqual(repeatedPending, { status: "pending" });
    const [preservedPendingUser] = await smokeDatabase
      .select({
        id: users.id,
        displayName: users.displayName,
        passwordHash: users.passwordHash,
      })
      .from(users)
      .where(eq(users.email, pendingEmail))
      .limit(1);
    assert.deepEqual(preservedPendingUser, {
      id: originalPendingUser.id,
      displayName: originalPendingUser.displayName,
      passwordHash: originalPendingUser.passwordHash,
    });
    const pendingSessions = await smokeDatabase
      .select({ id: sessions.id })
      .from(sessions)
      .where(eq(sessions.userId, originalPendingUser.id));
    assert.equal(pendingSessions.length, 0);
    const pendingVerificationTokens = await smokeDatabase
      .select({ tokenHash: emailVerificationTokens.tokenHash })
      .from(emailVerificationTokens)
      .where(eq(emailVerificationTokens.userId, originalPendingUser.id));
    assert.deepEqual(pendingVerificationTokens, [
      { tokenHash: hashSessionToken(confirmationTokens[1] ?? "") },
    ]);
    assert.deepEqual(confirmationLinks, [
      `https://lacesout.app/verify-email#${confirmationTokens[0]}`,
      `https://lacesout.app/verify-email#${confirmationTokens[1]}`,
    ]);
    const resetRepository = new DrizzlePasswordResetRepository(smokeDatabase);
    const resetAt = new Date();
    const resetTokenHash = "r".repeat(43);
    await resetRepository.replaceOutstandingToken({
      userId: originalPendingUser.id,
      tokenHash: resetTokenHash,
      expiresAt: new Date(resetAt.getTime() + 30 * 60 * 1000),
      createdAt: resetAt,
    });
    assert.equal(
      await resetRepository.redeemToken({
        tokenHash: resetTokenHash,
        newPasswordHash: originalPendingUser.passwordHash ?? "",
        now: resetAt,
      }),
      "reset",
    );
    const [pendingAfterReset] = await smokeDatabase
      .select({ emailVerifiedAt: users.emailVerifiedAt })
      .from(users)
      .where(eq(users.id, originalPendingUser.id))
      .limit(1);
    assert.equal(pendingAfterReset?.emailVerifiedAt, null);

    throw new SmokeRollback({
      normalizedEmail: true,
      memberRole: true,
      passwordHashed: true,
      sessionHashed: true,
      duplicateRejected: true,
      wrongCodeRejected: true,
      pendingIdentityPreserved: true,
      pendingHasNoSession: true,
      verificationRotated: true,
      resetDoesNotVerify: true,
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
