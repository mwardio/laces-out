import { getHeapStatistics } from "node:v8";
import { createDatabase, type Database } from "@laces-out/db";
import type { ProjectionRefreshService } from "./jobs.js";
import { FirstPartyProjectionService } from "./first-party-projections.js";
import {
  WEEKLY_PROJECTION_PROCESS_PROTOCOL,
  isWeeklyProjectionProcessRequest,
  weeklyProjectionProcessError,
  type WeeklyProjectionProcessResponse,
} from "./first-party-projection-process-protocol.js";

/** One service instance keeps its training cache across sequential requests. */
export function startWeeklyProjectionProcess(input: {
  readonly connectionString: string;
  readonly createService?: (database: Database) => ProjectionRefreshService;
}): void {
  if (!process.send) throw new Error("Weekly projection worker requires an IPC parent");
  const database = createDatabase(input.connectionString, 2);
  const service =
    input.createService?.(database.db) ??
    new FirstPartyProjectionService({ database: database.db });
  let active: { readonly id: number; readonly controller: AbortController } | undefined;
  let closing: Promise<void> | undefined;
  const close = (code: number): Promise<void> => {
    if (closing) return closing;
    active?.controller.abort(new Error("Weekly projection worker is stopping"));
    closing = database
      .close()
      .catch(() => undefined)
      .then(() => {
        process.exitCode = code;
        if (process.connected) process.disconnect();
      });
    return closing;
  };
  const send = (message: WeeklyProjectionProcessResponse): void => {
    if (closing || !process.connected) return;
    try {
      process.send!(message, (error) => {
        if (error) void close(1);
      });
    } catch {
      void close(1);
    }
  };
  process.on("message", (message: unknown) => {
    if (closing) return;
    if (!isWeeklyProjectionProcessRequest(message) || active) {
      void close(1);
      return;
    }
    const controller = new AbortController();
    active = { id: message.id, controller };
    void (async () => {
      let response: WeeklyProjectionProcessResponse;
      try {
        await service.refreshProjections(message.job, {
          jobId: message.jobId,
          signal: controller.signal,
        });
        response = { type: "result", id: message.id, ok: true };
      } catch (error) {
        response = {
          type: "result",
          id: message.id,
          ok: false,
          error: weeklyProjectionProcessError(error),
        };
      }
      active = undefined;
      send({
        ...response,
        memory: { ...process.memoryUsage(), heapLimit: getHeapStatistics().heap_size_limit },
      });
    })().catch(() => {
      void close(1);
    });
  });
  process.once("disconnect", () => {
    void close(1);
  });
  process.once("SIGTERM", () => {
    void close(0);
  });
  process.once("SIGINT", () => {
    void close(0);
  });
  send({ type: "ready", protocol: WEEKLY_PROJECTION_PROCESS_PROTOCOL });
}
