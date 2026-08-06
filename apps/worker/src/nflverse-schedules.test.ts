import { createHash } from "node:crypto";

import type { NflverseScheduleGame } from "@laces-out/source-nflverse";
import { describe, expect, it } from "vitest";

import {
  assertCompleteModernRegularSeasonSchedule,
  conservativeScheduleStatus,
  nflEasternKickoffAt,
  scheduleSelectionChecksum,
} from "./nflverse-schedules.js";

function game(overrides: Partial<NflverseScheduleGame> = {}): NflverseScheduleGame {
  return {
    gameId: "2026_01_CHI_GB",
    season: 2026,
    week: 1,
    seasonType: "REG",
    gameType: "REG",
    gameDate: "2026-09-13",
    startTimeEastern: "13:00",
    timeTbd: false,
    awayTeam: "CHI",
    homeTeam: "GB",
    awayScore: null,
    homeScore: null,
    awayRestDays: 7,
    homeRestDays: 7,
    venue: "home",
    status: "scheduled",
    ...overrides,
  };
}

function completeSchedule() {
  const teams = Array.from(
    { length: 32 },
    (_, index) =>
      `${String.fromCharCode(65 + Math.floor(index / 26))}${String.fromCharCode(65 + (index % 26))}`,
  );
  let rotation = [...teams];
  const games: ReturnType<typeof game>[] = [];
  for (let round = 0; round < 17; round += 1) {
    for (let index = 0; index < 16; index += 1) {
      games.push(
        game({
          gameId: `2026_${String(round === 0 && index === 0 ? 18 : round + 1).padStart(2, "0")}_${index}`,
          week: round === 0 && index === 0 ? 18 : round + 1,
          awayTeam: rotation[index]!,
          homeTeam: rotation[31 - index]!,
        }),
      );
    }
    const first = rotation[0];
    const last = rotation.at(-1);
    rotation = [first, last, ...rotation.slice(1, -1)] as string[];
  }
  return games;
}

describe("nflverse schedule worker helpers", () => {
  it("hashes a selected season deterministically independent of source order", () => {
    const first = game();
    const second = game({ gameId: "2026_01_BUF_MIA", awayTeam: "BUF", homeTeam: "MIA" });
    expect(scheduleSelectionChecksum([first, second])).toBe(
      scheduleSelectionChecksum([second, first]),
    );
    expect(scheduleSelectionChecksum([first])).toMatch(/^[a-f0-9]{64}$/u);
  });

  it("changes when projection-relevant schedule context changes", () => {
    const baseline = scheduleSelectionChecksum([game()]);
    expect(scheduleSelectionChecksum([game({ homeTeam: "MIN" })])).not.toBe(baseline);
    expect(scheduleSelectionChecksum([game({ startTimeEastern: null, timeTbd: true })])).not.toBe(
      baseline,
    );
    expect(
      scheduleSelectionChecksum([game({ awayScore: 17, homeScore: 20, status: "final" })]),
    ).not.toBe(baseline);
  });

  it("does not use a weak or truncated digest", () => {
    const checksum = scheduleSelectionChecksum([game()]);
    expect(checksum).toHaveLength(64);
    expect(checksum).not.toBe(createHash("md5").update("schedule").digest("hex"));
  });

  it("requires the complete modern 272-game ledger before admission", () => {
    const complete = completeSchedule();
    expect(() => assertCompleteModernRegularSeasonSchedule(2026, complete)).not.toThrow();
    expect(() => assertCompleteModernRegularSeasonSchedule(2026, complete.slice(1))).toThrow(
      /Incomplete 2026 regular-season schedule/u,
    );
  });

  it("admits only the known 2022 Buffalo-Cincinnati cancellation as a 271-game ledger", () => {
    const complete = completeSchedule();
    const canceledLedger = (week: number) => {
      const canceledMatchup = complete.find((row) => row.week === week)!;
      const teamCode = (team: string) =>
        team === canceledMatchup.awayTeam
          ? "BUF"
          : team === canceledMatchup.homeTeam
            ? "CIN"
            : team;
      return complete
        .map((row) =>
          game({
            ...row,
            season: 2022,
            awayTeam: teamCode(row.awayTeam),
            homeTeam: teamCode(row.homeTeam),
          }),
        )
        .filter(
          (row) =>
            !(
              (row.awayTeam === "BUF" && row.homeTeam === "CIN") ||
              (row.awayTeam === "CIN" && row.homeTeam === "BUF")
            ),
        );
    };
    const canceled = canceledLedger(17);

    expect(canceled).toHaveLength(271);
    expect(() => assertCompleteModernRegularSeasonSchedule(2022, canceled)).not.toThrow();
    expect(() => assertCompleteModernRegularSeasonSchedule(2022, canceledLedger(16))).toThrow(
      /Incomplete 2022 regular-season schedule/u,
    );
    expect(() =>
      assertCompleteModernRegularSeasonSchedule(
        2023,
        canceled.map((row) => game({ ...row, season: 2023 })),
      ),
    ).toThrow(/Incomplete 2023 regular-season schedule/u);
  });

  it("converts Eastern kickoff clocks across daylight-saving time", () => {
    expect(nflEasternKickoffAt(game())?.toISOString()).toBe("2026-09-13T17:00:00.000Z");
    expect(
      nflEasternKickoffAt(
        game({ gameDate: "2026-12-13", startTimeEastern: "13:00" }),
      )?.toISOString(),
    ).toBe("2026-12-13T18:00:00.000Z");
    expect(nflEasternKickoffAt(game({ startTimeEastern: null, timeTbd: true }))).toBeNull();
  });

  describe("conservativeScheduleStatus", () => {
    const kickoffAt = new Date("2026-09-13T17:00:00.000Z");

    it("never reports final while an in-progress score could be mistaken for complete", () => {
      // A score-derived "final" published moments after kickoff must not be trusted yet.
      expect(
        conservativeScheduleStatus(
          { status: "final" },
          kickoffAt,
          new Date("2026-09-13T17:05:00.000Z"),
        ),
      ).toBe("in-progress");
    });

    it("reports final once a conservative floor has elapsed since kickoff", () => {
      expect(
        conservativeScheduleStatus(
          { status: "final" },
          kickoffAt,
          new Date("2026-09-13T21:00:00.000Z"),
        ),
      ).toBe("final");
    });

    it("withholds final when kickoff was too recent, even with scores present", () => {
      expect(
        conservativeScheduleStatus(
          { status: "final" },
          kickoffAt,
          new Date("2026-09-13T20:59:00.000Z"),
        ),
      ).toBe("in-progress");
    });

    it("falls back to the score-derived status alone when kickoff is unknown", () => {
      expect(
        conservativeScheduleStatus({ status: "final" }, null, new Date("2026-09-13T17:05:00.000Z")),
      ).toBe("final");
    });

    it("leaves a scoreless scheduled game untouched regardless of elapsed time", () => {
      expect(
        conservativeScheduleStatus(
          { status: "scheduled" },
          kickoffAt,
          new Date("2026-09-13T21:00:00.000Z"),
        ),
      ).toBe("scheduled");
    });
  });
});
