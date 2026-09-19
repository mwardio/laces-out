import { beforeAll, describe, expect, it } from "vitest";
import {
  buildRosMarginalIntervalStorage,
  rosMarginalIntervalQualificationIsPublicationQualified,
  rosMarginalIntervalQualificationIsStructurallyValid,
  rosMarginalIntervalStorageIsValid,
  rosMarginalIntervalStorageMatchesQualifications,
  type RosMarginalIntervalStorage,
} from "./ros-marginal-interval-storage.js";
import {
  buildRosMarginalIntervalQualificationFixture,
  rosMarginalIntervalQualificationFixtureInput,
} from "./ros-marginal-interval-test-fixtures.js";
import {
  buildRosMarginalIntervalQualificationSet,
  type RosMarginalIntervalQualification,
} from "./ros-marginal-interval-qualification.js";
import { validateMarginalRosTrainingCohort } from "./marginal-ros-training.js";
import { sha256Hex } from "./sha256.js";

function canonical(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`;
  if (value !== null && typeof value === "object")
    return `{${Object.entries(value)
      .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
      .map(([key, child]) => `${JSON.stringify(key)}:${canonical(child)}`)
      .join(",")}}`;
  return JSON.stringify(value);
}
function rehash<T>(value: T, field: string): T {
  const body = { ...value } as Record<string, unknown>;
  delete body[field];
  return { ...body, [field]: sha256Hex(canonical(body)) } as T;
}
function reverseKeys(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(reverseKeys);
  if (value !== null && typeof value === "object")
    return Object.fromEntries(
      Object.entries(value)
        .reverse()
        .map(([key, child]) => [key, reverseKeys(child)]),
    );
  return value;
}
type Mutable<T> = { -readonly [K in keyof T]: T[K] extends object ? Mutable<T[K]> : T[K] };
const CHAMPION = sha256Hex("synthetic-immutable-champion");
let qualifications: readonly RosMarginalIntervalQualification[];
let storage: RosMarginalIntervalStorage;
beforeAll(() => {
  qualifications = buildRosMarginalIntervalQualificationFixture();
  storage = buildRosMarginalIntervalStorage({
    qualifications,
    championArtifactChecksum: CHAMPION,
    releasedCells: qualifications.map((receipt) => receipt.cell),
  });
});
function fullMutation(mutate: (receipt: Mutable<RosMarginalIntervalQualification>) => void) {
  const changed = structuredClone(qualifications[0]!) as Mutable<RosMarginalIntervalQualification>;
  mutate(changed);
  return rehash(changed, "qualificationChecksum");
}
function storageMutation(mutate: (receipt: Mutable<RosMarginalIntervalStorage>) => void) {
  const changed = structuredClone(storage) as Mutable<RosMarginalIntervalStorage>;
  mutate(changed);
  changed.cells = changed.cells.map((cell) => rehash(cell, "cellChecksum"));
  return rehash(changed, "evidenceChecksum");
}

describe("bounded immutable qualification receipt validation", () => {
  it("accepts authoritative reconstruction and JSONB key ordering without refitting", () => {
    for (const receipt of qualifications) {
      expect(rosMarginalIntervalQualificationIsStructurallyValid(receipt)).toBe(true);
      expect(rosMarginalIntervalQualificationIsPublicationQualified(receipt)).toBe(true);
      expect(
        rosMarginalIntervalQualificationIsStructurallyValid(
          reverseKeys(JSON.parse(JSON.stringify(receipt))),
        ),
      ).toBe(true);
    }
  });
  it.each([
    [
      "wrong future year",
      (r: Mutable<RosMarginalIntervalQualification>) => {
        r.forecastSeason = r.comparisonSeason;
      },
    ],
    [
      "dropped held-out year",
      (r: Mutable<RosMarginalIntervalQualification>) => {
        r.requiredEvaluationSeasons.pop();
      },
    ],
    [
      "undeclared cell",
      (r: Mutable<RosMarginalIntervalQualification>) => {
        r.sourceScope.requiredCells = r.sourceScope.requiredCells.filter(
          (cell) => cell.bucket !== r.cell.bucket,
        );
      },
    ],
    [
      "relaxed selector",
      (r: Mutable<RosMarginalIntervalQualification>) => {
        Object.assign(r.meanSelectorOptions, { minimumSamples: 1 });
      },
    ],
    [
      "mutable policy substitution",
      (r: Mutable<RosMarginalIntervalQualification>) => {
        Object.assign(r, {
          meanSelectorPolicyVersion: "season-walk-forward-mean-rmse-marginal-quantiles-v8",
        });
      },
    ],
    [
      "chronological strategy substitution",
      (r: Mutable<RosMarginalIntervalQualification>) => {
        r.strategy = "contextual";
      },
    ],
    [
      "missing historical artifact",
      (r: Mutable<RosMarginalIntervalQualification>) => {
        r.historicalArtifacts.pop();
      },
    ],
    [
      "historical chronology",
      (r: Mutable<RosMarginalIntervalQualification>) => {
        r.historicalArtifacts[0]!.forecastSeason++;
      },
    ],
    [
      "candidate source manifest",
      (r: Mutable<RosMarginalIntervalQualification>) => {
        r.sources.candidate.sourceManifestChecksum = "a".repeat(64);
      },
    ],
    [
      "candidate source report",
      (r: Mutable<RosMarginalIntervalQualification>) => {
        r.sources.candidate.source.reportChecksum = "a".repeat(64);
      },
    ],
    [
      "previous source scoring",
      (r: Mutable<RosMarginalIntervalQualification>) => {
        r.sources.previous.source.scoringProfileKey = "bad-profile";
      },
    ],
    [
      "unsupported renaming",
      (r: Mutable<RosMarginalIntervalQualification>) => {
        Object.assign(r.sourceScope, { identityAmendment: "anything" });
      },
    ],
    [
      "missing linkage",
      (r: Mutable<RosMarginalIntervalQualification>) => {
        r.linkage.pop();
      },
    ],
    [
      "comparison row substitution",
      (r: Mutable<RosMarginalIntervalQualification>) => {
        r.linkage.at(-1)!.comparisonCandidateRowsChecksum = "b".repeat(64);
      },
    ],
    [
      "evidence row substitution",
      (r: Mutable<RosMarginalIntervalQualification>) => {
        r.linkage[0]!.evidenceSourceRowsChecksum = "b".repeat(64);
      },
    ],
    [
      "invented fit lineage",
      (r: Mutable<RosMarginalIntervalQualification>) => {
        r.evidence.blocks[0]!.artifactChecksum = "a".repeat(64);
      },
    ],
    [
      "forged numerical summaries",
      (r: Mutable<RosMarginalIntervalQualification>) => {
        r.evidence.overall.samples++;
      },
    ],
    [
      "forged mean proof",
      (r: Mutable<RosMarginalIntervalQualification>) => {
        r.meanChoice.meanSelectionEvidence.clearsMeanMargin = true;
      },
    ],
    [
      "unknown nested mean field",
      (r: Mutable<RosMarginalIntervalQualification>) => {
        Object.assign(r.meanChoice.meanSelectionEvidence.seasonEvidence[0]!, { hidden: true });
      },
    ],
    [
      "unknown legacy artifact field",
      (r: Mutable<RosMarginalIntervalQualification>) => {
        Object.assign(r.previousMeanChoice.intervalCalibrationArtifacts.recency, { hidden: true });
      },
    ],
    [
      "forged legacy artifact",
      (r: Mutable<RosMarginalIntervalQualification>) => {
        r.previousMeanChoice.intervalCalibrationArtifacts.recency.adjustmentPoints++;
      },
    ],
    [
      "unknown field",
      (r: Mutable<RosMarginalIntervalQualification>) => {
        Object.assign(r, { admitted: true });
      },
    ],
    [
      "invented release authority",
      (r: Mutable<RosMarginalIntervalQualification>) => {
        Object.assign(r, { canAuthorizeRelease: true });
      },
    ],
    [
      "invented state",
      (r: Mutable<RosMarginalIntervalQualification>) => {
        Object.assign(r, { state: "admitted" });
      },
    ],
  ] as const)("rejects %s even with a recomputed outer checksum", (_name, mutate) => {
    expect(rosMarginalIntervalQualificationIsStructurallyValid(fullMutation(mutate))).toBe(false);
  });
  it("fails closed on forged checksum, cycles, sparse arrays and excessive nested structures", () => {
    const invalid = { ...qualifications[0], qualificationChecksum: "0".repeat(64) };
    expect(rosMarginalIntervalQualificationIsStructurallyValid(invalid)).toBe(false);
    const cyclic: Record<string, unknown> = {};
    cyclic.self = cyclic;
    for (const value of [
      null,
      [],
      undefined,
      Infinity,
      cyclic,
      { ...invalid, linkage: new Array(100_000) },
    ])
      expect(rosMarginalIntervalQualificationIsStructurallyValid(value)).toBe(false);
    const sparse = structuredClone(qualifications[0]!);
    Reflect.deleteProperty(sparse.linkage, 0);
    expect(rosMarginalIntervalQualificationIsStructurallyValid(sparse)).toBe(false);
  });
  it("retains genuine failed numerical receipts without publishing the failed cell", () => {
    const input = rosMarginalIntervalQualificationFixtureInput();
    const replace = (source: typeof input.candidate) => {
      const heldOutSeasons = source.heldOutSeasons.map((season) => ({
        ...season,
        forecasts: season.forecasts.map((row) => ({
          ...row,
          actualPoints:
            row.forecastSeason === 2025 && row.asOfWeek >= 14 ? 10_000 : row.actualPoints,
        })),
      }));
      return {
        ...source,
        heldOutSeasons,
        rowsChecksum: validateMarginalRosTrainingCohort(heldOutSeasons, heldOutSeasons).provenance
          .evaluationRowsChecksum,
      };
    };
    const receipts = buildRosMarginalIntervalQualificationSet({
      ...input,
      candidate: replace(input.candidate),
      previous: replace(input.previous),
    });
    const failed = receipts.find((receipt) => receipt.cell.bucket === "one-to-four")!;
    expect(failed.state).toBe("failed-qualification");
    expect(rosMarginalIntervalQualificationIsStructurallyValid(failed)).toBe(true);
    expect(rosMarginalIntervalQualificationIsPublicationQualified(failed)).toBe(false);
    expect(() =>
      buildRosMarginalIntervalStorage({
        qualifications: receipts,
        championArtifactChecksum: CHAMPION,
        releasedCells: [failed.cell],
      }),
    ).toThrow(/lacks interval qualification/u);
    const passing = receipts.find((receipt) => receipt.state === "qualified")!;
    expect(
      rosMarginalIntervalStorageIsValid(
        buildRosMarginalIntervalStorage({
          qualifications: receipts,
          championArtifactChecksum: CHAMPION,
          releasedCells: [passing.cell],
        }),
      ),
    ).toBe(true);
  });
  it("validates separate prior-only training provenance without changing audit support", () => {
    const input = rosMarginalIntervalQualificationFixtureInput();
    const source = input.candidate;
    const heldOutSeasons = source.heldOutSeasons.map((season) => ({
      ...season,
      forecasts: [
        ...season.forecasts,
        ...season.forecasts.map((row) => ({
          ...row,
          playerId: `${row.playerId}:extra`,
          inputChecksum: sha256Hex(`${row.inputChecksum}:extra`),
        })),
      ],
    }));
    const intervalTraining = {
      ...source,
      heldOutSeasons,
      source: {
        ...source.source,
        physicalCorpusChecksum: sha256Hex("separate-training-physics"),
        reportChecksum: sha256Hex("separate-training-report"),
      },
      rowsChecksum: validateMarginalRosTrainingCohort(heldOutSeasons, heldOutSeasons).provenance
        .evaluationRowsChecksum,
    };
    const receipts = buildRosMarginalIntervalQualificationSet({ ...input, intervalTraining });
    expect(receipts.every(rosMarginalIntervalQualificationIsStructurallyValid)).toBe(true);
    expect(receipts[0]!.meanChoice).toEqual(qualifications[0]!.meanChoice);
    expect(receipts[0]!.intervalTraining!.additionalTrainingForecasts).toBe(544);
    const changed = structuredClone(receipts[0]!) as Mutable<RosMarginalIntervalQualification>;
    Object.assign(changed.intervalTraining!, { evaluationRowsChecksum: "b".repeat(64) });
    expect(
      rosMarginalIntervalQualificationIsStructurallyValid(rehash(changed, "qualificationChecksum")),
    ).toBe(false);
    expect(
      rosMarginalIntervalStorageIsValid(
        buildRosMarginalIntervalStorage({
          qualifications: receipts,
          championArtifactChecksum: CHAMPION,
          releasedCells: [receipts[0]!.cell],
        }),
      ),
    ).toBe(true);
  });
});

describe("schema-2 immutable interval storage", () => {
  it("stores compact exact scope and bindings, with no raw player arrays or release authority", () => {
    expect(rosMarginalIntervalStorageIsValid(storage)).toBe(true);
    expect(storage.schemaVersion).toBe(2);
    expect(storage.interpretation).toBe("historical-descriptive");
    expect(storage.quantiles).toEqual([0.15, 0.5, 0.85]);
    expect(storage.cells).toHaveLength(3);
    expect(JSON.stringify(storage).length).toBeLessThan(18_000);
    expect(
      rosMarginalIntervalStorageMatchesQualifications(
        reverseKeys(JSON.parse(JSON.stringify(storage))),
        {
          qualifications,
          championArtifactChecksum: CHAMPION,
          releasedCells: storage.releasedCells,
        },
      ),
    ).toBe(true);
  });
  it("canonicalizes caller scope and set ordering", () => {
    expect(
      buildRosMarginalIntervalStorage({
        qualifications: [...qualifications].reverse(),
        championArtifactChecksum: CHAMPION,
        releasedCells: [...storage.releasedCells].reverse(),
      }),
    ).toEqual(storage);
  });
  it.each([
    ["empty scope", []],
    ["unknown scope", [{ position: "WR", bucket: "nine-plus" }]],
    [
      "duplicate scope",
      [
        { position: "DST", bucket: "one-to-four" },
        { position: "DST", bucket: "one-to-four" },
      ],
    ],
  ] as const)("rejects %s", (_name, releasedCells) => {
    expect(() =>
      buildRosMarginalIntervalStorage({
        qualifications,
        championArtifactChecksum: CHAMPION,
        releasedCells,
      }),
    ).toThrow();
  });
  it("rejects missing, extra and duplicate qualifications", () => {
    for (const receipts of [
      qualifications.slice(1),
      [...qualifications, qualifications[0]!],
      [qualifications[0]!, qualifications[0]!, qualifications[2]!],
    ]) {
      expect(() =>
        buildRosMarginalIntervalStorage({
          qualifications: receipts,
          championArtifactChecksum: CHAMPION,
          releasedCells: storage.releasedCells,
        }),
      ).toThrow();
    }
  });
  it.each([
    [
      "empty released scope",
      (s: Mutable<RosMarginalIntervalStorage>) => {
        s.releasedCells = [];
        s.cells = [];
      },
    ],
    [
      "extra cell",
      (s: Mutable<RosMarginalIntervalStorage>) => {
        s.cells.push(s.cells[0]!);
      },
    ],
    [
      "unknown envelope field",
      (s: Mutable<RosMarginalIntervalStorage>) => {
        Object.assign(s, { approved: true });
      },
    ],
    [
      "unknown cell field",
      (s: Mutable<RosMarginalIntervalStorage>) => {
        Object.assign(s.cells[0]!, { approved: true });
      },
    ],
    [
      "wrong method",
      (s: Mutable<RosMarginalIntervalStorage>) => {
        Object.assign(s, { method: "block-cqr" });
      },
    ],
    [
      "wrong quantiles",
      (s: Mutable<RosMarginalIntervalStorage>) => {
        Object.assign(s, { quantiles: [0.1, 0.5, 0.9] });
      },
    ],
    [
      "wrong nominal",
      (s: Mutable<RosMarginalIntervalStorage>) => {
        Object.assign(s, { nominalCoverage: 0.8 });
      },
    ],
    [
      "live forecast mismatch",
      (s: Mutable<RosMarginalIntervalStorage>) => {
        s.cells[0]!.forecastSeason++;
      },
    ],
    [
      "profile mismatch",
      (s: Mutable<RosMarginalIntervalStorage>) => {
        s.cells[0]!.scoringProfileKey = "custom";
      },
    ],
    [
      "source scope mismatch",
      (s: Mutable<RosMarginalIntervalStorage>) => {
        s.cells[0]!.sourceScopeChecksum = "b".repeat(64);
      },
    ],
    [
      "favorable year subset",
      (s: Mutable<RosMarginalIntervalStorage>) => {
        s.cells[0]!.requiredEvaluationSeasons.pop();
        s.cells[0]!.annualSupport.pop();
      },
    ],
    [
      "too few annual cutoffs",
      (s: Mutable<RosMarginalIntervalStorage>) => {
        s.cells[0]!.annualSupport[0]!.cutoffs = [10, 11];
      },
    ],
    [
      "too few annual rows",
      (s: Mutable<RosMarginalIntervalStorage>) => {
        s.cells[0]!.annualSupport[0]!.samples = 17;
      },
    ],
    [
      "duplicate cutoff",
      (s: Mutable<RosMarginalIntervalStorage>) => {
        s.cells[0]!.annualSupport[0]!.cutoffs = [10, 10, 11];
      },
    ],
    [
      "missing champion pin",
      (s: Mutable<RosMarginalIntervalStorage>) => {
        s.championArtifactChecksum = "";
      },
    ],
    [
      "incorrect aggregate",
      (s: Mutable<RosMarginalIntervalStorage>) => {
        s.cells[0]!.aggregate.coverage = { numerator: "3", denominator: "5" };
        s.cells[0]!.aggregate.lowerTail = { numerator: "1", denominator: "5" };
        s.cells[0]!.aggregate.upperTail = { numerator: "1", denominator: "5" };
      },
    ],
    [
      "noncanonical fraction",
      (s: Mutable<RosMarginalIntervalStorage>) => {
        s.cells[0]!.aggregate.coverage = { numerator: "2", denominator: "2" };
      },
    ],
    [
      "invalid probability partition",
      (s: Mutable<RosMarginalIntervalStorage>) => {
        s.cells[0]!.annualSupport[0]!.lowerTail = { numerator: "1", denominator: "2" };
      },
    ],
    [
      "strict worse WIS",
      (s: Mutable<RosMarginalIntervalStorage>) => {
        s.cells[0]!.candidateWis = Number.MIN_VALUE;
        s.cells[0]!.benchmarkWis["previous-deployed"] = 0;
      },
    ],
  ] as const)("rejects %s even with recomputed compact checksums", (_name, mutate) => {
    expect(rosMarginalIntervalStorageIsValid(storageMutation(mutate))).toBe(false);
  });
  it.each([
    ["coverage boundary", "3", "5", "1", "5", "1", "5", true],
    ["lower tail boundary", "3", "5", "1", "4", "3", "20", true],
    ["upper tail boundary", "3", "5", "3", "20", "1", "4", true],
    [
      "coverage fraction just below",
      "599999999999999999",
      "1000000000000000000",
      "200000000000000001",
      "1000000000000000000",
      "1",
      "5",
      false,
    ],
    [
      "lower tail fraction just above",
      "3",
      "5",
      "250000000000000001",
      "1000000000000000000",
      "149999999999999999",
      "1000000000000000000",
      false,
    ],
    [
      "upper tail fraction just above",
      "3",
      "5",
      "149999999999999999",
      "1000000000000000000",
      "250000000000000001",
      "1000000000000000000",
      false,
    ],
  ] as const)("uses exact rational screening at %s", (_name, cn, cd, ln, ld, un, ud, expected) => {
    const changed = storageMutation((s) => {
      const fractions = {
        coverage: { numerator: cn, denominator: cd },
        lowerTail: { numerator: ln, denominator: ld },
        upperTail: { numerator: un, denominator: ud },
      };
      for (const cell of s.cells) {
        Object.assign(cell.aggregate, fractions);
        for (const year of cell.annualSupport) Object.assign(year, fractions);
      }
    });
    expect(rosMarginalIntervalStorageIsValid(changed)).toBe(expected);
    // A self-consistent fraction is never proof that the immutable source actually produced it.
    expect(
      rosMarginalIntervalStorageMatchesQualifications(changed, {
        qualifications,
        championArtifactChecksum: CHAMPION,
        releasedCells: storage.releasedCells,
      }),
    ).toBe(false);
  });
  it("requires external champion and receipt binding even for self-consistent hashes", () => {
    const changed = storageMutation((s) => {
      s.championArtifactChecksum = "a".repeat(64);
      s.cells[0]!.qualificationChecksum = "b".repeat(64);
    });
    expect(rosMarginalIntervalStorageIsValid(changed)).toBe(true);
    expect(
      rosMarginalIntervalStorageMatchesQualifications(changed, {
        qualifications,
        championArtifactChecksum: CHAMPION,
        releasedCells: storage.releasedCells,
      }),
    ).toBe(false);
  });
  it("keeps weak individual years descriptive while enforcing the aggregate screen", () => {
    const changed = storageMutation((s) => {
      for (const cell of s.cells) {
        Object.assign(cell.annualSupport[0]!, {
          coverage: { numerator: "1", denominator: "2" },
          lowerTail: { numerator: "0", denominator: "1" },
          upperTail: { numerator: "1", denominator: "2" },
        });
        cell.aggregate = {
          coverage: { numerator: "5", denominator: "6" },
          lowerTail: { numerator: "0", denominator: "1" },
          upperTail: { numerator: "1", denominator: "6" },
        };
      }
    });
    expect(rosMarginalIntervalStorageIsValid(changed)).toBe(true);
  });
  it("rejects impossible annual denominator size before multiplying across years", () => {
    const denominator = 10n ** 1000n + 1n;
    const changed = storageMutation((s) => {
      for (const cell of s.cells) {
        const metrics = {
          coverage: {
            numerator: (denominator - 2n).toString(),
            denominator: denominator.toString(),
          },
          lowerTail: { numerator: "1", denominator: denominator.toString() },
          upperTail: { numerator: "1", denominator: denominator.toString() },
        };
        cell.aggregate = metrics;
        for (const year of cell.annualSupport) Object.assign(year, metrics);
      }
    });
    expect(rosMarginalIntervalStorageIsValid(changed)).toBe(false);
  });
});
