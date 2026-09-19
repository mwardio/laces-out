import { describe, expect, it } from "vitest";

import type { DecisionProjectionPlayerRow } from "./in-season-decisions.js";
import {
  reconcileRosterProjectionAliases,
  type ProjectionExternalIdentity,
  type ProjectionRosterIdentity,
} from "./projection-roster-aliases.js";

const canonical: DecisionProjectionPlayerRow = {
  playerId: "canonical",
  gsisId: "00-0040878",
  name: "Mike Washington Jr.",
  primaryPosition: "RB",
  eligiblePositions: ["RB"],
  nflTeam: "LV",
  status: "ACTIVE",
  meanPoints: "84.247",
  floorPoints: "40.123",
  ceilingPoints: "120.456",
};
const roster: ProjectionRosterIdentity = { ...canonical, playerId: "roster", gsisId: null };
const scopedId: ProjectionExternalIdentity = {
  playerId: roster.playerId,
  source: "espn-self-asserted",
  externalId: "league:4686658",
};
const resolve = (
  options: {
    rosterPlayers?: readonly ProjectionRosterIdentity[];
    projections?: readonly DecisionProjectionPlayerRow[];
    externalIds?: readonly ProjectionExternalIdentity[];
    externalEvidenceComplete?: boolean;
  } = {},
) =>
  reconcileRosterProjectionAliases({
    leagueSeasonId: "league",
    rosterPlayers: [roster],
    projections: [canonical],
    externalIds: [scopedId],
    externalEvidenceComplete: true,
    ...options,
  });

describe("current roster aliases for approved projections", () => {
  it("reads exact trusted name/team/position matches despite an unbridged provider ID", () => {
    expect(resolve()).toEqual([
      { ...canonical, ...roster, projectionPlayerId: canonical.playerId },
    ]);
  });

  it.each(["CLE", "BAL", "PIT", "LA", "WSH"])(
    "matches a unique %s defense regardless of display name",
    (nflTeam) => {
      const canonicalTeam = nflTeam === "LA" ? "LAR" : nflTeam === "WSH" ? "WAS" : nflTeam;
      expect(
        resolve({
          rosterPlayers: [{ ...roster, name: "Provider D/ST", nflTeam, primaryPosition: "DEF" }],
          projections: [
            {
              ...canonical,
              name: "Canonical D/ST",
              gsisId: null,
              nflTeam: canonicalTeam,
              primaryPosition: "D/ST",
            },
          ],
        }),
      ).toMatchObject([
        {
          playerId: roster.playerId,
          projectionPlayerId: canonical.playerId,
          meanPoints: canonical.meanPoints,
        },
      ]);
    },
  );

  it("uses an explicit provider crosswalk when the name differs", () => {
    expect(
      resolve({
        rosterPlayers: [{ ...roster, name: "M. Washington" }],
        externalIds: [
          scopedId,
          { playerId: canonical.playerId, source: "sleeper-espn", externalId: "4686658" },
        ],
      }),
    ).toHaveLength(1);
  });

  it.each(["470.p.26686", "461.p.26686", "nfl.p.26686", "26686"])(
    "joins Yahoo roster key %s to a numeric crosswalk for projections and health",
    (externalId) => {
      expect(
        resolve({
          rosterPlayers: [{ ...roster, name: "Different Provider Display Name" }],
          externalIds: [
            { playerId: roster.playerId, source: "yahoo", externalId },
            { playerId: canonical.playerId, source: "sleeper-yahoo", externalId: "26686" },
          ],
        }),
      ).toEqual([
        {
          ...canonical,
          ...roster,
          name: "Different Provider Display Name",
          projectionPlayerId: canonical.playerId,
        },
      ]);
    },
  );

  it("rejects conflicting normalized Yahoo identities in either order", () => {
    const second = { ...canonical, playerId: "second", gsisId: "00-0040888" };
    const externalIds = [
      { playerId: roster.playerId, source: "yahoo", externalId: "470.p.26686" },
      { playerId: canonical.playerId, source: "sleeper-yahoo", externalId: "26686" },
      { playerId: second.playerId, source: "sleeper-yahoo", externalId: "nfl.p.26686" },
    ];
    for (const rows of [externalIds, [...externalIds].reverse()]) {
      expect(resolve({ projections: [canonical, second], externalIds: rows })).toEqual([]);
    }
  });

  it.each(["nba.p.26686", "470.p.26686.extra", "470.p."])(
    "does not hide invalid Yahoo evidence %s behind exact name matching",
    (externalId) => {
      expect(
        resolve({
          externalIds: [
            { playerId: roster.playerId, source: "yahoo", externalId },
            { playerId: canonical.playerId, source: "sleeper-yahoo", externalId: "26686" },
          ],
        }),
      ).toEqual([]);
    },
  );

  it("does not borrow a scoped crosswalk from another league", () => {
    expect(
      resolve({
        rosterPlayers: [{ ...roster, name: "Different Name" }],
        externalIds: [
          { ...scopedId, externalId: "other-league:4686658" },
          { playerId: canonical.playerId, source: "espn", externalId: "4686658" },
        ],
      }),
    ).toEqual([]);
  });

  it("retains a direct forecast without replacing it with canonical numbers", () => {
    expect(
      resolve({ projections: [canonical, { ...canonical, ...roster, meanPoints: "75" }] }),
    ).toEqual([]);
  });

  it.each([
    { nflTeam: "KC" },
    { primaryPosition: "WR" },
    { gsisId: "00-different" },
    { nflTeam: null },
    { name: "Mike Washington Sr." },
  ])("leaves mismatched or uncertain roster identities uncovered: %j", (difference) => {
    expect(resolve({ rosterPlayers: [{ ...roster, ...difference }] })).toEqual([]);
  });

  it("requires a GSIS catalog identity for a name match", () => {
    expect(resolve({ projections: [{ ...canonical, gsisId: null }] })).toEqual([]);
  });

  it("rejects ambiguous names and defenses", () => {
    expect(
      resolve({
        projections: [canonical, { ...canonical, playerId: "duplicate", gsisId: "00-other" }],
      }),
    ).toEqual([]);
    expect(
      resolve({
        rosterPlayers: [{ ...roster, primaryPosition: "DST" }],
        projections: [canonical, { ...canonical, playerId: "duplicate" }].map((row) => ({
          ...row,
          primaryPosition: "DST",
          gsisId: null,
        })),
      }),
    ).toEqual([]);
  });

  it("rejects conflicting canonical provider IDs even with an exact name", () => {
    expect(
      resolve({
        externalIds: [
          scopedId,
          { playerId: canonical.playerId, source: "espn", externalId: "999" },
        ],
      }),
    ).toEqual([]);
  });

  it("does not fall back to a name when explicit identity points to an incompatible player", () => {
    expect(
      resolve({
        projections: [canonical, { ...canonical, playerId: "linked", nflTeam: "KC" }],
        externalIds: [scopedId, { playerId: "linked", source: "espn", externalId: "4686658" }],
      }),
    ).toEqual([]);
  });

  it("rejects competing roster aliases and an already-rostered canonical identity", () => {
    expect(resolve({ rosterPlayers: [roster, { ...roster, playerId: "second-alias" }] })).toEqual(
      [],
    );
    expect(resolve({ rosterPlayers: [roster, canonical] })).toEqual([]);
  });

  it("does not manufacture a missing forecast", () => {
    expect(resolve({ projections: [] })).toEqual([]);
  });

  it.each([undefined, false])("requires complete external bridge evidence: %s", (complete) => {
    const input = {
      leagueSeasonId: "league",
      rosterPlayers: [roster],
      projections: [canonical],
      externalIds: [
        scopedId,
        { playerId: canonical.playerId, source: "sleeper-espn", externalId: "4686658" },
      ],
    };
    expect(
      reconcileRosterProjectionAliases({
        ...input,
        ...(complete === undefined ? {} : { externalEvidenceComplete: complete }),
      }),
    ).toEqual([]);
  });

  it.each(["sleeper-espn", "espn"])(
    "does not retry a name for a known %s target outside the pool",
    (source) => {
      expect(
        resolve({
          externalIds: [scopedId, { playerId: "outside", source, externalId: "4686658" }],
        }),
      ).toEqual([]);
    },
  );

  it("uses a Sleeper bridge before an unqualified legacy ESPN UUID, while rejecting a different GSIS owner", () => {
    const rows = [
      scopedId,
      { playerId: canonical.playerId, source: "sleeper-espn", externalId: "4686658" },
    ];
    expect(
      resolve({
        externalIds: [
          ...rows,
          { playerId: "legacy", source: "espn", externalId: "4686658", catalogGsisId: null },
        ],
      }),
    ).toHaveLength(1);
    expect(
      resolve({
        externalIds: [
          ...rows,
          { playerId: "outside", source: "espn", externalId: "4686658", catalogGsisId: "00-other" },
        ],
      }),
    ).toEqual([]);
    expect(
      resolve({
        externalIds: [
          scopedId,
          { playerId: "outside", source: "sleeper-espn", externalId: "4686658" },
          {
            playerId: canonical.playerId,
            source: "espn",
            externalId: "4686658",
            catalogGsisId: canonical.gsisId,
          },
        ],
      }),
    ).toEqual([]);
  });

  it.each([false, true])(
    "rejects a Yahoo bridge split across inside and outside targets in either order: %s",
    (reverse) => {
      const externalIds = [
        { playerId: roster.playerId, source: "yahoo", externalId: "470.p.26686" },
        { playerId: canonical.playerId, source: "sleeper-yahoo", externalId: "26686" },
        { playerId: "outside", source: "sleeper-yahoo", externalId: "nfl.p.26686" },
      ];
      expect(resolve({ externalIds: reverse ? externalIds.reverse() : externalIds })).toEqual([]);
    },
  );

  it("does not confuse unrelated Yahoo roster aliases with canonical bridges", () => {
    expect(
      resolve({
        externalIds: [
          { playerId: roster.playerId, source: "yahoo", externalId: "470.p.26686" },
          { playerId: "other-roster", source: "yahoo", externalId: "469.p.26686" },
        ],
      }),
    ).toHaveLength(1);
  });

  it("retains a trusted direct Yahoo target outside the pool for reverse bridge evidence", () => {
    expect(
      resolve({
        externalIds: [
          { playerId: roster.playerId, source: "sleeper-yahoo", externalId: "26686" },
          {
            playerId: "outside",
            source: "yahoo",
            externalId: "470.p.26686",
            catalogGsisId: "00-outside",
          },
        ],
      }),
    ).toEqual([]);
  });

  it("does not retry a name for a trusted direct Yahoo target outside the pool", () => {
    expect(
      resolve({
        externalIds: [
          { playerId: roster.playerId, source: "yahoo", externalId: "470.p.26686" },
          {
            playerId: "outside",
            source: "yahoo",
            externalId: "469.p.26686",
            catalogGsisId: "00-outside",
          },
        ],
      }),
    ).toEqual([]);
  });

  it("uses an in-pool trusted direct Yahoo identity without requiring a matching display name", () => {
    expect(
      resolve({
        rosterPlayers: [{ ...roster, name: "Different Provider Display Name" }],
        externalIds: [
          { playerId: roster.playerId, source: "yahoo", externalId: "470.p.26686" },
          {
            playerId: canonical.playerId,
            source: "yahoo",
            externalId: "469.p.26686",
            catalogGsisId: canonical.gsisId,
          },
        ],
      }),
    ).toMatchObject([{ playerId: roster.playerId, projectionPlayerId: canonical.playerId }]);
  });

  it.each([false, true])(
    "rejects conflicting Sleeper and trusted direct Yahoo targets in either order: %s",
    (reverse) => {
      const externalIds = [
        { playerId: roster.playerId, source: "yahoo", externalId: "470.p.26686" },
        { playerId: canonical.playerId, source: "sleeper-yahoo", externalId: "26686" },
        {
          playerId: "outside",
          source: "yahoo",
          externalId: "469.p.26686",
          catalogGsisId: "00-outside",
        },
      ];
      expect(resolve({ externalIds: reverse ? externalIds.reverse() : externalIds })).toEqual([]);
    },
  );

  it("rejects an additional contradictory anchor ID even if one bridge matches", () => {
    expect(
      resolve({
        externalIds: [
          { playerId: roster.playerId, source: "yahoo", externalId: "470.p.26686" },
          { playerId: roster.playerId, source: "yahoo", externalId: "470.p.99999" },
          { playerId: canonical.playerId, source: "sleeper-yahoo", externalId: "26686" },
        ],
      }),
    ).toEqual([]);
  });

  it.each([
    ["James Cook III", "James Cook"],
    ["KC Concepcion Jr.", "KC Concepcion"],
    ["Travis Etienne Jr.", "Travis Etienne"],
    ["Kyle Pitts Sr.", "Kyle Pitts"],
  ])(
    "uses complete evidence for the unique suffix spelling %s / %s",
    (aliasName, canonicalName) => {
      expect(
        resolve({
          rosterPlayers: [{ ...roster, name: aliasName }],
          projections: [{ ...canonical, name: canonicalName }],
        }),
      ).toHaveLength(1);
    },
  );

  it("does not prune a conflicting suffix or provider ID out of an ambiguous base-name cohort", () => {
    const junior = { ...canonical, name: "Same Player Jr." };
    const senior = {
      ...canonical,
      playerId: "senior",
      gsisId: "00-other",
      name: "Same Player Sr.",
    };
    expect(
      resolve({
        rosterPlayers: [{ ...roster, name: "Same Player" }],
        projections: [junior, senior],
        externalIds: [
          scopedId,
          { playerId: senior.playerId, source: "espn", externalId: "other-id" },
        ],
      }),
    ).toEqual([]);
  });

  it("keeps exact full names first and suffix matches bijective", () => {
    expect(
      resolve({
        projections: [
          canonical,
          { ...canonical, playerId: "other", gsisId: "00-other", name: "Mike Washington" },
        ],
      }),
    ).toHaveLength(1);
    expect(
      resolve({
        rosterPlayers: [roster, { ...roster, playerId: "second", name: "Mike Washington" }],
      }),
    ).toEqual([]);
  });
});
