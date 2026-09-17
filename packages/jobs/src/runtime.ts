import { PgBoss } from "pg-boss";
import { deadLetterQueueNames, queueNames } from "./queues.js";

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

const KNOWN_QUEUE_NAMES = new Set<string>([
  ...Object.values(queueNames),
  ...Object.values(deadLetterQueueNames),
  "__pgboss__send-it",
]);

// pg-boss emits these messages without the warning type used in its optional database records.
// Exact matching keeps arbitrary provider/error text out of both logs and rate-limit keys.
const WARNING_MESSAGES = new Map([
  ["Warning: slow query. Your queues and/or database server should be reviewed", "slow_query"],
  ["Warning: large queue backlog. Your queue should be reviewed", "queue_backlog"],
  [
    "Warning: Clock skew between this instance and the database server. This will not break scheduling, but is emitted any time the skew exceeds 60 seconds.",
    "clock_skew",
  ],
]);

function record(value: unknown): Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}

function nonnegativeNumber(value: unknown): number | undefined {
  return typeof value === "number" &&
    Number.isFinite(value) &&
    value >= 0 &&
    value <= Number.MAX_SAFE_INTEGER
    ? value
    : undefined;
}

function nonnegativeInteger(value: unknown): number | undefined {
  const number = nonnegativeNumber(value);
  return number !== undefined && Number.isInteger(number) ? number : undefined;
}

function warningFields(
  detail: Record<string, unknown>,
): Record<string, unknown> & { warningClass: string; queue?: string | undefined } {
  const data = record(detail.data);
  const warningClass =
    (typeof detail.message === "string" ? WARNING_MESSAGES.get(detail.message) : undefined) ??
    (data.type === "listen_notify_unavailable" ? "listen_notify_unavailable" : "unknown");
  switch (warningClass) {
    case "slow_query":
      return { warningClass, elapsedSeconds: nonnegativeNumber(data.elapsed) };
    case "queue_backlog":
      return {
        warningClass,
        queue:
          typeof data.name === "string" && KNOWN_QUEUE_NAMES.has(data.name) ? data.name : undefined,
        queuedCount: nonnegativeInteger(data.queuedCount),
        warningQueueSize: nonnegativeInteger(data.warningQueueSize),
      };
    case "clock_skew":
      return {
        warningClass,
        clockSkewSeconds: nonnegativeNumber(data.seconds),
        clockDirection:
          data.direction === "slower" || data.direction === "faster" ? data.direction : undefined,
      };
    default:
      return { warningClass };
  }
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
  const logStates = new Map<string, { lastLoggedAt: number; suppressed: number }>();
  for (const event of ["error", "warning"] as const) {
    boss.on(event, (error: unknown) => {
      const detail = record(error);
      const warning = event === "warning" ? warningFields(detail) : undefined;
      // Finite allowlists bound this map. One noisy queue must not hide a different warning class
      // or a second queue's backlog, while repeated events remain limited to one log per 30 seconds.
      const rateLimitKey = warning
        ? `warning:${warning.warningClass}:${warning.queue ?? ""}`
        : "error";
      const state = logStates.get(rateLimitKey);
      const at = now();
      if (state !== undefined && at >= state.lastLoggedAt && at - state.lastLoggedAt < 30_000) {
        state.suppressed = Math.min(Number.MAX_SAFE_INTEGER, state.suppressed + 1);
        return;
      }
      const code = safeToken(detail.code);
      const fields = {
        event: `job-queue-${event}`,
        process: typeof options === "object" ? safeToken(options.application_name) : undefined,
        name: safeToken(detail.name),
        code,
        syscall: safeToken(detail.syscall),
        transient: code !== undefined && TRANSIENT_CODES.has(code),
        ...warning,
        suppressedSincePreviousLog: state?.suppressed ?? 0,
      };
      // Never log raw errors: pg errors/warnings can contain SQL, connection URLs, and job data.
      logStates.set(rateLimitKey, { lastLoggedAt: at, suppressed: 0 });
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
