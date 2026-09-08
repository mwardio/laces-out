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
 * Pins a long artifact build to the main thread's exact provider inputs. The second read closes the
 * race where roster/crosswalk/source state changes after simulation starts but before results are
 * handed back for publication.
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
  const targets = await input.provider.buildTargets(input.context);
  const after = await input.provider.sourceChecksum(checksumInput);
  if (after !== input.context.candidateProviderChecksum) {
    throw new Error("ROS candidate inputs changed during artifact simulation");
  }
  return targets;
}

function runRosWorker<Input, Result>(input: {
  readonly entry: string;
  readonly workerData: Input;
  readonly description: string;
}): Promise<Result> {
  return new Promise<Result>((resolve, reject) => {
    const worker = new Worker(new URL(input.entry, import.meta.url), {
      workerData: input.workerData,
    });
    let settled = false;
    const finish = (callback: () => void) => {
      if (settled) return;
      settled = true;
      callback();
    };
    worker.once("message", (message: WorkerResponse<Result>) => {
      finish(() => {
        if (message.ok) resolve(message.result);
        else reject(new Error(message.error));
      });
    });
    worker.once("error", (error) => finish(() => reject(error)));
    worker.once("exit", (code) => {
      if (code !== 0) {
        finish(() => reject(new Error(`${input.description} exited with code ${code}`)));
      }
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

/**
 * Runs an admitted scoring profile's complete database load, calibration, and simulation away from
 * the pg-boss event loop. Keeping only the final publication transaction in the parent prevents a
 * long calibration from starving queue heartbeats or other profiles' PostgreSQL handshakes.
 */
export function buildFirstPartyRosTargetsInWorker(
  context: FirstPartyRosCandidateContext,
): Promise<readonly FirstPartyRosPublicationTarget[]> {
  return runRosWorker<FirstPartyRosCandidateContext, readonly FirstPartyRosPublicationTarget[]>({
    entry: "./first-party-ros-artifact-worker.js",
    workerData: context,
    description: "ROS artifact worker",
  });
}
