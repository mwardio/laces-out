import { createCipheriv, createDecipheriv, randomBytes as nodeRandomBytes } from "node:crypto";

const ALGORITHM = "aes-256-gcm" as const;
const KEY_BYTES = 32;
const IV_BYTES = 12;
const AUTH_TAG_BYTES = 16;
const MAX_PLAINTEXT_BYTES = 64 * 1024;
const KEY_ID_PATTERN = /^[A-Za-z0-9._-]{1,64}$/u;
const PURPOSE_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:/-]{0,127}$/u;

export interface CredentialKey {
  readonly id: string;
  readonly keyBytes: Uint8Array;
}

export interface CredentialEnvelopeV1 {
  readonly version: 1;
  readonly algorithm: typeof ALGORITHM;
  readonly keyId: string;
  readonly purpose: string;
  readonly createdAt: string;
  readonly iv: string;
  readonly ciphertext: string;
  readonly authTag: string;
}

export type CredentialEnvelope = CredentialEnvelopeV1;

export type CredentialEnvelopeErrorCode =
  | "INVALID_KEY"
  | "INVALID_ENVELOPE"
  | "UNSUPPORTED_VERSION"
  | "UNKNOWN_KEY"
  | "PURPOSE_MISMATCH"
  | "ENCRYPTION_FAILED"
  | "DECRYPTION_FAILED";

export class CredentialEnvelopeError extends Error {
  public readonly code: CredentialEnvelopeErrorCode;

  public constructor(code: CredentialEnvelopeErrorCode, message: string) {
    super(message);
    this.name = "CredentialEnvelopeError";
    this.code = code;
  }
}

export interface ParseCredentialKeyOptions {
  readonly keyId?: string;
}

/**
 * Parse an AES-256 key from an environment-safe, unambiguous representation.
 * Raw passphrases are intentionally rejected; accepted forms are
 * `base64:<value>`, `base64url:<value>`, and `hex:<64 hex characters>`.
 */
export function parseCredentialKey(
  encoded: string,
  options: ParseCredentialKeyOptions = {},
): CredentialKey {
  const keyId = options.keyId ?? "primary";
  if (!KEY_ID_PATTERN.test(keyId)) {
    throw new CredentialEnvelopeError("INVALID_KEY", "Credential key ID is invalid");
  }

  const separator = encoded.indexOf(":");
  if (separator < 1) {
    throw new CredentialEnvelopeError(
      "INVALID_KEY",
      "Credential key must use a base64:, base64url:, or hex: prefix",
    );
  }

  const encoding = encoded.slice(0, separator);
  const value = encoded.slice(separator + 1);
  let decoded: Buffer;

  if (encoding === "hex") {
    if (!/^[0-9a-fA-F]{64}$/u.test(value)) {
      throw new CredentialEnvelopeError(
        "INVALID_KEY",
        "Hex credential keys must contain exactly 64 hexadecimal characters",
      );
    }
    decoded = Buffer.from(value, "hex");
  } else if (encoding === "base64") {
    if (!/^(?:[A-Za-z0-9+/]{4}){10}[A-Za-z0-9+/]{3}=$/u.test(value)) {
      throw new CredentialEnvelopeError(
        "INVALID_KEY",
        "Base64 credential key is not canonical 32-byte base64",
      );
    }
    decoded = Buffer.from(value, "base64");
  } else if (encoding === "base64url") {
    if (!/^[A-Za-z0-9_-]{43}=?$/u.test(value)) {
      throw new CredentialEnvelopeError(
        "INVALID_KEY",
        "Base64url credential key is not canonical 32-byte base64url",
      );
    }
    decoded = Buffer.from(value, "base64url");
  } else {
    throw new CredentialEnvelopeError(
      "INVALID_KEY",
      "Credential key must use a base64:, base64url:, or hex: prefix",
    );
  }

  if (decoded.byteLength !== KEY_BYTES) {
    throw new CredentialEnvelopeError(
      "INVALID_KEY",
      `Credential keys must decode to exactly ${KEY_BYTES} bytes`,
    );
  }

  return Object.freeze({ id: keyId, keyBytes: Uint8Array.from(decoded) });
}

export interface EncryptCredentialOptions {
  readonly purpose: string;
  readonly now?: () => Date;
  readonly randomBytes?: (size: number) => Uint8Array;
}

export interface DecryptCredentialOptions {
  readonly expectedPurpose: string;
}

function assertPurpose(purpose: string): void {
  if (!PURPOSE_PATTERN.test(purpose)) {
    throw new CredentialEnvelopeError("INVALID_ENVELOPE", "Credential purpose is invalid");
  }
}

function toBase64Url(value: Uint8Array): string {
  return Buffer.from(value).toString("base64url");
}

function fromBase64Url(value: string, field: string, expectedLength?: number): Buffer {
  if (!/^[A-Za-z0-9_-]+$/u.test(value)) {
    throw new CredentialEnvelopeError("INVALID_ENVELOPE", `${field} is not base64url`);
  }
  const decoded = Buffer.from(value, "base64url");
  if (decoded.toString("base64url") !== value) {
    throw new CredentialEnvelopeError("INVALID_ENVELOPE", `${field} is not canonical base64url`);
  }
  if (expectedLength !== undefined && decoded.byteLength !== expectedLength) {
    throw new CredentialEnvelopeError(
      "INVALID_ENVELOPE",
      `${field} must decode to ${expectedLength} bytes`,
    );
  }
  return decoded;
}

function envelopeAad(envelope: {
  readonly version: 1;
  readonly algorithm: typeof ALGORITHM;
  readonly keyId: string;
  readonly purpose: string;
  readonly createdAt: string;
}): Buffer {
  // Length-prefixing avoids delimiter ambiguity if a future purpose format expands.
  const fields = [
    String(envelope.version),
    envelope.algorithm,
    envelope.keyId,
    envelope.purpose,
    envelope.createdAt,
  ];
  return Buffer.from(fields.map((field) => `${field.length}:${field}`).join(""), "utf8");
}

export function encryptCredential(
  credential: unknown,
  key: CredentialKey,
  options: EncryptCredentialOptions,
): CredentialEnvelopeV1 {
  assertPurpose(options.purpose);
  if (!KEY_ID_PATTERN.test(key.id) || key.keyBytes.byteLength !== KEY_BYTES) {
    throw new CredentialEnvelopeError("INVALID_KEY", "Credential key is not AES-256 material");
  }

  let plaintext: Buffer;
  try {
    const serialized = JSON.stringify(credential);
    if (serialized === undefined) {
      throw new TypeError("Credential is not JSON serializable");
    }
    plaintext = Buffer.from(serialized, "utf8");
  } catch {
    throw new CredentialEnvelopeError(
      "ENCRYPTION_FAILED",
      "Credential could not be serialized for encryption",
    );
  }

  if (plaintext.byteLength > MAX_PLAINTEXT_BYTES) {
    throw new CredentialEnvelopeError(
      "ENCRYPTION_FAILED",
      `Credential plaintext exceeds ${MAX_PLAINTEXT_BYTES} bytes`,
    );
  }

  const iv = Buffer.from((options.randomBytes ?? nodeRandomBytes)(IV_BYTES));
  if (iv.byteLength !== IV_BYTES) {
    throw new CredentialEnvelopeError(
      "ENCRYPTION_FAILED",
      `Credential IV source must return exactly ${IV_BYTES} bytes`,
    );
  }

  const createdAt = (options.now ?? (() => new Date()))().toISOString();
  const authenticatedFields = {
    version: 1 as const,
    algorithm: ALGORITHM,
    keyId: key.id,
    purpose: options.purpose,
    createdAt,
  };

  try {
    const cipher = createCipheriv(ALGORITHM, key.keyBytes, iv, {
      authTagLength: AUTH_TAG_BYTES,
    });
    cipher.setAAD(envelopeAad(authenticatedFields));
    const ciphertext = Buffer.concat([cipher.update(plaintext), cipher.final()]);
    const authTag = cipher.getAuthTag();

    return Object.freeze({
      ...authenticatedFields,
      iv: toBase64Url(iv),
      ciphertext: toBase64Url(ciphertext),
      authTag: toBase64Url(authTag),
    });
  } catch (error) {
    if (error instanceof CredentialEnvelopeError) throw error;
    throw new CredentialEnvelopeError("ENCRYPTION_FAILED", "Credential encryption failed");
  } finally {
    plaintext.fill(0);
  }
}

function parseEnvelope(value: unknown): CredentialEnvelopeV1 {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new CredentialEnvelopeError("INVALID_ENVELOPE", "Credential envelope must be an object");
  }
  const candidate = value as Record<string, unknown>;
  const allowedFields = new Set([
    "version",
    "algorithm",
    "keyId",
    "purpose",
    "createdAt",
    "iv",
    "ciphertext",
    "authTag",
  ]);
  if (Object.keys(candidate).some((field) => !allowedFields.has(field))) {
    throw new CredentialEnvelopeError(
      "INVALID_ENVELOPE",
      "Credential envelope contains unknown fields",
    );
  }

  if (candidate.version !== 1) {
    throw new CredentialEnvelopeError(
      "UNSUPPORTED_VERSION",
      "Credential envelope version is not supported",
    );
  }
  if (
    candidate.algorithm !== ALGORITHM ||
    typeof candidate.keyId !== "string" ||
    !KEY_ID_PATTERN.test(candidate.keyId) ||
    typeof candidate.purpose !== "string" ||
    !PURPOSE_PATTERN.test(candidate.purpose) ||
    typeof candidate.createdAt !== "string" ||
    !Number.isFinite(Date.parse(candidate.createdAt)) ||
    new Date(candidate.createdAt).toISOString() !== candidate.createdAt ||
    typeof candidate.iv !== "string" ||
    typeof candidate.ciphertext !== "string" ||
    typeof candidate.authTag !== "string"
  ) {
    throw new CredentialEnvelopeError("INVALID_ENVELOPE", "Credential envelope is malformed");
  }

  fromBase64Url(candidate.iv, "iv", IV_BYTES);
  const ciphertext = fromBase64Url(candidate.ciphertext, "ciphertext");
  if (ciphertext.byteLength > MAX_PLAINTEXT_BYTES + AUTH_TAG_BYTES) {
    throw new CredentialEnvelopeError("INVALID_ENVELOPE", "Credential ciphertext is too large");
  }
  fromBase64Url(candidate.authTag, "authTag", AUTH_TAG_BYTES);

  return {
    version: 1,
    algorithm: ALGORITHM,
    keyId: candidate.keyId,
    purpose: candidate.purpose,
    createdAt: candidate.createdAt,
    iv: candidate.iv,
    ciphertext: candidate.ciphertext,
    authTag: candidate.authTag,
  };
}

function findKey(
  keyring: CredentialKey | readonly CredentialKey[] | ReadonlyMap<string, CredentialKey>,
  keyId: string,
): CredentialKey | undefined {
  if (keyring instanceof Map) {
    const keysById = keyring as ReadonlyMap<string, CredentialKey>;
    return keysById.get(keyId);
  }
  if (Array.isArray(keyring)) {
    const keys = keyring as readonly CredentialKey[];
    return keys.find((candidate) => candidate.id === keyId);
  }
  const singleKey = keyring as CredentialKey;
  return singleKey.id === keyId ? singleKey : undefined;
}

export function decryptCredential<T = unknown>(
  envelopeInput: unknown,
  keyring: CredentialKey | readonly CredentialKey[] | ReadonlyMap<string, CredentialKey>,
  options: DecryptCredentialOptions,
): T {
  const envelope = parseEnvelope(envelopeInput);
  assertPurpose(options.expectedPurpose);
  if (envelope.purpose !== options.expectedPurpose) {
    throw new CredentialEnvelopeError(
      "PURPOSE_MISMATCH",
      "Credential envelope purpose does not match its use",
    );
  }

  const key = findKey(keyring, envelope.keyId);
  if (key === undefined) {
    throw new CredentialEnvelopeError("UNKNOWN_KEY", "Credential envelope key is unavailable");
  }
  if (key.keyBytes.byteLength !== KEY_BYTES) {
    throw new CredentialEnvelopeError("INVALID_KEY", "Credential key is not AES-256 material");
  }

  try {
    const decipher = createDecipheriv(
      ALGORITHM,
      key.keyBytes,
      fromBase64Url(envelope.iv, "iv", IV_BYTES),
      { authTagLength: AUTH_TAG_BYTES },
    );
    decipher.setAAD(envelopeAad(envelope));
    decipher.setAuthTag(fromBase64Url(envelope.authTag, "authTag", AUTH_TAG_BYTES));
    const plaintext = Buffer.concat([
      decipher.update(fromBase64Url(envelope.ciphertext, "ciphertext")),
      decipher.final(),
    ]);
    try {
      return JSON.parse(plaintext.toString("utf8")) as T;
    } finally {
      plaintext.fill(0);
    }
  } catch {
    // Deliberately do not distinguish bad tag, wrong key, or corrupt ciphertext.
    throw new CredentialEnvelopeError("DECRYPTION_FAILED", "Credential decryption failed");
  }
}
