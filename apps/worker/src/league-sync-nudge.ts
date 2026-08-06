import { emailSends, leagueMemberships, userPreferences, users, type Database } from "@fantasy/db";
import { renderLeagueSyncNudgeEmail, type EmailTransport } from "@fantasy/email";
import { and, asc, eq, gte, isNotNull, isNull, lte, or } from "drizzle-orm";

import type { EmailSweepJob, EmailSweepResult, EmailSweepService } from "./jobs.js";

/**
 * The one follow-up a new member ever gets: registered a few days ago, no league connected yet.
 * Eligibility is decided at execution time from stored data; the daily schedule only supplies the
 * occasion. The window has both edges on purpose — a deployment that turns SMTP on months after
 * launch must not greet its whole dormant backlog.
 */
export const NUDGE_DELAY_DAYS = 3;
export const NUDGE_WINDOW_DAYS = 14;
const NUDGE_BATCH_LIMIT = 200;
const DAY_MILLISECONDS = 24 * 60 * 60 * 1000;

export interface NudgeCandidate {
  readonly userId: string;
  readonly email: string;
  readonly displayName: string;
}

export interface LeagueSyncNudgeRepository {
  /** Members registered inside the window, with no league membership, no prior nudge, and email on. */
  listCandidates(input: {
    readonly registeredBefore: Date;
    readonly registeredAfter: Date;
    readonly limit: number;
  }): Promise<readonly NudgeCandidate[]>;
  /** Returns false when this member's nudge was already claimed — the whole idempotency rule. */
  claim(userId: string, idempotencyKey: string, now: Date): Promise<boolean>;
  releaseClaim(idempotencyKey: string): Promise<void>;
}

export class DrizzleLeagueSyncNudgeRepository implements LeagueSyncNudgeRepository {
  readonly #database: Database;

  constructor(database: Database) {
    this.#database = database;
  }

  async listCandidates(input: {
    readonly registeredBefore: Date;
    readonly registeredAfter: Date;
    readonly limit: number;
  }): Promise<readonly NudgeCandidate[]> {
    return this.#database
      .select({ userId: users.id, email: users.email, displayName: users.displayName })
      .from(users)
      .leftJoin(leagueMemberships, eq(leagueMemberships.userId, users.id))
      .leftJoin(userPreferences, eq(userPreferences.userId, users.id))
      .leftJoin(
        emailSends,
        and(eq(emailSends.userId, users.id), eq(emailSends.kind, "league-sync-nudge")),
      )
      .where(
        and(
          lte(users.createdAt, input.registeredBefore),
          gte(users.createdAt, input.registeredAfter),
          // A pending account never confirmed its address; it gets no optional email at all.
          isNotNull(users.emailVerifiedAt),
          isNull(leagueMemberships.id),
          isNull(emailSends.id),
          // No preference row means the default: email on.
          or(isNull(userPreferences.userId), eq(userPreferences.emailNotifications, true)),
        ),
      )
      .orderBy(asc(users.createdAt), asc(users.id))
      .limit(input.limit);
  }

  async claim(userId: string, idempotencyKey: string, now: Date): Promise<boolean> {
    const claimed = await this.#database
      .insert(emailSends)
      .values({ userId, kind: "league-sync-nudge", idempotencyKey, createdAt: now })
      .onConflictDoNothing({ target: emailSends.idempotencyKey })
      .returning({ id: emailSends.id });
    return claimed.length > 0;
  }

  async releaseClaim(idempotencyKey: string): Promise<void> {
    await this.#database.delete(emailSends).where(eq(emailSends.idempotencyKey, idempotencyKey));
  }
}

const EMPTY_SWEEP = {
  considered: 0,
  sent: 0,
  duplicates: 0,
  failures: 0,
} as const;

export interface LeagueSyncNudgeServiceOptions {
  readonly repository: LeagueSyncNudgeRepository;
  /** Absent when the operator configured no SMTP identity. The sweep then no-ops, never throws. */
  readonly transport?: EmailTransport;
  readonly webUrl: string;
  readonly now?: () => Date;
}

export class LeagueSyncNudgeService implements EmailSweepService {
  readonly #repository: LeagueSyncNudgeRepository;
  readonly #transport: EmailTransport | undefined;
  readonly #webUrl: string;
  readonly #now: () => Date;

  constructor(options: LeagueSyncNudgeServiceOptions) {
    this.#repository = options.repository;
    this.#transport = options.transport;
    this.#webUrl = options.webUrl.replace(/\/+$/u, "");
    this.#now = options.now ?? (() => new Date());
  }

  async sweep(job: EmailSweepJob): Promise<EmailSweepResult> {
    // Widened on purpose: today's kind list has one entry, and narrowing `job.kind` against it
    // would leave `never` for the skipped label a future kind still deserves.
    const kind: string = job.kind;
    if (kind !== "league-sync-nudge") {
      return { ...EMPTY_SWEEP, skipped: `no-handler:${kind}` };
    }
    const transport = this.#transport;
    if (!transport) return { ...EMPTY_SWEEP, skipped: "smtp-not-configured" };

    const now = this.#now();
    const candidates = await this.#repository.listCandidates({
      registeredBefore: new Date(now.getTime() - NUDGE_DELAY_DAYS * DAY_MILLISECONDS),
      registeredAfter: new Date(now.getTime() - NUDGE_WINDOW_DAYS * DAY_MILLISECONDS),
      limit: NUDGE_BATCH_LIMIT,
    });

    let sent = 0;
    let duplicates = 0;
    let failures = 0;
    for (const candidate of candidates) {
      const idempotencyKey = `league-sync-nudge:${candidate.userId}`;
      if (!(await this.#repository.claim(candidate.userId, idempotencyKey, this.#now()))) {
        duplicates += 1;
        continue;
      }
      const rendered = renderLeagueSyncNudgeEmail({
        displayName: candidate.displayName,
        webUrl: this.#webUrl,
      });
      const outcome = await transport.send({
        to: candidate.email,
        subject: rendered.subject,
        text: rendered.text,
        html: rendered.html,
      });
      if (outcome === "failed") {
        // Releasing the claim lets tomorrow's sweep retry a member a transient failure skipped.
        failures += 1;
        await this.#repository.releaseClaim(idempotencyKey);
        continue;
      }
      sent += 1;
    }

    return { considered: candidates.length, sent, duplicates, failures, skipped: null };
  }
}
