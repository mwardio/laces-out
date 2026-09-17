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
  const context = workerData as FirstPartyRosCandidateContext;
  const startedAt = Date.now();
  const provider = databaseFirstPartyRosCandidateProvider({
    database: database.db,
    onSnapshotReady: () =>
      console.info(
        JSON.stringify({
          event: "ros-inputs-snapshotted",
          artifactChecksum: context.artifact.artifactChecksum,
          candidateProviderChecksum: context.candidateProviderChecksum,
          elapsedMs: Date.now() - startedAt,
        }),
      ),
  });
  const result = await provider.buildTargetBatch(context);
  const targets = Object.values(result).flat();
  console.info(
    JSON.stringify({
      event: "ros-artifact-built",
      artifactChecksum: context.artifact.artifactChecksum,
      targets: targets.length,
      artifacts: Object.keys(result).length,
      players: targets.reduce((total, target) => total + target.released.length, 0),
      elapsedMs: Date.now() - startedAt,
    }),
  );
  parentPort.postMessage({ ok: true, result });
} catch (error) {
  parentPort.postMessage({
    ok: false,
    error: error instanceof Error ? error.message : "ROS artifact worker failed",
  });
} finally {
  await database.close();
}
