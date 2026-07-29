import type { Database } from "@fantasy/db";
import { describe, expect, it, vi } from "vitest";

import {
  currentManagedProjectionProfile,
  currentManagedProjectionProfileKey,
  MANAGED_PROJECTION_SCORING_RULE_LIMIT,
} from "./managed-projection-profile.js";

interface RawRuleRow {
  readonly statKey: string;
  readonly operation: string;
  readonly points: string;
  readonly thresholdLow: string | null;
  readonly thresholdHigh: string | null;
  readonly providerStatId: string | null;
}

function rawRule(providerStatId: string, statKey: string, points: string): RawRuleRow {
  return {
    statKey,
    operation: "multiply",
    points,
    thresholdLow: null,
    thresholdHigh: null,
    providerStatId,
  };
}

function mockedDatabase(
  rows: readonly RawRuleRow[],
  provider: "espn" | "yahoo" = "espn",
): {
  readonly database: Database;
  readonly leagueLimit: ReturnType<typeof vi.fn>;
  readonly scoringLimit: ReturnType<typeof vi.fn>;
} {
  const leagueLimit = vi.fn(() => Promise.resolve([{ provider }]));
  const scoringLimit = vi.fn(() => Promise.resolve(rows));
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

function boundedReadDatabase(ruleCount: number): {
  readonly database: Database;
  readonly leagueLimit: ReturnType<typeof vi.fn>;
  readonly scoringLimit: ReturnType<typeof vi.fn>;
} {
  return mockedDatabase(Array.from({ length: ruleCount }, () => rawRule("3", "3", "0.04")));
}

/**
 * Sanitized, minimal transcription of a real garagely-shaped league: a supported offensive rule
 * (ESPN stat 3, passing yards) alongside a D/ST bracket override
 * (`132:slot:16` — an accepted yards-allowed tier rule since WP2 of
 * `docs/ROS_GATE_AND_DST_PLAN.md`, but excluded from the emitted profile while D/ST is
 * unsupported) and a bare D/ST-only unsupported stat (`205`, ESPN's "Defensive 2pt Return").
 * Under the position-scoped core, this normalizes to `available` (QB supported) even though D/ST
 * is not — the exact case that used to collapse `currentManagedProjectionProfileKey` to null.
 *
 * The unsupported stat used to be `206`; that ID became a priced de minimis zero component on
 * 2026-07-29 (`docs/dst-stat-id-evidence-2026-07-29.md` §4), so this fixture now uses the
 * defense-specific variant, which has no recorded occurrence bound and stays unsupported. The
 * behavior under test — a league whose D/ST cannot be priced still yields a key for the positions
 * that can — is unchanged; only the ID that demonstrates it moved.
 */
const GARAGELY_SHAPED_ROWS: readonly RawRuleRow[] = [
  rawRule("3", "3", "0.04"),
  rawRule("132:slot:16", "ESPN stat 132 override for D/ST", "-1"),
  rawRule("205", "205", "2"),
];

/** Every rule here is D/ST-only-scoped, so zero positions ever become supported. */
const ZERO_SUPPORTED_POSITION_ROWS: readonly RawRuleRow[] = [rawRule("205", "205", "2")];

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

  it("returns a non-null key for a garagely-shaped rule set whose profile excludes D/ST-only rules", async () => {
    const { database } = mockedDatabase(GARAGELY_SHAPED_ROWS);

    const key = await currentManagedProjectionProfileKey(
      database,
      "30000000-0000-4000-8000-000000000002",
    );

    expect(key).not.toBeNull();
    const rules = JSON.parse(key!) as readonly { readonly statId: string }[];
    expect(rules.map((rule) => rule.statId)).toEqual(["passing_yards"]);
    // D/ST is unsupported (205), so nothing D/ST-scoped may leak into the key — including the
    // accepted-but-excluded `132:slot:16` yards-allowed tier rule.
    expect(rules.some((rule) => rule.statId.includes("yards_allowed"))).toBe(false);
    expect(rules.some((rule) => rule.statId.includes("points_allowed"))).toBe(false);
  });

  it("prices a yards-allowed tier rule when D/ST is the supported position (fan-out carries WP1's components)", async () => {
    // WP2 Step 5 (`docs/ROS_GATE_AND_DST_PLAN.md`): this package's private
    // `availableComponents` union spreads `firstPartyTeamDefenseProjectionComponents()`, so the
    // nine yards-allowed tiers must be available here without edits. If they were not,
    // COMPONENT_UNAVAILABLE would withhold D/ST and this key would be null.
    const { database } = mockedDatabase([rawRule("128", "128", "5")]);

    const key = await currentManagedProjectionProfileKey(
      database,
      "30000000-0000-4000-8000-000000000008",
    );

    expect(key).not.toBeNull();
    const rules = JSON.parse(key!) as readonly { readonly statId: string }[];
    expect(rules.map((rule) => rule.statId)).toEqual(["yards_allowed_0_99_probability"]);
  });

  it("returns null for a rule set where zero positions are supported", async () => {
    const { database } = mockedDatabase(ZERO_SUPPORTED_POSITION_ROWS);

    await expect(
      currentManagedProjectionProfileKey(database, "30000000-0000-4000-8000-000000000003"),
    ).resolves.toBeNull();
  });
});

describe("currentManagedProjectionProfile", () => {
  it("reports per-position support for a garagely-shaped rule set (QB supported, D/ST not)", async () => {
    const { database } = mockedDatabase(GARAGELY_SHAPED_ROWS);

    const profile = await currentManagedProjectionProfile(
      database,
      "30000000-0000-4000-8000-000000000004",
    );

    expect(profile.key).not.toBeNull();
    expect(profile.positions).not.toBeNull();
    const qb = profile.positions?.find((item) => item.position === "QB");
    const dst = profile.positions?.find((item) => item.position === "DST");
    expect(qb?.supported).toBe(true);
    expect(dst?.supported).toBe(false);
    expect(dst?.reasons.length).toBeGreaterThan(0);
  });

  it("returns null positions only at the bounded-read sentinel", async () => {
    const { database } = boundedReadDatabase(MANAGED_PROJECTION_SCORING_RULE_LIMIT);

    const profile = await currentManagedProjectionProfile(
      database,
      "30000000-0000-4000-8000-000000000005",
    );

    expect(profile).toEqual({ key: null, positions: null });
  });

  it("returns a non-null positions array (all unsupported) when zero positions are supported", async () => {
    const { database } = mockedDatabase(ZERO_SUPPORTED_POSITION_ROWS);

    const profile = await currentManagedProjectionProfile(
      database,
      "30000000-0000-4000-8000-000000000006",
    );

    expect(profile.key).toBeNull();
    expect(profile.positions).not.toBeNull();
    expect(profile.positions?.every((item) => !item.supported)).toBe(true);
  });

  it("returns non-null (all-unsupported) positions, not the sentinel, when no season is stored", async () => {
    const leagueLimit = vi.fn(() => Promise.resolve([]));
    const select = vi.fn().mockReturnValueOnce({
      from: () => ({
        where: () => ({ limit: leagueLimit }),
      }),
    });
    const database = { select } as unknown as Database;

    const profile = await currentManagedProjectionProfile(
      database,
      "30000000-0000-4000-8000-000000000007",
    );

    expect(profile.key).toBeNull();
    // Distinct from the bounded-read sentinel: this league was never even truncated, it just does
    // not exist, so `positions` still reports a real (all-unsupported) per-position breakdown.
    expect(profile.positions).not.toBeNull();
    expect(profile.positions?.every((item) => !item.supported)).toBe(true);
    expect(select).toHaveBeenCalledTimes(1);
  });
});
