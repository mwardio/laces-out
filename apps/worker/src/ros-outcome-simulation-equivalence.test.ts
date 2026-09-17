import { createHash } from "node:crypto";
import { describe, expect, it } from "vitest";
import { simulateFirstPartyRosOutcomes } from "@laces-out/projections";
import { createRosOutcomeSimulationPool } from "./ros-outcome-simulation-pool.js";
import { denseSimulationInput } from "./ros-outcome-simulation.test-fixtures.js";

const bytes = (array: Float64Array | Uint8Array) =>
  Buffer.from(array.buffer, array.byteOffset, array.byteLength);

describe("ROS simulation worker numeric transport", () => {
  it("preserves all Float64/game bytes and metadata for six dense positions and both strategies", async () => {
    const pool = createRosOutcomeSimulationPool();
    const digest = createHash("sha256");
    let columns = 0;
    const started = Date.now();
    try {
      for (const position of ["QB", "RB", "WR", "TE", "K", "DST"] as const) {
        const inputs = (["contextual", "availability-aware-recency"] as const).map((strategy) =>
          denseSimulationInput(position, strategy),
        );
        const expected = inputs.map(simulateFirstPartyRosOutcomes);
        const actual = await Promise.all(inputs.map(pool.simulate));
        for (const [index, outcome] of actual.entries()) {
          const serial = expected[index]!;
          expect(outcome.schemaVersion).toBe(serial.schemaVersion);
          expect(outcome.modelVersion).toBe(serial.modelVersion);
          expect(outcome.scenarioCount).toBe(16_384);
          expect(outcome.metadata).toEqual(serial.metadata);
          expect(bytes(outcome.games).equals(bytes(serial.games))).toBe(true);
          expect(Object.keys(outcome.columns)).toEqual(Object.keys(serial.columns));
          digest.update(JSON.stringify(outcome.metadata));
          digest.update(bytes(outcome.games));
          for (const [stat, column] of Object.entries(outcome.columns)) {
            expect(
              bytes(column).equals(bytes(serial.columns[stat]!)),
              `${position}/${inputs[index]!.strategy}/${stat}`,
            ).toBe(true);
            digest.update(stat);
            digest.update(bytes(column));
            columns += 1;
          }
        }
      }
      expect(pool.stats()).toMatchObject({
        workersCreated: 2,
        peakActive: 2,
        active: 0,
        queued: 0,
      });
      expect(pool.stats().peakMemory.heapLimit).toBeLessThan(600 * 1_024 * 1_024);
      expect(pool.stats().peakMemory.heapLimit).toBeGreaterThan(400 * 1_024 * 1_024);
      process.stdout.write(
        `${JSON.stringify({ event: "ros-worker-byte-proof", forecasts: 12, scenarios: 16_384, columns, sha256: digest.digest("hex"), elapsedSeconds: (Date.now() - started) / 1000, ...pool.stats() })}\n`,
      );
    } finally {
      await pool.close();
    }
  }, 180_000);
});
