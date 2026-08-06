import { loadEnvironment } from "@laces-out/config";
import { createDatabase, sessions, users } from "@laces-out/db";
import { eq, sql } from "drizzle-orm";

import { hashOwnerPassword } from "./auth.js";

const environment = loadEnvironment();
const email = process.env.ACCOUNT_EMAIL?.trim().toLowerCase();
const newPassword = process.env.ACCOUNT_NEW_PASSWORD;

if (!email || email.length > 320 || !email.includes("@") || !newPassword) {
  throw new Error(
    "Set ACCOUNT_EMAIL and ACCOUNT_NEW_PASSWORD (12-128 characters) for this one-shot command. " +
      "Supply the password ephemerally; do not save it in .env or shell history.",
  );
}

const passwordHash = await hashOwnerPassword(newPassword);
const database = createDatabase(environment.DATABASE_URL, 1);
try {
  const changed = await database.db.transaction(async (transaction) => {
    const [account] = await transaction
      .select({ id: users.id })
      .from(users)
      .where(sql`lower(${users.email}) = ${email}`)
      .limit(1);
    if (!account) return false;

    await transaction
      .update(users)
      .set({ passwordHash, updatedAt: new Date() })
      .where(eq(users.id, account.id));
    // A password reset is a security boundary: every existing device must authenticate again.
    await transaction.delete(sessions).where(eq(sessions.userId, account.id));
    return true;
  });

  if (!changed) throw new Error("No account matches ACCOUNT_EMAIL");
  // Avoid echoing the account identifier or supplied secret into deployment logs.
  process.stdout.write("Account password reset; all existing sessions were revoked.\n");
} finally {
  await database.close();
}
