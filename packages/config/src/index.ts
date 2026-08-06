import { z } from "zod";

const blankToUndefined = (value: unknown): unknown => (value === "" ? undefined : value);
/**
 * Comma-separated origins arrive as one string. Entries are trimmed and stripped of a trailing
 * slash so `https://example.app/` and `https://example.app` are the same allowlist entry, which is
 * what an `Origin` header will actually carry.
 */
const commaSeparatedOrigins = (value: unknown): unknown =>
  typeof value === "string"
    ? value
        .split(",")
        .map((entry) => entry.trim().replace(/\/+$/u, ""))
        .filter((entry) => entry !== "")
    : value;
const booleanFlag = z
  .preprocess(
    (value) => (typeof value === "string" ? value.trim().toLowerCase() : value),
    z.enum(["true", "false", "1", "0"]).default("false"),
  )
  .transform((value) => value === "true" || value === "1");

const environmentSchema = z.object({
  NODE_ENV: z.enum(["development", "test", "production"]).default("development"),
  // WEB_URL is canonical for link-building; ADDITIONAL_WEB_ORIGINS only widens origin acceptance.
  WEB_URL: z.url().default("http://localhost:3000"),
  /**
   * Extra browser origins the API accepts requests from — a second domain pointed at this same
   * deployment. It widens the CORS reflection and the production origin check and nothing else:
   * every link the API builds (Yahoo callback redirects, invitation URLs, share cards) still uses
   * the canonical WEB_URL, so a member who arrives on a second domain is never handed a link that
   * silently changes which domain they are on.
   */
  ADDITIONAL_WEB_ORIGINS: z.preprocess(commaSeparatedOrigins, z.array(z.url()).default([])),
  API_URL: z.url().default("http://localhost:4000"),
  PORT: z.coerce.number().int().min(1).max(65_535).default(4000),
  DATABASE_URL: z.string().min(1).default("postgres://fantasy:fantasy@localhost:5432/fantasy"),
  CREDENTIAL_ENCRYPTION_KEY: z.preprocess(blankToUndefined, z.string().min(1).optional()),
  GEMINI_API_KEY: z.preprocess(blankToUndefined, z.string().trim().min(8).max(512).optional()),
  OPENROUTER_API_KEY: z.preprocess(blankToUndefined, z.string().trim().min(8).max(512).optional()),
  MANAGED_AI_DAILY_REQUEST_LIMIT: z.coerce.number().int().min(1).max(500).default(50),
  MANAGED_AI_MAX_OUTPUT_TOKENS: z.coerce.number().int().min(64).max(8192).default(2000),
  SESSION_SECRET: z.preprocess(blankToUndefined, z.string().min(32).optional()),
  /**
   * Allows account creation without the deployment-wide invite code. This stays off by default so
   * self-hosted instances remain closed unless their operator makes an explicit choice.
   */
  REGISTRATION_OPEN: booleanFlag,
  REGISTRATION_INVITE_CODE: z.preprocess(
    blankToUndefined,
    z.string().trim().min(12).max(128).optional(),
  ),
  YAHOO_CLIENT_ID: z.preprocess(blankToUndefined, z.string().min(1).optional()),
  YAHOO_CLIENT_SECRET: z.preprocess(blankToUndefined, z.string().min(1).optional()),
  YAHOO_REDIRECT_URI: z.url().default("http://localhost:4000/v1/connections/yahoo/callback"),
  /**
   * Dedicated unattended-read kill switch. Manual Yahoo authorization and refresh remain available
   * when this is false; true is rejected unless the server-held Yahoo credential path is complete.
   */
  YAHOO_AUTOMATED_SYNC_ENABLED: booleanFlag,
  /**
   * Master switch for ESPN live draft ingest. Defaults off: the capability must not turn itself on
   * anywhere it has not been validated, and flipping this to false is the emergency kill switch —
   * it stops new provider mutation while accepted events and manual backup keep working.
   */
  ESPN_LIVE_DRAFT_SYNC: booleanFlag,
  /**
   * Anonymous reads use an unofficial ESPN web-client endpoint. Keep this off until the operator
   * has completed the documented evidence and provider-policy gate for the deployment.
   */
  ESPN_PUBLIC_DIRECT_SYNC_ENABLED: booleanFlag,
  /**
   * Allows members to opt in to encrypted server-side ESPN session storage for unattended,
   * read-only refreshes. Disabled by default because this is an unofficial provider path.
   */
  ESPN_SERVER_SESSION_SYNC_ENABLED: booleanFlag,
  /**
   * Web push VAPID identity. All three are optional and absent by default: a deployment that has
   * never generated a key pair reports game-day alerts as unavailable rather than failing.
   */
  VAPID_PUBLIC_KEY: z.preprocess(
    blankToUndefined,
    z
      .string()
      .trim()
      .regex(/^[A-Za-z0-9_-]{87}$/u)
      .optional(),
  ),
  VAPID_PRIVATE_KEY: z.preprocess(
    blankToUndefined,
    z
      .string()
      .trim()
      .regex(/^[A-Za-z0-9_-]{43}$/u)
      .optional(),
  ),
  VAPID_SUBJECT: z.preprocess(
    blankToUndefined,
    z
      .string()
      .trim()
      .regex(/^(?:mailto:\S+@\S+|https:\/\/\S+)$/u)
      .max(255)
      .optional(),
  ),
  /**
   * Outbound email identity, optional and absent by default: a deployment without SMTP settings
   * simply sends no email — registration, password entry, and the worker all keep working. The
   * four are all-or-nothing; SMTP_PORT alone carries a default because 587 (STARTTLS submission)
   * is right for nearly every provider, including iCloud custom domains.
   */
  SMTP_HOST: z.preprocess(blankToUndefined, z.string().trim().min(1).max(255).optional()),
  SMTP_PORT: z.coerce.number().int().min(1).max(65_535).default(587),
  SMTP_USER: z.preprocess(blankToUndefined, z.string().trim().min(1).max(320).optional()),
  SMTP_PASSWORD: z.preprocess(blankToUndefined, z.string().min(1).max(1024).optional()),
  /** RFC 5322 From: either `user@example.app` or `Display Name <user@example.app>`. */
  EMAIL_FROM: z.preprocess(
    blankToUndefined,
    z
      .string()
      .trim()
      .max(320)
      .regex(
        /^(?:[^<>\r\n]{1,100}<[^\s@<>]+@[^\s@<>]+\.[^\s@<>]+>|[^\s@<>]+@[^\s@<>]+\.[^\s@<>]+)$/u,
      )
      .optional(),
  ),
  /**
   * Enforces confirm-first registration and invitation acceptance. Kept separate from SMTP so
   * schema and delivery support can be deployed before legacy clients are exposed to the gate.
   */
  EMAIL_VERIFICATION_ENABLED: booleanFlag,
  LOG_LEVEL: z.enum(["fatal", "error", "warn", "info", "debug", "trace", "silent"]).default("info"),
});

export type Environment = z.infer<typeof environmentSchema>;

export class ConfigurationError extends Error {
  readonly issues: readonly z.core.$ZodIssue[];

  constructor(issues: readonly z.core.$ZodIssue[]) {
    super(`Invalid environment configuration: ${z.prettifyError({ issues })}`);
    this.name = "ConfigurationError";
    this.issues = issues;
  }
}

function assertProductionBrowserOrigin(value: string, name: string): void {
  const origin = new URL(value);
  const loopback =
    origin.protocol === "http:" && ["localhost", "127.0.0.1", "[::1]"].includes(origin.hostname);
  if (origin.protocol !== "https:" && !loopback) {
    throw new Error(`Production ${name} must use HTTPS unless it is a loopback origin`);
  }
  if (
    origin.username !== "" ||
    origin.password !== "" ||
    origin.pathname !== "/" ||
    origin.search !== "" ||
    origin.hash !== "" ||
    value !== origin.origin
  ) {
    throw new Error(`Production ${name} must be a bare origin without credentials or a path`);
  }
}

export function loadEnvironment(
  source: Readonly<Record<string, string | undefined>> = process.env,
): Environment {
  const parsed = environmentSchema.safeParse(source);
  if (!parsed.success) {
    throw new ConfigurationError(parsed.error.issues);
  }

  if (parsed.data.NODE_ENV === "production") {
    const missing = [
      parsed.data.CREDENTIAL_ENCRYPTION_KEY ? undefined : "CREDENTIAL_ENCRYPTION_KEY",
      parsed.data.SESSION_SECRET ? undefined : "SESSION_SECRET",
    ].filter((value): value is string => value !== undefined);

    if (missing.length > 0) {
      throw new Error(`Missing production secrets: ${missing.join(", ")}`);
    }

    const placeholderPattern = /^(?:base64:)?(?:replace-with|change-?me|example\b)/iu;
    const placeholders = [
      ["SESSION_SECRET", parsed.data.SESSION_SECRET],
      ["CREDENTIAL_ENCRYPTION_KEY", parsed.data.CREDENTIAL_ENCRYPTION_KEY],
      ["REGISTRATION_INVITE_CODE", parsed.data.REGISTRATION_INVITE_CODE],
      ["GEMINI_API_KEY", parsed.data.GEMINI_API_KEY],
      ["OPENROUTER_API_KEY", parsed.data.OPENROUTER_API_KEY],
      ["YAHOO_CLIENT_ID", parsed.data.YAHOO_CLIENT_ID],
      ["YAHOO_CLIENT_SECRET", parsed.data.YAHOO_CLIENT_SECRET],
      ["SMTP_PASSWORD", parsed.data.SMTP_PASSWORD],
    ].flatMap(([name, value]) =>
      typeof value === "string" && placeholderPattern.test(value) ? [name] : [],
    );
    try {
      const databaseUrl = new URL(parsed.data.DATABASE_URL);
      if (databaseUrl.username === "fantasy" && databaseUrl.password === "fantasy") {
        placeholders.push("DATABASE_URL");
      }
    } catch {
      placeholders.push("DATABASE_URL");
    }
    if (placeholders.length > 0) {
      throw new Error(
        `Unsafe production placeholder configuration: ${[...new Set(placeholders)].join(", ")}`,
      );
    }

    assertProductionBrowserOrigin(parsed.data.WEB_URL, "WEB_URL");
    // Every additional origin is held to the WEB_URL rules: a request-acceptance allowlist must not
    // be the one place a plaintext or path-carrying origin slips into production.
    for (const additionalOrigin of parsed.data.ADDITIONAL_WEB_ORIGINS) {
      assertProductionBrowserOrigin(additionalOrigin, "ADDITIONAL_WEB_ORIGINS");
    }
  }

  if (parsed.data.REGISTRATION_INVITE_CODE && !parsed.data.SESSION_SECRET) {
    throw new Error("REGISTRATION_INVITE_CODE requires SESSION_SECRET");
  }
  if (parsed.data.REGISTRATION_OPEN && !parsed.data.SESSION_SECRET) {
    throw new Error("REGISTRATION_OPEN requires SESSION_SECRET");
  }

  const vapidWasRequested = Boolean(
    parsed.data.VAPID_PUBLIC_KEY || parsed.data.VAPID_PRIVATE_KEY || parsed.data.VAPID_SUBJECT,
  );
  if (
    vapidWasRequested &&
    (!parsed.data.VAPID_PUBLIC_KEY || !parsed.data.VAPID_PRIVATE_KEY || !parsed.data.VAPID_SUBJECT)
  ) {
    throw new Error(
      "Web push requires VAPID_PUBLIC_KEY, VAPID_PRIVATE_KEY, and VAPID_SUBJECT together",
    );
  }

  const smtpWasRequested = Boolean(
    parsed.data.SMTP_HOST ||
    parsed.data.SMTP_USER ||
    parsed.data.SMTP_PASSWORD ||
    parsed.data.EMAIL_FROM,
  );
  if (
    smtpWasRequested &&
    (!parsed.data.SMTP_HOST ||
      !parsed.data.SMTP_USER ||
      !parsed.data.SMTP_PASSWORD ||
      !parsed.data.EMAIL_FROM)
  ) {
    throw new Error(
      "Outbound email requires SMTP_HOST, SMTP_USER, SMTP_PASSWORD, and EMAIL_FROM together",
    );
  }
  if (
    parsed.data.EMAIL_VERIFICATION_ENABLED &&
    (!parsed.data.SMTP_HOST ||
      !parsed.data.SMTP_USER ||
      !parsed.data.SMTP_PASSWORD ||
      !parsed.data.EMAIL_FROM)
  ) {
    throw new Error("EMAIL_VERIFICATION_ENABLED requires complete outbound email configuration");
  }

  const yahooWasRequested = Boolean(parsed.data.YAHOO_CLIENT_ID || parsed.data.YAHOO_CLIENT_SECRET);
  if (
    yahooWasRequested &&
    (!parsed.data.YAHOO_CLIENT_ID ||
      !parsed.data.YAHOO_CLIENT_SECRET ||
      !parsed.data.CREDENTIAL_ENCRYPTION_KEY)
  ) {
    throw new Error(
      "Yahoo requires YAHOO_CLIENT_ID, YAHOO_CLIENT_SECRET, and CREDENTIAL_ENCRYPTION_KEY together",
    );
  }
  if (
    parsed.data.YAHOO_AUTOMATED_SYNC_ENABLED &&
    (!parsed.data.YAHOO_CLIENT_ID ||
      !parsed.data.YAHOO_CLIENT_SECRET ||
      !parsed.data.CREDENTIAL_ENCRYPTION_KEY)
  ) {
    throw new Error("YAHOO_AUTOMATED_SYNC_ENABLED requires complete Yahoo server configuration");
  }
  if (parsed.data.ESPN_SERVER_SESSION_SYNC_ENABLED && !parsed.data.CREDENTIAL_ENCRYPTION_KEY) {
    throw new Error("ESPN_SERVER_SESSION_SYNC_ENABLED requires CREDENTIAL_ENCRYPTION_KEY");
  }
  if (yahooWasRequested) {
    const apiUrl = new URL(parsed.data.API_URL);
    const expectedCallback = new URL("/v1/connections/yahoo/callback", apiUrl);
    const configuredCallback = new URL(parsed.data.YAHOO_REDIRECT_URI);
    if (
      apiUrl.username !== "" ||
      apiUrl.password !== "" ||
      configuredCallback.username !== "" ||
      configuredCallback.password !== "" ||
      configuredCallback.search !== "" ||
      configuredCallback.hash !== "" ||
      configuredCallback.toString() !== expectedCallback.toString()
    ) {
      throw new Error(
        `YAHOO_REDIRECT_URI must be the exact configured API origin callback: ${expectedCallback.toString()}`,
      );
    }
  }

  return Object.freeze(parsed.data);
}
