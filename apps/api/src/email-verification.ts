import { randomBytes } from "node:crypto";

import { hashSessionToken } from "./auth.js";

export const emailVerificationTokenLifetimeHours = 24;
export const emailVerificationRequiredCode = "email_verification_required";

export function emailVerificationRequiredProblem(correlationId: string) {
  return {
    type: "https://fantasy.local/problems/email-verification-required",
    title: "Email confirmation required",
    status: 403,
    code: emailVerificationRequiredCode,
    detail: "Check your email to confirm your account, then return to the sign-in screen.",
    correlationId,
  } as const;
}

const tokenShape = /^[A-Za-z0-9_-]{43}$/u;

export interface PendingVerificationUserRecord {
  readonly id: string;
  readonly email: string;
  readonly displayName: string;
}

/**
 * Persistence boundary for email confirmation. `redeemToken` must be atomic: marking the account
 * verified and consuming the token either both happen or neither does.
 */
export interface EmailVerificationRepository {
  redeemToken(input: {
    readonly tokenHash: string;
    readonly now: Date;
  }): Promise<{ readonly userId: string } | undefined>;
  findUnverifiedUserByEmail(email: string): Promise<PendingVerificationUserRecord | undefined>;
  /** Stores the new token hash and invalidates any previous unused link for the account. */
  replaceOutstandingToken(input: {
    readonly userId: string;
    readonly tokenHash: string;
    readonly expiresAt: Date;
    readonly createdAt: Date;
  }): Promise<void>;
}

export interface EmailConfirmationDelivery {
  sendConfirmationEmail(input: {
    readonly email: string;
    readonly displayName: string;
    readonly confirmUrl: string;
    readonly expiresHours: number;
  }): Promise<void>;
}

export function buildConfirmUrl(webUrl: string, token: string): string {
  // Keep bearer material in the fragment: browsers do not send it to Caddy, Next, or analytics.
  return `${webUrl.replace(/\/+$/u, "")}/verify-email#${encodeURIComponent(token)}`;
}

export interface EmailVerificationServiceOptions {
  readonly repository: EmailVerificationRepository;
  readonly delivery: EmailConfirmationDelivery;
  /** Canonical web origin; the emailed link always lands on it. */
  readonly webUrl: string;
  readonly now?: () => Date;
  readonly tokenFactory?: () => string;
}

export class EmailVerificationService {
  readonly #repository: EmailVerificationRepository;
  readonly #delivery: EmailConfirmationDelivery;
  readonly #webUrl: string;
  readonly #now: () => Date;
  readonly #tokenFactory: () => string;

  constructor(options: EmailVerificationServiceOptions) {
    this.#repository = options.repository;
    this.#delivery = options.delivery;
    this.#webUrl = options.webUrl;
    this.#now = options.now ?? (() => new Date());
    this.#tokenFactory = options.tokenFactory ?? (() => randomBytes(32).toString("base64url"));
  }

  /**
   * Consumes a live confirmation link and reports which account it activated. Confirmation does
   * not issue a session; every client returns to the normal password sign-in flow.
   */
  async verifyEmail(token: string): Promise<{ readonly userId: string } | undefined> {
    if (!tokenShape.test(token)) return undefined;
    return this.#repository.redeemToken({
      tokenHash: hashSessionToken(token),
      now: this.#now(),
    });
  }

  /**
   * Resolves identically for unknown, already-verified, and pending addresses; the route answers
   * before calling this, so neither the body nor its timing discloses account state.
   */
  async requestResend(emailInput: string): Promise<void> {
    const email = emailInput.normalize("NFKC").trim().toLowerCase();
    if (email.length < 3 || email.length > 254 || !email.includes("@") || /\s/u.test(email)) {
      return;
    }
    const user = await this.#repository.findUnverifiedUserByEmail(email);
    if (!user) return;

    const token = this.#tokenFactory();
    if (!tokenShape.test(token)) {
      throw new Error("Email verification token factory must return 32 random bytes as base64url");
    }
    const now = this.#now();
    await this.#repository.replaceOutstandingToken({
      userId: user.id,
      tokenHash: hashSessionToken(token),
      expiresAt: new Date(now.getTime() + emailVerificationTokenLifetimeHours * 60 * 60 * 1000),
      createdAt: now,
    });
    await this.#delivery.sendConfirmationEmail({
      email: user.email,
      displayName: user.displayName,
      confirmUrl: buildConfirmUrl(this.#webUrl, token),
      expiresHours: emailVerificationTokenLifetimeHours,
    });
  }
}
