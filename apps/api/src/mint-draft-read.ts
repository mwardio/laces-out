import { loadEnvironment } from "@laces-out/config";
import {
  createDatabase,
  leagueMemberships,
  leagueSeasons,
  leagues as leagueTable,
} from "@laces-out/db";
import { and, eq } from "drizzle-orm";

import { runDraftReadProvisioner, writeNewPrivateDraftReadFile } from "./draft-read-provisioner.js";

async function main(): Promise<number> {
  let database: ReturnType<typeof createDatabase> | undefined;
  try {
    const environment = loadEnvironment();
    database = createDatabase(environment.DATABASE_URL, 1);
    const provisioningDatabase = database;
    const activeMembershipUsers = async (scope: {
      readonly leagueId: string;
      readonly season: number;
    }): Promise<readonly string[]> => {
      const memberships = await provisioningDatabase.db
        .select({ userId: leagueMemberships.userId })
        .from(leagueMemberships)
        .innerJoin(
          leagueTable,
          and(eq(leagueTable.id, leagueMemberships.leagueId), eq(leagueTable.archived, false)),
        )
        .innerJoin(
          leagueSeasons,
          and(
            eq(leagueSeasons.leagueId, leagueTable.id),
            eq(leagueSeasons.provider, "espn"),
            eq(leagueSeasons.externalKey, scope.leagueId),
            eq(leagueSeasons.season, scope.season),
          ),
        );
      return memberships.map((membership) => membership.userId);
    };
    return await runDraftReadProvisioner(
      {
        sessionSecret: environment.SESSION_SECRET,
        userId: process.env.DRAFT_READ_USER_ID,
        leagueScopesJson: process.env.DRAFT_READ_LEAGUES,
        lifetimeSeconds: process.env.DRAFT_READ_TTL_SECONDS,
        tokenFile: process.env.DRAFT_READ_TOKEN_FILE,
      },
      {
        resolveUniqueUserForScopes: async (scopes) => {
          let candidates: Set<string> | undefined;
          for (const scope of scopes) {
            const activeUsers = new Set(await activeMembershipUsers(scope));
            candidates =
              candidates === undefined
                ? activeUsers
                : new Set([...candidates].filter((userId) => activeUsers.has(userId)));
            if (candidates.size === 0) return undefined;
          }
          return candidates?.size === 1 ? [...candidates][0] : undefined;
        },
        membershipIsActive: async (userId, scope) => {
          return (await activeMembershipUsers(scope)).includes(userId);
        },
        writeCredentialFile: writeNewPrivateDraftReadFile,
      },
      {
        stdout: (text) => process.stdout.write(text),
        stderr: (text) => process.stderr.write(text),
      },
    );
  } catch {
    // Startup/configuration failures use the same fixed redacted message as provisioning errors.
    process.stderr.write("DraftRead capability provisioning failed.\n");
    return 1;
  } finally {
    await database?.close().catch(() => undefined);
  }
}

process.exitCode = await main();
