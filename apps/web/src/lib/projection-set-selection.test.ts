import type { ProjectionSetSummary } from "@laces-out/contracts";
import { describe, expect, it } from "vitest";
import {
  isCurrentManagedProjection,
  preferredProjectionSet,
  projectionScoringNotice,
} from "./projection-set-selection.js";

function set(
  id: string,
  compatibility: "current" | "changed" | "unknown" | undefined,
  horizon: "week" | "rest-of-season" = "week",
): ProjectionSetSummary {
  return {
    id,
    leagueSeasonId: "league",
    creatorUserId: null,
    creatorDisplayName: null,
    origin: "laces-out",
    visibility: "league",
    sourceLabel: id,
    sourceFileName: null,
    season: 2026,
    week: horizon === "week" ? 2 : null,
    horizon,
    playerCount: 1,
    inputChecksum: "a",
    sourceChecksum: "a",
    sourceObservedAt: null,
    sourceObservedAtStatus: "unverified",
    importedAt: "2026-09-10T12:00:00.000Z",
    isOwnedByCurrentUser: false,
    managed: {
      ...(compatibility === undefined ? {} : { scoringCompatibility: compatibility }),
      modelVersion: "previous-approved-model",
      computedAt: "2026-09-10T12:00:00.000Z",
      inputCheckedAt: "2026-09-10T12:00:00.000Z",
      trainingCutoff: null,
      statsThrough: null,
      qualityState: "publishable",
      championByPosition: [],
      coverage: null,
      warnings: [],
      backtest: null,
    },
  };
}

describe("projection defaults preserve exact league scoring", () => {
  it.each(["week", "rest-of-season"] as const)(
    "keeps an older same-scoring %s forecast ahead of newer mismatched or unknown history",
    (horizon) => {
      const rows = [
        set("new-different", "changed", horizon),
        set("unverified", "unknown", horizon),
        set("older-approved", "current", horizon),
      ];
      expect(preferredProjectionSet(rows, horizon, 2)).toBe(rows[2]);
      expect(projectionScoringNotice(rows[2])).toBeNull();
    },
  );
  it.each(["changed", "unknown", undefined] as const)(
    "never automatically displays a managed set with %s scoring, including legacy cached payloads",
    (compatibility) => {
      const historical = set("history", compatibility);
      expect(isCurrentManagedProjection(historical)).toBe(false);
      expect(preferredProjectionSet([historical], "week", 2)).toBeUndefined();
      // An explicitly selected historical set still has an explanation alongside its rows.
      expect(projectionScoringNotice(historical)).toContain("Historical forecast");
    },
  );
  it("preserves user-provided projection defaults while warning only for managed history", () => {
    const imported = { ...set("custom", undefined), origin: "custom" as const, managed: null };
    expect(preferredProjectionSet([set("different", "changed"), imported], "week", 2)).toBe(
      imported,
    );
    expect(projectionScoringNotice(imported)).toBeNull();
  });
  it("prefers the current weekly window without mixing in ROS", () => {
    const previous = { ...set("previous-week", "current"), week: 1 };
    const current = set("current-week", "current");
    expect(
      preferredProjectionSet(
        [set("ros", "current", "rest-of-season"), previous, current],
        "week",
        2,
      ),
    ).toBe(current);
  });
});
