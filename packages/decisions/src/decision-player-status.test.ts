import { describe, expect, it } from "vitest";
import {
  dataSources,
  nflScheduleObservations,
  playerExternalIds,
  playerSourceObservations,
  players,
  type Database,
} from "@laces-out/db";
import {
  decisionStatusSourceIsCurrent,
  normalizedDecisionStatus,
  resolveDecisionHealthStatus,
  loadDecisionPlayerStatuses,
  type DecisionStatusSource,
} from "./decision-player-status.js";

const now = new Date("2026-09-17T23:00:00Z");
const kickoff = new Date("2026-09-20T20:05:00Z");
const source: DecisionStatusSource = {
  enabled: true,
  lastChecksum: "current",
  lastSuccessfulAt: now,
  lastCheckedAt: now,
  consecutiveFailures: 0,
  checkIntervalMinutes: 60,
  metadata: {},
};

describe("decision player health evidence", () => {
  it.each(["ACT", "active", "Healthy"])(
    "normalizes %s without assuming it is verified health evidence",
    (raw) => {
      expect(normalizedDecisionStatus(raw)).toBe("ACTIVE");
      expect(resolveDecisionHealthStatus([], kickoff, now)).toBe("UNKNOWN");
    },
  );
  it.each([
    ["Q", "QUESTIONABLE"],
    ["O", "OUT"],
    ["D", "DOUBTFUL"],
    ["Reserve/Injured", "IR"],
    ["inactive", "NA"],
  ])("preserves %s as %s", (raw, expected) => {
    expect(normalizedDecisionStatus(raw)).toBe(expected);
  });
  it("keeps known injury separate from active roster eligibility and clears it after explicit newer recovery", () => {
    const injury = {
      status: "QUESTIONABLE" as const,
      observedAt: new Date("2026-09-17T18:00:00Z"),
    };
    expect(
      resolveDecisionHealthStatus(
        [injury, { status: "ACTIVE", observedAt: new Date("2026-09-17T17:00:00Z") }],
        kickoff,
        now,
      ),
    ).toBe("QUESTIONABLE");
    expect(
      resolveDecisionHealthStatus(
        [injury, { status: "ACTIVE", observedAt: new Date("2026-09-17T19:00:00Z") }],
        kickoff,
        now,
      ),
    ).toBe("ACTIVE");
    expect(
      resolveDecisionHealthStatus([{ status: "OUT", observedAt: now }, injury], kickoff, now),
    ).toBe("OUT");
  });
  it("does not admit future observations or stretch short-term injuries beyond a week", () => {
    expect(
      resolveDecisionHealthStatus(
        [{ status: "QUESTIONABLE", observedAt: new Date(now.getTime() + 1) }],
        kickoff,
        now,
      ),
    ).toBe("UNKNOWN");
    expect(
      resolveDecisionHealthStatus(
        [{ status: "QUESTIONABLE", observedAt: now }],
        new Date("2026-09-27T17:00:00Z"),
        now,
      ),
    ).toBe("UNKNOWN");
    expect(
      resolveDecisionHealthStatus(
        [{ status: "IR", observedAt: now }],
        new Date("2026-09-27T17:00:00Z"),
        now,
      ),
    ).toBe("IR");
    expect(
      resolveDecisionHealthStatus(
        [{ status: "IR", observedAt: now }],
        new Date("2026-10-27T17:00:00Z"),
        now,
      ),
    ).toBe("UNKNOWN");
    expect(resolveDecisionHealthStatus([{ status: "OUT", observedAt: now }], null, now)).toBe(
      "UNKNOWN",
    );
  });
  it("requires the selected source to be fresh, healthy and outside a refresh transaction", () => {
    expect(decisionStatusSourceIsCurrent(source, now)).toBe(true);
    for (const overrides of [
      { enabled: false },
      { lastChecksum: null },
      { consecutiveFailures: 1 },
      { lastCheckedAt: new Date(now.getTime() + 1) },
      { lastSuccessfulAt: new Date(now.getTime() - 211 * 60_000) },
      { metadata: { availability: "unavailable" } },
      { metadata: { publishable: false } },
      { metadata: { refreshClaimedAt: now.toISOString() } },
    ])
      expect(decisionStatusSourceIsCurrent({ ...source, ...overrides }, now)).toBe(false);
  });
});

describe("health evidence for roster aliases", () => {
  const canonical = {
    playerId: "canonical",
    gsisId: "00-0036970",
    name: "Kyle Pitts",
    primaryPosition: "TE",
    eligiblePositions: ["TE"],
    nflTeam: "ATL",
    status: "ACT",
    observedAt: now,
    feedStatus: "Active",
    injuryStatus: "QUESTIONABLE",
    practice: null,
  };
  const alias = { ...canonical, playerId: "alias", gsisId: null, name: "Kyle Pitts Sr." };
  const yahoo = { playerId: alias.playerId, source: "yahoo", externalId: "470.p.33392" };
  function harness(input: { bridges?: readonly unknown[]; direct?: boolean } = {}) {
    let externalReads = 0;
    let transactionOptions: unknown;
    const database = {
      transaction: async (read: (db: unknown) => Promise<unknown>, options: unknown) => {
        transactionOptions = options;
        return read(database);
      },
      select: () => {
        let table: unknown;
        const query = {
          from: (value: unknown) => {
            table = value;
            return query;
          },
          innerJoin: () => query,
          where: () => query,
          orderBy: () => query,
          limit: () => query,
          then: (resolve: (value: unknown) => unknown) => {
            if (table === dataSources)
              return Promise.resolve(
                resolve([
                  { ...source, id: "sleeper", key: "sleeper.players", lastChangedAt: now },
                  { ...source, id: "schedule", key: "nflverse.schedules.2026" },
                ]),
              );
            if (table === players)
              return Promise.resolve(resolve([input.direct ? canonical : alias]));
            if (table === playerSourceObservations) return Promise.resolve(resolve([canonical]));
            if (table === nflScheduleObservations)
              return Promise.resolve(
                resolve([
                  {
                    homeTeam: "ATL",
                    awayTeam: "BUF",
                    kickoffAt: kickoff,
                    week: 2,
                    status: "scheduled",
                    homeScore: null,
                    awayScore: null,
                  },
                ]),
              );
            if (table === playerExternalIds)
              return Promise.resolve(
                resolve(++externalReads === 1 ? [yahoo] : (input.bridges ?? [])),
              );
            throw new Error("Unexpected table in health lookup");
          },
        };
        return query;
      },
    };
    return {
      load: () =>
        loadDecisionPlayerStatuses(database as unknown as Database, {
          playerIds: [input.direct ? canonical.playerId : alias.playerId],
          leagueSeasonId: "league",
          season: 2026,
          week: 2,
          now,
        }),
      externalReads: () => externalReads,
      transactionOptions: () => transactionOptions,
    };
  }

  it("uses complete identity evidence to attach the correct current injury to a suffix alias", async () => {
    const h = harness();
    expect((await h.load()).get(alias.playerId)).toBe("QUESTIONABLE");
    expect(h.externalReads()).toBe(2);
    expect(h.transactionOptions()).toEqual({
      isolationLevel: "repeatable read",
      accessMode: "read only",
    });
  });

  it("does not borrow a same-name injury when the provider points outside the selected health catalog", async () => {
    const h = harness({
      bridges: [
        {
          playerId: "outside",
          source: "sleeper-yahoo",
          externalId: "33392",
          catalogGsisId: "00-other",
        },
      ],
    });
    expect((await h.load()).get(alias.playerId)).toBe("UNKNOWN");
  });

  it("preserves direct current health evidence without a global bridge lookup", async () => {
    const h = harness({ direct: true });
    expect((await h.load()).get(canonical.playerId)).toBe("QUESTIONABLE");
    expect(h.externalReads()).toBe(0);
  });
});
