import { z } from "zod";

const blankToUndefined = (value: unknown): unknown => (value === "" ? undefined : value);
const booleanFlag = z
  .preprocess(
    (value) => (typeof value === "string" ? value.trim().toLowerCase() : value),
    z.enum(["true", "false", "1", "0"]).default("false"),
  )
  .transform((value) => value === "true" || value === "1");

const environmentSchema = z.object({
  NODE_ENV: z.enum(["development", "test", "production"]).default("development"),
  WEB_URL: z.url().default("http://localhost:3000"),
  API_URL: z.url().default("http://localhost:4000"),
  PORT: z.coerce.number().int().min(1).max(65_535).default(4000),
  DATABASE_URL: z.string().min(1).default("postgres://fantasy:fantasy@localhost:5432/fantasy"),
  CREDENTIAL_ENCRYPTION_KEY: z.preprocess(blankToUndefined, z.string().min(1).optional()),
  GEMINI_API_KEY: z.preprocess(blankToUndefined, z.string().trim().min(8).max(512).optional()),
  MANAGED_AI_DAILY_REQUEST_LIMIT: z.coerce.number().int().min(1).max(500).default(50),
  MANAGED_AI_MAX_OUTPUT_TOKENS: z.coerce.number().int().min(64).max(8192).default(2000),
  SESSION_SECRET: z.preprocess(blankToUndefined, z.string().min(32).optional()),
  REGISTRATION_INVITE_CODE: z.preprocess(
    blankToUndefined,
    z.string().trim().min(12).max(128).optional(),
  ),
  YAHOO_CLIENT_ID: z.preprocess(blankToUndefined, z.string().min(1).optional()),
  YAHOO_CLIENT_SECRET: z.preprocess(blankToUndefined, z.string().min(1).optional()),
  YAHOO_REDIRECT_URI: z.url().default("http://localhost:4000/v1/connections/yahoo/callback"),
  /**
   * Master switch for ESPN live draft ingest. Defaults off: the capability must not turn itself on
   * anywhere it has not been validated, and flipping this to false is the emergency kill switch —
   * it stops new provider mutation while accepted events and manual backup keep working.
   */
  ESPN_LIVE_DRAFT_SYNC: booleanFlag,
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
      ["YAHOO_CLIENT_ID", parsed.data.YAHOO_CLIENT_ID],
      ["YAHOO_CLIENT_SECRET", parsed.data.YAHOO_CLIENT_SECRET],
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

    const webUrl = new URL(parsed.data.WEB_URL);
    const loopbackWebOrigin =
      webUrl.protocol === "http:" && ["localhost", "127.0.0.1", "[::1]"].includes(webUrl.hostname);
    if (webUrl.protocol !== "https:" && !loopbackWebOrigin) {
      throw new Error("Production WEB_URL must use HTTPS unless it is a loopback origin");
    }
    if (
      webUrl.username !== "" ||
      webUrl.password !== "" ||
      webUrl.pathname !== "/" ||
      webUrl.search !== "" ||
      webUrl.hash !== "" ||
      parsed.data.WEB_URL !== webUrl.origin
    ) {
      throw new Error("Production WEB_URL must be a bare origin without credentials or a path");
    }
  }

  if (parsed.data.REGISTRATION_INVITE_CODE && !parsed.data.SESSION_SECRET) {
    throw new Error("REGISTRATION_INVITE_CODE requires SESSION_SECRET");
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

  return Object.freeze(parsed.data);
}
