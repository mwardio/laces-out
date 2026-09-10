import { describe, expect, it } from "vitest";

import {
  mergeEspnWeeklyBoxScores,
  parseEspnWeeklyBoxScoreArtifact,
} from "./espn-weekly-box-score.js";

describe("stored ESPN weekly box scores", () => {
  const artifact = {
    kind: "weekly-box-scores",
    week: 1,
    matchups: [
      {
        providerMatchupId: "101",
        home: { providerTeamId: "1", totalPoints: 0 },
        away: { providerTeamId: "2", totalPoints: 0 },
      },
    ],
    playerScores: [
      { providerTeamId: "1", starter: true, actualPoints: 11.82 },
      { providerTeamId: "1", starter: false, actualPoints: 30 },
      { providerTeamId: "2", starter: true, actualPoints: 7 },
      { providerTeamId: "2", starter: true, actualPoints: null },
    ],
  };

  it("recovers live team scores from starter actuals in older zero-total artifacts", () => {
    expect(parseEspnWeeklyBoxScoreArtifact(artifact)).toEqual({
      week: 1,
      matchups: [
        {
          providerMatchupId: "101",
          homeProviderTeamId: "1",
          awayProviderTeamId: "2",
          homeScore: 11.82,
          awayScore: 7,
        },
      ],
    });
  });

  it("overlays only an exact provider matchup and preserves a newer meaningful core score", () => {
    const parsed = parseEspnWeeklyBoxScoreArtifact(artifact);
    const base = {
      providerMatchupId: "101",
      week: 1,
      homeProviderTeamId: "1",
      awayProviderTeamId: "2",
      homeScore: "0",
      awayScore: "0",
      effectiveAt: new Date("2026-09-10T12:35:00.000Z"),
    };
    expect(
      mergeEspnWeeklyBoxScores([base], parsed, new Date("2026-09-10T12:34:00.000Z")),
    ).toMatchObject([{ homeScore: "11.82", awayScore: "7" }]);
    expect(
      mergeEspnWeeklyBoxScores(
        [{ ...base, homeScore: "12", awayScore: "8" }],
        parsed,
        new Date("2026-09-10T12:34:00.000Z"),
      ),
    ).toMatchObject([{ homeScore: "12", awayScore: "8" }]);
  });
});
