import { createHash } from "node:crypto";

import {
  FIRST_PARTY_ROS_DEFAULT_SCENARIOS,
  projectFirstPartyRestOfSeasonProfiles,
  projectionScoringProfileKey,
  type FirstPartyRosProjection,
  type FirstPartyRosProjectionInput,
  type ProjectionScoringProfile,
} from "@laces-out/projections";

/** Per-refresh, bounded summaries. Physical paths are streamed and immediately discarded. */
export function createRosLiveProjectionReuse(options: {
  readonly profiles: readonly ProjectionScoringProfile[];
  readonly maximumBytes?: number;
  readonly simulate?: typeof projectFirstPartyRestOfSeasonProfiles;
}): (input: FirstPartyRosProjectionInput) => FirstPartyRosProjection {
  const maximumBytes = options.maximumBytes ?? 128 * 1_024 * 1_024;
  if (!Number.isSafeInteger(maximumBytes) || maximumBytes < 0 || maximumBytes > 128 * 1_024 * 1_024)
    throw new RangeError("Invalid live ROS summary cache bound");
  // Copy caller-owned rule objects so later league synchronization cannot alter this batch.
  const profiles = new Map(
    options.profiles.map((profile) => {
      const snapshot = structuredClone(profile);
      return [projectionScoringProfileKey(snapshot), snapshot] as const;
    }),
  );
  const ordered = [...profiles].sort(([left], [right]) => left.localeCompare(right));
  const cache = new Map<
    string,
    { bytes: number; projections: ReadonlyMap<string, FirstPartyRosProjection> }
  >();
  let bytes = 0;
  return (input) => {
    const { scoringProfile, ...football } = input;
    const profileKey = projectionScoringProfileKey(scoringProfile);
    const index = ordered.findIndex(([key]) => key === profileKey);
    if (index < 0) throw new Error("Live ROS scoring profile was not pinned for this refresh");
    // Batches limit temporary point-array memory even if hundreds of distinct leagues join.
    const batchStart = Math.floor(index / 32) * 32;
    const selected = ordered.slice(batchStart, batchStart + 32).map(([, profile]) => profile);
    const identity = createHash("sha256")
      .update(
        JSON.stringify({
          football: {
            ...football,
            scenarioCount: input.scenarioCount ?? FIRST_PARTY_ROS_DEFAULT_SCENARIOS,
          },
          batchStart,
        }),
      )
      .digest("hex");
    const hit = cache.get(identity);
    if (hit) {
      cache.delete(identity);
      cache.set(identity, hit);
      return structuredClone(hit.projections.get(profileKey)!);
    }
    const projected = (options.simulate ?? projectFirstPartyRestOfSeasonProfiles)(
      football,
      selected,
    );
    const value = projected.get(profileKey);
    if (!value) throw new Error("ROS simulation omitted a pinned scoring profile");
    const size = Buffer.byteLength(JSON.stringify([...projected]));
    while (bytes + size > maximumBytes && cache.size > 0) {
      const oldest = cache.entries().next().value!;
      bytes -= oldest[1].bytes;
      cache.delete(oldest[0]);
    }
    if (size <= maximumBytes) {
      cache.set(identity, { bytes: size, projections: projected });
      bytes += size;
    }
    return structuredClone(value);
  };
}
