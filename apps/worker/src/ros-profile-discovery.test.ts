import { rosProfileDefinitionFromKey, type StoredLeagueScoringRule } from "@laces-out/projections";
import type * as Projections from "@laces-out/projections";
import { describe, expect, it, vi } from "vitest";

import fixtures from "../../../packages/projections/src/ros-scoring-live-shapes.fixture.json" with { type: "json" };
import { discoverRosScoringProfiles } from "./ros-profile-discovery.js";

vi.mock("@laces-out/projections", async (importOriginal) => {
  const actual = await importOriginal<typeof Projections>();
  return { ...actual, rosProfileDefinitionFromKey: vi.fn(actual.rosProfileDefinitionFromKey) };
});

function rules(index = 0): StoredLeagueScoringRule[] {
  const fixture = fixtures[index]!;
  return fixture.rules.map((rule) => ({
    ...rule,
    provider: fixture.provider,
  }));
}

describe("ROS scoring discovery", () => {
  it("discovers all four real provider shapes and shares a proof across identical leagues", () => {
    const result = discoverRosScoringProfiles([
      ...fixtures.map((_, index) => ({ leagueSeasonId: `league-${index}`, rules: rules(index) })),
      { leagueSeasonId: "another-member", rules: rules() },
    ]);
    expect(result.unsupportedLeagueSeasonIds).toEqual([]);
    expect(result.profiles).toHaveLength(4);
    expect(result.profiles[0]?.leagueSeasonIds).toEqual(["league-0", "another-member"]);
    expect(result.profiles.map((profile) => profile.definition.digest)).toEqual(
      fixtures.map((fixture) => fixture.digest),
    );
  });

  it("discovers a new numeric scoring variation without any catalog code change", () => {
    const changed = rules().map((rule) =>
      rule.providerStatId === "20" ? { ...rule, points: -1.5 } : rule,
    );
    const result = discoverRosScoringProfiles([{ leagueSeasonId: "new-format", rules: changed }]);
    expect(result.profiles).toHaveLength(1);
    expect(fixtures.map((fixture) => fixture.digest)).not.toContain(
      result.profiles[0]?.definition.digest,
    );
  });

  it("does not authorize an unknown nonzero rule by dropping it", () => {
    const result = discoverRosScoringProfiles([
      {
        leagueSeasonId: "unknown",
        rules: [
          ...rules(),
          {
            provider: "espn",
            statKey: "999999",
            providerStatId: "999999",
            operation: "multiply",
            points: 10,
          },
        ],
      },
    ]);
    expect(result.profiles).toEqual([]);
    expect(result.unsupportedLeagueSeasonIds).toEqual(["unknown"]);
  });

  it("does not invent a profile for empty league rules", () => {
    expect(discoverRosScoringProfiles([{ leagueSeasonId: "incomplete-sync", rules: [] }])).toEqual({
      profiles: [],
      unsupportedLeagueSeasonIds: ["incomplete-sync"],
    });
  });

  it("isolates strict identity rejection to the affected league", () => {
    vi.mocked(rosProfileDefinitionFromKey).mockImplementationOnce(() => {
      throw new TypeError("Oversized scoring identity");
    });
    const result = discoverRosScoringProfiles([
      { leagueSeasonId: "rejected", rules: rules() },
      { leagueSeasonId: "healthy", rules: rules(1) },
    ]);
    expect(result.unsupportedLeagueSeasonIds).toEqual(["rejected"]);
    expect(result.profiles.map((profile) => profile.leagueSeasonIds)).toEqual([["healthy"]]);
  });

  it("keeps a digest collision as a hard failure", () => {
    const [first, second] = discoverRosScoringProfiles([
      { leagueSeasonId: "one", rules: rules() },
      { leagueSeasonId: "two", rules: rules(1) },
    ]).profiles;
    vi.mocked(rosProfileDefinitionFromKey)
      .mockReturnValueOnce(first!.definition)
      .mockReturnValueOnce({ ...second!.definition, digest: first!.definition.digest });
    expect(() =>
      discoverRosScoringProfiles([
        { leagueSeasonId: "one", rules: rules() },
        { leagueSeasonId: "two", rules: rules(1) },
      ]),
    ).toThrow(/collision/);
  });
});
