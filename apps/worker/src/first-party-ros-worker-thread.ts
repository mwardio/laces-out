import { createHash } from "node:crypto";
import { Worker } from "node:worker_threads";

import type {
  FirstPartyRosLeagueTargetBuilder,
  FirstPartyRosLeagueTargetInput,
  FirstPartyRosLeagueTargetResult,
} from "./first-party-ros-candidate-provider.js";
import type {
  FirstPartyRosCandidateProvider,
  FirstPartyRosCandidateContext,
  FirstPartyRosPublicationTarget,
} from "./first-party-ros-projections.js";

type WorkerResponse<Result> =
  { readonly ok: true; readonly result: Result } | { readonly ok: false; readonly error: string };

/**
 * Rejects obsolete work before entering the provider. The database provider then verifies the
 * expected checksum and materializes every input in a short repeatable-read transaction. Live
 * writes after that snapshot belong to the next refresh and cannot invalidate this simulation.
 */
export async function buildVerifiedFirstPartyRosTargets(input: {
  readonly provider: FirstPartyRosCandidateProvider;
  readonly context: FirstPartyRosCandidateContext;
}): Promise<readonly FirstPartyRosPublicationTarget[]> {
  const checksumInput = { season: input.context.season, window: input.context.window };
  const before = await input.provider.sourceChecksum(checksumInput);
  if (before !== input.context.candidateProviderChecksum) {
    throw new Error("ROS candidate inputs changed before artifact simulation started");
  }
  return input.provider.buildTargets(input.context);
}

function runRosWorker<Input, Result>(input: {
  readonly entry: string;
  readonly workerData: Input;
  readonly description: string;
  readonly signal?: AbortSignal;
}): Promise<Result> {
  return new Promise<Result>((resolve, reject) => {
    input.signal?.throwIfAborted();
    const worker = new Worker(new URL(input.entry, import.meta.url), {
      workerData: input.workerData,
      // Isolate an unexpectedly large fit from the queue owner and the API on the same host.
      // Allocation failure rejects this job and retains prior publication instead of host OOM.
      resourceLimits: { maxOldGenerationSizeMb: 2_048 },
    });
    let settled = false;
    let terminating = false;
    const finish = (callback: () => void) => {
      if (settled) return;
      settled = true;
      input.signal?.removeEventListener("abort", abort);
      callback();
    };
    const abort = () => {
      if (settled || terminating) return;
      terminating = true;
      void worker.terminate().then(
        () => finish(() => reject(new Error(`${input.description} aborted`))),
        (error: unknown) =>
          finish(() =>
            reject(error instanceof Error ? error : new Error("ROS worker termination failed")),
          ),
      );
    };
    input.signal?.addEventListener("abort", abort, { once: true });
    if (input.signal?.aborted) abort();
    worker.once("message", (message: WorkerResponse<Result>) => {
      if (terminating) return;
      finish(() => {
        if (message.ok) resolve(message.result);
        else reject(new Error(message.error));
      });
    });
    worker.once("error", (error) => {
      if (!terminating) finish(() => reject(error));
    });
    worker.once("exit", (code) => {
      if (terminating) return;
      finish(() =>
        reject(new Error(`${input.description} exited without a result (code ${code})`)),
      );
    });
  });
}

/** Runs one deterministic league/profile simulation on a separate CPU core. */
export const buildFirstPartyRosLeagueTargetInWorker: FirstPartyRosLeagueTargetBuilder = (
  input: FirstPartyRosLeagueTargetInput,
) =>
  runRosWorker<FirstPartyRosLeagueTargetInput, FirstPartyRosLeagueTargetResult>({
    entry: "./first-party-ros-simulation-worker.js",
    workerData: input,
    description: "ROS simulation worker",
  });

export type FirstPartyRosTargetBatch = Readonly<
  Record<string, readonly FirstPartyRosPublicationTarget[]>
>;

/** All profiles for one immutable refresh share one worker and its bounded football caches. */
export function createSharedFirstPartyRosTargetBuilder(
  runBatch: (
    context: FirstPartyRosCandidateContext,
    signal?: AbortSignal,
  ) => Promise<FirstPartyRosTargetBatch>,
): FirstPartyRosCandidateProvider["buildTargets"] {
  const pending = new Map<string, Promise<FirstPartyRosTargetBatch>>();
  return async (context, signal) => {
    signal?.throwIfAborted();
    const key = createHash("sha256")
      .update(
        JSON.stringify({
          season: context.season,
          window: context.window,
          now: context.now.toISOString(),
          checksum: context.candidateProviderChecksum,
          artifacts: context.artifacts.map((artifact) => artifact.artifactChecksum).sort(),
        }),
      )
      .digest("hex");
    let result = pending.get(key);
    if (!result) {
      result = runBatch(context, signal);
      pending.set(key, result);
      const current = result;
      const remove = () => {
        if (pending.get(key) === current) pending.delete(key);
      };
      void result.then(remove, remove);
    }
    const batch = await result;
    signal?.throwIfAborted();
    const targets = batch[context.artifact.artifactChecksum];
    if (!targets) throw new Error("ROS batch omitted the requested admitted artifact");
    return targets;
  };
}

export const buildFirstPartyRosTargetsInWorker = createSharedFirstPartyRosTargetBuilder(
  (context, signal) =>
    runRosWorker<FirstPartyRosCandidateContext, FirstPartyRosTargetBatch>({
      entry: "./first-party-ros-artifact-worker.js",
      workerData: context,
      description: "ROS refresh worker",
      ...(signal ? { signal } : {}),
    }),
);
