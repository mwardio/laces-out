import type { Database } from "@fantasy/db";
import { describe, expect, it, vi } from "vitest";

import {
  currentManagedProjectionProfileKey,
  MANAGED_PROJECTION_SCORING_RULE_LIMIT,
} from "./managed-projection-profile.js";

function boundedReadDatabase(ruleCount: number): {
  readonly database: Database;
  readonly leagueLimit: ReturnType<typeof vi.fn>;
  readonly scoringLimit: ReturnType<typeof vi.fn>;
} {
  const leagueLimit = vi.fn(() => Promise.resolve([{ provider: "espn" }]));
  const scoringLimit = vi.fn(() =>
    Promise.resolve(
      Array.from({ length: ruleCount }, () => ({
        statKey: "3",
        operation: "multiply",
        points: "0.04",
        thresholdLow: null,
        thresholdHigh: null,
        providerStatId: "3",
      })),
    ),
  );
  const select = vi
    .fn()
    .mockReturnValueOnce({
      from: () => ({
        where: () => ({ limit: leagueLimit }),
      }),
    })
    .mockReturnValueOnce({
      from: () => ({
        where: () => ({ limit: scoringLimit }),
      }),
    });
  return {
    database: { select } as unknown as Database,
    leagueLimit,
    scoringLimit,
  };
}

describe("currentManagedProjectionProfileKey", () => {
  it("bounds the scoring-rule read and fails closed at the sentinel", async () => {
    const { database, leagueLimit, scoringLimit } = boundedReadDatabase(
      MANAGED_PROJECTION_SCORING_RULE_LIMIT,
    );

    await expect(
      currentManagedProjectionProfileKey(database, "30000000-0000-4000-8000-000000000001"),
    ).resolves.toBeNull();
    expect(leagueLimit).toHaveBeenCalledWith(1);
    expect(scoringLimit).toHaveBeenCalledWith(MANAGED_PROJECTION_SCORING_RULE_LIMIT);
  });
});
