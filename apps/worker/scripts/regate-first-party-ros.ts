import { createHash } from "node:crypto";
import { existsSync, readFileSync, writeFileSync } from "node:fs";

import {
  ROS_SCORING_PROFILE_KEYS,
  isRosScoringProfileKey,
  rosScoringProfile,
} from "@fantasy/projections";

import {
  firstPartyRosAdmissionConstants,
  validateFirstPartyRosAdmission,
} from "../src/first-party-ros-admission.js";
import { regateFirstPartyRosReport } from "../src/first-party-ros-regate.js";

/**
 * Recomputes a completed `ros:validate` report's release-gate verdict from the evidence that report
 * already stores, against the currently compiled ceiling constants, and writes the result to a new
 * file.
 *
 * The gate is a pure function of the champion choices, so when only a ceiling moves the forecasts
 * are identical by construction and re-running the multi-hour validation would regenerate the same
 * numbers. This script performs no forecast, no simulation and no database work; it never writes
 * back over its input.
 *
 *   npm run ros:regate -w @fantasy/worker -- \
 *     --report=reports/ros-validation-v8-full-ppr-n8-2026-07-28.json \
 *     --out=reports/ros-validation-v8-full-ppr-n8-2026-07-28.regated.json
 *
 * The verdict is only trustworthy because `apps/worker/src/first-party-ros-regate.test.ts` proves
 * that re-gating each stored report with the constants unchanged reproduces its original blockers
 * and state exactly.
 */

function stringOption(name: string): string | undefined {
  const raw = process.argv.find((argument) => argument.startsWith(`${name}=`));
  return raw ? raw.slice(name.length + 1) : undefined;
}

function fail(message: string): void {
  process.stderr.write(`${message}\n`);
  process.exitCode = 1;
}

function main(): void {
  const reportPath = stringOption("--report");
  const outPath = stringOption("--out");
  if (!reportPath) {
    fail("Missing required --report=<path> pointing at a completed ros:validate JSON report.");
    return;
  }
  if (!outPath) {
    fail("Missing required --out=<path>. The re-gated report is never written in place.");
    return;
  }
  if (outPath === reportPath) {
    fail("Refusing to run: --out must differ from --report so the source report is never lost.");
    return;
  }
  if (existsSync(outPath) && !process.argv.includes("--overwrite")) {
    fail(`Refusing to run: ${outPath} already exists. Pass --overwrite to replace it.`);
    return;
  }

  // Admission identity is per-profile, exactly as in ros:admit; an unknown name refuses rather than
  // silently checking the default profile.
  const scoringProfileName = stringOption("--scoring-profile") ?? "full-ppr";
  if (!isRosScoringProfileKey(scoringProfileName)) {
    fail(
      `--scoring-profile must be one of ${ROS_SCORING_PROFILE_KEYS.join(", ")} ` +
        `(received ${scoringProfileName}).`,
    );
    return;
  }
  const scoringProfile = rosScoringProfile(scoringProfileName);

  let raw: string;
  try {
    raw = readFileSync(reportPath, "utf8");
  } catch (error) {
    fail(`Could not read --report=${reportPath}: ${(error as Error).message}`);
    return;
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (error) {
    fail(`Could not parse --report=${reportPath}: ${(error as Error).message}`);
    return;
  }

  let result;
  try {
    result = regateFirstPartyRosReport({
      report: parsed,
      sourceReportPath: reportPath,
      sourceReportSha256: createHash("sha256").update(raw, "utf8").digest("hex"),
      regatedAt: new Date().toISOString(),
    });
  } catch (error) {
    // A missing gate input throws rather than being reconstructed. Nothing is written.
    fail((error as Error).message);
    return;
  }
  if (result.state === "unusable") {
    process.stdout.write(
      `${JSON.stringify({ state: "unusable", sourceReportPath: reportPath, reasons: result.reasons }, null, 2)}\n`,
    );
    process.exitCode = 1;
    return;
  }

  // The re-gated report must still be admissible on its own terms. The artifact checksum moves
  // whenever the release gate's verdict moves; that is the change being recorded, not a defect.
  const evidenceThroughRaw = stringOption("--evidence-through");
  const evidenceThroughSeason = evidenceThroughRaw
    ? Number(evidenceThroughRaw)
    : ((result.report.champion as Record<string, unknown>).evidenceThroughSeason as number);
  const admission = validateFirstPartyRosAdmission({
    report: result.report,
    evidenceThroughSeason,
    constants: firstPartyRosAdmissionConstants(scoringProfile.profile),
  });

  writeFileSync(outPath, `${JSON.stringify(result.report, null, 2)}\n`, "utf8");
  process.stdout.write(
    `${JSON.stringify(
      {
        state: "re-gated",
        mode: "gate-only-re-evaluation",
        forecastEvidence: "carried-unchanged-from-source-run",
        freshValidationRun: false,
        sourceReportPath: reportPath,
        sourceGeneratedAt: result.report.generatedAt ?? null,
        outPath,
        scoringProfile: { key: scoringProfile.key, digest: scoringProfile.digest },
        ceilings: result.ceilings,
        verdictChanged: result.verdictChanged,
        sourceState: result.sourceState,
        sourceBlockers: result.sourceBlockers,
        regatedState: result.reportState,
        regatedBlockers: result.blockers,
        admission:
          admission.state === "admissible"
            ? {
                state: admission.state,
                artifactChecksum: admission.artifactChecksum,
                admittedWithCellBlockers: admission.cellBlockers,
              }
            : { state: admission.state, blockers: admission.blockers },
      },
      null,
      2,
    )}\n`,
  );
  if (admission.state !== "admissible" && !process.argv.includes("--allow-inadmissible")) {
    process.exitCode = 1;
  }
}

main();
