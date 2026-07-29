import { readFileSync } from "node:fs";

import { createDatabase, firstPartyRosChampionArtifacts } from "@fantasy/db";
import {
  ROS_SCORING_PROFILE_KEYS,
  isRosScoringProfileKey,
  rosScoringProfile,
} from "@fantasy/projections";
import { and, eq } from "drizzle-orm";

import {
  firstPartyRosAdmissionConstants,
  validateFirstPartyRosAdmission,
} from "../src/first-party-ros-admission.js";

function stringOption(name: string): string | undefined {
  const raw = process.argv.find((argument) => argument.startsWith(`${name}=`));
  return raw ? raw.slice(name.length + 1) : undefined;
}

function flag(name: string): boolean {
  return process.argv.includes(name);
}

function fail(message: string): void {
  process.stderr.write(`${message}\n`);
  process.exitCode = 1;
}

async function main(): Promise<void> {
  // The database URL must be supplied explicitly on the command line. Reading DATABASE_URL from the
  // environment is deliberately unsupported: an implicit URL once pointed a maintenance script at
  // the wrong database (see docs/operations.md), so this rail refuses to guess.
  const databaseUrl = stringOption("--database-url");
  if (!databaseUrl || databaseUrl.trim() === "") {
    fail(
      "Refusing to run: pass an explicit --database-url=postgres://... . " +
        "DATABASE_URL from the environment is never used by this script.",
    );
    return;
  }
  const reportPath = stringOption("--report");
  if (!reportPath) {
    fail("Missing required --report=<path> pointing at ros:validate JSON output.");
    return;
  }
  const evidenceThroughRaw = stringOption("--evidence-through");
  if (!evidenceThroughRaw) {
    fail("Missing required --evidence-through=<season>.");
    return;
  }
  const evidenceThroughSeason = Number(evidenceThroughRaw);
  if (!Number.isSafeInteger(evidenceThroughSeason)) {
    fail("--evidence-through must be an integer season, e.g. --evidence-through=2025.");
    return;
  }

  // Each scoring profile is admitted independently and keeps its own artifact. An unknown name
  // refuses rather than defaulting, so a report can never be admitted under the wrong identity.
  const scoringProfileName = stringOption("--scoring-profile") ?? "full-ppr";
  if (!isRosScoringProfileKey(scoringProfileName)) {
    fail(
      `--scoring-profile must be one of ${ROS_SCORING_PROFILE_KEYS.join(", ")} ` +
        `(received ${scoringProfileName}).`,
    );
    return;
  }
  const scoringProfile = rosScoringProfile(scoringProfileName);

  const confirm = flag("--confirm");
  const dryRunRequested = flag("--dry-run");
  const willWrite = confirm && !dryRunRequested;

  let report: unknown;
  try {
    report = JSON.parse(readFileSync(reportPath, "utf8"));
  } catch (error) {
    fail(`Could not read or parse --report=${reportPath}: ${(error as Error).message}`);
    return;
  }

  const constants = firstPartyRosAdmissionConstants(scoringProfile.profile);
  const validation = validateFirstPartyRosAdmission({
    report,
    evidenceThroughSeason,
    constants,
  });
  if (validation.state === "rejected") {
    process.stdout.write(
      `${JSON.stringify(
        {
          state: "rejected",
          scoringProfile: { key: scoringProfile.key, digest: scoringProfile.digest },
          blockers: validation.blockers,
        },
        null,
        2,
      )}\n`,
    );
    process.exitCode = 1;
    return;
  }

  const { payload, artifactChecksum, cellBlockers } = validation;
  const summary = {
    season: payload.season,
    scoringProfile: { key: scoringProfile.key, label: scoringProfile.label },
    scoringProfileDigest: scoringProfile.digest,
    scoringProfileKey: payload.scoringProfileKey,
    modelVersion: payload.modelVersion,
    policyVersion: payload.policyVersion,
    calibrationVersion: payload.calibrationVersion,
    evidenceThroughSeason: payload.evidenceThroughSeason,
    sourceChecksumCount: payload.sourceChecksums.length,
    artifactChecksum,
    // Per-cell admission (ratified 2026-07-22): these cells stay withheld by the per-cell
    // release gate at publish time; every clean cell publishes.
    admittedWithCellBlockers: cellBlockers,
  };

  if (!willWrite) {
    const reason = dryRunRequested ? "--dry-run set" : "no --confirm flag";
    process.stdout.write(
      `${JSON.stringify(
        {
          state: "dry-run",
          reason: `no rows written (${reason}); pass --confirm (and omit --dry-run) to admit`,
          wouldInsert: summary,
        },
        null,
        2,
      )}\n`,
    );
    return;
  }

  const { db, close } = createDatabase(databaseUrl, 1);
  try {
    const existing = await db
      .select({ id: firstPartyRosChampionArtifacts.id })
      .from(firstPartyRosChampionArtifacts)
      .where(
        and(
          eq(firstPartyRosChampionArtifacts.season, payload.season),
          eq(firstPartyRosChampionArtifacts.scoringProfileKey, payload.scoringProfileKey),
          eq(firstPartyRosChampionArtifacts.modelVersion, payload.modelVersion),
          eq(firstPartyRosChampionArtifacts.policyVersion, payload.policyVersion),
          eq(firstPartyRosChampionArtifacts.calibrationVersion, payload.calibrationVersion),
          eq(firstPartyRosChampionArtifacts.artifactChecksum, artifactChecksum),
        ),
      )
      .limit(1);
    if (existing.length > 0) {
      process.stdout.write(
        `${JSON.stringify(
          { state: "already-admitted", artifactId: existing[0]!.id, artifact: summary },
          null,
          2,
        )}\n`,
      );
      return;
    }

    const inserted = await db
      .insert(firstPartyRosChampionArtifacts)
      .values({
        season: payload.season,
        scoringProfileKey: payload.scoringProfileKey,
        modelVersion: payload.modelVersion,
        policyVersion: payload.policyVersion,
        calibrationVersion: payload.calibrationVersion,
        evidenceThroughSeason: payload.evidenceThroughSeason,
        sourceChecksums: payload.sourceChecksums,
        policy: payload.policy as unknown as Record<string, unknown>,
        releaseGate: payload.releaseGate,
        artifactChecksum,
        admittedAt: new Date(),
      })
      .onConflictDoNothing({
        target: [
          firstPartyRosChampionArtifacts.season,
          firstPartyRosChampionArtifacts.scoringProfileKey,
          firstPartyRosChampionArtifacts.modelVersion,
          firstPartyRosChampionArtifacts.policyVersion,
          firstPartyRosChampionArtifacts.calibrationVersion,
          firstPartyRosChampionArtifacts.artifactChecksum,
        ],
      })
      .returning({ id: firstPartyRosChampionArtifacts.id });
    if (inserted.length === 0) {
      process.stdout.write(
        `${JSON.stringify({ state: "already-admitted", artifact: summary }, null, 2)}\n`,
      );
      return;
    }
    process.stdout.write(
      `${JSON.stringify(
        { state: "admitted", artifactId: inserted[0]!.id, artifact: summary },
        null,
        2,
      )}\n`,
    );
  } finally {
    await close();
  }
}

await main();
