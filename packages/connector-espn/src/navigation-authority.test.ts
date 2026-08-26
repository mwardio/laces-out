import { describe, expect, it } from "vitest";

import type { EspnSessionArtifact } from "./session-client.js";
import { normalizeEspnNavigationManagerAuthority } from "./navigation-authority.js";

const leagueId = "123456789";
const season = 2026;
const activeMemberId = "{123e4567-e89b-42d3-a456-426614174000}";
const otherMemberId = "{223e4567-e89b-42d3-a456-426614174000}";

function artifact(
  members: readonly Record<string, unknown>[],
  overrides: Partial<EspnSessionArtifact> = {},
): EspnSessionArtifact {
  return {
    leagueId,
    season,
    endpoint:
      `https://lm-api-reads.fantasy.espn.com/apis/v3/games/ffl/seasons/${season}` +
      `/segments/0/leagues/${leagueId}?view=mNav`,
    capturedAt: "2026-08-26T18:00:00.000Z",
    checksumSha256: "a".repeat(64),
    payload: { id: leagueId, seasonId: season, members },
    ...overrides,
  };
}

describe("ESPN navigation member authority", () => {
  it.each([
    [{ id: activeMemberId, isLeagueManager: true }, true],
    [{ id: activeMemberId, isLeagueManager: false, isLeagueCreator: true }, true],
    [
      {
        id: activeMemberId,
        isLeagueManager: false,
        isLeagueCreator: false,
        isLeagueAdmin: true,
      },
      true,
    ],
    [{ id: activeMemberId, isLeagueManager: false, isLeagueCreator: false }, false],
    [{ id: activeMemberId, isLeagueManager: false }, null],
    [{ id: activeMemberId }, null],
  ] as const)("resolves only explicit exact-member evidence %#", (member, expected) => {
    expect(normalizeEspnNavigationManagerAuthority(artifact([member]), activeMemberId)).toBe(
      expected,
    );
  });

  it("does not borrow a co-manager's authority", () => {
    expect(
      normalizeEspnNavigationManagerAuthority(
        artifact([
          { id: activeMemberId, isLeagueManager: false, isLeagueCreator: false },
          { id: otherMemberId, isLeagueManager: true, isLeagueCreator: false },
        ]),
        activeMemberId,
      ),
    ).toBe(false);
  });

  it("returns unknown for missing or canonically ambiguous active members", () => {
    expect(
      normalizeEspnNavigationManagerAuthority(
        artifact([{ id: otherMemberId, isLeagueManager: true, isLeagueCreator: true }]),
        activeMemberId,
      ),
    ).toBeNull();

    expect(
      normalizeEspnNavigationManagerAuthority(
        artifact([
          { id: activeMemberId, isLeagueManager: true },
          { id: activeMemberId.slice(1, -1).toUpperCase(), isLeagueManager: false },
        ]),
        activeMemberId,
      ),
    ).toBeNull();
  });

  it("rejects league, season, and endpoint boundary drift", () => {
    expect(() =>
      normalizeEspnNavigationManagerAuthority(
        artifact([{ id: activeMemberId, isLeagueManager: true }], {
          payload: {
            id: "999",
            seasonId: season,
            members: [{ id: activeMemberId, isLeagueManager: true }],
          },
        }),
        activeMemberId,
      ),
    ).toThrow(/enclosed league payload/u);

    expect(() =>
      normalizeEspnNavigationManagerAuthority(
        artifact([{ id: activeMemberId, isLeagueManager: true }], {
          payload: {
            id: leagueId,
            seasonId: 2025,
            members: [{ id: activeMemberId, isLeagueManager: true }],
          },
        }),
        activeMemberId,
      ),
    ).toThrow(/enclosed league payload/u);

    for (const endpoint of [
      `https://lm-api-reads.fantasy.espn.com/apis/v3/games/ffl/seasons/${season}/segments/0/leagues/${leagueId}?view=mTeam`,
      `https://lm-api-reads.fantasy.espn.com/apis/v3/games/ffl/seasons/${season}/segments/0/leagues/${leagueId}?view=mNav&view=mTeam`,
      `https://example.com/apis/v3/games/ffl/seasons/${season}/segments/0/leagues/${leagueId}?view=mNav`,
    ]) {
      expect(() =>
        normalizeEspnNavigationManagerAuthority(
          artifact([{ id: activeMemberId, isLeagueManager: true }], { endpoint }),
          activeMemberId,
        ),
      ).toThrow(/navigation endpoint/u);
    }
  });

  it("rejects duplicate raw member IDs and sanitizes schema issues", () => {
    const privateValue = "private-provider-value-must-not-escape";
    try {
      normalizeEspnNavigationManagerAuthority(
        artifact([
          { id: activeMemberId, isLeagueManager: false },
          { id: activeMemberId, isLeagueManager: privateValue },
        ]),
        activeMemberId,
      );
      throw new Error("expected navigation validation to fail");
    } catch (error) {
      expect(JSON.stringify(error)).not.toContain(privateValue);
    }
  });
});
