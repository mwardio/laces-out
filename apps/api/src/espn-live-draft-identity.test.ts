import { describe, expect, it } from "vitest";

import {
  ProviderPlayerResolver,
  ProviderTeamResolver,
  normalizeIdentityName,
} from "./espn-live-draft-identity.js";

const TEAM_A = "40000000-0000-4000-8000-00000000000a";
const TEAM_B = "40000000-0000-4000-8000-00000000000b";
const PLAYER_A = "50000000-0000-4000-8000-00000000000a";
const PLAYER_B = "50000000-0000-4000-8000-00000000000b";
const PLAYER_D = "50000000-0000-4000-8000-00000000000d";

describe("identity name normalization", () => {
  it("folds case, punctuation, and diacritics", () => {
    expect(normalizeIdentityName("Ja'Marr Chase")).toBe(normalizeIdentityName("jamarr chase"));
    expect(normalizeIdentityName("Amon-Ra St. Brown")).toBe(
      normalizeIdentityName("amon ra st brown"),
    );
  });

  it("drops generational suffixes that providers disagree about", () => {
    expect(normalizeIdentityName("Marvin Harrison Jr.")).toBe(
      normalizeIdentityName("Marvin Harrison"),
    );
    expect(normalizeIdentityName("Odell Beckham Jr")).toBe(normalizeIdentityName("Odell Beckham"));
  });

  it("does not collapse genuinely different names", () => {
    expect(normalizeIdentityName("Michael Pittman")).not.toBe(
      normalizeIdentityName("Mike Pittman"),
    );
  });
});

describe("team resolution", () => {
  const candidates = [
    { id: TEAM_A, name: "Ditka's Revenge", externalKey: "1" },
    { id: TEAM_B, name: "Finkle Is Einhorn", externalKey: "2" },
  ];

  it("prefers the provider team ID", () => {
    const resolver = new ProviderTeamResolver(candidates);
    expect(resolver.resolve({ providerTeamId: "2", teamName: "anything at all" })).toMatchObject({
      status: "resolved",
      id: TEAM_B,
      via: "provider-team-id",
    });
  });

  it("falls back to an exact unique name when no provider ID is exposed", () => {
    const resolver = new ProviderTeamResolver(candidates);
    expect(resolver.resolve({ providerTeamId: null, teamName: "ditkas revenge" })).toMatchObject({
      status: "resolved",
      id: TEAM_A,
      via: "unique-team-name",
    });
  });

  it("holds rather than guessing when a provider ID is unknown", () => {
    const resolver = new ProviderTeamResolver(candidates);
    expect(resolver.resolve({ providerTeamId: "99", teamName: "Ditka's Revenge" })).toMatchObject({
      status: "unresolved",
      reason: "unknown",
    });
  });

  it("holds when two teams share a name", () => {
    const resolver = new ProviderTeamResolver([
      { id: TEAM_A, name: "The Team", externalKey: null },
      { id: TEAM_B, name: "The Team", externalKey: null },
    ]);
    expect(resolver.resolve({ providerTeamId: null, teamName: "The Team" })).toMatchObject({
      status: "unresolved",
      reason: "ambiguous",
    });
  });

  it("never resolves an unknown team name", () => {
    const resolver = new ProviderTeamResolver(candidates);
    expect(resolver.resolve({ providerTeamId: null, teamName: "Some Other Guy" })).toMatchObject({
      status: "unresolved",
    });
  });
});

describe("player resolution", () => {
  const candidates = [
    { id: PLAYER_A, name: "Patrick Mahomes", positions: ["QB"], nflTeam: "KC" },
    { id: PLAYER_B, name: "Ja'Marr Chase", positions: ["WR"], nflTeam: "CIN" },
    { id: PLAYER_D, name: "Chiefs D/ST", positions: ["DST"], nflTeam: "KC" },
  ];

  it("prefers the crosswalked provider player ID", () => {
    const resolver = new ProviderPlayerResolver(candidates, new Map([["3139477", PLAYER_A]]));
    expect(
      resolver.resolve({
        providerPlayerId: "3139477",
        playerName: "P. Mahomes",
        proTeam: null,
        position: null,
      }),
    ).toMatchObject({ status: "resolved", id: PLAYER_A, via: "provider-player-id" });
  });

  it("falls back to a unique name, pro team, and position triple", () => {
    const resolver = new ProviderPlayerResolver(candidates, new Map());
    expect(
      resolver.resolve({
        providerPlayerId: null,
        playerName: "JaMarr Chase",
        proTeam: "CIN",
        position: "WR",
      }),
    ).toMatchObject({ status: "resolved", id: PLAYER_B, via: "name-team-position" });
  });

  it("maps a defense by NFL club however ESPN spells it", () => {
    const resolver = new ProviderPlayerResolver(candidates, new Map());
    for (const spelling of ["Kansas City DST", "Chiefs D/ST", "Kansas City Defense", "KC D/ST"]) {
      expect(
        resolver.resolve({
          providerPlayerId: null,
          playerName: spelling,
          proTeam: "KC",
          position: "DST",
        }),
      ).toMatchObject({ status: "resolved", id: PLAYER_D });
    }
  });

  it("uses the NFL club path for a defense spelling no name match could reach", () => {
    const resolver = new ProviderPlayerResolver(candidates, new Map());
    expect(
      resolver.resolve({
        providerPlayerId: null,
        playerName: "Kansas City Special Teams",
        proTeam: "KC",
        position: "DST",
      }),
    ).toMatchObject({ status: "resolved", id: PLAYER_D, via: "defense-nfl-team" });
  });

  it("holds two different players who share a name, team, and position", () => {
    const resolver = new ProviderPlayerResolver(
      [
        { id: PLAYER_A, name: "Mike Williams", positions: ["WR"], nflTeam: "LAC" },
        { id: PLAYER_B, name: "Mike Williams", positions: ["WR"], nflTeam: "LAC" },
      ],
      new Map(),
    );
    expect(
      resolver.resolve({
        providerPlayerId: null,
        playerName: "Mike Williams",
        proTeam: "LAC",
        position: "WR",
      }),
    ).toMatchObject({ status: "unresolved", reason: "ambiguous" });
  });

  it("distinguishes same-named players on different teams", () => {
    const resolver = new ProviderPlayerResolver(
      [
        { id: PLAYER_A, name: "Mike Williams", positions: ["WR"], nflTeam: "LAC" },
        { id: PLAYER_B, name: "Mike Williams", positions: ["WR"], nflTeam: "NYJ" },
      ],
      new Map(),
    );
    expect(
      resolver.resolve({
        providerPlayerId: null,
        playerName: "Mike Williams",
        proTeam: "NYJ",
        position: "WR",
      }),
    ).toMatchObject({ status: "resolved", id: PLAYER_B });
  });

  it("holds an unknown rookie rather than inventing a crosswalk entry", () => {
    const resolver = new ProviderPlayerResolver(candidates, new Map());
    expect(
      resolver.resolve({
        providerPlayerId: "9999999",
        playerName: "Undrafted Rookie",
        proTeam: "SEA",
        position: "RB",
      }),
    ).toMatchObject({ status: "unresolved", reason: "unknown" });
  });

  it("does not match on name alone when the pro team disagrees", () => {
    const resolver = new ProviderPlayerResolver(candidates, new Map());
    expect(
      resolver.resolve({
        providerPlayerId: null,
        playerName: "Patrick Mahomes",
        proTeam: "DEN",
        position: "QB",
      }),
    ).toMatchObject({ status: "unresolved" });
  });
});
