import { randomBytes } from "node:crypto";

import { hashOwnerPassword, hashSessionToken } from "./auth.js";

export const passwordResetTokenLifetimeMinutes = 30;

const tokenShape = /^[A-Za-z0-9_-]{43}$/u;

export interface PasswordResetUserRecord {
  readonly id: string;
  readonly email: string;
  readonly displayName: string;
}

/**
 * Persistence boundary for self-service password reset. Implementations must make `redeemToken`
 * atomic: the password replacement, the used marker, and the session revocation either all happen
 * or none do — a token that changed a password but left sessions alive would be a security hole,
 * not a partial success.
 */
export interface PasswordResetRepository {
  findUserByEmail(email: string): Promise<PasswordResetUserRecord | undefined>;
  /** Stores the new token hash and invalidates any previous unused link for the account. */
  replaceOutstandingToken(input: {
    readonly userId: string;
    readonly tokenHash: string;
    readonly expiresAt: Date;
    readonly createdAt: Date;
  }): Promise<void>;
  redeemToken(input: {
    readonly tokenHash: string;
    readonly newPasswordHash: string;
    readonly now: Date;
  }): Promise<"reset" | "invalid">;
}

export interface PasswordResetEmailDelivery {
  sendPasswordResetEmail(input: {
    readonly email: string;
    readonly displayName: string;
    readonly resetUrl: string;
    readonly expiresMinutes: number;
  }): Promise<void>;
}

export interface PasswordResetServiceOptions {
  readonly repository: PasswordResetRepository;
  readonly delivery: PasswordResetEmailDelivery;
  /** Canonical web origin; the emailed link always lands on it. */
  readonly webUrl: string;
  readonly now?: () => Date;
  readonly tokenFactory?: () => string;
}

export class PasswordResetService {
  readonly #repository: PasswordResetRepository;
  readonly #delivery: PasswordResetEmailDelivery;
  readonly #webUrl: string;
  readonly #now: () => Date;
  readonly #tokenFactory: () => string;

  constructor(options: PasswordResetServiceOptions) {
    this.#repository = options.repository;
    this.#delivery = options.delivery;
    this.#webUrl = options.webUrl.replace(/\/+$/u, "");
    this.#now = options.now ?? (() => new Date());
    this.#tokenFactory = options.tokenFactory ?? (() => randomBytes(32).toString("base64url"));
  }

  /**
   * Resolves identically for known and unknown addresses; the route answers before calling this,
   * so neither the response body nor its timing says whether an account exists.
   */
  async requestReset(emailInput: string): Promise<void> {
    const email = emailInput.normalize("NFKC").trim().toLowerCase();
    if (email.length < 3 || email.length > 254 || !email.includes("@") || /\s/u.test(email)) {
      return;
    }
    const user = await this.#repository.findUserByEmail(email);
    if (!user) return;

    const token = this.#tokenFactory();
    if (!tokenShape.test(token)) {
      throw new Error("Password reset token factory must return 32 random bytes as base64url");
    }
    const now = this.#now();
    const expiresAt = new Date(now.getTime() + passwordResetTokenLifetimeMinutes * 60 * 1000);
    await this.#repository.replaceOutstandingToken({
      userId: user.id,
      tokenHash: hashSessionToken(token),
      expiresAt,
      createdAt: now,
    });
    await this.#delivery.sendPasswordResetEmail({
      email: user.email,
      displayName: user.displayName,
      // Keep bearer material out of proxy, application, and analytics request logs.
      resetUrl: `${this.#webUrl}/reset-password#${encodeURIComponent(token)}`,
      expiresMinutes: passwordResetTokenLifetimeMinutes,
    });
  }

  async resetPassword(token: string, newPassword: string): Promise<"reset" | "invalid"> {
    if (!tokenShape.test(token)) return "invalid";
    let newPasswordHash: string;
    try {
      newPasswordHash = await hashOwnerPassword(newPassword);
    } catch (error) {
      if (error instanceof RangeError) return "invalid";
      throw error;
    }
    return this.#repository.redeemToken({
      tokenHash: hashSessionToken(token),
      newPasswordHash,
      now: this.#now(),
    });
  }
}
