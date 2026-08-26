import { createHmac, randomBytes } from "node:crypto";

import type { ApplicationRole, LeagueMembershipRole } from "@laces-out/db";

import { hashOwnerPassword, hashSessionToken } from "./auth.js";
import {
  buildConfirmUrl,
  emailVerificationTokenLifetimeHours,
  type EmailConfirmationDelivery,
} from "./email-verification.js";

const invitationTokenBytes = 32;
const invitationTokenPattern = /^[A-Za-z0-9_-]{43}$/;
const uuidPattern = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const defaultLifetimeMilliseconds = 7 * 24 * 60 * 60 * 1000;
const minimumLifetimeMilliseconds = 15 * 60 * 1000;
const maximumLifetimeMilliseconds = 30 * 24 * 60 * 60 * 1000;

export type InvitableLeagueRole = Exclude<LeagueMembershipRole, "owner">;

export interface InvitationKeyring {
  readonly tokenHmacKey: Uint8Array;
  readonly emailHmacKey: Uint8Array;
}

export interface InvitationScope {
  readonly leagueId: string;
  readonly leagueRole: InvitableLeagueRole;
}

export interface PendingInvitationRecord {
  readonly id: string;
  readonly email: string;
  readonly invitedByUserId: string;
  readonly role: ApplicationRole;
  readonly leagueId: string | null;
  readonly leagueName: string | null;
  readonly leagueRole: InvitableLeagueRole | null;
  readonly existingUserId: string | null;
  readonly expiresAt: Date;
}

export type CreateInvitationRepositoryResult =
  | { readonly status: "created"; readonly invitation: PendingInvitationRecord }
  | { readonly status: "forbidden" }
  | { readonly status: "scope_not_found" }
  | { readonly status: "token_conflict" };

export type InvitationAcceptanceIdentity =
  | {
      readonly kind: "new_user";
      readonly displayName: string;
      readonly passwordHash: string;
      readonly verification?: {
        readonly tokenHash: string;
        readonly expiresAt: Date;
      };
    }
  | { readonly kind: "existing_user"; readonly userId: string };

export interface AcceptedInvitationRecord {
  readonly invitationId: string;
  readonly user: {
    readonly id: string;
    readonly email: string;
    readonly displayName: string;
  };
  readonly createdUser: boolean;
  readonly verificationRequired: boolean;
  readonly membership: {
    readonly leagueId: string;
    readonly role: LeagueMembershipRole;
    /** Internal authority source; never serialized as a public response field. */
    readonly explicitCommissioner: boolean;
  } | null;
}

export type AcceptInvitationRepositoryResult =
  | { readonly status: "accepted"; readonly acceptance: AcceptedInvitationRecord }
  | { readonly status: "unavailable" }
  | { readonly status: "identity_conflict" };

export type RevokeInvitationRepositoryResult =
  | { readonly status: "revoked"; readonly invitationId: string }
  | { readonly status: "forbidden" }
  | { readonly status: "unavailable" };

/**
 * Persistence boundary for invitation operations. Implementations must make each
 * mutation atomic; in particular, `accept` must lock or conditionally consume the
 * invite before committing any user or membership changes.
 */
export interface InvitationRepository {
  create(input: {
    readonly invitedByUserId: string;
    readonly tokenHash: string;
    readonly email: string;
    readonly emailHash: string;
    readonly role: ApplicationRole;
    readonly leagueId: string | null;
    readonly leagueRole: InvitableLeagueRole | null;
    readonly expiresAt: Date;
    readonly now: Date;
  }): Promise<CreateInvitationRepositoryResult>;

  findActiveByTokenHash(tokenHash: string, now: Date): Promise<PendingInvitationRecord | undefined>;

  accept(input: {
    readonly tokenHash: string;
    readonly identity: InvitationAcceptanceIdentity;
    readonly now: Date;
  }): Promise<AcceptInvitationRepositoryResult>;

  revoke(input: {
    readonly invitationId: string;
    readonly revokedByUserId: string;
    readonly now: Date;
  }): Promise<RevokeInvitationRepositoryResult>;
}

export type InvitationErrorCode =
  | "INVITATION_INVALID_INPUT"
  | "INVITATION_FORBIDDEN"
  | "INVITATION_UNAVAILABLE"
  | "INVITATION_AUTHENTICATION_REQUIRED"
  | "INVITATION_ACCOUNT_MISMATCH"
  | "INVITATION_STATE_CHANGED";

const safeErrorDetails: Record<
  InvitationErrorCode,
  { readonly statusCode: number; readonly message: string }
> = {
  INVITATION_INVALID_INPUT: {
    statusCode: 400,
    message: "The invitation request is invalid.",
  },
  INVITATION_FORBIDDEN: {
    statusCode: 403,
    message: "You are not allowed to manage invitations.",
  },
  INVITATION_UNAVAILABLE: {
    statusCode: 404,
    message: "This invitation is unavailable.",
  },
  INVITATION_AUTHENTICATION_REQUIRED: {
    statusCode: 401,
    message: "Sign in to the invited account before accepting this invitation.",
  },
  INVITATION_ACCOUNT_MISMATCH: {
    statusCode: 409,
    message: "This invitation belongs to a different account.",
  },
  INVITATION_STATE_CHANGED: {
    statusCode: 409,
    message: "The invitation changed while it was being accepted. Please try again.",
  },
};

/** A route-safe error that deliberately excludes email addresses and token material. */
export class InvitationError extends Error {
  readonly code: InvitationErrorCode;
  readonly statusCode: number;

  constructor(code: InvitationErrorCode) {
    const detail = safeErrorDetails[code];
    super(detail.message);
    this.name = "InvitationError";
    this.code = code;
    this.statusCode = detail.statusCode;
  }
}

export interface CreateInvitationInput {
  readonly invitedByUserId: string;
  readonly email: string;
  readonly role?: ApplicationRole;
  readonly scope?: InvitationScope;
  readonly expiresAt?: Date;
}

export interface CreatedInvitation {
  readonly id: string;
  /** Returned exactly once. Callers must send it to the invitee and never log it. */
  readonly token: string;
  readonly email: string;
  readonly role: ApplicationRole;
  readonly scope: InvitationScope | null;
  readonly expiresAt: Date;
}

export interface InvitationInspection {
  readonly id: string;
  readonly emailHint: string;
  readonly role: ApplicationRole;
  readonly scope: (InvitationScope & { readonly leagueName: string | null }) | null;
  readonly expiresAt: Date;
  readonly requiresAuthentication: boolean;
}

export interface AcceptInvitationInput {
  readonly token: string;
  /** Present when a browser session has already authenticated an existing user. */
  readonly authenticatedUserId?: string;
  /** Required only when the invitation creates a new account. */
  readonly displayName?: string;
  /** Required only when the invitation creates a new account. */
  readonly password?: string;
}

export interface InvitationServiceOptions {
  readonly now?: () => Date;
  readonly tokenFactory?: () => string;
  readonly confirmation?: {
    readonly delivery: EmailConfirmationDelivery;
    readonly webUrl: string;
    readonly tokenFactory?: () => string;
    readonly onDeliveryError?: (error: unknown) => void;
  };
}

/**
 * Derives independent token and email HMAC keys from one deployment secret.
 * The input must be stable for at least as long as the longest-lived invitation.
 */
export function deriveInvitationKeyring(rootSecret: Uint8Array | string): InvitationKeyring {
  const secret = typeof rootSecret === "string" ? Buffer.from(rootSecret, "utf8") : rootSecret;
  if (secret.byteLength < 32) {
    throw new RangeError("Invitation root secret must contain at least 32 bytes");
  }
  return {
    tokenHmacKey: createHmac("sha256", secret)
      .update("laces-out/invitation-token/v1", "utf8")
      .digest(),
    emailHmacKey: createHmac("sha256", secret)
      .update("laces-out/invitation-email/v1", "utf8")
      .digest(),
  };
}

export function normalizeInvitationEmail(value: string): string {
  const email = value.normalize("NFKC").trim().toLowerCase();
  const hasControlCharacter = [...email].some((character) => {
    const codePoint = character.codePointAt(0) ?? 0;
    return codePoint <= 31 || codePoint === 127;
  });
  if (email.length < 3 || email.length > 254 || /\s/u.test(email) || hasControlCharacter) {
    throw new InvitationError("INVITATION_INVALID_INPUT");
  }
  const at = email.indexOf("@");
  if (
    at < 1 ||
    at !== email.lastIndexOf("@") ||
    at > 64 ||
    at === email.length - 1 ||
    email.startsWith(".") ||
    email.slice(0, at).endsWith(".") ||
    email.slice(at + 1).startsWith(".") ||
    email.endsWith(".")
  ) {
    throw new InvitationError("INVITATION_INVALID_INPUT");
  }
  return email;
}

export function hashInvitationToken(token: string, keyring: InvitationKeyring): string {
  return createHmac("sha256", keyring.tokenHmacKey).update(token, "utf8").digest("base64url");
}

export function hashInvitationEmail(email: string, keyring: InvitationKeyring): string {
  return createHmac("sha256", keyring.emailHmacKey)
    .update(normalizeInvitationEmail(email), "utf8")
    .digest("base64url");
}

function assertToken(token: string): void {
  if (!invitationTokenPattern.test(token)) {
    throw new InvitationError("INVITATION_UNAVAILABLE");
  }
}

function assertIdentifier(identifier: string): void {
  if (!uuidPattern.test(identifier)) {
    throw new InvitationError("INVITATION_INVALID_INPUT");
  }
}

function normalizeDisplayName(value: string): string {
  const displayName = value.normalize("NFKC").trim().replace(/\s+/gu, " ");
  if (displayName.length < 1 || displayName.length > 100) {
    throw new InvitationError("INVITATION_INVALID_INPUT");
  }
  return displayName;
}

function emailHint(email: string): string {
  const [local = "", domain = ""] = email.split("@");
  const visible = local.slice(0, 1);
  return `${visible}${"*".repeat(Math.min(Math.max(local.length - 1, 3), 8))}@${domain}`;
}

function scopeFromRecord(record: PendingInvitationRecord): InvitationScope | null {
  if (!record.leagueId || !record.leagueRole) return null;
  return { leagueId: record.leagueId, leagueRole: record.leagueRole };
}

export class InvitationService {
  readonly #repository: InvitationRepository;
  readonly #keyring: InvitationKeyring;
  readonly #now: () => Date;
  readonly #tokenFactory: () => string;
  readonly #confirmation: InvitationServiceOptions["confirmation"];

  constructor(
    repository: InvitationRepository,
    keyring: InvitationKeyring,
    options: InvitationServiceOptions = {},
  ) {
    if (keyring.tokenHmacKey.byteLength < 32 || keyring.emailHmacKey.byteLength < 32) {
      throw new RangeError("Invitation HMAC keys must contain at least 32 bytes");
    }
    this.#repository = repository;
    this.#keyring = keyring;
    this.#now = options.now ?? (() => new Date());
    this.#tokenFactory =
      options.tokenFactory ?? (() => randomBytes(invitationTokenBytes).toString("base64url"));
    this.#confirmation = options.confirmation;
  }

  async create(input: CreateInvitationInput): Promise<CreatedInvitation> {
    assertIdentifier(input.invitedByUserId);
    const email = normalizeInvitationEmail(input.email);
    const now = this.#now();
    const expiresAt = input.expiresAt ?? new Date(now.getTime() + defaultLifetimeMilliseconds);
    const lifetime = expiresAt.getTime() - now.getTime();
    if (
      !Number.isFinite(expiresAt.getTime()) ||
      lifetime < minimumLifetimeMilliseconds ||
      lifetime > maximumLifetimeMilliseconds
    ) {
      throw new InvitationError("INVITATION_INVALID_INPUT");
    }
    if (input.scope) {
      assertIdentifier(input.scope.leagueId);
      if (!(["commissioner", "member"] as const).includes(input.scope.leagueRole)) {
        throw new InvitationError("INVITATION_INVALID_INPUT");
      }
    }
    const role = input.role ?? "member";
    if (role !== "member" && role !== "admin") {
      throw new InvitationError("INVITATION_INVALID_INPUT");
    }

    // A collision is cryptographically implausible, but retrying keeps the service
    // correct even with an injected deterministic token factory in tests.
    for (let attempt = 0; attempt < 3; attempt += 1) {
      const token = this.#tokenFactory();
      if (!invitationTokenPattern.test(token)) {
        throw new Error("Invitation token factory must return 32 random bytes as base64url");
      }
      const result = await this.#repository.create({
        invitedByUserId: input.invitedByUserId,
        tokenHash: hashInvitationToken(token, this.#keyring),
        email,
        emailHash: hashInvitationEmail(email, this.#keyring),
        role,
        leagueId: input.scope?.leagueId ?? null,
        leagueRole: input.scope?.leagueRole ?? null,
        expiresAt,
        now,
      });
      if (result.status === "token_conflict") continue;
      if (result.status === "forbidden") {
        throw new InvitationError("INVITATION_FORBIDDEN");
      }
      if (result.status === "scope_not_found") {
        throw new InvitationError("INVITATION_INVALID_INPUT");
      }
      return {
        id: result.invitation.id,
        token,
        email,
        role,
        scope: scopeFromRecord(result.invitation),
        expiresAt: result.invitation.expiresAt,
      };
    }
    throw new Error("Unable to allocate a unique invitation token");
  }

  async inspect(token: string): Promise<InvitationInspection> {
    assertToken(token);
    const invitation = await this.#repository.findActiveByTokenHash(
      hashInvitationToken(token, this.#keyring),
      this.#now(),
    );
    if (!invitation) throw new InvitationError("INVITATION_UNAVAILABLE");
    return {
      id: invitation.id,
      emailHint: emailHint(invitation.email),
      role: invitation.role,
      scope:
        invitation.leagueId && invitation.leagueRole
          ? {
              leagueId: invitation.leagueId,
              leagueRole: invitation.leagueRole,
              leagueName: invitation.leagueName,
            }
          : null,
      expiresAt: invitation.expiresAt,
      requiresAuthentication: invitation.existingUserId !== null,
    };
  }

  async accept(input: AcceptInvitationInput): Promise<AcceptedInvitationRecord> {
    assertToken(input.token);
    if (input.authenticatedUserId) assertIdentifier(input.authenticatedUserId);
    const tokenHash = hashInvitationToken(input.token, this.#keyring);
    const now = this.#now();
    const invitation = await this.#repository.findActiveByTokenHash(tokenHash, now);
    if (!invitation) throw new InvitationError("INVITATION_UNAVAILABLE");

    let identity: InvitationAcceptanceIdentity;
    let rawVerificationToken: string | undefined;
    if (invitation.existingUserId) {
      if (!input.authenticatedUserId) {
        throw new InvitationError("INVITATION_AUTHENTICATION_REQUIRED");
      }
      if (input.authenticatedUserId !== invitation.existingUserId) {
        throw new InvitationError("INVITATION_ACCOUNT_MISMATCH");
      }
      identity = { kind: "existing_user", userId: input.authenticatedUserId };
    } else {
      // A signed-in user must never silently create a second account for an invite
      // addressed to a different email.
      if (input.authenticatedUserId) {
        throw new InvitationError("INVITATION_ACCOUNT_MISMATCH");
      }
      if (!input.displayName || !input.password) {
        throw new InvitationError("INVITATION_INVALID_INPUT");
      }
      const displayName = normalizeDisplayName(input.displayName);
      let passwordHash: string;
      try {
        passwordHash = await hashOwnerPassword(input.password);
      } catch (error) {
        if (error instanceof RangeError) {
          throw new InvitationError("INVITATION_INVALID_INPUT");
        }
        throw error;
      }
      const confirmation = this.#confirmation;
      if (confirmation) {
        rawVerificationToken =
          confirmation.tokenFactory?.() ?? randomBytes(invitationTokenBytes).toString("base64url");
        if (!invitationTokenPattern.test(rawVerificationToken)) {
          throw new Error(
            "Email verification token factory must return 32 random bytes as base64url",
          );
        }
      }
      identity = {
        kind: "new_user",
        displayName,
        passwordHash,
        ...(rawVerificationToken
          ? {
              verification: {
                tokenHash: hashSessionToken(rawVerificationToken),
                expiresAt: new Date(
                  now.getTime() + emailVerificationTokenLifetimeHours * 60 * 60 * 1000,
                ),
              },
            }
          : {}),
      };
    }

    const result = await this.#repository.accept({ tokenHash, identity, now });
    if (result.status === "unavailable") {
      throw new InvitationError("INVITATION_UNAVAILABLE");
    }
    if (result.status === "identity_conflict") {
      throw new InvitationError("INVITATION_STATE_CHANGED");
    }
    const acceptance = result.acceptance;
    if (acceptance.verificationRequired && rawVerificationToken && this.#confirmation) {
      try {
        await this.#confirmation.delivery.sendConfirmationEmail({
          email: acceptance.user.email,
          displayName: acceptance.user.displayName,
          confirmUrl: buildConfirmUrl(this.#confirmation.webUrl, rawVerificationToken),
          expiresHours: emailVerificationTokenLifetimeHours,
        });
      } catch (error) {
        // The accepted invitation, account, membership, and token remain recoverable via resend.
        this.#confirmation.onDeliveryError?.(error);
      }
    }
    return acceptance;
  }

  async revoke(revokedByUserId: string, invitationId: string): Promise<{ id: string }> {
    assertIdentifier(revokedByUserId);
    assertIdentifier(invitationId);
    const result = await this.#repository.revoke({
      invitationId,
      revokedByUserId,
      now: this.#now(),
    });
    if (result.status === "forbidden") {
      throw new InvitationError("INVITATION_FORBIDDEN");
    }
    if (result.status === "unavailable") {
      throw new InvitationError("INVITATION_UNAVAILABLE");
    }
    return { id: result.invitationId };
  }
}
