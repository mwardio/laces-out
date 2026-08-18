import { parentPort, workerData } from "node:worker_threads";

import {
  buildFirstPartyRosLeagueTarget,
  type FirstPartyRosLeagueTargetInput,
} from "./first-party-ros-candidate-provider.js";

if (parentPort === null) {
  throw new Error("ROS simulation worker must run inside a worker thread");
}

try {
  const result = buildFirstPartyRosLeagueTarget(workerData as FirstPartyRosLeagueTargetInput);
  parentPort.postMessage({ ok: true, result });
} catch (error) {
  parentPort.postMessage({
    ok: false,
    error: error instanceof Error ? error.message : "ROS simulation worker failed",
  });
}
