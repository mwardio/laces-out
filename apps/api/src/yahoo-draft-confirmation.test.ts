import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";

import { describe, expect, it } from "vitest";

import {
  verifyYahooDraftConfirmation,
  YahooDraftConfirmationError,
  yahooDraftConfirmationContextSchema,
  yahooDraftFinalBoardManifestSchema,
} from "./yahoo-draft-confirmation.js";
import {
  YAHOO_DRAFT_PREREGISTRATION_CHECKSUM,
  YAHOO_DRAFT_RELEASE,
} from "./yahoo-draft-release.js";

const LEAGUE_KEY = "449.l.12345";
const LEAGUE_FINGERPRINT = sha256(LEAGUE_KEY);
const GIT_REVISION = "a".repeat(40);
const SOURCE_CAPTURE = Buffer.from("independently retained Yahoo final board", "utf8");
const TEAM_A = "40000000-0000-4000-8000-00000000000a";
const TEAM_B = "40000000-0000-4000-8000-00000000000b";
const TEAM_KEY_A = `${LEAGUE_KEY}.t.1`;
const TEAM_KEY_B = `${LEAGUE_KEY}.t.2`;
const PLAYER_ID = (value: number): string =>
  `50000000-0000-4000-8000-${value.toString().padStart(12, "0")}`;
const PLAYER_KEY = (value: number): string => `449.p.${9000 + value}`;

function sha256(value: string | Uint8Array): string {
  return createHash("sha256").update(value).digest("hex");
}

interface ExamplePick {
  readonly teamKey: string;
  readonly playerKey: string;
  readonly cost: number | null;
}

function slots(prefix: string) {
  return [1, 2].map((index) => ({
    id: `${prefix}-slot-${index}`,
    type: "BENCH" as const,
    label: `Bench ${index}`,
    kind: "BENCH" as const,
    eligiblePositions: ["RB" as const],
  }));
}

function artifact(picks: readonly ExamplePick[]): string {
  const rows = picks
    .map(
      (pick, index) => `<draft_result>
        <pick>${index + 1}</pick>
        <round>${Math.ceil((index + 1) / 2)}</round>
        <team_key>${pick.teamKey}</team_key>
        <player_key>${pick.playerKey}</player_key>
        ${pick.cost === null ? "" : `<cost>${pick.cost}</cost>`}
      </draft_result>`,
    )
    .join("\n");
  return `<?xml version="1.0" encoding="UTF-8"?>
    <fantasy_content>
      <league>
        <league_key>${LEAGUE_KEY}</league_key>
        <league_id>12345</league_id>
        <draft_status>postdraft</draft_status>
        <draft_results count="${picks.length}">${rows}</draft_results>
      </league>
    </fantasy_content>`;
}

function confirmationCase(format: "snake" | "auction") {
  const picks: readonly ExamplePick[] = [
    { teamKey: TEAM_KEY_A, playerKey: PLAYER_KEY(1), cost: format === "auction" ? 20 : null },
    { teamKey: TEAM_KEY_B, playerKey: PLAYER_KEY(2), cost: format === "auction" ? 10 : null },
    { teamKey: TEAM_KEY_B, playerKey: PLAYER_KEY(3), cost: format === "auction" ? 15 : null },
    { teamKey: TEAM_KEY_A, playerKey: PLAYER_KEY(4), cost: format === "auction" ? 5 : null },
  ];
  const artifactXml = artifact(picks);
  const manifest = {
    schemaVersion: 1,
    evidenceClass: "independent-yahoo-final-board",
    format,
    leagueFingerprintSha256: LEAGUE_FINGERPRINT,
    season: 2026,
    capturedAt: "2026-09-05T12:00:00.000Z",
    source: "yahoo-final-board-ui",
    sourceCaptureMediaType: "image/png",
    sourceCaptureSha256: sha256(SOURCE_CAPTURE),
    captureAttestation:
      "captured-from-yahoo-final-board-without-reference-to-fantasy-api-draftresults",
    draftScopeAttestation:
      "yahoo-final-board-shows-no-keepers-no-traded-picks-and-no-third-round-reversal",
    picks: picks.map((pick, index) => ({
      overallPick: index + 1,
      round: Math.ceil((index + 1) / 2),
      yahooTeamKey: pick.teamKey,
      yahooPlayerKey: pick.playerKey,
      cost: pick.cost,
    })),
  };
  const manifestJson = JSON.stringify(manifest, null, 2);
  const commonConfig = {
    teams: [
      { id: TEAM_A, name: "Team A", rosterSlots: slots("a") },
      { id: TEAM_B, name: "Team B", rosterSlots: slots("b") },
    ],
    players: [1, 2, 3, 4].map((value) => ({
      id: PLAYER_ID(value),
      name: `Player ${value}`,
      positions: ["RB"],
    })),
  };
  const config =
    format === "snake"
      ? {
          mode: "SNAKE",
          ...commonConfig,
          pickOrder: [TEAM_A, TEAM_B, TEAM_B, TEAM_A],
        }
      : {
          mode: "AUCTION",
          ...commonConfig,
          teams: commonConfig.teams.map((team) => ({ ...team, budget: 100 })),
          minimumBid: 1,
        };
  const context = {
    schemaVersion: 1,
    evidenceClass: "frozen-yahoo-draft-confirmation-context",
    protocol: "yahoo-draft-polling-v1",
    format,
    preregistrationSha256: YAHOO_DRAFT_PREREGISTRATION_CHECKSUM,
    frozenImplementationGitRevision: GIT_REVISION,
    leagueFingerprintSha256: LEAGUE_FINGERPRINT,
    yahooLeagueKey: LEAGUE_KEY,
    season: 2026,
    holdoutSelectedAt: "2026-09-05T09:00:00.000Z",
    implementationFrozenAt: "2026-09-05T10:00:00.000Z",
    artifactCapturedAt: "2026-09-05T13:00:00.000Z",
    evidenceFrozenAt: "2026-09-05T14:00:00.000Z",
    holdoutSelectionAttestation: "selected-before-reveal-and-did-not-influence-this-implementation",
    standardScopeConfirmation: "no-keepers-or-traded-picks",
    productionConfigurationAttestation:
      "exported-or-built-with-the-frozen-production-path-before-artifact-reveal",
    identityMappingAttestation:
      "copied-from-preexisting-provider-mappings-without-using-the-final-artifact",
    expectedManifestSha256: sha256(manifestJson),
    expectedArtifactSha256: sha256(artifactXml),
    feedId: "60000000-0000-4000-8000-000000000001",
    draftId: "60000000-0000-4000-8000-000000000002",
    config,
    teamMappings: [
      { yahooTeamKey: TEAM_KEY_A, internalTeamId: TEAM_A },
      { yahooTeamKey: TEAM_KEY_B, internalTeamId: TEAM_B },
    ],
    playerMappings: [1, 2, 3, 4].map((value) => ({
      yahooPlayerKey: PLAYER_KEY(value),
      internalPlayerId: PLAYER_ID(value),
    })),
  };
  return { artifactXml, context, manifest, manifestJson };
}

function verify(example: ReturnType<typeof confirmationCase>) {
  return verifyYahooDraftConfirmation({
    sourceCapture: SOURCE_CAPTURE,
    manifestJson: example.manifestJson,
    contextJson: JSON.stringify(example.context, null, 2),
    artifactXml: example.artifactXml,
    actualImplementationGitRevision: GIT_REVISION,
    actualPreregistrationSha256: YAHOO_DRAFT_PREREGISTRATION_CHECKSUM,
    evaluatedAt: new Date("2026-09-05T15:00:00.000Z"),
  });
}

function failureCode(action: () => unknown): string {
  try {
    action();
  } catch (error) {
    expect(error).toBeInstanceOf(YahooDraftConfirmationError);
    return error instanceof YahooDraftConfirmationError ? error.code : "";
  }
  throw new Error("Expected confirmation to fail closed");
}

describe("Yahoo frozen holdout confirmation", () => {
  it("pins the release checksum to the exact checked-in preregistration bytes", () => {
    const preregistration = readFileSync(
      new URL("../../../docs/yahoo-draft-polling-preregistration-v1.json", import.meta.url),
    );

    expect(sha256(preregistration)).toBe(YAHOO_DRAFT_PREREGISTRATION_CHECKSUM);
  });

  it("keeps the checked-in manifest and context templates aligned with the strict schemas", () => {
    const manifest = JSON.parse(
      readFileSync(
        new URL("../../../docs/yahoo-draft-final-board-manifest-v1.example.json", import.meta.url),
        "utf8",
      ),
    ) as unknown;
    const context = JSON.parse(
      readFileSync(
        new URL("../../../docs/yahoo-draft-confirmation-context-v1.example.json", import.meta.url),
        "utf8",
      ),
    ) as unknown;

    expect(yahooDraftFinalBoardManifestSchema.safeParse(manifest).success).toBe(true);
    expect(yahooDraftConfirmationContextSchema.safeParse(context).success).toBe(true);
  });

  it.each(["snake", "auction"] as const)(
    "compares an independent %s board and replays every cumulative prefix",
    (format) => {
      const originalRelease = JSON.stringify(YAHOO_DRAFT_RELEASE);
      const result = verify(confirmationCase(format));

      expect(result).toMatchObject({
        evidenceClass: "yahoo-draft-confirmation-checks",
        format,
        status: "eligible-for-manual-release-review",
        releaseAdmission: false,
        releaseStateChanged: false,
        manualReviewRequired: true,
        picksCompared: 4,
        prefixesEvaluated: 5,
        idempotentPrefixReplays: 5,
        finalDraftComplete: true,
      });
      expect(result.evidenceChecksumSha256).toMatch(/^[a-f0-9]{64}$/u);
      const repeatedExample = confirmationCase(format);
      const repeatedAtAnotherTime = verifyYahooDraftConfirmation({
        sourceCapture: SOURCE_CAPTURE,
        manifestJson: repeatedExample.manifestJson,
        contextJson: JSON.stringify(repeatedExample.context, null, 2),
        artifactXml: repeatedExample.artifactXml,
        actualImplementationGitRevision: GIT_REVISION,
        actualPreregistrationSha256: YAHOO_DRAFT_PREREGISTRATION_CHECKSUM,
        evaluatedAt: new Date("2026-09-05T16:00:00.000Z"),
      });
      expect(repeatedAtAnotherTime.evidenceChecksumSha256).toBe(result.evidenceChecksumSha256);
      expect(JSON.stringify(YAHOO_DRAFT_RELEASE)).toBe(originalRelease);
      expect(YAHOO_DRAFT_RELEASE[format].state).toBe("shadow-only");
    },
  );

  it("fails before replay when the independent board disagrees", () => {
    const example = confirmationCase("snake");
    example.manifest.picks[0]!.yahooTeamKey = TEAM_KEY_B;
    example.manifestJson = JSON.stringify(example.manifest, null, 2);
    example.context.expectedManifestSha256 = sha256(example.manifestJson);

    expect(failureCode(() => verify(example))).toBe("INDEPENDENT_BOARD_MISMATCH");
  });

  it("fails closed when either frozen evidence file changes", () => {
    const example = confirmationCase("snake");
    example.artifactXml += "\n";

    expect(failureCode(() => verify(example))).toBe("EVIDENCE_HASH_MISMATCH");
  });

  it("fails closed when the retained independent source does not match its manifest hash", () => {
    const example = confirmationCase("snake");

    expect(
      failureCode(() =>
        verifyYahooDraftConfirmation({
          sourceCapture: Buffer.from("a different source capture", "utf8"),
          manifestJson: example.manifestJson,
          contextJson: JSON.stringify(example.context),
          artifactXml: example.artifactXml,
          actualImplementationGitRevision: GIT_REVISION,
          actualPreregistrationSha256: YAHOO_DRAFT_PREREGISTRATION_CHECKSUM,
          evaluatedAt: new Date("2026-09-05T15:00:00.000Z"),
        }),
      ),
    ).toBe("EVIDENCE_HASH_MISMATCH");
  });

  it("rejects a checkout that differs from the frozen revision", () => {
    const example = confirmationCase("snake");

    expect(
      failureCode(() =>
        verifyYahooDraftConfirmation({
          sourceCapture: SOURCE_CAPTURE,
          manifestJson: example.manifestJson,
          contextJson: JSON.stringify(example.context),
          artifactXml: example.artifactXml,
          actualImplementationGitRevision: "c".repeat(40),
          actualPreregistrationSha256: YAHOO_DRAFT_PREREGISTRATION_CHECKSUM,
          evaluatedAt: new Date("2026-09-05T15:00:00.000Z"),
        }),
      ),
    ).toBe("IMPLEMENTATION_NOT_FROZEN");
  });

  it("rejects evidence captured or evaluated out of the preregistered order", () => {
    const example = confirmationCase("snake");
    example.context.artifactCapturedAt = "2026-09-05T11:00:00.000Z";

    expect(failureCode(() => verify(example))).toBe("EVIDENCE_TIMELINE_INVALID");
  });

  it("rejects a completed snake board using a custom or traded pick order", () => {
    const example = confirmationCase("snake");
    if (!("pickOrder" in example.context.config)) throw new Error("Expected snake config");
    example.context.config.pickOrder = [TEAM_A, TEAM_B, TEAM_A, TEAM_B];

    expect(failureCode(() => verify(example))).toBe("DRAFT_SCOPE_CONTRADICTION");
  });

  it("rejects provider artifacts that are not completed", () => {
    const example = confirmationCase("snake");
    example.artifactXml = example.artifactXml.replace("postdraft", "drafting");
    example.context.expectedArtifactSha256 = sha256(example.artifactXml);

    expect(failureCode(() => verify(example))).toBe("ARTIFACT_NOT_COMPLETE");
  });

  it("rejects auction boards that violate the frozen production budget", () => {
    const example = confirmationCase("auction");
    example.artifactXml = example.artifactXml.replace("<cost>20</cost>", "<cost>101</cost>");
    example.context.expectedArtifactSha256 = sha256(example.artifactXml);
    example.manifest.picks[0]!.cost = 101;
    example.manifestJson = JSON.stringify(example.manifest, null, 2);
    example.context.expectedManifestSha256 = sha256(example.manifestJson);

    expect(failureCode(() => verify(example))).toBe("PREFIX_REPLAY_FAILED");
  });

  it.each(["budget", "minimum bid"] as const)(
    "rejects a non-positive frozen auction %s",
    (field) => {
      const example = confirmationCase("auction");
      const config = example.context.config;
      if (!("minimumBid" in config)) throw new Error("Expected auction config");
      if (field === "budget") {
        const firstTeam = config.teams[0];
        if (firstTeam === undefined || !("budget" in firstTeam)) {
          throw new Error("Expected auction team");
        }
        firstTeam.budget = 0;
      } else {
        config.minimumBid = 0;
      }

      expect(failureCode(() => verify(example))).toBe("INPUT_SCHEMA_INVALID");
    },
  );

  it("rejects unknown manifest fields rather than silently accepting schema drift", () => {
    const example = confirmationCase("snake");
    const manifestWithUnknownField = { ...example.manifest, admitted: true };
    example.manifestJson = JSON.stringify(manifestWithUnknownField);
    example.context.expectedManifestSha256 = sha256(example.manifestJson);

    expect(failureCode(() => verify(example))).toBe("INPUT_SCHEMA_INVALID");
  });
});
