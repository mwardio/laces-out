import { createHmac, randomBytes, timingSafeEqual } from "node:crypto";

import type { ApplicationRole } from "@fantasy/db";

import {
  hashOwnerPassword,
  hashSessionToken,
  sessionLifetimeSeconds,
  type LoginResult,
} from "./auth.js";

const minimumInviteCodeLength = 12;
const maximumInviteCodeLength = 128;

export interface RegisteredUserRecord {
  readonly id: string;
  readonly email: string;
  readonly displayName: string;
  readonly role: ApplicationRole;
}

/**
 * Persistence boundary for shared-code registration. Implementations must insert
 * the member and its initial session in the same transaction. A unique-email
 * conflict is deliberately represented only as `undefined`.
 */
export interface RegistrationRepository {
  createMemberWithSession(input: {
    readonly email: string;
    readonly displayName: string;
    readonly passwordHash: string;
    readonly tokenHash: string;
    readonly expiresAt: Date;
  }): Promise<RegisteredUserRecord | undefined>;
}

function normalizeInviteCode(value: string): string | undefined {
  const normalized = value.normalize("NFKC").trim();
  const hasControlCharacter = [...normalized].some((character) => {
    const codePoint = character.codePointAt(0) ?? 0;
    return codePoint <= 31 || codePoint === 127;
  });
  if (
    normalized.length < minimumInviteCodeLength ||
    normalized.length > maximumInviteCodeLength ||
    hasControlCharacter
  ) {
    return undefined;
  }
  return normalized;
}

function normalizeEmail(value: string): string | undefined {
  const email = value.normalize("NFKC").trim().toLowerCase();
  if (email.length < 3 || email.length > 254 || /\s/u.test(email)) return undefined;
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
    return undefined;
  }
  return email;
}

function normalizeDisplayName(value: string): string | undefined {
  const displayName = value.normalize("NFKC").trim().replace(/\s+/gu, " ");
  if (displayName.length < 1 || displayName.length > 100) return undefined;
  const hasControlCharacter = [...displayName].some((character) => {
    const codePoint = character.codePointAt(0) ?? 0;
    return codePoint <= 31 || codePoint === 127;
  });
  return hasControlCharacter ? undefined : displayName;
}

function deriveInviteCodeKey(rootSecret: Uint8Array | string): Buffer {
  const secret = typeof rootSecret === "string" ? Buffer.from(rootSecret, "utf8") : rootSecret;
  if (secret.byteLength < 32) {
    throw new RangeError("Registration root secret must contain at least 32 bytes");
  }
  return createHmac("sha256", secret).update("laces-out/registration-invite/v1", "utf8").digest();
}

function digestInviteCode(code: string, key: Uint8Array): Buffer {
  return createHmac("sha256", key).update(code, "utf8").digest();
}

export interface RegistrationServiceOptions {
  readonly now?: () => Date;
  readonly tokenFactory?: () => string;
}

/**
 * Creates member accounts in either open or shared-code mode. In shared-code mode, only a keyed
 * digest remains on this instance after construction; the code itself is never persisted.
 */
export class RegistrationService {
  readonly #repository: RegistrationRepository;
  readonly #inviteCodeKey: Buffer | undefined;
  readonly #expectedInviteCodeDigest: Buffer | undefined;
  readonly #now: () => Date;
  readonly #tokenFactory: () => string;

  constructor(
    repository: RegistrationRepository,
    rootSecret: Uint8Array | string,
    inviteCode: string | undefined,
    options: RegistrationServiceOptions = {},
  ) {
    const normalizedInviteCode =
      inviteCode === undefined ? undefined : normalizeInviteCode(inviteCode);
    if (inviteCode !== undefined && !normalizedInviteCode) {
      throw new RangeError(
        `Registration invite code must be ${minimumInviteCodeLength}-${maximumInviteCodeLength} characters without controls`,
      );
    }
    this.#repository = repository;
    if (normalizedInviteCode) {
      this.#inviteCodeKey = deriveInviteCodeKey(rootSecret);
      this.#expectedInviteCodeDigest = digestInviteCode(normalizedInviteCode, this.#inviteCodeKey);
    }
    this.#now = options.now ?? (() => new Date());
    this.#tokenFactory = options.tokenFactory ?? (() => randomBytes(32).toString("base64url"));
  }

  async register(input: {
    readonly inviteCode?: string;
    readonly email: string;
    readonly displayName: string;
    readonly password: string;
  }): Promise<LoginResult | undefined> {
    const expectedInviteCodeDigest = this.#expectedInviteCodeDigest;
    const inviteCodeKey = this.#inviteCodeKey;
    const inviteCodeIsValid =
      !expectedInviteCodeDigest || !inviteCodeKey
        ? true
        : timingSafeEqual(
            // HMAC output has a fixed length, so timingSafeEqual never falls back to a
            // length-dependent branch. Invalid shapes are represented by a sentinel.
            digestInviteCode(
              input.inviteCode === undefined
                ? "\u0000invalid-registration-code"
                : (normalizeInviteCode(input.inviteCode) ?? "\u0000invalid-registration-code"),
              inviteCodeKey,
            ),
            expectedInviteCodeDigest,
          );
    const email = normalizeEmail(input.email);
    const displayName = normalizeDisplayName(input.displayName);
    // Hash every well-formed request before applying the generic rejection so
    // response timing does not become a practical valid-code oracle.
    let passwordHash: string;
    try {
      passwordHash = await hashOwnerPassword(input.password);
    } catch (error) {
      if (error instanceof RangeError) return undefined;
      throw error;
    }
    if (!inviteCodeIsValid || !email || !displayName) return undefined;

    const now = this.#now();
    const expiresAt = new Date(now.getTime() + sessionLifetimeSeconds * 1000);
    const token = this.#tokenFactory();
    if (!/^[A-Za-z0-9_-]{43}$/u.test(token)) {
      throw new Error("Registration token factory must return 32 random bytes as base64url");
    }
    const user = await this.#repository.createMemberWithSession({
      email,
      displayName,
      passwordHash,
      tokenHash: hashSessionToken(token),
      expiresAt,
    });
    if (!user) return undefined;
    return { token, expiresAt, user };
  }
}
