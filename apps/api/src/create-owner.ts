import { count, sql } from "drizzle-orm";
import { createDatabase, users } from "@laces-out/db";
import { loadEnvironment } from "@laces-out/config";

import { hashOwnerPassword } from "./auth.js";

const environment = loadEnvironment();
const email = process.env.OWNER_EMAIL?.trim().toLowerCase();
const displayName = process.env.OWNER_DISPLAY_NAME?.trim() || "Owner";
const password = process.env.OWNER_PASSWORD;

if (!email || !email.includes("@") || !password) {
  throw new Error(
    "Set OWNER_EMAIL and OWNER_PASSWORD (12-128 characters) for this one-shot command. " +
      "Do not save OWNER_PASSWORD in .env or shell history.",
  );
}

const database = createDatabase(environment.DATABASE_URL, 1);
try {
  const [existing] = await database.db.select({ total: count() }).from(users);
  if (Number(existing?.total ?? 0) > 0) {
    throw new Error("An owner already exists; refusing to create another account");
  }

  const passwordHash = await hashOwnerPassword(password);
  // Operator-created accounts activate immediately; null email_verified_at means pending only.
  await database.db
    .insert(users)
    .values({ email, displayName, passwordHash, role: "admin", emailVerifiedAt: new Date() });
  // Avoid logging the supplied email; it is not needed to confirm success.
  process.stdout.write(
    "Owner administrator account created. Clear OWNER_PASSWORD from the environment now.\n",
  );
  await database.db.execute(sql`select 1`);
} finally {
  await database.close();
}
