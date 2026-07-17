import { readFileSync } from "node:fs";

import { describe, expect, it } from "vitest";

import { EspnImportError, parseEspnManualImport } from "./manual-import.js";

const fixture = readFileSync(
  new URL("../test/fixtures/canonical-v1.json", import.meta.url),
  "utf8",
);

describe("ESPN canonical manual import", () => {
  it("parses schema v1 into the normalized sync contract", () => {
    const bundle = parseEspnManualImport(fixture);

    expect(bundle.provider).toBe("espn");
    expect(bundle.league).toMatchObject({
      externalId: "espn:2026:987654321",
      providerLeagueId: "987654321",
      season: 2026,
      name: "Sanitized ESPN League",
      settings: {
        teamCount: 2,
        draftType: "auction",
        auctionBudget: 200,
        waiverType: "faab",
      },
    });
    expect(bundle.teams[0]).toMatchObject({
      externalId: "espn:2026:987654321:team:1",
      isCurrentUser: true,
      roster: [
        {
          externalId: "espn:2026:player:10001",
          providerPlayerId: "10001",
          lineupSlot: "QB",
        },
      ],
    });
    expect(bundle.provenance).toMatchObject({
      mode: "manual-import",
      fetchedAt: "2026-07-16T12:00:00.000Z",
    });
  });

  it("rejects inconsistent and unknown data with value-free issues", () => {
    const value = JSON.parse(fixture) as {
      league: { settings: { teamCount: number } };
      unexpected?: string;
    };
    value.league.settings.teamCount = 3;
    expect(() => parseEspnManualImport(value)).toThrowError(EspnImportError);
    try {
      parseEspnManualImport(value);
    } catch (error) {
      expect(error).toBeInstanceOf(EspnImportError);
      expect((error as EspnImportError).issues).toEqual(
        expect.arrayContaining([expect.objectContaining({ path: "league.settings.teamCount" })]),
      );
    }

    value.league.settings.teamCount = 2;
    value.unexpected = "sensitive imported value";
    try {
      parseEspnManualImport(value);
    } catch (error) {
      expect((error as EspnImportError).issues).toEqual(
        expect.arrayContaining([expect.objectContaining({ path: "" })]),
      );
      expect(JSON.stringify((error as EspnImportError).issues)).not.toContain(
        "sensitive imported value",
      );
    }
  });
});
