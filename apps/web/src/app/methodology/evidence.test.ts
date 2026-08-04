import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

import {
  METHODOLOGY_EVIDENCE_MANIFEST_VERSION,
  ROS_COUNT_WORDS,
  rosArtifact,
  rosAvailabilityCeilings,
  rosAvailabilityGate,
  rosCellBlockerLifecycle,
  rosCellBlockerPolicy,
  rosConvergence,
  rosForecastCount,
  rosGateHistory,
  rosGateRows,
  rosHeldOutSeasons,
  rosPlayersPerPosition,
  rosSampleWidening,
  rosSampleWideningRows,
  rosScenarioPaths,
  rosScopeFigures,
  rosScoringProfiles,
  rosSharedReplayScope,
  rosSourceSeasons,
  rosWithheldCellFigures,
  weeklyArtifact,
  weeklyChampionOutcome,
  weeklyEvidenceState,
  weeklyGateRows,
  weeklyScopeFigures,
  weeklySeasons,
} from "./evidence.js";

function figureValue(label: string): string {
  const figure = weeklyScopeFigures.find((entry) => entry.label === label);
  if (!figure) throw new Error(`no weekly figure labelled ${label}`);
  return figure.value;
}

const pageSource = readFileSync(fileURLToPath(new URL("./page.tsx", import.meta.url)), "utf8");
/** Prettier wraps JSX prose, so phrase assertions run against whitespace-collapsed source. */
const pageProse = pageSource.replace(/\s+/gu, " ");

const weeklyAudit = JSON.parse(
  readFileSync(
    fileURLToPath(new URL("./weekly-validation-2026-07-27.json", import.meta.url)),
    "utf8",
  ),
) as {
  readonly generatedAt: string;
  readonly seasons: readonly number[];
  readonly gate: { readonly state: string; readonly reasons: readonly string[] };
  readonly player: {
    readonly predictions: number;
    readonly policy: { readonly modelVersion: string };
    readonly qualifiedCandidatePositions: readonly string[];
    readonly championOverall: { readonly mae: number; readonly bias: number };
  };
  readonly defense: {
    readonly predictions: number;
    readonly overall: { readonly mae: number; readonly baselineMae: number };
  };
};

describe("methodology evidence manifest", () => {
  it("is versioned", () => {
    // v2 widened the rest-of-season block from one scoring profile to three. v3 replaced all three
    // with the eight-player re-validation of 2026-07-28, which superseded them by recency. v4 added
    // the two league-shaped catalog profiles. v5 replaces their reconstructed v8 evidence with the
    // native-lineage, D/ST-complete v9 replays admitted 2026-08-04.
    expect(METHODOLOGY_EVIDENCE_MANIFEST_VERSION).toBe("methodology-evidence-v5");
  });

  // These values come from the three reports/ros-validation-v8-*-n8-2026-07-28.json artifacts, the
  // two native-lineage v9 catalog artifacts, and the engine's own constants. Pinning them means a
  // change to page copy cannot silently invent a new figure, and a model change forces this test to
  // be revisited alongside the published claim.
  it("pins the held-out seasons of the official rest-of-season replay", () => {
    expect(rosHeldOutSeasons).toEqual([2022, 2023, 2024, 2025]);
    expect(rosHeldOutSeasons).toHaveLength(4);
  });

  it("pins the graded forecast count and the sample it came from", () => {
    expect(rosForecastCount).toBe(3264);
    expect(rosPlayersPerPosition).toBe(8);
  });

  it("derives the graded forecast count from the replay's own cell structure", () => {
    // 68 batches x 6 positions x 8 sampled players. The artifact's 18 cells carry 288 samples for
    // each nine-plus cell and 128 for every other cell, which must sum to the published total.
    const ninePlus = 6 * 288;
    const shorterHorizons = 12 * 128;
    expect(ninePlus + shorterHorizons).toBe(rosForecastCount);
    expect(68 * 6 * rosPlayersPerPosition).toBe(rosForecastCount);
  });

  it("pins the two availability ceilings apart, because they are not interchangeable", () => {
    // FIRST_PARTY_ROS_MAX_AVAILABILITY_MAE / _MAX_NINE_PLUS_AVAILABILITY_MAE / _MAX_AVAILABILITY_BIAS
    // in packages/projections/src/rest-of-season.ts. A nine-plus cell compared against 1.5 would
    // report a failure the engine never raised, so the wider ceiling must stay a separate value.
    expect(rosAvailabilityCeilings.shortHorizonMae).toBe(1.5);
    expect(rosAvailabilityCeilings.ninePlusMae).toBe(2.75);
    expect(rosAvailabilityCeilings.signedBias).toBe(1);
    expect(rosAvailabilityCeilings.ninePlusMae).toBeGreaterThan(
      rosAvailabilityCeilings.shortHorizonMae,
    );
  });

  it("pins the simulation path counts", () => {
    expect(rosScenarioPaths.release).toBe(12_288);
    expect(rosScenarioPaths.reference).toBe(16_384);
    // The release run must be a strict prefix of the reference run for the check to be meaningful.
    expect(rosScenarioPaths.reference).toBeGreaterThan(rosScenarioPaths.release);
  });

  it("pins the convergence result", () => {
    expect(rosConvergence).toEqual({ converged: 144, total: 144 });
  });

  it("pins the source seasons", () => {
    expect(rosSourceSeasons).toEqual({ first: 2019, last: 2025, count: 7 });
    expect(rosSourceSeasons.last - rosSourceSeasons.first + 1).toBe(rosSourceSeasons.count);
  });

  it("pins the model, policy, and calibration identities", () => {
    expect(rosArtifact.modelVersion).toBe("laces-ros-distribution-v7");
    expect(rosArtifact.policyVersion).toBe("season-walk-forward-block-wis-cqr-v4");
    expect(rosArtifact.calibrationVersion).toBe("season-blocked-split-conformal-cqr-v1");
    expect(rosArtifact.intervalMethodVersion).toBe("simulation-p15-p50-p85-cqr-v1");
    expect(rosArtifact.availabilityCalibrationVersion).toBe(
      "historical-ros-availability-curve-matched-v3",
    );
    expect(rosArtifact.roleCalibrationVersion).toBe("historical-ros-role-center-two-moment-v4");
    expect(rosArtifact.kickerCalibrationVersion).toBe("historical-ros-kicker-count-process-v1");
  });

  it("pins the artifact checksum and scoring profile digest as lowercase sha256", () => {
    expect(rosArtifact.artifactChecksum).toBe(
      "739b8306e3f3212542d2f778575bfe741b79e8660bc27357d86064f1554996a1",
    );
    expect(rosArtifact.scoringProfileDigest).toBe(
      "dd74455ddb551d53f68ba9420f4446aebf63e3e8ea34efd24119cc780c47a484",
    );
    for (const digest of [rosArtifact.artifactChecksum, rosArtifact.scoringProfileDigest]) {
      expect(digest).toMatch(/^[a-f0-9]{64}$/u);
    }
  });

  it("pins the reported and admission states", () => {
    expect(rosArtifact.reportState).toBe("insufficient");
    expect(rosArtifact.admissionState).toBe("admissible");
    expect(rosArtifact.evidenceThroughSeason).toBe(2025);
  });
});

describe("rest-of-season scoring profiles", () => {
  // Values come from the three eight-player v8 reports, all dated 2026-07-28 by their own
  // .generatedAt, and from re-running validateFirstPartyRosAdmission against each. Each resulting
  // artifactChecksum equals the artifact_checksum of that profile's newest
  // first_party_ros_champion_artifacts row for season 2026 in the production database.
  it("pins the profiles, in the engine's fixed order", () => {
    expect(rosScoringProfiles.map((profile) => profile.key)).toEqual([
      "full-ppr",
      "half-ppr",
      "standard",
      "espn-standard-2pt",
      "espn-standard-2pt-nxm",
    ]);
    expect(rosScoringProfiles.map((profile) => profile.label)).toEqual([
      "Full PPR",
      "Half PPR",
      "Standard (non-PPR)",
      "Standard + 2-pt, split kicker brackets, XP-missed penalty",
      "Standard + 2-pt, split kicker brackets, no XP-missed penalty",
    ]);
    // Short labels are what prose joins into a list, so they must exist and stay distinct.
    const shortLabels = rosScoringProfiles.map((profile) => profile.shortLabel);
    expect(new Set(shortLabels).size).toBe(rosScoringProfiles.length);
    for (const shortLabel of shortLabels) expect(shortLabel.length).toBeGreaterThan(0);
  });

  it("pins each report's own state and blockers verbatim", () => {
    expect(
      rosScoringProfiles.map((profile) => [profile.key, profile.reportState] as const),
    ).toEqual([
      ["full-ppr", "insufficient"],
      ["half-ppr", "insufficient"],
      ["standard", "insufficient"],
      ["espn-standard-2pt", "insufficient"],
      ["espn-standard-2pt-nxm", "insufficient"],
    ]);
    expect(rosScoringProfiles.map((profile) => [...profile.reportedBlockers])).toEqual([
      [
        "calibration_QB_nine-plus_availability_mae_above_maximum",
        "calibration_WR_five-to-eight_availability_mae_above_maximum",
      ],
      ["calibration_QB_nine-plus_availability_mae_above_maximum"],
      ["calibration_QB_nine-plus_availability_mae_above_maximum"],
      ["calibration_DST_five-to-eight_coverage_shortfall_above_maximum"],
      ["calibration_DST_five-to-eight_coverage_shortfall_above_maximum"],
    ]);
    // Every blocker must match the admission policy's cell pattern, or the artifact would have been
    // rejected outright rather than admitted with cells withheld.
    for (const profile of rosScoringProfiles) {
      for (const blocker of profile.reportedBlockers) {
        expect(blocker).toMatch(
          /^(?:cell|champion|calibration)_(?:QB|RB|WR|TE|K|DST)_(?:one-to-four|five-to-eight|nine-plus)_/u,
        );
      }
    }
  });

  it("pins each admitted artifact checksum and scoring digest as lowercase sha256", () => {
    expect(
      rosScoringProfiles.map((profile) => [profile.key, profile.artifactChecksum] as const),
    ).toEqual([
      ["full-ppr", "739b8306e3f3212542d2f778575bfe741b79e8660bc27357d86064f1554996a1"],
      ["half-ppr", "f419d48b31458a9f1cdf747930bda60e55cc370dad9dd8a72392e1bef5ded358"],
      ["standard", "2ab659edb7b376f2f29583b88846a7dcde6b22ea8db934a1aed1eefde5c4f4d6"],
      ["espn-standard-2pt", "e870faab6d4e8c387f4b91e92bc77b6ce7e5cf0141a1c05aae7b39a2672e3adf"],
      ["espn-standard-2pt-nxm", "e3f5fb77c01ce377140be137de400b6f4a824ec8d741de8a2321c62450017165"],
    ]);
    expect(
      rosScoringProfiles.map((profile) => [profile.key, profile.scoringProfileDigest] as const),
    ).toEqual([
      ["full-ppr", "dd74455ddb551d53f68ba9420f4446aebf63e3e8ea34efd24119cc780c47a484"],
      ["half-ppr", "66c5c9a41225e6b1b2fde37f680a78a450c3b098c107a8eff47e1df251c338c8"],
      ["standard", "ecf4238506ddd4284870dcec5408b1acff501de29ee0f7662ef12f6d19a24ad0"],
      ["espn-standard-2pt", "6a2ce8c94a3733673f17056d2ffafc27dca00c1ab93d17ce58a1bdce9b6d6843"],
      ["espn-standard-2pt-nxm", "d0e49cad7fbbdf20552427d107bea2cd9a6c2f735b4d67745d5e5ca9e85832eb"],
    ]);
    const digests = new Set<string>();
    for (const profile of rosScoringProfiles) {
      for (const digest of [profile.artifactChecksum, profile.scoringProfileDigest]) {
        expect(digest).toMatch(/^[a-f0-9]{64}$/u);
        digests.add(digest);
      }
    }
    // Distinct profiles must never share a scoring key or an artifact identity.
    expect(digests.size).toBe(rosScoringProfiles.length * 2);
  });

  it("keeps the full-PPR record identical to the single-profile manifest it grew out of", () => {
    const fullPpr = rosScoringProfiles.find((profile) => profile.key === "full-ppr");
    expect(fullPpr).toBeDefined();
    expect(fullPpr?.artifactChecksum).toBe(rosArtifact.artifactChecksum);
    expect(fullPpr?.scoringProfileDigest).toBe(rosArtifact.scoringProfileDigest);
    expect(fullPpr?.reportState).toBe(rosArtifact.reportState);
    expect(fullPpr?.admissionState).toBe(rosArtifact.admissionState);
    expect(fullPpr?.evaluatedAt).toBe(rosArtifact.evaluatedAt);
  });

  it("pins the evaluation and admission dates", () => {
    expect(rosScoringProfiles.map((profile) => profile.evaluatedAt)).toEqual([
      "2026-07-28",
      "2026-07-28",
      "2026-07-28",
      "2026-08-04",
      "2026-08-04",
    ]);
    expect(rosScoringProfiles.map((profile) => profile.admittedAt)).toEqual([
      "2026-07-28",
      "2026-07-28",
      "2026-07-28",
      "2026-08-04",
      "2026-08-04",
    ]);
    // Nothing may be admitted before the replay that justifies it.
    for (const profile of rosScoringProfiles) {
      expect(profile.admittedAt >= profile.evaluatedAt).toBe(true);
    }
  });

  it("pins the shared replay scope every profile was graded at", () => {
    expect(rosSharedReplayScope.batches).toBe(68);
    expect(rosSharedReplayScope.cells).toBe(18);
    expect(rosSharedReplayScope.convergenceDiagnostics).toBe(rosConvergence.total);
  });

  it("pins the same complete six-position forecast count for every profile", () => {
    expect(rosScoringProfiles.map((profile) => [profile.key, profile.forecasts] as const)).toEqual([
      ["full-ppr", rosForecastCount],
      ["half-ppr", rosForecastCount],
      ["standard", rosForecastCount],
      ["espn-standard-2pt", rosForecastCount],
      ["espn-standard-2pt-nxm", rosForecastCount],
    ]);
    expect(new Set(rosScoringProfiles.map((profile) => profile.forecasts))).toEqual(
      new Set([rosForecastCount]),
    );
  });

  it("spells the profile counts the page states in prose", () => {
    // The page indexes ROS_COUNT_WORDS with a real .length, so the word can never disagree with
    // the array. This pins the entries that indexing actually reaches.
    expect(ROS_COUNT_WORDS[rosScoringProfiles.length]).toBe("five");
    const blocked = rosScoringProfiles.filter((profile) => profile.reportedBlockers.length > 0);
    expect(ROS_COUNT_WORDS[blocked.length]).toBe("five");
    const clean = rosScoringProfiles.filter((profile) => profile.reportedBlockers.length === 0);
    expect(ROS_COUNT_WORDS[clean.length]).toBe("zero");
    expect(ROS_COUNT_WORDS[rosScoringProfiles.filter((p) => p.narrowerSampleReplayed).length]).toBe(
      "three",
    );
    expect(pageProse).not.toMatch(/\{rosProfileCount\}/u);
  });

  it("names the ratified per-cell policy that admission relied on", () => {
    expect(rosCellBlockerPolicy.ratifiedAt).toBe("2026-07-22");
    expect(rosCellBlockerPolicy.source).toContain("first-party-ros-admission.ts");
  });

  it("states the cell-blocker lifecycle without overclaiming re-evaluation", () => {
    // Admission (first-party-ros-admission.ts) defers per-cell blockers to the release gate, and
    // publication records a cellDecisions entry per bucket. But the same publication module's
    // admittedCellBlockers overrides a releasing gate for cells the admitted report blocked, so
    // "re-evaluated" must never be published as "may release anyway".
    expect(rosCellBlockerLifecycle.reEvaluatedAtPublication).toBe(true);
    expect(rosCellBlockerLifecycle.decisionsRecordedPerCell).toBe("cellDecisions");
    expect(rosCellBlockerLifecycle.admittedBlockersOverrideReleasingGate).toBe(true);
    expect(rosCellBlockerLifecycle.admissionSource).toContain("first-party-ros-admission.ts");
    expect(rosCellBlockerLifecycle.publicationSource).toContain("first-party-ros-publication.ts");
    // RETIRED (round 6): the two page pins went with the cell-blocker lifecycle paragraph, which
    // was cut from the page. The page no longer describes admitted artifacts or cell blockers at
    // all, so there is no copy left to overclaim; the lifecycle stays pinned here as the record.
  });

  it("sources every withheld-cell figure from a named artifact field or code constant", () => {
    expect(rosWithheldCellFigures.length).toBeGreaterThan(0);
    for (const figure of rosWithheldCellFigures) {
      expect(figure.source).toMatch(
        /ros-validation-v(?:8(?:\/v9)?|9)[a-z0-9-]* \.|FIRST_PARTY_ROS_/u,
      );
      expect(figure.value.length).toBeGreaterThan(0);
    }
    // The artifact-pointer column was dropped from the rendered tables by direction. Every pointer
    // is still required of the manifest — above and in the scope-figure test — which is where an
    // operator checks them; the page must not grow the column back without that being a decision.
    // Pinned on the binding rather than on the words "read from", which still appear in the
    // dataset-level provenance a caption is entitled to state.
    expect(pageProse).not.toContain("{figure.source}");
    expect(pageProse).not.toContain('scope="col">Read from');
    expect(pageProse).not.toContain("Source column");
  });

  it("records why each blocked cell is blocked, against its own horizon's ceiling", () => {
    const byLabel = new Map(rosWithheldCellFigures.map((figure) => [figure.label, figure]));
    // Every quarterback 9+ cell is over FIRST_PARTY_ROS_MAX_NINE_PLUS_AVAILABILITY_MAE = 2.75.
    // Comparing any of these against the 1.5 short-window ceiling would be a category error.
    for (const [label, value] of [
      [
        "Full PPR — quarterback, 9+ weeks: expected-games error",
        "2.8091 games against a 2.75-game ceiling — blocked, over by 0.0591",
      ],
      [
        "Half PPR — quarterback, 9+ weeks: expected-games error",
        "2.8057 games against a 2.75-game ceiling — blocked, over by 0.0557",
      ],
      [
        "Standard — quarterback, 9+ weeks: expected-games error",
        "2.7638 games against a 2.75-game ceiling — blocked, over by 0.0138",
      ],
    ] as const) {
      expect(byLabel.get(label)?.value).toBe(value);
      expect(byLabel.get(label)?.source).toContain(
        "FIRST_PARTY_ROS_MAX_NINE_PLUS_AVAILABILITY_MAE",
      );
    }
    // The wide receiver 5-8 cell blocks under one profile and clears under the other two; all three
    // are published so the page cannot present the failure as the whole picture.
    expect(byLabel.get("Full PPR — wide receiver, 5–8 weeks: expected-games error")?.value).toBe(
      "1.5399 games against a 1.5-game ceiling — blocked, over by 0.0399",
    );
    expect(byLabel.get("Standard — wide receiver, 5–8 weeks: expected-games error")?.value).toBe(
      "1.4912 games against a 1.5-game ceiling — not blocked, under by 0.0088",
    );
    expect(byLabel.get("Half PPR — wide receiver, 5–8 weeks: expected-games error")?.value).toBe(
      "1.3755 games against a 1.5-game ceiling — not blocked, under by 0.1245",
    );
    // The kicker coverage evidence test no longer finds undercoverage in either profile.
    expect(byLabel.get("Half PPR — kicker, 1–4 weeks: walk-forward blocks covered")?.value).toBe(
      "3 of 4 — not blocked",
    );
    expect(byLabel.get("Standard — kicker, 1–4 weeks: walk-forward blocks covered")?.value).toBe(
      "2 of 4 — not blocked",
    );
  });

  it("records what the wider sample changed, in both directions", () => {
    expect(rosSampleWidening.previousPlayersPerPosition).toBe(5);
    expect(rosSampleWidening.playersPerPosition).toBe(rosPlayersPerPosition);
    expect(rosSampleWidening.playersPerPosition).toBeGreaterThan(
      rosSampleWidening.previousPlayersPerPosition,
    );
    // No gate, threshold, tolerance, or minimum moved; only the sample did. Publishing a
    // regression as if the bar had been lowered instead would be the dishonest reading.
    expect(rosSampleWidening.gatesUnchanged).toBe(true);
    expect(rosSampleWideningRows.map((row) => [row.profile, row.change])).toEqual([
      ["Full PPR", "Zero blockers to two"],
      ["Half PPR", "One to one, a different cell"],
      ["Standard (non-PPR)", "Two blockers to one"],
    ]);
    // Each row's "after" must agree with the profile record it describes, so the comparison table
    // cannot drift away from the blockers actually published above it.
    // The table covers exactly the profiles that have both generations — no more (which would imply
    // a comparison that was never run) and no fewer (which would hide one that was).
    expect(rosSampleWideningRows.map((row) => row.profile)).toEqual(
      rosScoringProfiles
        .filter((profile) => profile.narrowerSampleReplayed)
        .map((profile) => profile.label),
    );
    expect(rosSampleWideningRows).toHaveLength(3);
    expect(rosScoringProfiles.filter((profile) => !profile.narrowerSampleReplayed)).toHaveLength(2);
    expect(rosSampleWideningRows.map((row) => row.after)).toEqual([
      "Quarterback 9+; wide receiver 5–8.",
      "Quarterback 9+.",
      "Quarterback 9+.",
    ]);
    // RETIRED (round 6): the sample-widening section was cut from the page. The comparison stays
    // pinned here so the manifest cannot drift, but no copy asserts it any more.
  });
});

describe("published claims stay honest about release state", () => {
  it("describes the live publication gate the rail actually runs", () => {
    // REWRITTEN (round 8). This row read "Not performed. The rail reports
    // shadow_publication_disabled unconditionally" — true while the rail was shadow-only, false
    // once it began releasing. `shadow_publication_disabled` survives in the worker only on the
    // DEGRADED branch (first-party-ros-projections.ts), not on the release path, which runs
    // evaluateFirstPartyRosPublication per league and per position.
    const publication = rosGateRows.find((row) => row.gate === "Publication");
    expect(publication).toBeDefined();
    expect(publication?.state).toBe("pass");
    expect(publication?.outcome).not.toContain("shadow_publication_disabled");
    // All four live conditions must stay named, or the row stops describing the gate it claims to.
    for (const condition of [
      "validates against the running constants",
      "scoring identity matches",
      "remaining-season window is complete",
      "live release gate returns release",
    ]) {
      expect(publication?.requirement).toContain(condition);
    }
  });

  it("states the rest-of-season release rule instead of a blanket publishing claim", () => {
    // REWRITTEN (round 8). The page used to say rest-of-season forecasts "are not published to
    // users today" and described shadow-mode promotion as the reason. Both were true only while no
    // league had cleared, and would have become false at draft time without anyone editing the
    // page. The replacement is true in both states because it states the gate, not the moment.
    expect(pageProse).toContain("Rest-of-season release is gated per league and per position");
    expect(pageProse).toContain("its scoring matches an admitted evidence artifact");
    expect(pageProse).toContain(
      "a synced league, the current NFL player pool, and a complete remaining-season window",
    );
    expect(pageProse).toContain("receives nothing rather than a weaker number");
    // The audit clause is allowed, but only as auditing — never as the reason nothing ships.
    expect(pageProse).toContain("records what it released and what it withheld");
    // Retired framings that a future edit must not reinstate.
    for (const stale of [
      "not published to users today",
      "shadow mode",
      "Promotion out of shadow mode",
      "still in validation and do not publish",
    ]) {
      expect(pageSource).not.toContain(stale);
    }
  });

  it("discloses the replays that did not clear their gates", () => {
    const failed = rosGateHistory.filter((row) => row.outcome === "fail");
    expect(failed).toHaveLength(5);
    // A receipt that lists only the passing run is not a receipt. The current replay is itself a
    // failing row, so it must appear here and not only in the profile table.
    expect(failed.map((row) => row.run)).toEqual([
      "v6 — 2026-07-22",
      "v7 — 2026-07-23",
      "v8, narrower sample — 2026-07-28 (Half PPR, Standard)",
      "v8, current sample — 2026-07-28 (all three profiles)",
      "v9, D/ST-complete catalog profiles — 2026-08-04 (Standard + 2-pt, with and without the XP-missed penalty)",
    ]);
    for (const row of failed) {
      expect(row.blockers.length).toBeGreaterThan(0);
      expect(row.blockers).not.toBe("None.");
    }
    // Two historical rows pass. The superseded narrow-sample Full PPR replay and the earlier v8
    // catalog pair remain in the receipt even though neither is the current evidence.
    const passed = rosGateHistory.filter((row) => row.outcome === "pass");
    expect(passed).toHaveLength(2);
    expect(passed[0]?.run).toContain("narrower sample");
    expect(passed[0]?.blockers).toContain("Superseded");
    const current = rosGateHistory[rosGateHistory.length - 1];
    expect(current?.run).toContain("D/ST-complete catalog profiles");
    expect(current?.state).toBe("insufficient");
    expect(current?.outcome).toBe("fail");
    expect(current?.blockers).toContain("Team-defense interval coverage");
    // The superseded clean catalog run stays on the record directly before the current v9 row.
    const priorRun = rosGateHistory[rosGateHistory.length - 2];
    expect(priorRun?.run).toContain("v8, catalog profiles");
    expect(priorRun?.state).toBe("evidence-ready");
  });

  it("no longer claims the live publication gate still point-compares", () => {
    // On 2026-07-29 the live release gate adopted the availability evidence test (same ceilings,
    // same alpha) and a position-scoped evidence-identity comparison, so the superseded claim is
    // pinned stale in both the manifest and the rendered copy.
    expect(rosAvailabilityGate.revisedAt).toBe("2026-07-28");
    expect(rosAvailabilityGate.publicationGateAlignedAt).toBe("2026-07-29");
    expect(rosAvailabilityGate.ceilingsUnchanged).toBe(true);
    expect(rosAvailabilityGate.biasKeepsPointComparison).toBe(true);
    expect(rosAvailabilityGate.admittedEvidenceGradedUnderPointComparison).toBe(true);
    expect(rosAvailabilityGate).not.toHaveProperty("publicationGateStillPointCompares");
    const manifest = readFileSync(fileURLToPath(new URL("./evidence.ts", import.meta.url)), "utf8");
    for (const source of [pageProse, manifest]) {
      expect(source).not.toContain("still point-compares");
      expect(source).not.toContain("publicationGateStillPointCompares");
    }
    // RETIRED (round 6): both page pins went with the availability-gate paragraph, which was cut.
    // The page no longer describes the gate's decision rule or admitted artifacts, so it makes no
    // claim about either. The negative pins above stay — they are what stop the superseded
    // "still point-compares" claim being reintroduced anywhere.
  });

  it("discloses that the richer weekly model did not earn promotion", () => {
    expect(weeklyChampionOutcome.playerPositionsWonByRicherModel).toBe(0);
    expect(weeklyChampionOutcome.playerPositionsDefendedByBaseline).toBe(5);
    expect(pageProse).toContain("The simpler model is still winning");
  });

  it("no longer claims the rest-of-season evidence covers a single scoring profile", () => {
    // The superseded limitations bullet. It was true until half-PPR and standard were validated
    // and admitted; republishing any part of it would be a false claim, so it is pinned as stale.
    for (const stale of [
      "The rest-of-season evidence covers one scoring profile",
      "The replay graded a single fixed profile",
      "Coverage for common league scoring variants has not been established",
    ]) {
      expect(pageProse).not.toContain(stale);
    }
  });

  it("never presents a profile that did not clear its gates as cleanly validated", () => {
    const blocked = rosScoringProfiles.filter((profile) => profile.reportedBlockers.length > 0);
    expect(blocked).toHaveLength(5);
    for (const profile of blocked) {
      // Its own run did not clear, and admission did not change that.
      expect(profile.reportState).toBe("insufficient");
      expect(profile.admissionState).toBe("admissible");
      expect(profile.withheldCells).not.toBe("None.");
    }
    // The raw engine enums stay pinned in the manifest above and must never reach product copy:
    // "insufficient" printed beside "admissible" reads as a contradiction of two facts that
    // actually agree. The page states their meaning instead, and the meaning is what is pinned.
    expect(pageSource).not.toContain("insufficient");
    expect(pageSource).not.toContain("admissible");
    expect(pageProse).not.toContain("Reported state");
    // RETIRED (round 6): the per-profile evidence table and its admission paragraphs were cut, so
    // the pins on "did not clear their own gates", "The runs did not pass; admission tolerated
    // them.", "cell-scoped rather than global" and the per-row withheld-cell renders retire with
    // them. The page now states only the summary rule — a cell that fails a gate is withheld and
    // publishes nothing — which is pinned in "states that a withheld cell publishes nothing".
  });

  it("pins the current D/ST interval blocker without weakening the other cells", () => {
    const clean = rosScoringProfiles.filter((profile) => profile.reportedBlockers.length === 0);
    expect(clean).toHaveLength(0);
    const catalogProfiles = rosScoringProfiles.filter((profile) =>
      profile.key.startsWith("espn-standard-2pt"),
    );
    expect(catalogProfiles).toHaveLength(2);
    for (const profile of catalogProfiles) {
      expect(profile.reportState).toBe("insufficient");
      expect(profile.reportedBlockers).toEqual([
        "calibration_DST_five-to-eight_coverage_shortfall_above_maximum",
      ]);
      expect(profile.withheldCells).toBe("Team defense, 5–8 remaining weeks.");
    }
    const defenceRows = rosWithheldCellFigures.filter((figure) =>
      figure.label.includes("team defense"),
    );
    expect(defenceRows).toHaveLength(2);
    for (const row of defenceRows) {
      expect(row.value).toContain("0 of 4");
      expect(row.value).toContain("blocked");
      expect(row.value).toContain("lower point error than baseline");
    }
    // Full PPR was the clean profile at the narrower sample and is not at this one.
    expect(rosArtifact.reportState).not.toBe("evidence-ready");
    for (const stale of [
      "came back clean",
      "replay cleared its statistical gates",
      "0 blockers recorded",
      "No scoring profile is clean",
    ]) {
      expect(pageProse).not.toContain(stale);
    }
    // The gate table keeps legacy availability failures separate from the current D/ST interval
    // failure, and the blocker summary acknowledges both.
    const failedGates = rosGateRows.filter((row) => row.state === "fail").map((row) => row.gate);
    expect(failedGates).toEqual([
      "Availability accuracy",
      "Interval calibration",
      "Release blockers",
    ]);
  });

  it("cannot republish any figure from superseded replay generations", () => {
    // Every value below was a published claim until a wider or D/ST-complete validation superseded
    // it. Reinstating one would be a false current claim, so each is pinned as stale across the
    // manifest and rendered copy alike.
    const manifest = readFileSync(fileURLToPath(new URL("./evidence.ts", import.meta.url)), "utf8");
    const staleFigures = [
      // .report.forecasts and its display form at five players per position.
      "2040",
      "2,040",
      // The first catalog replay omitted meaningful D/ST scoring and therefore graded fewer rows.
      "2965",
      "2,965",
      // Superseded availability MAE values: standard/full-ppr WR five-to-eight, and QB nine-plus.
      "1.5031",
      "1.4118",
      "2.6396",
      "2.6384",
      "2.6731",
      // Superseded worst signed bias.
      "0.9136",
      // Superseded admitted artifact checksums, retained in the database as immutable history.
      "67e7ba0945444df5b43dff75f5073721f10e3aa092c49723b88ac09d3e655d5d",
      "fb636ad5028350f67ac7c1222c969ad52872ef8967ae4cce063ea3d3f36f88ac",
      "b779d5c13b9147b16a04107456c0c3128b6baef7a6f5d03f52eadb313321dbc7",
      // Superseded v8 catalog artifact checksums and scoring digests.
      "0f715aba1888f35d60f359ef4299c7e80dbe7824f6f28c6a871deda1ce950ff9",
      "a513471f27d73e84831dd17215ef959746dfc4315c2b9b8ba03bd1b3970c9430",
      "4835b6c57ae0ceeebb1750ad6ff81ec5f6988f28fb5193b42a067178cfe0a09e",
      "d2bdcbc7a786d05fa4dcf0b9dbd9f519cf9c78c1e883ed2fef7f913c94ceb49e",
    ];
    for (const stale of staleFigures) {
      expect(pageSource).not.toContain(stale);
      // The manifest may name the stale value only inside this test, never as published evidence.
      expect(manifest).not.toContain(stale);
    }
    // The kicker coverage blocker was real at the narrower sample and is not reported now.
    for (const profile of rosScoringProfiles) {
      expect(profile.reportedBlockers).not.toContain(
        "calibration_K_one-to-four_coverage_shortfall_above_maximum",
      );
    }
    // Scope figures must state the sample that actually produced them.
    const sampled = rosScopeFigures.find(
      (figure) => figure.label === "Players sampled per position, per cutoff",
    );
    expect(sampled?.value).toBe(String(rosPlayersPerPosition));
    // The scope row must state every forecast total currently in play and no superseded one. It is
    // no longer a single number, so this pins membership rather than equality — which is stricter,
    // because it now has to hold for each profile's own count.
    const graded = rosScopeFigures.find(
      (figure) => figure.label === "Forecasts graded against realized outcomes",
    );
    expect(graded).toBeDefined();
    const currentTotals = [...new Set(rosScoringProfiles.map((profile) => profile.forecasts))];
    expect(currentTotals).toContain(rosForecastCount);
    for (const total of currentTotals) {
      expect(graded?.value).toContain(total.toLocaleString("en-US"));
    }
  });

  it("states that a withheld cell publishes nothing rather than a weaker number", () => {
    expect(pageProse).toContain(
      "A withheld cell means no number is published for that position and horizon at all, " +
        "not a lower-confidence number",
    );
  });

  it("keeps the development-evidence caveat about the held-out corpus", () => {
    // UPDATED (round 6), not retired: the caveat survives the cut in compressed form, so the pins
    // move to the wording that carries it. What must remain sayable is that the held-out seasons
    // were replayed during development, that this makes the evidence development evidence rather
    // than a clean out-of-sample test, and that a real confirmation needs an unseen season.
    expect(pageProse).toContain("The rest-of-season evidence is development evidence");
    expect(pageProse).toContain("replayed while the model was being revised");
    expect(pageProse).toContain("not a clean out-of-sample test");
    expect(pageProse).toContain(
      "A genuine confirmation requires a season the model has never seen",
    );
  });

  it("does not borrow the shadow model's evidence for what actually publishes", () => {
    // METH-2. The subtitle sits above the split between the two models, so every clause in it has
    // to be true of the weekly rail. rosHeldOutSeasons (four) belongs to the rest-of-season model,
    // which publishes nothing; the weekly audit covers weeklySeasons (three).
    expect(pageProse).toContain("The model that publishes is backtested across");
    expect(pageProse).toContain("{weeklySeasonCountWord} completed NFL");
    expect(rosHeldOutSeasons.length).not.toBe(weeklySeasons.length);
    // The rest-of-season season count may still be stated, but only inside its own section.
    const rosSectionStart = pageProse.indexOf("Rest-of-season release is gated per league");
    expect(rosSectionStart).toBeGreaterThan(0);
    expect(pageProse.indexOf("{rosHeldOutCountWord}")).toBeGreaterThan(rosSectionStart);
  });

  it("states the convergence check at the scope the code actually runs it", () => {
    // METH-1. Both paths diagnose exactly one representative forecast per position/horizon stratum
    // — first-party-ros-backtest.ts (`const sample = [...values].sort(...)[0]!`) and
    // first-party-ros-candidate-provider.ts (`const representative = ordered[0]!`). The page may
    // say each projection is SIMULATED at the release path count; it may not say each projection is
    // CHECKED against the reference run.
    expect(pageProse).toContain("convergence is spot-checked per position-and-horizon stratum");
    expect(pageProse).not.toContain("paths and checked against a larger");
    // The diagnostics count is far smaller than the forecast count, which is what makes
    // "each projection is checked" false. Pinned so the two can never be conflated again.
    expect(rosConvergence.total).toBeLessThan(
      Math.min(...rosScoringProfiles.map((profile) => profile.forecasts)),
    );
  });

  it("never implies team defense cleared the player positions' promotion margin", () => {
    // METH-3. FIRST_PARTY_CHAMPION_MINIMUM_IMPROVEMENT (0.02) is applied in
    // applyFirstPartyProjectionChampionPolicy to player positions only. D/ST promotion is the bare
    // strict inequality `beatsBaseline: mae < baselineMae` (first-party.ts), and the worker gate is
    // the same bare comparison. The measured 4.67% is real but was never held to a margin.
    expect(pageProse).toContain("held to a different and weaker test");
    expect(pageProse).toContain("only has to beat its baseline, with no margin required");
    expect(pageProse).not.toContain("Team defense is the exception");
    // The improvement may still be published — but never as evidence of clearing a bar.
    expect(weeklyChampionOutcome.defenseImprovement).toBe("4.67%");
  });

  it("keeps weekly and rest-of-season evidence in separate sections", () => {
    expect(pageSource).toContain("Two models, graded separately");
    expect(weeklyGateRows.length).toBeGreaterThan(0);
    expect(rosGateRows.length).toBeGreaterThan(0);
  });
});

describe("weekly figures match the checked-in audit they claim to come from", () => {
  // The weekly figures are the ones most at risk of drifting, because the validator stores nothing
  // on its own. Each published value is re-derived here from the audit file itself.
  it("matches the audit's graded counts", () => {
    expect(weeklyAudit.player.predictions).toBe(9261);
    expect(weeklyAudit.defense.predictions).toBe(1632);
    expect(figureValue("Player forecasts graded")).toBe("9,261");
    expect(figureValue("Team-defense forecasts graded")).toBe("1,632");
  });

  it("matches the audit's error and bias, rounded to four decimals", () => {
    expect(weeklyAudit.player.championOverall.mae.toFixed(4)).toBe("4.4032");
    expect(weeklyAudit.player.championOverall.bias.toFixed(4)).toBe("-0.1077");
    expect(figureValue("Player error (MAE)")).toContain("4.4032");
    expect(figureValue("Player bias")).toContain("-0.1077");
  });

  it("matches the audit's team-defense comparison", () => {
    expect(weeklyAudit.defense.overall.mae.toFixed(4)).toBe("4.3193");
    expect(weeklyAudit.defense.overall.baselineMae.toFixed(4)).toBe("4.5309");
    expect(figureValue("Team-defense error (MAE)")).toBe("4.3193 vs 4.5309 baseline");
  });

  it("matches the audit's identity, seasons, and gate state", () => {
    expect(weeklyAudit.generatedAt.slice(0, 10)).toBe(weeklyArtifact.evaluatedAt);
    expect(weeklyAudit.player.policy.modelVersion).toBe(weeklyArtifact.modelVersion);
    expect(weeklyAudit.gate.state).toBe(weeklyArtifact.gateState);
    expect(weeklyAudit.gate.reasons).toEqual([]);
    expect(weeklyAudit.seasons).toEqual([...weeklySeasons]);
  });

  it("agrees with the audit that no richer player model qualified", () => {
    expect(weeklyAudit.player.qualifiedCandidatePositions).toEqual([]);
  });

  it("does not republish the stale figures from docs/operations.md", () => {
    // That prose reports 4.4065 / -0.1074 / 71.02% and model v7; the audit disagrees with all four.
    for (const stale of ["4.4065", "-0.1074", "71.02%", "laces-weekly-components-v7"]) {
      expect(pageSource).not.toContain(stale);
    }
  });
});

describe("no proof number is hardcoded into page copy", () => {
  // Task 10.5: the page must render figures from the manifest, never from a literal typed into
  // JSX. Any numeric literal in page.tsx that is not an allowed layout value fails this test.
  const allowedLiterals = new Set([
    "15", // lucide icon size
    "18", // lucide icon size
    "0", // tabIndex on the scrollable table regions
    "1", // seasons arithmetic: last - first + 1
  ]);

  it("contains no unexplained numeric literal in the page component", () => {
    const withoutImports = pageSource.slice(pageSource.indexOf("export const metadata"));
    const literals = withoutImports.match(/(?<![\w.-])\d[\d,._]*/gu) ?? [];
    const unexpected = literals.filter((literal) => !allowedLiterals.has(literal));
    expect(unexpected).toEqual([]);
  });

  it("sources every scope figure from a named artifact field or code constant", () => {
    expect(rosScopeFigures.length).toBeGreaterThan(0);
    for (const figure of rosScopeFigures) {
      expect(figure.source.length).toBeGreaterThan(0);
      // Each source must name a real artifact pointer or an exported engine constant.
      expect(figure.source).toMatch(
        /ros-validation-v(?:8(?:\/v9)?|9)[a-z0-9-]* \.|FIRST_PARTY_ROS_/u,
      );
    }
  });

  it("publishes weekly accuracy only because a real audit backs it", () => {
    expect(weeklyEvidenceState.publishesAccuracyFigures).toBe(true);
    expect(weeklyArtifact.artifactFile).toBe("weekly-validation-2026-07-27.json");
  });

  it("records where the weekly gate thresholds were read from", () => {
    expect(weeklyEvidenceState.gateSource).toContain("first-party-projections.ts");
    expect(weeklyEvidenceState.gateSource).toContain("first-party.ts");
  });
});
