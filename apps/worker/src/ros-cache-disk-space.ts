import { statfs } from "node:fs/promises";

/** Operational headroom for the database and app; never part of an immutable evidence identity. */
export const ROS_CACHE_MINIMUM_FREE_BYTES = 5n * 1_024n * 1_024n * 1_024n;

export class RosCacheDiskSpaceError extends Error {
  readonly availableBytes: string | undefined;
  readonly requiredFreeBytes: string | undefined;

  constructor(
    readonly code: "insufficient_disk_space" | "disk_space_check_failed",
    availableBytes?: bigint,
    requiredFreeBytes?: bigint,
  ) {
    super(
      code === "insufficient_disk_space"
        ? `ROS cache write stopped to preserve disk headroom (${String(availableBytes)} bytes available; ${String(requiredFreeBytes)} required).`
        : "ROS cache write stopped because available disk headroom could not be verified.",
    );
    this.name = "RosCacheDiskSpaceError";
    this.availableBytes = availableBytes?.toString();
    this.requiredFreeBytes = requiredFreeBytes?.toString();
  }
}

/** zlib's conservative bound plus gzip framing, before compressed size is known. */
export function rosCacheCompressedWriteBudget(dataBytes: number): number {
  if (!Number.isSafeInteger(dataBytes) || dataBytes < 0)
    throw new RangeError("Invalid cache byte budget");
  return (
    dataBytes +
    Math.floor(dataBytes / 4_096) +
    Math.floor(dataBytes / 16_384) +
    Math.floor(dataBytes / 33_554_432) +
    64
  );
}

/**
 * Check user-available filesystem blocks before a bounded write. This is a headroom check, not
 * a filesystem quota: unrelated writers can still consume space after the observation.
 */
export async function assertRosCacheHeadroom(
  directory: string,
  pendingBytes: number,
  signal?: AbortSignal,
): Promise<void> {
  if (!Number.isSafeInteger(pendingBytes) || pendingBytes < 0)
    throw new RangeError("Invalid cache byte budget");
  signal?.throwIfAborted();
  let stats;
  try {
    stats = await statfs(directory, { bigint: true });
  } catch {
    signal?.throwIfAborted();
    throw new RosCacheDiskSpaceError("disk_space_check_failed");
  }
  signal?.throwIfAborted();
  if (stats.bavail < 0n || stats.bsize <= 0n)
    throw new RosCacheDiskSpaceError("disk_space_check_failed");
  const available = stats.bavail * stats.bsize;
  const required = ROS_CACHE_MINIMUM_FREE_BYTES + BigInt(pendingBytes);
  if (available < required)
    throw new RosCacheDiskSpaceError("insufficient_disk_space", available, required);
}
