import { rosScoringProfile } from "@laces-out/projections";
import { describe, expect, it } from "vitest";

// Conformance-only import of the canonical wire contract. Production code cannot import it until
// the contracts barrel re-exports the leaf module.
import {
  ROS_WITHHOLDING_REASONS as CONTRACT_ROS_WITHHOLDING_REASONS,
  parseRosReleaseStatus,
} from "../../../packages/contracts/src/ros-release-status.js";
import {
  ROS_LEAGUE_POSITIONS,
  ROS_WITHHOLDING_REASONS,
  deriveAdmittedArtifacts,
  deriveCellGates,
  deriveLeagueReadiness,
  derivePublishedSets,
  deriveScoringProfileCoverage,
  deriveShadowAudit,
  type RosLeaguePositionSupport,
} from "./ros-release-status.js";

// Real catalog identities, so these tests fail if the canonical key ever changes shape.
const supportedKey = rosScoringProfile("full-ppr").scoringProfileKey;
const standardKey = rosScoringProfile("standard").scoringProfileKey;
const now = new Date("2026-09-01T06:00:00.000Z");

/** Every position reported supported with no messages — the default, happy-path shape. */
const ALL_POSITIONS_SUPPORTED: readonly RosLeaguePositionSupport[] = ROS_LEAGUE_POSITIONS.map(
  (position) => ({ position, supported: true, reasons: [] }),
);

type LeagueRow = Parameters<typeof deriveLeagueReadiness>[0]["leagues"][number];

function leagueRow(overrides: Partial<LeagueRow> = {}): LeagueRow {
  return {
    leagueSeasonId: "league-1",
    leagueName: "Daragely",
    scoringProfileKey: supportedKey,
    positions: ALL_POSITIONS_SUPPORTED,
    scheduleComplete: true,
    candidatePoolSnapshotAt: new Date("2026-09-01T00:00:00.000Z"),
    candidateInputCount: 300,
    sourceVerifiedAt: new Date("2026-09-01T00:00:00.000Z"),
    nonConvergedCells: 0,
    ...overrides,
  };
}

describe("deriveLeagueReadiness", () => {
  it("allows a partial profile match when at least one position is admitted", () => {
    const [league] = deriveLeagueReadiness({
      admittedScoringProfileKeys: [supportedKey],
      leagues: [leagueRow({ leagueSeasonId: "league-1", scoringProfileKey: standardKey })],
      now,
    });

    expect(league?.state).toBe("ready");
    expect(league?.reasons).toEqual([]);
    expect(league?.positions.filter((position) => position.decision === "ready")).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ position: "QB" }),
        expect.objectContaining({ position: "K" }),
        expect.objectContaining({ position: "DST" }),
      ]),
    );
  });

  it("names every unmet input independently rather than stopping at the first", () => {
    const [league] = deriveLeagueReadiness({
      admittedScoringProfileKeys: [supportedKey],
      leagues: [
        leagueRow({
          leagueSeasonId: "league-2",
          scheduleComplete: false,
          candidatePoolSnapshotAt: null,
          candidateInputCount: 0,
          sourceVerifiedAt: new Date("2026-01-01T00:00:00.000Z"),
          nonConvergedCells: 2,
        }),
      ],
      now,
    });

    expect(league?.reasons).toEqual([
      "incomplete-schedule",
      "missing-candidate-pool",
      "insufficient-candidate-inputs",
      "non-converged-cell",
      "stale-source",
    ]);
    expect(league?.state).toBe("withheld");
  });

  it("reports no-league-synced when the caller has no league season at all", () => {
    expect(
      deriveLeagueReadiness({ admittedScoringProfileKeys: [supportedKey], leagues: [], now }),
    ).toEqual([
      {
        leagueSeasonId: null,
        leagueName: null,
        state: "withheld",
        reasons: ["no-league-synced"],
        scoringProfile: null,
        positions: [],
      },
    ]);
  });

  it("is ready when every input is present and the profile is admitted", () => {
    const [league] = deriveLeagueReadiness({
      admittedScoringProfileKeys: [supportedKey],
      leagues: [leagueRow({ leagueSeasonId: "league-3" })],
      now,
    });

    expect(league?.state).toBe("ready");
    expect(league?.reasons).toEqual([]);
    expect(league?.scoringProfile?.label).toBe("Full PPR");
  });

  it("reports a mixture of ready and withheld leagues in one response", () => {
    const readiness = deriveLeagueReadiness({
      admittedScoringProfileKeys: [supportedKey],
      leagues: [
        leagueRow({ leagueSeasonId: "ready-league" }),
        leagueRow({ leagueSeasonId: "withheld-league", scheduleComplete: false }),
      ],
      now,
    });

    expect(readiness.map((entry) => [entry.leagueSeasonId, entry.state])).toEqual([
      ["ready-league", "ready"],
      ["withheld-league", "withheld"],
    ]);
  });

  it("does not label an unrecognized league profile with a catalog name", () => {
    const [league] = deriveLeagueReadiness({
      admittedScoringProfileKeys: [supportedKey],
      leagues: [
        leagueRow({
          leagueSeasonId: "custom",
          scoringProfileKey: '[{"statId":"receptions","points":1.75,"bonuses":[]}]',
        }),
      ],
      now,
    });

    expect(league?.scoringProfile).toBeNull();
    expect(league?.reasons).toEqual(["no-admitted-scoring-profile"]);
  });
});

describe("deriveLeagueReadiness position readiness", () => {
  it("splits scoring-rules-unsupported (zero positions supported) from no-admitted-scoring-profile", () => {
    const unsupportedPositions = ROS_LEAGUE_POSITIONS.map((position) => ({
      position,
      supported: false,
      reasons: ["No stored league scoring rules were available."],
    }));

    const [unsupported] = deriveLeagueReadiness({
      admittedScoringProfileKeys: [supportedKey],
      leagues: [leagueRow({ scoringProfileKey: null, positions: unsupportedPositions })],
      now,
    });
    expect(unsupported?.reasons).toEqual(["scoring-rules-unsupported"]);

    const [mismatched] = deriveLeagueReadiness({
      admittedScoringProfileKeys: [supportedKey],
      leagues: [
        leagueRow({
          scoringProfileKey: '[{"statId":"unsupported_stat","points":1,"bonuses":[]}]',
        }),
      ],
      now,
    });
    expect(mismatched?.reasons).toEqual(["no-admitted-scoring-profile"]);
  });

  it("withholds every position with position-unsupported when normalization produced zero supported positions", () => {
    const unsupportedPositions = ROS_LEAGUE_POSITIONS.map((position) => ({
      position,
      supported: false,
      reasons: ["No stored league scoring rules were available."],
    }));

    const [league] = deriveLeagueReadiness({
      admittedScoringProfileKeys: [supportedKey],
      leagues: [leagueRow({ scoringProfileKey: null, positions: unsupportedPositions })],
      now,
    });

    expect(league?.positions).toHaveLength(6);
    for (const entry of league?.positions ?? []) {
      expect(entry.decision).toBe("withheld");
      expect(entry.reasons).toEqual([
        "position-unsupported",
        "No stored league scoring rules were available.",
      ]);
    }
  });

  it("withholds one unsupported position with its normalization messages, while ready positions stay ready", () => {
    const positions: readonly RosLeaguePositionSupport[] = ROS_LEAGUE_POSITIONS.map((position) =>
      position === "DST"
        ? {
            position,
            supported: false,
            reasons: ["The league defines no DST scoring rules this projection run can price."],
          }
        : { position, supported: true, reasons: [] },
    );

    const [league] = deriveLeagueReadiness({
      admittedScoringProfileKeys: [supportedKey],
      leagues: [leagueRow({ positions })],
      now,
    });

    const byPosition = new Map(league?.positions.map((entry) => [entry.position, entry]));
    expect(byPosition.get("DST")).toEqual({
      position: "DST",
      decision: "withheld",
      reasons: [
        "position-unsupported",
        "The league defines no DST scoring rules this projection run can price.",
      ],
    });
    for (const position of ["QB", "RB", "WR", "TE", "K"] as const) {
      // scoringProfileKey is unchanged (supportedKey), so every supported position's scoped key
      // equals the admitted artifact's own scoped key exactly.
      expect(byPosition.get(position)).toEqual({ position, decision: "ready", reasons: [] });
    }
  });

  it("withholds a supported position with scoring-profile-position-mismatch when its scoped rules differ from every admitted artifact", () => {
    // full-ppr and standard share every rule except reception points, so only the pass-catching
    // positions (RB/WR/TE) disagree at the position-scoped key; QB/K/DST never reference receptions
    // and match byte-for-byte.
    const [league] = deriveLeagueReadiness({
      admittedScoringProfileKeys: [supportedKey],
      leagues: [leagueRow({ scoringProfileKey: standardKey })],
      now,
    });

    const byPosition = new Map(league?.positions.map((entry) => [entry.position, entry]));
    for (const position of ["RB", "WR", "TE"] as const) {
      expect(byPosition.get(position)).toEqual({
        position,
        decision: "withheld",
        reasons: ["scoring-profile-position-mismatch"],
      });
    }
    for (const position of ["QB", "K", "DST"] as const) {
      expect(byPosition.get(position)?.decision).toBe("ready");
    }
  });

  it("clamps a rule-heavy league's per-position reasons to the wire contract's 32-reason cap", () => {
    // A league with dozens of unmappable rule rows attributes one normalization message per rule
    // to a withheld position; unclamped, this can exceed `rosLeaguePositionReadinessSchema.reasons`'
    // `.max(32)` in `packages/contracts/src/ros-release-status.ts` and blank the whole payload.
    const heavyReasons = Array.from({ length: 40 }, (_unused, index) => `unmappable-rule-${index}`);
    const positions: readonly RosLeaguePositionSupport[] = ROS_LEAGUE_POSITIONS.map((position) =>
      position === "QB"
        ? { position, supported: false, reasons: heavyReasons }
        : { position, supported: true, reasons: [] },
    );

    const [league] = deriveLeagueReadiness({
      admittedScoringProfileKeys: [supportedKey],
      leagues: [leagueRow({ scoringProfileKey: null, positions })],
      now,
    });

    const qb = league?.positions.find((entry) => entry.position === "QB");
    expect(qb?.reasons).toHaveLength(32);
    expect(qb?.reasons[0]).toBe("position-unsupported");
    // The clamp keeps the earliest messages (most load-bearing: the first rule rows a league
    // author sees), not an arbitrary or reordered subset.
    expect(qb?.reasons.slice(1)).toEqual(heavyReasons.slice(0, 31));
  });

  it("is ready at every position when the league's whole key exactly equals an admitted artifact's", () => {
    const [league] = deriveLeagueReadiness({
      admittedScoringProfileKeys: [supportedKey],
      leagues: [leagueRow()],
      now,
    });

    expect(league?.positions).toHaveLength(6);
    expect(league?.positions.map((entry) => entry.decision)).toEqual(
      Array.from({ length: 6 }, () => "ready"),
    );
  });
});

describe("deriveShadowAudit", () => {
  it("never lets a shadow run describe the admitted artifact or the release state", () => {
    const audit = deriveShadowAudit({
      sourceSyncRunId: "run-9",
      mode: "shadow",
      qualityState: "degraded",
      createdAt: new Date("2026-07-27T00:00:00.000Z"),
      reasons: ["shadow_publication_disabled"],
    });

    expect(audit).toEqual({
      state: "recorded",
      latestRun: {
        sourceSyncRunId: "run-9",
        mode: "shadow",
        qualityState: "degraded",
        createdAt: "2026-07-27T00:00:00.000Z",
        reasons: ["shadow_publication_disabled"],
      },
    });
    expect(Object.keys(audit)).not.toContain("publication");
  });

  it("is 'none' when the season has never been audited", () => {
    expect(deriveShadowAudit(null)).toEqual({ state: "none", latestRun: null });
  });
});

describe("deriveAdmittedArtifacts and deriveScoringProfileCoverage", () => {
  const artifactRow = {
    season: 2026,
    scoringProfileKey: supportedKey,
    modelVersion: "laces-ros-distribution-v7",
    policyVersion: "season-walk-forward-block-wis-cqr-v4",
    calibrationVersion: "season-blocked-split-conformal-cqr-v1",
    evidenceThroughSeason: 2025,
    artifactChecksum: "67e7ba0945444df5b43dff75f5073721f10e3aa092c49723b88ac09d3e655d5d",
    admittedAt: new Date("2026-07-23T13:33:21.912Z"),
    sourceChecksumCount: 42,
  };

  it("reports 'none' with no artifacts rather than an empty 'admitted'", () => {
    expect(deriveAdmittedArtifacts([])).toEqual({ state: "none", artifacts: [] });
  });

  it("keeps one artifact per scoring profile, newest admission first", () => {
    const state = deriveAdmittedArtifacts([
      { ...artifactRow, admittedAt: new Date("2026-07-01T00:00:00.000Z") },
      artifactRow,
    ]);

    expect(state.state).toBe("admitted");
    expect(state.artifacts).toHaveLength(1);
    expect(state.artifacts[0]?.admittedAt).toBe("2026-07-23T13:33:21.912Z");
    expect(state.artifacts[0]?.scoringProfile.label).toBe("Full PPR");
  });

  it("lists a catalog profile with no admitted artifact as unsupported", () => {
    const coverage = deriveScoringProfileCoverage(deriveAdmittedArtifacts([artifactRow]));

    expect(coverage.supported.map((profile) => profile.label)).toEqual(["Full PPR"]);
    expect(coverage.unsupported.map((entry) => entry.profile.label)).toEqual([
      "Half PPR",
      "Standard (non-PPR)",
      "Standard + 2-pt, split kicker brackets, XP-missed penalty",
      "Standard + 2-pt, split kicker brackets, no XP-missed penalty",
      "Full PPR + yardage-game bonuses, 6-pt passing TD",
    ]);
    for (const entry of coverage.unsupported) {
      expect(entry.blockers).toEqual(["no_admitted_artifact"]);
    }
  });
});

describe("deriveCellGates", () => {
  it("returns every decision, released and withheld, from the latest release run", () => {
    const gates = deriveCellGates({
      createdAt: new Date("2026-09-01T00:00:00.000Z"),
      cellDecisions: [
        { position: "RB", bucket: "one-to-four", state: "release", reasons: [] },
        {
          position: "K",
          bucket: "one-to-four",
          state: "withhold",
          reasons: ["interval-coverage-gate-failed"],
        },
      ],
    });

    expect(gates.state).toBe("evaluated");
    expect(gates.evaluatedAt).toBe("2026-09-01T00:00:00.000Z");
    expect(gates.cells).toEqual([
      { position: "RB", bucket: "one-to-four", decision: "released", reasons: [] },
      {
        position: "K",
        bucket: "one-to-four",
        decision: "withheld",
        reasons: ["interval-coverage-gate-failed"],
      },
    ]);
  });

  it("is 'none' when no release run has recorded cell decisions", () => {
    expect(deriveCellGates(null)).toEqual({ state: "none", evaluatedAt: null, cells: [] });
    expect(deriveCellGates({ createdAt: new Date(), cellDecisions: [] })).toEqual({
      state: "none",
      evaluatedAt: null,
      cells: [],
    });
  });
});

describe("derivePublishedSets", () => {
  const setRow = {
    projectionSetId: "set-1",
    leagueSeasonId: "league-1",
    season: 2026,
    playerCount: 210,
    windowStartWeek: 7,
    windowEndWeek: 17,
    asOfWeek: 6,
    fetchedAt: new Date("2026-10-01T00:00:00.000Z"),
    inputChecksum: "b".repeat(64),
    championArtifactChecksum: "c".repeat(64),
    scoringProfileKey: supportedKey,
    leagueName: "Daragely",
  };

  it("marks the last good set as retained when the newest evaluation withheld", () => {
    const [published] = derivePublishedSets({
      rows: [setRow],
      preservePriorGoodSet: true,
    });

    expect(published?.retainedFromEarlierRun).toBe(true);
    expect(published?.scoringProfile?.label).toBe("Full PPR");
  });

  it("does not mark a set as retained when the newest evaluation released everything", () => {
    const [published] = derivePublishedSets({ rows: [setRow], preservePriorGoodSet: false });

    expect(published?.retainedFromEarlierRun).toBe(false);
  });

  it("keeps only the newest set per league", () => {
    const published = derivePublishedSets({
      rows: [
        { ...setRow, projectionSetId: "older", fetchedAt: new Date("2026-09-01T00:00:00.000Z") },
        { ...setRow, projectionSetId: "newer", fetchedAt: new Date("2026-10-01T00:00:00.000Z") },
      ],
      preservePriorGoodSet: false,
    });

    expect(published).toHaveLength(1);
    expect(published[0]?.projectionSetId).toBe("newer");
  });
});

describe("contract conformance", () => {
  it("keeps the API's reason list identical to the canonical wire contract", () => {
    // The contracts barrel is owned elsewhere this wave, so `apps/api` declares these shapes
    // locally. This guard fails the moment the two definitions diverge.
    expect([...ROS_WITHHOLDING_REASONS]).toEqual([...CONTRACT_ROS_WITHHOLDING_REASONS]);
  });

  it("produces a payload the canonical wire schema accepts", () => {
    const status = {
      season: 2026,
      modelVersion: "laces-ros-distribution-v7",
      admittedArtifacts: deriveAdmittedArtifacts([
        {
          season: 2026,
          scoringProfileKey: supportedKey,
          modelVersion: "laces-ros-distribution-v7",
          policyVersion: "season-walk-forward-block-wis-cqr-v4",
          calibrationVersion: "season-blocked-split-conformal-cqr-v1",
          evidenceThroughSeason: 2025,
          artifactChecksum: "67e7ba0945444df5b43dff75f5073721f10e3aa092c49723b88ac09d3e655d5d",
          admittedAt: new Date("2026-07-23T13:33:21.912Z"),
          sourceChecksumCount: 42,
        },
      ]),
      scoringProfiles: deriveScoringProfileCoverage(
        deriveAdmittedArtifacts([
          {
            season: 2026,
            scoringProfileKey: supportedKey,
            modelVersion: "laces-ros-distribution-v7",
            policyVersion: "season-walk-forward-block-wis-cqr-v4",
            calibrationVersion: "season-blocked-split-conformal-cqr-v1",
            evidenceThroughSeason: 2025,
            artifactChecksum: "67e7ba0945444df5b43dff75f5073721f10e3aa092c49723b88ac09d3e655d5d",
            admittedAt: new Date("2026-07-23T13:33:21.912Z"),
            sourceChecksumCount: 42,
          },
        ]),
      ),
      leagueReadiness: deriveLeagueReadiness({
        admittedScoringProfileKeys: [supportedKey],
        leagues: [leagueRow()],
        now,
      }),
      cellGates: deriveCellGates({
        createdAt: now,
        cellDecisions: [{ position: "RB", bucket: "one-to-four", state: "release", reasons: [] }],
      }),
      publishedSets: [],
      shadowAudit: deriveShadowAudit(null),
    };

    expect(parseRosReleaseStatus(JSON.parse(JSON.stringify(status)))).not.toBeNull();
  });
});
