import { loadEnvironment } from "@laces-out/config";
import { createDatabase } from "@laces-out/db";
import { parentPort, workerData } from "node:worker_threads";

import { databaseFirstPartyRosCandidateProvider } from "./first-party-ros-candidate-provider.js";
import type { FirstPartyRosCandidateContext } from "./first-party-ros-projections.js";

if (parentPort === null) {
  throw new Error("ROS artifact worker must run inside a worker thread");
}

const environment = loadEnvironment();
const database = createDatabase(environment.DATABASE_URL, 4);

try {
  const provider = databaseFirstPartyRosCandidateProvider({ database: database.db });
  const result = await provider.buildTargets(workerData as FirstPartyRosCandidateContext);
  parentPort.postMessage({ ok: true, result });
} catch (error) {
  parentPort.postMessage({
    ok: false,
    error: error instanceof Error ? error.message : "ROS artifact worker failed",
  });
} finally {
  await database.close();
}
