import { Worker } from "node:worker_threads";

import type {
  FirstPartyRosLeagueTargetBuilder,
  FirstPartyRosLeagueTargetInput,
  FirstPartyRosLeagueTargetResult,
} from "./first-party-ros-candidate-provider.js";
import type {
  FirstPartyRosCandidateContext,
  FirstPartyRosPublicationTarget,
} from "./first-party-ros-projections.js";

type WorkerResponse<Result> =
  { readonly ok: true; readonly result: Result } | { readonly ok: false; readonly error: string };

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
