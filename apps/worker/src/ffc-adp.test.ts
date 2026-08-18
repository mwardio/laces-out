import { DEFAULT_SOURCE_MATCH_RATE, sourceMatchRateThreshold } from "@laces-out/domain";
import { describe, expect, it } from "vitest";

import { buildUniqueFfcIdentity, defaultFfcAdpContexts, ffcAdpSourceKey } from "./ffc-adp.js";

describe("FFC ADP worker integration helpers", () => {
  it("builds all admitted redraft scoring and league-size contexts", () => {
    const contexts = defaultFfcAdpContexts(2026);
    expect(contexts).toHaveLength(12);
    expect(contexts).toContainEqual({
      season: 2026,
      teams: 12,
      scoringFormat: "ppr",
      position: null,
    });
    expect(contexts.some((context) => context.scoringFormat === "dynasty")).toBe(false);
  });

  it("uses team-aware identity while quarantining ambiguous name-position fallbacks", () => {
    const identity = buildUniqueFfcIdentity([
      { id: "one", fullName: "Chris Smith", primaryPosition: "WR", nflTeam: "BUF" },
      { id: "two", fullName: "Chris Smith", primaryPosition: "WR", nflTeam: "MIA" },
      { id: "three", fullName: "Unique Player", primaryPosition: "RB", nflTeam: "ATL" },
    ]);
    expect(identity.teamAware.get("chris smith|WR|BUF")).toBe("one");
    expect(identity.teamAware.get("chris smith|WR|MIA")).toBe("two");
    expect(identity.namePosition.has("chris smith|WR|")).toBe(false);
    expect(identity.namePosition.get("unique player|RB|")).toBe("three");
  });

  it("normalizes source suffixes, diacritics, and defenses for subsequent append-only snapshots", () => {
    const identity = buildUniqueFfcIdentity([
      { id: "cook", fullName: "James Cook III", primaryPosition: "RB", nflTeam: "BUF" },
      { id: "kicker", fullName: "Eddy Piñeiro", primaryPosition: "PK", nflTeam: "SF" },
      { id: "rams", fullName: "LA D/ST", primaryPosition: "D/ST", nflTeam: "LAR" },
    ]);

    expect(identity.teamAware.get("james cook|RB|BUF")).toBe("cook");
    expect(identity.teamAware.get("eddy pineiro|K|SF")).toBe("kicker");
    expect(identity.defenseByTeam.get("LA")).toBe("rams");
  });

  it("offers a unique name-team fallback for dual-role players and quarantines collisions", () => {
    const identity = buildUniqueFfcIdentity([
      { id: "hunter", fullName: "Travis Hunter", primaryPosition: "CB", nflTeam: "JAX" },
      { id: "first-smith", fullName: "Alex Smith", primaryPosition: "QB", nflTeam: "KC" },
      { id: "second-smith", fullName: "Alex Smith", primaryPosition: "TE", nflTeam: "KC" },
    ]);

    expect(identity.nameTeam.get("travis hunter|JAX")).toBe("hunter");
    expect(identity.nameTeam.has("alex smith|KC")).toBe(false);
  });

  it("keys every admitted context onto its registered match-rate threshold", () => {
    for (const context of defaultFfcAdpContexts(2026)) {
      const threshold = sourceMatchRateThreshold(ffcAdpSourceKey(context));

      expect(threshold.minimumMatchRate).toBe(DEFAULT_SOURCE_MATCH_RATE);
      expect(threshold.rationale).not.toMatch(/no source-specific threshold/iu);
    }
  });
});
