import assert from "node:assert/strict";

import { loadEnvironment } from "@fantasy/config";
import { createDatabase, type Database, sessions, users } from "@fantasy/db";
import { eq } from "drizzle-orm";

import { DrizzleRegistrationRepository } from "../src/registration-repository.js";
import { RegistrationService } from "../src/registration.js";

interface SmokeResult {
  readonly normalizedEmail: true;
  readonly memberRole: true;
  readonly passwordHashed: true;
  readonly sessionHashed: true;
  readonly duplicateRejected: true;
  readonly wrongCodeRejected: true;
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

    throw new SmokeRollback({
      normalizedEmail: true,
      memberRole: true,
      passwordHashed: true,
      sessionHashed: true,
      duplicateRejected: true,
      wrongCodeRejected: true,
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
