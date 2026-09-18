import { assertProjectionRefreshJob, type ProjectionRefreshJob } from "@laces-out/jobs";

export const WEEKLY_PROJECTION_PROCESS_PROTOCOL = 1;
export interface WeeklyProjectionProcessRequest {
  readonly type: "refresh";
  readonly id: number;
  readonly job: ProjectionRefreshJob;
  readonly jobId: string;
}
export interface WeeklyProjectionProcessMemory {
  readonly rss: number;
  readonly heapLimit: number;
  readonly heapUsed?: number;
  readonly heapTotal?: number;
  readonly external?: number;
  readonly arrayBuffers?: number;
}
export type WeeklyProjectionProcessResponse =
  | { readonly type: "ready"; readonly protocol: 1 }
  | {
      readonly type: "result";
      readonly id: number;
      readonly ok: boolean;
      readonly error?: { readonly name: string; readonly code?: string };
      readonly memory?: WeeklyProjectionProcessMemory;
    };

/** Only named, nonnegative byte counts may reach lifecycle logs, including from older children. */
export function weeklyProjectionProcessMemory(
  value: unknown,
): WeeklyProjectionProcessMemory | undefined {
  if (value === null || typeof value !== "object") return undefined;
  const memory = value as Record<string, unknown>;
  const bytes = (candidate: unknown): candidate is number =>
    typeof candidate === "number" && Number.isSafeInteger(candidate) && candidate >= 0;
  if (!bytes(memory.rss) || !bytes(memory.heapLimit)) return undefined;
  return {
    rss: memory.rss,
    heapLimit: memory.heapLimit,
    ...Object.fromEntries(
      ["heapUsed", "heapTotal", "external", "arrayBuffers"].flatMap((key) =>
        bytes(memory[key]) ? [[key, memory[key]]] : [],
      ),
    ),
  };
}

export function isWeeklyProjectionProcessRequest(
  value: unknown,
): value is WeeklyProjectionProcessRequest {
  if (value === null || typeof value !== "object") return false;
  const request = value as Partial<WeeklyProjectionProcessRequest>;
  if (
    request.type !== "refresh" ||
    !Number.isSafeInteger(request.id) ||
    request.id! < 1 ||
    typeof request.jobId !== "string" ||
    request.jobId.length < 1 ||
    request.jobId.length > 256 ||
    request.job === null ||
    typeof request.job !== "object"
  )
    return false;
  try {
    assertProjectionRefreshJob(request.job);
    return true;
  } catch {
    return false;
  }
}

/** SQL and connection errors can carry credentials or job data; IPC exposes only bounded tokens. */
export function weeklyProjectionProcessError(error: unknown): { name: string; code?: string } {
  const detail = error !== null && typeof error === "object" ? error : {};
  const name =
    "name" in detail &&
    typeof detail.name === "string" &&
    /^[a-zA-Z0-9_.-]{1,80}$/.test(detail.name)
      ? detail.name
      : "Error";
  const code =
    "code" in detail &&
    typeof detail.code === "string" &&
    /^[a-zA-Z0-9_.-]{1,80}$/.test(detail.code)
      ? detail.code
      : undefined;
  return { name, ...(code === undefined ? {} : { code }) };
}
