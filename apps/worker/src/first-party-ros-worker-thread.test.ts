import { describe, expect, it, vi } from "vitest";

import type {
  FirstPartyRosCandidateContext,
  FirstPartyRosCandidateProvider,
} from "./first-party-ros-projections.js";
import { buildVerifiedFirstPartyRosTargets } from "./first-party-ros-worker-thread.js";

const expectedChecksum = "a".repeat(64);
const changedChecksum = "b".repeat(64);
const context = {
  season: 2026,
  window: {
    asOfWeek: 4,
    currentWeek: 5,
    windowStartWeek: 5,
    windowEndWeek: 18,
    currentWeekStarted: false,
  },
  candidateProviderChecksum: expectedChecksum,
} as FirstPartyRosCandidateContext;

function providerWithChecksums(checksums: readonly string[]) {
  let index = 0;
  const buildTargets = vi.fn(async () => []);
  return {
    provider: {
      sourceChecksum: async () => checksums[Math.min(index++, checksums.length - 1)]!,
      buildTargets,
    } satisfies FirstPartyRosCandidateProvider,
    buildTargets,
  };
}

describe("buildVerifiedFirstPartyRosTargets", () => {
  it("returns targets when the provider input snapshot matches", async () => {
    const fixture = providerWithChecksums([expectedChecksum, expectedChecksum]);

    await expect(
      buildVerifiedFirstPartyRosTargets({ provider: fixture.provider, context }),
    ).resolves.toEqual([]);
    expect(fixture.buildTargets).toHaveBeenCalledTimes(1);
  });

  it("does not start a build whose inputs no longer match the main-thread checksum", async () => {
    const fixture = providerWithChecksums([changedChecksum]);

    await expect(
      buildVerifiedFirstPartyRosTargets({ provider: fixture.provider, context }),
    ).rejects.toThrow("changed before artifact simulation");
    expect(fixture.buildTargets).not.toHaveBeenCalled();
  });

  it("keeps a materialized snapshot valid when live inputs subsequently change", async () => {
    const fixture = providerWithChecksums([expectedChecksum, changedChecksum]);

    await expect(
      buildVerifiedFirstPartyRosTargets({ provider: fixture.provider, context }),
    ).resolves.toEqual([]);
    expect(fixture.buildTargets).toHaveBeenCalledTimes(1);
  });
});
