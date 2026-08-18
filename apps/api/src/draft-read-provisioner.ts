import {
  DRAFT_READ_TOKEN_LIMITS,
  draftReadLeagueScopeSchema,
  type DraftReadLeagueScope,
} from "@laces-out/contracts";
import { open, unlink } from "node:fs/promises";
import type { FileHandle } from "node:fs/promises";
import { isAbsolute } from "node:path";
import { z } from "zod";

import { mintDraftReadToken } from "./draft-read.js";

const safeFailureMessage = "DraftRead capability provisioning failed.\n";

export interface DraftReadProvisioningInput {
  readonly sessionSecret: string | undefined;
  readonly userId: string | undefined;
  readonly leagueScopesJson: string | undefined;
  readonly lifetimeSeconds: string | undefined;
  readonly tokenFile: string | undefined;
}

export interface DraftReadProvisioningDependencies {
  readonly resolveUniqueUserForScopes?: (
    scopes: readonly DraftReadLeagueScope[],
  ) => Promise<string | undefined>;
  readonly membershipIsActive: (userId: string, scope: DraftReadLeagueScope) => Promise<boolean>;
  readonly writeCredentialFile: (absolutePath: string, token: string) => Promise<void>;
  readonly now?: Date;
}

export interface DraftReadProvisioningIo {
  readonly stdout: (text: string) => void;
  readonly stderr: (text: string) => void;
}

export class DraftReadProvisioningError extends Error {
  constructor() {
    super(safeFailureMessage.trim());
    this.name = "DraftReadProvisioningError";
  }
}

/** Creates a new credential file without following or replacing an existing path. */
export async function writeNewPrivateDraftReadFile(
  absolutePath: string,
  token: string,
): Promise<void> {
  if (!isAbsolute(absolutePath)) throw new DraftReadProvisioningError();
  let handle: FileHandle | undefined;
  try {
    handle = await open(absolutePath, "wx", 0o600);
    await handle.writeFile(`${token}\n`, { encoding: "utf8" });
  } catch {
    if (handle) {
      await handle.close().catch(() => undefined);
      await unlink(absolutePath).catch(() => undefined);
    }
    throw new DraftReadProvisioningError();
  }
  await handle.close().catch(async () => {
    await unlink(absolutePath).catch(() => undefined);
    throw new DraftReadProvisioningError();
  });
}

async function provisionDraftReadCapability(
  input: DraftReadProvisioningInput,
  dependencies: DraftReadProvisioningDependencies,
): Promise<Date> {
  try {
    const sessionSecret = z.string().min(32).parse(input.sessionSecret);
    const tokenFile = z.string().trim().min(1).parse(input.tokenFile);
    if (!isAbsolute(tokenFile)) throw new DraftReadProvisioningError();

    const untrustedScopes: unknown = JSON.parse(input.leagueScopesJson ?? "");
    const leagueScopes = z
      .array(draftReadLeagueScopeSchema)
      .min(1)
      .max(DRAFT_READ_TOKEN_LIMITS.maximumLeagueScopes)
      .parse(untrustedScopes);
    const uniqueScopes = new Set(
      leagueScopes.map((scope) => `${scope.leagueId}\u0000${scope.season}`),
    );
    if (uniqueScopes.size !== leagueScopes.length) throw new DraftReadProvisioningError();
    const lifetimeSeconds = z.coerce
      .number()
      .int()
      .min(1)
      .max(DRAFT_READ_TOKEN_LIMITS.maximumLifetimeSeconds)
      .default(3_600)
      .parse(input.lifetimeSeconds);
    const suppliedUserId = input.userId?.trim();
    const resolvedUserId = suppliedUserId
      ? suppliedUserId
      : await dependencies.resolveUniqueUserForScopes?.(leagueScopes);
    const userId = z.string().uuid().parse(resolvedUserId);

    for (const scope of leagueScopes) {
      if (!(await dependencies.membershipIsActive(userId, scope))) {
        throw new DraftReadProvisioningError();
      }
    }

    const capability = mintDraftReadToken({
      sessionSecret,
      userId,
      leagues: leagueScopes,
      lifetimeSeconds,
      ...(dependencies.now ? { now: dependencies.now } : {}),
    });
    await dependencies.writeCredentialFile(tokenFile, capability.token);
    return capability.expiresAt;
  } catch {
    // No parser, database, or filesystem detail may echo a secret or local identifier.
    throw new DraftReadProvisioningError();
  }
}

/** Runs the provisioner through fixed output messages suitable for a one-shot CLI. */
export async function runDraftReadProvisioner(
  input: DraftReadProvisioningInput,
  dependencies: DraftReadProvisioningDependencies,
  io: DraftReadProvisioningIo,
): Promise<number> {
  try {
    const expiresAt = await provisionDraftReadCapability(input, dependencies);
    io.stdout(`DraftRead capability written; expires ${expiresAt.toISOString()}.\n`);
    return 0;
  } catch {
    io.stderr(safeFailureMessage);
    return 1;
  }
}
