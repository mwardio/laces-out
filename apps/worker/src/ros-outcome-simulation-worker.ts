import { getHeapStatistics } from "node:v8";
import {
  simulateFirstPartyRosOutcomes,
  type FirstPartyRosOutcomeInput,
} from "@laces-out/projections";

if (process.send === undefined) throw new Error("ROS outcome simulation requires an IPC child");
process.on("disconnect", () => process.exit(0));
process.on(
  "message",
  (message: { readonly id: number; readonly input: FirstPartyRosOutcomeInput }) => {
    try {
      const result = simulateFirstPartyRosOutcomes(message.input);
      const memory = process.memoryUsage();
      process.send!({
        id: message.id,
        ok: true,
        result,
        memory: {
          rss: memory.rss,
          heapUsed: memory.heapUsed,
          external: memory.external,
          heapLimit: getHeapStatistics().heap_size_limit,
        },
      });
    } catch (error) {
      process.send!({
        id: message.id,
        ok: false,
        error: (error instanceof Error ? error.message : "ROS outcome simulation failed").slice(
          0,
          512,
        ),
      });
    }
  },
);
