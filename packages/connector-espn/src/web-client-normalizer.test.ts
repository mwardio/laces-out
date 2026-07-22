import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";

import { describe, expect, it } from "vitest";

import {
  EspnWebClientNormalizationError,
  MAX_ESPN_WEB_CLIENT_SNAPSHOT_BYTES,
  normalizeEspnWebClientSnapshot,
} from "./web-client-normalizer.js";

const fixture = readFileSync(
  new URL("../test/fixtures/web-client-v1.json", import.meta.url),
  "utf8",
);

interface FixtureRosterEntry {
  lineupSlotId: number;
  playerId: string;
  playerPoolEntry: {
    id: string;
    onTeamId: string;
    player: {
      id: string;
      eligibleSlots: number[];
      fullName?: string;
    };
  };
}

interface FixtureEnvelope {
  checksumSha256: string;
  endpoint: string;
  leagueId: string;
  payload: {
    id: string;
    seasonId: number;
    settings: {
      draftSettings: { type: string; keeperCount?: number };
      rosterSettings: { lineupSlotCounts: Record<string, number> };
    };
    members: Array<{ id: string; isLeagueManager?: boolean | 0 | 1 }>;
    teams: Array<{
      id: string;
      logo?: string | null;
      owners: string[];
      playoffSeed?: number;
      waiverRank?: number;
      transactionCounter?: { acquisitionBudgetSpent?: number };
      record?: {
        overall: {
          wins: number;
        };
      };
      roster: { entries: FixtureRosterEntry[] };
    }>;
    schedule?: Array<{
      id: string;
      winner: string;
      home: { teamId: string; totalPoints: number };
      away: { teamId: string; totalPoints: number };
    }>;
  };
}

function parsedFixture(): FixtureEnvelope {
  return JSON.parse(fixture) as FixtureEnvelope;
}

function captureError(value: unknown): EspnWebClientNormalizationError {
  try {
    normalizeEspnWebClientSnapshot(value);
  } catch (error) {
    expect(error).toBeInstanceOf(EspnWebClientNormalizationError);
    return error as EspnWebClientNormalizationError;
  }
  throw new Error("Expected normalization to fail");
}

describe("ESPN web-client snapshot normalizer", () => {
  it("normalizes a strict browser-local bridge envelope without truncating provider IDs", () => {
    const bundle = normalizeEspnWebClientSnapshot(fixture);

    expect(bundle).toMatchObject({
      schemaVersion: 1,
      provider: "espn",
      league: {
        externalId: "espn:2026:98765432101234567890",
        providerLeagueId: "98765432101234567890",
        season: 2026,
        name: "Moonshot Friends League",
        currentWeek: 4,
        settings: {
          teamCount: 2,
          draftType: "auction",
          auctionBudget: 200,
          waiverType: "faab",
          faabBudget: 100,
          playoffTeamCount: 1,
          operationalRules: {
            acquisitionLimit: 40,
            matchupAcquisitionLimit: 7,
            minimumBid: 1,
            waiverProcessDays: [2, 4, 6],
            waiverProcessHour: 3,
            keeperCount: 2,
            regularSeasonMatchupPeriods: 14,
            playoffMatchupPeriodLength: 1,
            playoffSeedingRule: "TOTAL_POINTS_SCORED",
            matchupTieRule: "NONE",
            playoffMatchupTieRule: "HOME_TEAM_WINS",
            scoringType: "H2H_POINTS",
            medianGameEnabled: true,
            tradeDeadlineAt: "2026-11-16T00:00:00.000Z",
            tradeReviewHours: 24,
            vetoVotesRequired: 4,
            divisions: [{ providerDivisionId: "1", name: "Snowflake Division" }],
          },
        },
      },
      provenance: {
        mode: "browser-local",
        fetchedAt: "2026-09-24T14:30:00.000Z",
        artifactChecksumSha256: "bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb",
      },
    });
    expect(bundle.league.settings.rosterSlots).toEqual(
      expect.arrayContaining([
        { position: "QB", count: 1, starting: true },
        { position: "BN", count: 2, starting: false },
        { position: "IR", count: 1, starting: false },
      ]),
    );
    expect(bundle.league.settings.scoringRules).toEqual(
      expect.arrayContaining([
        { statId: "3", name: null, points: 0.04 },
        {
          statId: "122:slot:16",
          name: "ESPN stat 122 override for D/ST",
          points: -1,
        },
      ]),
    );
    expect(bundle.teams[0]).toMatchObject({
      externalId: "espn:2026:98765432101234567890:team:101",
      providerTeamId: "101",
      isCurrentUser: false,
      faabRemaining: 83,
      waiverPriority: 2,
      managers: [
        {
          externalId: "manager-alpha-00000000-0000-0000-0000-000000000001",
          displayName: "Avery Example",
          isCommissioner: true,
        },
      ],
      roster: [
        {
          externalId: "espn:2026:player:900000000000000001",
          providerPlayerId: "900000000000000001",
          primaryPosition: "QB",
          lineupSlot: "QB",
          proTeamAbbreviation: "KC",
        },
        {
          primaryPosition: "RB",
          eligiblePositions: ["RB", "RB/WR", "FLEX", "OP", "BN", "IR"],
        },
      ],
    });
    expect(bundle.standings).toEqual({
      asOfWeek: 4,
      entries: [
        expect.objectContaining({
          teamExternalId: "espn:2026:98765432101234567890:team:101",
          providerTeamId: "101",
          rank: 1,
          playoffSeed: 1,
          wins: 3,
          losses: 0,
          pointsFor: 365.75,
          streakType: "win",
          streakLength: 3,
        }),
        expect.objectContaining({
          teamExternalId: "espn:2026:98765432101234567890:team:202",
          providerTeamId: "202",
          rank: 2,
          wins: 0,
          losses: 3,
          streakType: "loss",
        }),
      ],
    });
    expect(bundle.matchups?.asOfWeek).toBe(4);
    expect(bundle.matchups?.matchups).toHaveLength(3);
    expect(bundle.matchups?.matchups[0]).toMatchObject({
      providerMatchupId: "70000000000000000001",
      week: 3,
      status: "final",
      winnerTeamExternalId: "espn:2026:98765432101234567890:team:101",
      tied: false,
      home: { providerTeamId: "101", score: 121.5 },
      away: { providerTeamId: "202", score: 110.25 },
    });
    expect(bundle.matchups?.matchups[1]).toMatchObject({
      providerMatchupId: "70000000000000000002",
      week: 4,
      status: "in-progress",
      winnerTeamExternalId: null,
      home: { providerTeamId: "202", score: 67.125 },
      away: { providerTeamId: "101", score: 71.8 },
    });
    expect(bundle.matchups?.matchups[2]).toMatchObject({
      providerMatchupId: "70000000000000000003",
      week: 5,
      status: "scheduled",
      home: { score: null },
      away: { score: null },
    });
    expect(bundle.warnings.join(" ")).toContain("isCurrentUser");
  });

  it("accepts current preseason manager, seed, and legacy-logo variants safely", () => {
    const value = parsedFixture();
    delete value.payload.members[0]!.isLeagueManager;
    value.payload.members[1]!.isLeagueManager = 1;
    value.payload.teams[0]!.logo = "http://legacy.example/team-alpha.png";
    value.payload.teams[0]!.playoffSeed = 0;
    value.payload.teams[1]!.playoffSeed = 0;

    const bundle = normalizeEspnWebClientSnapshot(value);

    expect(bundle.teams[0]).toMatchObject({
      logoUrl: null,
      managers: [{ isCommissioner: false }],
    });
    expect(bundle.teams[1]).toMatchObject({ managers: [{ isCommissioner: true }] });
    expect(bundle.standings?.entries.map((entry) => entry.rank)).toEqual([1, 2]);
    expect(bundle.standings?.entries.map((entry) => entry.playoffSeed)).toEqual([1, 2]);
    expect(bundle.warnings.join(" ")).toContain("league-manager flags");
    expect(bundle.warnings.join(" ")).toContain("team-logo URLs were discarded");
    expect(bundle.warnings.join(" ")).toContain("unranked preseason standings");
  });

  it("preserves 20-digit provider team IDs across teams, standings, and matchup sides", () => {
    const value = parsedFixture();
    const originalTeamId = value.payload.teams[0]!.id;
    const decimalTeamId = "90071992547409931234";
    value.payload.teams[0]!.id = decimalTeamId;
    for (const entry of value.payload.teams[0]!.roster.entries) {
      entry.playerPoolEntry.onTeamId = decimalTeamId;
    }
    for (const matchup of value.payload.schedule ?? []) {
      if (matchup.home.teamId === originalTeamId) matchup.home.teamId = decimalTeamId;
      if (matchup.away.teamId === originalTeamId) matchup.away.teamId = decimalTeamId;
    }

    const bundle = normalizeEspnWebClientSnapshot(value);
    expect(bundle.teams[0]).toMatchObject({
      providerTeamId: decimalTeamId,
      externalId: `espn:2026:98765432101234567890:team:${decimalTeamId}`,
    });
    expect(bundle.standings?.entries[0]).toMatchObject({
      providerTeamId: decimalTeamId,
      teamExternalId: `espn:2026:98765432101234567890:team:${decimalTeamId}`,
    });
    expect(
      bundle.matchups?.matchups.some(
        (matchup) =>
          matchup.home.providerTeamId === decimalTeamId ||
          matchup.away.providerTeamId === decimalTeamId,
      ),
    ).toBe(true);
  });

  it("accepts a raw payload and checksums the exact received serialization", () => {
    const envelope = parsedFixture();
    const raw = JSON.stringify(envelope.payload);
    const bundle = normalizeEspnWebClientSnapshot(raw, {
      now: () => new Date("2026-09-24T15:00:00.000Z"),
    });

    expect(bundle.provenance).toEqual({
      mode: "public-unofficial",
      fetchedAt: "2026-09-24T15:00:00.000Z",
      endpoint: null,
      artifactChecksumSha256: createHash("sha256").update(raw, "utf8").digest("hex"),
    });
    expect(bundle.warnings.join(" ")).toContain("raw ESPN payload");

    const suppliedChecksum = "cccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccc";
    const objectBundle = normalizeEspnWebClientSnapshot(envelope.payload, {
      capturedAt: "2026-09-24T15:01:00.000Z",
      endpoint: envelope.endpoint,
      checksumSha256: suppliedChecksum,
    });
    expect(objectBundle.provenance).toEqual({
      mode: "public-unofficial",
      fetchedAt: "2026-09-24T15:01:00.000Z",
      endpoint: envelope.endpoint,
      artifactChecksumSha256: suppliedChecksum,
    });
  });

  it("fails closed on unknown required enums and never copies imported values into issues", () => {
    const value = parsedFixture();
    value.payload.settings.draftSettings.type = "secret-draft-shape-do-not-log";

    const error = captureError(value);
    expect(error.code).toBe("SCHEMA_DRIFT");
    expect(error.issues).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ path: "settings.draftSettings.type", code: "SCHEMA_DRIFT" }),
      ]),
    );
    expect(JSON.stringify(error.issues)).not.toContain("secret-draft-shape-do-not-log");
  });

  it("rejects endpoint drift and envelope/payload identity mismatches", () => {
    const missingView = parsedFixture();
    missingView.endpoint = missingView.endpoint.replace("&view=mRoster", "");
    expect(captureError(missingView)).toMatchObject({ code: "INVALID_ENVELOPE" });

    const mismatchedIdentity = parsedFixture();
    mismatchedIdentity.payload.id = "11111111111111111111";
    const error = captureError(mismatchedIdentity);
    expect(error).toMatchObject({ code: "INVALID_ENVELOPE" });
    expect(error.issues).toEqual(
      expect.arrayContaining([expect.objectContaining({ path: "payload" })]),
    );
  });

  it("rejects inconsistent owners, nested player IDs, and duplicate rostered players", () => {
    const unknownOwner = parsedFixture();
    unknownOwner.payload.teams[0]!.owners = ["unknown-manager"];
    expect(captureError(unknownOwner).issues).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ path: "teams.0.owners.0", code: "SCHEMA_DRIFT" }),
      ]),
    );

    const nestedMismatch = parsedFixture();
    nestedMismatch.payload.teams[0]!.roster.entries[0]!.playerPoolEntry.player.id = "42";
    expect(captureError(nestedMismatch).issues).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          path: "teams.0.roster.entries.0.playerId",
          code: "SCHEMA_DRIFT",
        }),
      ]),
    );

    const duplicate = parsedFixture();
    const first = duplicate.payload.teams[0]!.roster.entries[0]!;
    const second = duplicate.payload.teams[1]!.roster.entries[0]!;
    second.playerId = first.playerId;
    second.playerPoolEntry.id = first.playerId;
    second.playerPoolEntry.player.id = first.playerId;
    expect(captureError(duplicate).issues).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          path: "teams.1.roster.entries.0.playerId",
          code: "SCHEMA_DRIFT",
        }),
      ]),
    );
  });

  it("fails closed when requested standings or matchup data is absent or inconsistent", () => {
    const missingStanding = parsedFixture();
    for (const team of missingStanding.payload.teams) {
      delete team.record;
      delete team.playoffSeed;
    }
    expect(captureError(missingStanding).issues).toEqual(
      expect.arrayContaining([expect.objectContaining({ path: "teams" })]),
    );

    const missingMatchups = parsedFixture();
    delete missingMatchups.payload.schedule;
    expect(captureError(missingMatchups).issues).toEqual(
      expect.arrayContaining([expect.objectContaining({ path: "schedule" })]),
    );

    const unknownTeam = parsedFixture();
    unknownTeam.payload.schedule![0]!.home.teamId = "99999999999999999999";
    expect(captureError(unknownTeam).issues).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ path: "schedule.0.home.teamId", code: "SCHEMA_DRIFT" }),
      ]),
    );

    const impossibleWinner = parsedFixture();
    impossibleWinner.payload.schedule![0]!.winner = "AWAY";
    expect(captureError(impossibleWinner).issues).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ path: "schedule.0.winner", code: "SCHEMA_DRIFT" }),
      ]),
    );
  });

  it("rejects missing nested mRoster structure and unsupported slot IDs", () => {
    const missingPlayer = parsedFixture();
    delete missingPlayer.payload.teams[0]!.roster.entries[0]!.playerPoolEntry.player.fullName;
    expect(captureError(missingPlayer).issues).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          path: "teams.0.roster.entries.0.playerPoolEntry.player.fullName",
        }),
      ]),
    );

    const unknownSlot = parsedFixture();
    unknownSlot.payload.settings.rosterSettings.lineupSlotCounts["99"] = 1;
    expect(captureError(unknownSlot).issues).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          path: "settings.rosterSettings.lineupSlotCounts.99",
        }),
      ]),
    );
  });

  it("bounds both strings and object serializations before schema traversal", () => {
    const oversizedObject = {
      padding: "x".repeat(MAX_ESPN_WEB_CLIENT_SNAPSHOT_BYTES),
    };
    expect(captureError(JSON.stringify(oversizedObject))).toMatchObject({ code: "TOO_LARGE" });
    expect(captureError(oversizedObject)).toMatchObject({ code: "TOO_LARGE" });
  });
});
