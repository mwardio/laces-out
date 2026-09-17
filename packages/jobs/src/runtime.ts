import { PgBoss } from "pg-boss";

interface QueueLogger {
  error(fields: Record<string, unknown>, message: string): void;
  warn(fields: Record<string, unknown>, message: string): void;
}

const TRANSIENT_CODES = new Set([
  "EAI_AGAIN",
  "ENOTFOUND",
  "ECONNREFUSED",
  "ECONNRESET",
  "ETIMEDOUT",
  "EPIPE",
  "08000",
  "08001",
  "08003",
  "08004",
  "08006",
  "08007",
  "08P01",
  "53300",
  "57P01",
  "57P02",
  "57P03",
]);

function safeToken(value: unknown): string | undefined {
  return typeof value === "string" && /^[a-zA-Z0-9_.-]{1,80}$/u.test(value) ? value : undefined;
}

/**
 * pg-boss retries its background polling/supervision after reporting errors. Its public emitter
 * must have an error listener before start(): an unhandled event otherwise kills the process and
 * every active job. This observer does not intercept rejected job, dispatch, or startup promises.
 */
export function createJobQueue(
  options: ConstructorParameters<typeof PgBoss>[0],
  logger: QueueLogger,
  now: () => number = Date.now,
): PgBoss {
  const boss = new PgBoss(options);
  for (const event of ["error", "warning"] as const) {
    let lastLoggedAt: number | undefined;
    let suppressed = 0;
    boss.on(event, (error: unknown) => {
      const at = now();
      if (lastLoggedAt !== undefined && at >= lastLoggedAt && at - lastLoggedAt < 30_000) {
        suppressed = Math.min(Number.MAX_SAFE_INTEGER, suppressed + 1);
        return;
      }
      const detail = error !== null && typeof error === "object" ? error : {};
      const code = safeToken("code" in detail ? detail.code : undefined);
      const fields = {
        event: `job-queue-${event}`,
        process: typeof options === "object" ? safeToken(options.application_name) : undefined,
        name: safeToken("name" in detail ? detail.name : undefined),
        code,
        syscall: safeToken("syscall" in detail ? detail.syscall : undefined),
        transient: code !== undefined && TRANSIENT_CODES.has(code),
        suppressedSincePreviousLog: suppressed,
      };
      // Never log raw errors: pg errors/warnings can contain SQL, connection URLs, and job data.
      lastLoggedAt = at;
      suppressed = 0;
      try {
        if (event === "error") logger.error(fields, "job queue background operation failed");
        else logger.warn(fields, "job queue background warning");
      } catch {
        // A failed log transport must not turn a retryable queue event into process termination.
      }
    });
  }
  return boss;
}
