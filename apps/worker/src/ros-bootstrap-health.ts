import { isDeepStrictEqual } from "node:util";

import {
  firstPartyRosCorpusBootstraps,
  firstPartyRosProfileValidations,
  type Database,
} from "@laces-out/db";
import { queueNames } from "@laces-out/jobs";
import {
  FIRST_PARTY_ROS_MODEL_VERSION,
  FIRST_PARTY_ROS_POLICY_VERSION,
  FIRST_PARTY_ROS_INTERVAL_CALIBRATION_VERSION,
  type ProjectionDefensePointsAllowedDefinition,
} from "@laces-out/projections";
import { and, eq, sql } from "drizzle-orm";

import {
  readyRosSharedCorpusIdentity,
  rosSharedCorpusRequest,
} from "./ros-shared-corpus-runner.js";
import { rosCorpusDefinitionForProfileKey } from "./ros-corpus-routing.js";
import { rosProfileBootstrapWait } from "./ros-profile-recovery-state.js";

type BootstrapRow = typeof firstPartyRosCorpusBootstraps.$inferSelect;
const GRACE_MS = 15 * 60_000;

/** Observability only. This verdict never admits data, enqueues work, or changes readiness. */
export function describeRosBootstrapHealth(input: {
  readonly row: BootstrapRow | null;
  readonly readyCorpusIdentity: string | null;
  readonly pointerFailed: boolean;
  readonly request: ReturnType<typeof rosSharedCorpusRequest>;
  readonly outstandingJobs: number;
  readonly firstRequestedAt: Date | null;
  readonly now: Date;
}) {
  const { row, request, now } = input;
  const overdue = (date: Date | null) => date !== null && now.getTime() - date.getTime() > GRACE_MS;
  let attention = false;
  let reason = "no-current-demand";
  if (
    row &&
    (!isDeepStrictEqual(row.protocol, request.protocol) ||
      row.requestIdentity !== request.identity ||
      row.season !== request.protocol.season)
  ) {
    attention = true;
    reason = "request-ledger-mismatch";
  } else if (
    input.pointerFailed ||
    (row?.corpusIdentity && row.corpusIdentity !== input.readyCorpusIdentity)
  ) {
    attention = true;
    reason = "stored-history-needs-repair";
  } else if (!row) {
    attention = overdue(input.firstRequestedAt);
    reason = input.firstRequestedAt ? "bootstrap-not-registered" : reason;
  } else if (row.state === "blocked-integrity") {
    attention = true;
    reason = "stored-history-needs-repair";
  } else if (row.state === "ready") {
    attention =
      row.corpusIdentity === null || input.readyCorpusIdentity === null || row.verifiedAt === null;
    reason = attention ? "ready-history-unavailable" : "ready-pointer-verified";
  } else if (row.state === "waiting-source" || row.state === "retry-wait") {
    attention =
      row.nextAttemptAt === null || (overdue(row.nextAttemptAt) && input.outstandingJobs === 0);
    reason = attention ? "bootstrap-retry-overdue" : row.state;
  } else if (row.state === "pending" || row.state === "building") {
    attention = input.outstandingJobs === 0 && overdue(row.startedAt ?? row.updatedAt);
    reason = attention ? "bootstrap-job-missing" : row.state;
  } else {
    attention = true;
    reason = "bootstrap-state-invalid";
  }
  return {
    attention,
    reason,
    season: request.protocol.season,
    pointsAllowedDefinition: request.protocol.pointsAllowedDefinition,
    requestIdentity: request.identity,
    state: row?.state ?? "unregistered",
    attempt: row?.attempt ?? 0,
    updatedAt: row?.updatedAt.toISOString() ?? null,
    nextAttemptAt: row?.nextAttemptAt?.toISOString() ?? null,
    outstandingJobs: input.outstandingJobs,
    verificationScope:
      "ready pointer and corpus manifest; outcome vectors are verified at adoption and replay",
  };
}

export async function readRosBootstrapHealth(input: {
  readonly database: Database;
  readonly directory: string;
  readonly season: number;
  readonly signal: AbortSignal;
  readonly now?: Date;
  readonly pointsAllowedDefinition?: ProjectionDefensePointsAllowedDefinition;
}) {
  input.signal.throwIfAborted();
  const request = rosSharedCorpusRequest(input.season, input.pointsAllowedDefinition);
  const observed = await input.database.transaction(
    async (transaction) => {
      await transaction.execute(sql`set local statement_timeout = '5s'`);
      const [row] = await transaction
        .select()
        .from(firstPartyRosCorpusBootstraps)
        .where(eq(firstPartyRosCorpusBootstraps.requestIdentity, request.identity));
      const demands = await transaction
        .select({
          requestedAt: firstPartyRosProfileValidations.requestedAt,
          scoringProfileKey: firstPartyRosProfileValidations.scoringProfileKey,
          report: firstPartyRosProfileValidations.report,
        })
        .from(firstPartyRosProfileValidations)
        .where(
          and(
            eq(firstPartyRosProfileValidations.season, input.season),
            eq(firstPartyRosProfileValidations.modelVersion, FIRST_PARTY_ROS_MODEL_VERSION),
            eq(firstPartyRosProfileValidations.policyVersion, FIRST_PARTY_ROS_POLICY_VERSION),
            eq(
              firstPartyRosProfileValidations.calibrationVersion,
              FIRST_PARTY_ROS_INTERVAL_CALIBRATION_VERSION,
            ),
          ),
        );
      const requestedTimes = demands.flatMap((demand) => {
        try {
          const definition = rosCorpusDefinitionForProfileKey(demand.scoringProfileKey);
          const belongs =
            definition === null
              ? rosProfileBootstrapWait(demand.report, request.identity) ||
                (demand.report?.bootstrapWait === undefined &&
                  request.protocol.pointsAllowedDefinition === "yahoo-2022-v1")
              : definition === request.protocol.pointsAllowedDefinition;
          return belongs ? [demand.requestedAt.getTime()] : [];
        } catch {
          return [];
        }
      });
      const jobs = await transaction.execute<{ count: number }>(sql`
      select count(*)::int as count from pgboss.job
        where name = ${queueNames.bootstrapRosCorpus}
          and data->>'requestIdentity' = ${request.identity}
          and data->>'attempt' = ${String(row?.attempt ?? 0)}
          and state in ('created', 'retry', 'active')
    `);
      return {
        row: row ?? null,
        firstRequestedAt: requestedTimes.length ? new Date(Math.min(...requestedTimes)) : null,
        outstandingJobs: jobs[0]?.count ?? 0,
      };
    },
    { accessMode: "read only", isolationLevel: "repeatable read" },
  );
  let readyCorpusIdentity: string | null = null;
  let pointerFailed = false;
  try {
    readyCorpusIdentity = await readyRosSharedCorpusIdentity(
      input.directory,
      input.season,
      input.signal,
      input.pointsAllowedDefinition,
    );
  } catch {
    input.signal.throwIfAborted();
    pointerFailed = true;
  }
  return describeRosBootstrapHealth({
    ...observed,
    readyCorpusIdentity,
    pointerFailed,
    request,
    now: input.now ?? new Date(),
  });
}
