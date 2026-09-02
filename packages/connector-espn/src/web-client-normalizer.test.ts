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

/** ESPN's 2026 encoding as captured from an active league: unordered day names, boolean flag. */
const dayNameFixture = readFileSync(
  new URL("../test/fixtures/web-client-v2-active-day-names.json", import.meta.url),
  "utf8",
);

/** An active league whose waivers process on no scheduled day, so ESPN sends an empty array. */
const emptyWaiverFixture = readFileSync(
  new URL("../test/fixtures/web-client-v2-active-empty-waivers.json", import.meta.url),
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
      injuryStatus?: string | null;
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
      acquisitionSettings: {
        matchupAcquisitionLimit?: number;
        matchupLimitPerScoringPeriod?: boolean | number;
        waiverProcessDays?: (number | string)[];
      };
      draftSettings: { type: string; keeperCount?: number };
      rosterSettings: { lineupSlotCounts: Record<string, number> };
    };
    members: Array<{
      id: string;
      firstName?: string;
      lastName?: string;
      isLeagueManager?: boolean | 0 | 1;
    }>;
    teams: Array<{
      id: string;
      logo?: string | null;
      owners: string[];
      primaryOwner?: string | null;
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

function parsedEnvelope(source: string): FixtureEnvelope {
  return JSON.parse(source) as FixtureEnvelope;
}

function parsedFixture(): FixtureEnvelope {
  return parsedEnvelope(fixture);
}

function operationalRulesOf(value: unknown) {
  const rules = normalizeEspnWebClientSnapshot(value).league.settings.operationalRules;
  if (rules === undefined) throw new Error("Expected normalized operational rules");
  return rules;
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

  it("normalizes an omitted roster injury status as null", () => {
    const value = parsedFixture();
    const entry = value.payload.teams[0]!.roster.entries[0]!;
    delete entry.playerPoolEntry.player.injuryStatus;

    const bundle = normalizeEspnWebClientSnapshot(value);

    expect(bundle.teams[0]!.roster[0]!.status).toBeNull();
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

  it("carries a member's real name separately from their username", () => {
    const value = parsedFixture();
    value.payload.members[0]!.firstName = "Avery";
    value.payload.members[0]!.lastName = "Ward";
    // Only a first name: still a real name, and better than the username on its own.
    value.payload.members[1]!.firstName = "Blake";

    const bundle = normalizeEspnWebClientSnapshot(value);

    expect(bundle.teams[0]?.managers[0]).toMatchObject({
      displayName: "Avery Example",
      fullName: "Avery Ward",
    });
    expect(bundle.teams[1]?.managers[0]).toMatchObject({ fullName: "Blake" });
  });

  it("reports no real name when ESPN sends only a username", () => {
    const bundle = normalizeEspnWebClientSnapshot(parsedFixture());

    // The fixture carries no name parts, which is a normal member state rather than schema drift.
    expect(bundle.teams[0]?.managers[0]).toMatchObject({
      displayName: "Avery Example",
      fullName: null,
    });
  });

  it("identifies exactly one current-user team from the active ESPN member GUID", () => {
    const value = parsedFixture();
    const ownerId = "{123E4567-E89B-42D3-A456-426614174000}";
    value.payload.members[0]!.id = ownerId;
    value.payload.teams[0]!.owners = [ownerId];
    value.payload.teams[0]!.primaryOwner = ownerId;

    const bundle = normalizeEspnWebClientSnapshot(value, {
      // SWID casing and conventional braces do not change the underlying ESPN member GUID.
      activeMemberId: "123e4567-e89b-42d3-a456-426614174000",
    });

    expect(bundle.teams.map((team) => team.isCurrentUser)).toEqual([true, false]);
    expect(bundle.teams.map((team) => team.currentUserIsCommissioner)).toEqual([true, null]);
    expect(bundle.warnings.join(" ")).not.toContain("isCurrentUser is false");
  });

  it("binds the league-manager flag to the exact active member, not a co-manager", () => {
    const value = parsedFixture();
    const activeMember = value.payload.members[0]!;
    const leagueManager = value.payload.members[1]!;
    activeMember.isLeagueManager = false;
    leagueManager.isLeagueManager = true;
    value.payload.teams[0]!.owners = [activeMember.id, leagueManager.id];
    value.payload.teams[0]!.primaryOwner = activeMember.id;

    const bundle = normalizeEspnWebClientSnapshot(value, { activeMemberId: activeMember.id });

    expect(bundle.teams[0]).toMatchObject({
      isCurrentUser: true,
      currentUserIsCommissioner: false,
      managers: [{ isCommissioner: false }, { isCommissioner: true }],
    });
  });

  it("uses separately validated active-member authority without weakening the exact team join", () => {
    const value = parsedFixture();
    const activeMember = value.payload.members[0]!;
    activeMember.isLeagueManager = false;

    const promoted = normalizeEspnWebClientSnapshot(value, {
      activeMemberId: activeMember.id,
      activeMemberManagerAuthority: true,
    });
    expect(promoted.teams[0]).toMatchObject({
      isCurrentUser: true,
      currentUserIsCommissioner: true,
    });

    activeMember.isLeagueManager = true;
    const explicitlyFalse = normalizeEspnWebClientSnapshot(value, {
      activeMemberId: activeMember.id,
      activeMemberManagerAuthority: false,
    });
    expect(explicitlyFalse.teams[0]).toMatchObject({
      isCurrentUser: true,
      currentUserIsCommissioner: false,
    });

    const unknown = normalizeEspnWebClientSnapshot(value, {
      activeMemberId: activeMember.id,
      activeMemberManagerAuthority: null,
    });
    expect(unknown.teams[0]).toMatchObject({
      isCurrentUser: true,
      currentUserIsCommissioner: null,
    });

    const unmatched = normalizeEspnWebClientSnapshot(value, {
      activeMemberId: "private-current-member-not-in-this-league",
      activeMemberManagerAuthority: true,
    });
    expect(unmatched.teams.every((team) => !team.isCurrentUser)).toBe(true);
    expect(unmatched.teams.every((team) => team.currentUserIsCommissioner === null)).toBe(true);
  });

  it("keeps an omitted active-member league-manager flag unknown", () => {
    const value = parsedFixture();
    const activeMember = value.payload.members[0]!;
    delete activeMember.isLeagueManager;

    const bundle = normalizeEspnWebClientSnapshot(value, { activeMemberId: activeMember.id });

    expect(bundle.teams[0]).toMatchObject({
      isCurrentUser: true,
      currentUserIsCommissioner: null,
    });
  });

  it("fails closed without leaking an unmatched active ESPN member ID", () => {
    const activeMemberId = "private-current-member-not-in-this-league";
    const bundle = normalizeEspnWebClientSnapshot(parsedFixture(), { activeMemberId });

    expect(bundle.teams.every((team) => !team.isCurrentUser)).toBe(true);
    expect(bundle.warnings.join(" ")).toContain("did not match a team owner");
    expect(bundle.warnings.join(" ")).not.toContain(activeMemberId);
  });

  it("fails closed without leaking an active ESPN member ID that owns multiple teams", () => {
    const value = parsedFixture();
    const activeMemberId = value.payload.members[0]!.id;
    value.payload.teams[1]!.owners = [activeMemberId];
    value.payload.teams[1]!.primaryOwner = activeMemberId;

    const bundle = normalizeEspnWebClientSnapshot(value, { activeMemberId });

    expect(bundle.teams.every((team) => !team.isCurrentUser)).toBe(true);
    expect(bundle.warnings.join(" ")).toContain("matched multiple team owners");
    expect(bundle.warnings.join(" ")).not.toContain(activeMemberId);
  });

  it("fails closed when two raw member IDs canonicalize to the active SWID", () => {
    const value = parsedFixture();
    const bracedMemberId = "{123E4567-E89B-42D3-A456-426614174000}";
    const unbracedMemberId = "123e4567-e89b-42d3-a456-426614174000";
    value.payload.members[0]!.id = bracedMemberId;
    value.payload.members[1]!.id = unbracedMemberId;
    value.payload.teams[0]!.owners = [bracedMemberId];
    value.payload.teams[0]!.primaryOwner = bracedMemberId;
    value.payload.teams[1]!.owners = [unbracedMemberId];
    value.payload.teams[1]!.primaryOwner = unbracedMemberId;

    const bundle = normalizeEspnWebClientSnapshot(value, { activeMemberId: unbracedMemberId });

    expect(bundle.teams.every((team) => !team.isCurrentUser)).toBe(true);
    expect(bundle.teams.every((team) => team.currentUserIsCommissioner === null)).toBe(true);
    expect(bundle.warnings.join(" ")).toContain("matched multiple league members");
    expect(bundle.warnings.join(" ")).not.toContain(unbracedMemberId);
    expect(bundle.warnings.join(" ")).not.toContain(bracedMemberId);
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

  it("accepts ESPN's signed player IDs for NFL team defenses", () => {
    const value = parsedFixture();
    const entry = value.payload.teams[0]!.roster.entries[0]!;
    entry.playerId = "-16012";
    entry.playerPoolEntry.id = "-16012";
    entry.playerPoolEntry.player.id = "-16012";
    entry.playerPoolEntry.player.eligibleSlots = [16, 20];
    entry.lineupSlotId = 16;

    const bundle = normalizeEspnWebClientSnapshot(value);
    expect(bundle.teams[0]?.roster[0]).toMatchObject({
      externalId: "espn:2026:player:-16012",
      providerPlayerId: "-16012",
      primaryPosition: "D/ST",
    });
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
    const authenticatedViews = parsedFixture();
    authenticatedViews.endpoint += "&view=mNav";
    expect(() => normalizeEspnWebClientSnapshot(authenticatedViews)).not.toThrow();

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

/**
 * ESPN re-encoded two `acquisitionSettings` fields between the v1 capture and 2026-07-28:
 * `waiverProcessDays` became uppercase day names and `matchupLimitPerScoringPeriod` became a
 * boolean flag. Contract v2 accepts both encodings and refuses to read the flag as a count.
 */
describe("ESPN 2026 acquisition-settings encodings", () => {
  it("maps observed day names to getDay() numbers, de-duplicated and sorted", () => {
    // The fixture lists MONDAY, WEDNESDAY, FRIDAY, SUNDAY, THURSDAY, SATURDAY in ESPN's order.
    expect(operationalRulesOf(dayNameFixture).waiverProcessDays).toEqual([0, 1, 3, 4, 5, 6]);

    const shuffled = parsedEnvelope(dayNameFixture);
    shuffled.payload.settings.acquisitionSettings.waiverProcessDays = [
      "SATURDAY",
      "MONDAY",
      "MONDAY",
    ];
    expect(operationalRulesOf(shuffled).waiverProcessDays).toEqual([1, 6]);
  });

  it("keeps an active league's empty waiver schedule as an empty list", () => {
    const rules = operationalRulesOf(emptyWaiverFixture);
    expect(rules.waiverProcessDays).toEqual([]);
    // ESPN's -1 means "no limit", and the flag agrees.
    expect(rules.matchupAcquisitionLimit).toBeNull();
    expect(rules.matchupAcquisitionLimitEnabled).toBe(false);
  });

  it("still accepts the previously observed numeric day encoding", () => {
    const rules = operationalRulesOf(fixture);
    expect(rules.waiverProcessDays).toEqual([2, 4, 6]);
    expect(rules.matchupAcquisitionLimit).toBe(7);
    expect(rules.matchupAcquisitionLimitEnabled).toBe(true);
  });

  it("never reads the boolean per-scoring-period flag as an acquisition limit", () => {
    const rules = operationalRulesOf(dayNameFixture);
    expect(rules.matchupAcquisitionLimit).toBeNull();
    expect(rules.matchupAcquisitionLimit).not.toBe(0);
    expect(typeof rules.matchupAcquisitionLimit).not.toBe("boolean");
    expect(rules.matchupAcquisitionLimitEnabled).toBe(false);
  });

  it("reports a declared per-scoring-period limit without inventing a count", () => {
    // `true` has only ever been observed on a league ESPN had not activated for the season
    // (2026-07-28), so it is accepted verbatim and never mapped to a count.
    const declared = parsedEnvelope(dayNameFixture);
    declared.payload.settings.acquisitionSettings.matchupLimitPerScoringPeriod = true;
    const rules = operationalRulesOf(declared);
    expect(rules.matchupAcquisitionLimitEnabled).toBe(true);
    expect(rules.matchupAcquisitionLimit).toBeNull();

    declared.payload.settings.acquisitionSettings.matchupAcquisitionLimit = 3;
    expect(operationalRulesOf(declared)).toMatchObject({
      matchupAcquisitionLimit: 3,
      matchupAcquisitionLimitEnabled: true,
    });
  });

  it("lets a false flag override a numeric limit ESPN left behind", () => {
    const contradictory = parsedEnvelope(dayNameFixture);
    contradictory.payload.settings.acquisitionSettings.matchupAcquisitionLimit = 3;
    expect(operationalRulesOf(contradictory)).toMatchObject({
      matchupAcquisitionLimit: null,
      matchupAcquisitionLimitEnabled: false,
    });
  });

  it("still accepts a numeric matchupLimitPerScoringPeriod as a count", () => {
    const legacy = parsedFixture();
    delete legacy.payload.settings.acquisitionSettings.matchupAcquisitionLimit;
    legacy.payload.settings.acquisitionSettings.matchupLimitPerScoringPeriod = 5;
    expect(operationalRulesOf(legacy)).toMatchObject({
      matchupAcquisitionLimit: 5,
      matchupAcquisitionLimitEnabled: true,
    });
  });

  it("reports no answer when ESPN supplies neither the flag nor a count", () => {
    const silent = parsedFixture();
    delete silent.payload.settings.acquisitionSettings.matchupAcquisitionLimit;
    expect(operationalRulesOf(silent)).toMatchObject({
      matchupAcquisitionLimit: null,
      matchupAcquisitionLimitEnabled: null,
    });
  });

  it("fails closed on an unrecognized day name without copying it into issues", () => {
    const unknownDay = parsedEnvelope(dayNameFixture);
    unknownDay.payload.settings.acquisitionSettings.waiverProcessDays = [
      "MONDAY",
      "FUNDAY-DO-NOT-LOG",
    ];

    const error = captureError(unknownDay);
    expect(error.code).toBe("SCHEMA_DRIFT");
    expect(error.message).toContain("contract version 2");
    expect(error.issues).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          path: "settings.acquisitionSettings.waiverProcessDays.1",
          code: "SCHEMA_DRIFT",
        }),
      ]),
    );
    expect(JSON.stringify(error.issues)).not.toContain("FUNDAY-DO-NOT-LOG");
  });

  it("fails closed when day names and numbers are mixed in one array", () => {
    const mixed = parsedEnvelope(dayNameFixture);
    mixed.payload.settings.acquisitionSettings.waiverProcessDays = ["MONDAY", 2];
    expect(captureError(mixed).issues).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          path: "settings.acquisitionSettings.waiverProcessDays",
          code: "SCHEMA_DRIFT",
        }),
      ]),
    );
  });
});
