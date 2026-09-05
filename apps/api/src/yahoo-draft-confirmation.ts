import { createHash } from "node:crypto";

import {
  NFL_POSITIONS,
  NFL_TEAMS,
  PLAYER_STATUSES,
  ROSTER_SLOT_TYPES,
  playerId,
  rosterSlotId,
  teamId,
} from "@laces-out/domain";
import {
  createSnakePickOrder,
  reduceDraft,
  type DraftConfig,
  type DraftEvent,
} from "@laces-out/engine-draft";
import { parseYahooDraftResultsXml } from "@laces-out/connector-yahoo";
import { z } from "zod";

import {
  reconcileYahooDraftSnapshot,
  type YahooDraftMode,
  type YahooDraftPick,
} from "./yahoo-draft-reconciler.js";
import { YAHOO_DRAFT_PREREGISTRATION_CHECKSUM } from "./yahoo-draft-release.js";

const MAX_JSON_BYTES = 5 * 1024 * 1024;
const MAX_SOURCE_CAPTURE_BYTES = 25 * 1024 * 1024;
const MAX_CONFIRMATION_PICKS = 1_000;
const SHA256_PATTERN = /^[a-f0-9]{64}$/u;
const GIT_REVISION_PATTERN = /^[a-f0-9]{40}$/u;
const YAHOO_LEAGUE_KEY_PATTERN = /^(?:[a-z][a-z0-9-]{0,15}|[0-9]{1,10})\.l\.[0-9]{1,20}$/u;
const YAHOO_TEAM_KEY_PATTERN =
  /^(?:[a-z][a-z0-9-]{0,15}|[0-9]{1,10})\.l\.[0-9]{1,20}\.t\.[0-9]{1,20}$/u;
const YAHOO_PLAYER_KEY_PATTERN = /^(?:[a-z][a-z0-9-]{0,15}|[0-9]{1,10})\.p\.[0-9]{1,20}$/u;

const sha256Schema = z.string().regex(SHA256_PATTERN);
const gitRevisionSchema = z.string().regex(GIT_REVISION_PATTERN);
const uuidSchema = z.uuid();
const positiveIntegerSchema = z.number().int().positive();
const nonNegativeIntegerSchema = z.number().int().nonnegative();

const manifestBaseShape = {
  schemaVersion: z.literal(1),
  evidenceClass: z.literal("independent-yahoo-final-board"),
  leagueFingerprintSha256: sha256Schema,
  season: z.number().int().min(2000).max(2100),
  capturedAt: z.iso.datetime(),
  source: z.enum(["yahoo-final-board-ui", "yahoo-export"]),
  sourceCaptureMediaType: z.enum([
    "image/png",
    "image/jpeg",
    "application/pdf",
    "text/csv",
    "text/html",
  ]),
  sourceCaptureSha256: sha256Schema,
  captureAttestation: z.literal(
    "captured-from-yahoo-final-board-without-reference-to-fantasy-api-draftresults",
  ),
  draftScopeAttestation: z.literal(
    "yahoo-final-board-shows-no-keepers-no-traded-picks-and-no-third-round-reversal",
  ),
};

const manifestPickBaseShape = {
  overallPick: positiveIntegerSchema,
  round: positiveIntegerSchema,
  yahooTeamKey: z.string().regex(YAHOO_TEAM_KEY_PATTERN),
  yahooPlayerKey: z.string().regex(YAHOO_PLAYER_KEY_PATTERN),
};

const snakeManifestSchema = z
  .object({
    ...manifestBaseShape,
    format: z.literal("snake"),
    picks: z
      .array(z.object({ ...manifestPickBaseShape, cost: z.null() }).strict())
      .min(1)
      .max(MAX_CONFIRMATION_PICKS),
  })
  .strict();

const auctionManifestSchema = z
  .object({
    ...manifestBaseShape,
    format: z.literal("auction"),
    picks: z
      .array(z.object({ ...manifestPickBaseShape, cost: nonNegativeIntegerSchema }).strict())
      .min(1)
      .max(MAX_CONFIRMATION_PICKS),
  })
  .strict();

/** Strict, format-discriminated transcription of an independently retained Yahoo final board. */
export const yahooDraftFinalBoardManifestSchema = z
  .discriminatedUnion("format", [snakeManifestSchema, auctionManifestSchema])
  .superRefine((manifest, context) => {
    const players = new Set<string>();
    for (const [index, pick] of manifest.picks.entries()) {
      if (pick.overallPick !== index + 1) {
        context.addIssue({
          code: "custom",
          path: ["picks", index, "overallPick"],
          message: "final-board picks must be a contiguous one-based sequence",
        });
      }
      if (players.has(pick.yahooPlayerKey)) {
        context.addIssue({
          code: "custom",
          path: ["picks", index, "yahooPlayerKey"],
          message: "a final-board player may appear only once",
        });
      }
      players.add(pick.yahooPlayerKey);
    }
  });

export type YahooDraftFinalBoardManifest = z.infer<typeof yahooDraftFinalBoardManifestSchema>;

const rosterSlotSchema = z
  .object({
    id: z.string().min(1).max(200),
    type: z.enum(ROSTER_SLOT_TYPES),
    label: z.string().min(1).max(200),
    kind: z.enum(["STARTER", "BENCH", "INJURED_RESERVE", "TAXI"]),
    eligiblePositions: z.array(z.enum(NFL_POSITIONS)).min(1).max(NFL_POSITIONS.length),
  })
  .strict();

const playerSchema = z
  .object({
    id: uuidSchema,
    name: z.string().min(1).max(200),
    positions: z.array(z.enum(NFL_POSITIONS)).min(1).max(NFL_POSITIONS.length),
    nflTeam: z.enum(NFL_TEAMS).optional(),
    status: z.enum(PLAYER_STATUSES).optional(),
  })
  .strict();

const snakeTeamSchema = z
  .object({
    id: uuidSchema,
    name: z.string().min(1).max(200),
    rosterSlots: z.array(rosterSlotSchema).min(1).max(100),
  })
  .strict();

const auctionTeamSchema = snakeTeamSchema.extend({ budget: positiveIntegerSchema }).strict();

const snakeConfigSchema = z
  .object({
    mode: z.literal("SNAKE"),
    teams: z.array(snakeTeamSchema).min(2).max(100),
    players: z.array(playerSchema).min(1).max(10_000),
    pickOrder: z.array(uuidSchema).min(1).max(MAX_CONFIRMATION_PICKS),
  })
  .strict();

const auctionConfigSchema = z
  .object({
    mode: z.literal("AUCTION"),
    teams: z.array(auctionTeamSchema).min(2).max(100),
    players: z.array(playerSchema).min(1).max(10_000),
    minimumBid: positiveIntegerSchema,
  })
  .strict();

const teamMappingSchema = z
  .object({
    yahooTeamKey: z.string().regex(YAHOO_TEAM_KEY_PATTERN),
    internalTeamId: uuidSchema,
  })
  .strict();

const playerMappingSchema = z
  .object({
    yahooPlayerKey: z.string().regex(YAHOO_PLAYER_KEY_PATTERN),
    internalPlayerId: uuidSchema,
  })
  .strict();

const contextBaseShape = {
  schemaVersion: z.literal(1),
  evidenceClass: z.literal("frozen-yahoo-draft-confirmation-context"),
  protocol: z.literal("yahoo-draft-polling-v1"),
  preregistrationSha256: sha256Schema,
  frozenImplementationGitRevision: gitRevisionSchema,
  leagueFingerprintSha256: sha256Schema,
  yahooLeagueKey: z.string().regex(YAHOO_LEAGUE_KEY_PATTERN),
  season: z.number().int().min(2000).max(2100),
  holdoutSelectedAt: z.iso.datetime(),
  implementationFrozenAt: z.iso.datetime(),
  artifactCapturedAt: z.iso.datetime(),
  evidenceFrozenAt: z.iso.datetime(),
  holdoutSelectionAttestation: z.literal(
    "selected-before-reveal-and-did-not-influence-this-implementation",
  ),
  standardScopeConfirmation: z.literal("no-keepers-or-traded-picks"),
  productionConfigurationAttestation: z.literal(
    "exported-or-built-with-the-frozen-production-path-before-artifact-reveal",
  ),
  identityMappingAttestation: z.literal(
    "copied-from-preexisting-provider-mappings-without-using-the-final-artifact",
  ),
  expectedManifestSha256: sha256Schema,
  expectedArtifactSha256: sha256Schema,
  feedId: uuidSchema,
  draftId: uuidSchema,
  teamMappings: z.array(teamMappingSchema).min(2).max(100),
  playerMappings: z.array(playerMappingSchema).min(1).max(MAX_CONFIRMATION_PICKS),
};

const snakeContextSchema = z
  .object({
    ...contextBaseShape,
    format: z.literal("snake"),
    config: snakeConfigSchema,
  })
  .strict();

const auctionContextSchema = z
  .object({
    ...contextBaseShape,
    format: z.literal("auction"),
    config: auctionConfigSchema,
  })
  .strict();

/** Frozen implementation, artifact, mapping, and production-config identity for one holdout. */
export const yahooDraftConfirmationContextSchema = z.discriminatedUnion("format", [
  snakeContextSchema,
  auctionContextSchema,
]);

export type YahooDraftConfirmationContext = z.infer<typeof yahooDraftConfirmationContextSchema>;

export type YahooDraftConfirmationErrorCode =
  | "INPUT_TOO_LARGE"
  | "INPUT_JSON_INVALID"
  | "INPUT_SCHEMA_INVALID"
  | "EVIDENCE_HASH_MISMATCH"
  | "IMPLEMENTATION_NOT_FROZEN"
  | "EVIDENCE_TIMELINE_INVALID"
  | "FORMAT_MISMATCH"
  | "LEAGUE_IDENTITY_MISMATCH"
  | "ARTIFACT_NOT_COMPLETE"
  | "DRAFT_SCOPE_CONTRADICTION"
  | "CONFIGURATION_INVALID"
  | "IDENTITY_MAPPING_INVALID"
  | "INDEPENDENT_BOARD_MISMATCH"
  | "PREFIX_REPLAY_FAILED";

/** Bounded failure details are safe for a CLI; protected evidence values are never included. */
export class YahooDraftConfirmationError extends Error {
  public readonly code: YahooDraftConfirmationErrorCode;

  public constructor(code: YahooDraftConfirmationErrorCode, message: string) {
    super(message);
    this.name = "YahooDraftConfirmationError";
    this.code = code;
  }
}

export interface VerifyYahooDraftConfirmationInput {
  readonly sourceCapture: Uint8Array;
  readonly manifestJson: string;
  readonly contextJson: string;
  readonly artifactXml: string;
  readonly actualImplementationGitRevision: string;
  readonly actualPreregistrationSha256: string;
  readonly evaluatedAt: Date;
}

export interface YahooDraftConfirmationEvidence {
  readonly schemaVersion: 1;
  readonly evidenceClass: "yahoo-draft-confirmation-checks";
  readonly format: YahooDraftMode;
  readonly status: "eligible-for-manual-release-review";
  readonly releaseAdmission: false;
  readonly releaseStateChanged: false;
  readonly manualReviewRequired: true;
  readonly leagueFingerprintSha256: string;
  readonly frozenImplementationGitRevision: string;
  readonly preregistrationSha256: string;
  readonly contextSha256: string;
  readonly manifestSha256: string;
  readonly sourceCaptureSha256: string;
  readonly artifactRawSha256: string;
  readonly artifactNormalizedSha256: string;
  readonly picksCompared: number;
  readonly prefixesEvaluated: number;
  readonly idempotentPrefixReplays: number;
  readonly finalDraftComplete: true;
  readonly evaluatedAt: string;
  readonly evidenceChecksumSha256: string;
}

function sha256(value: string | Uint8Array): string {
  return createHash("sha256").update(value).digest("hex");
}

function fail(code: YahooDraftConfirmationErrorCode, message: string): never {
  throw new YahooDraftConfirmationError(code, message);
}

function parseJson(raw: string, label: string): unknown {
  if (Buffer.byteLength(raw, "utf8") > MAX_JSON_BYTES) {
    fail("INPUT_TOO_LARGE", `${label} exceeded the confirmation input limit.`);
  }
  try {
    return JSON.parse(raw) as unknown;
  } catch {
    return fail("INPUT_JSON_INVALID", `${label} was not valid JSON.`);
  }
}

function parsedSchema<T>(schema: z.ZodType<T>, value: unknown, label: string): T {
  const result = schema.safeParse(value);
  if (!result.success) {
    fail("INPUT_SCHEMA_INVALID", `${label} did not match its strict versioned schema.`);
  }
  return result.data;
}

function timestamp(value: string): number {
  return new Date(value).getTime();
}

function ensureUnique(values: readonly string[], label: string): void {
  if (new Set(values).size !== values.length) {
    fail("IDENTITY_MAPPING_INVALID", `${label} must be one-to-one.`);
  }
}

function yahooGameScope(key: string): string {
  return key.split(".", 1)[0] ?? "";
}

function draftConfig(context: YahooDraftConfirmationContext): DraftConfig {
  const players = context.config.players.map((player) => ({
    id: playerId(player.id),
    name: player.name,
    positions: player.positions,
    ...(player.nflTeam === undefined ? {} : { nflTeam: player.nflTeam }),
    ...(player.status === undefined ? {} : { status: player.status }),
  }));
  const slotsFor = (team: (typeof context.config.teams)[number]) =>
    team.rosterSlots.map((slot) => ({
      id: rosterSlotId(slot.id),
      type: slot.type,
      label: slot.label,
      kind: slot.kind,
      eligiblePositions: slot.eligiblePositions,
    }));
  if (context.format === "snake") {
    return {
      mode: "SNAKE",
      teams: context.config.teams.map((team) => ({
        id: teamId(team.id),
        name: team.name,
        rosterSlots: slotsFor(team),
      })),
      players,
      pickOrder: context.config.pickOrder.map(teamId),
    };
  }
  return {
    mode: "AUCTION",
    teams: context.config.teams.map((team) => ({
      id: teamId(team.id),
      name: team.name,
      rosterSlots: slotsFor(team),
      budget: team.budget,
    })),
    players,
    minimumBid: context.config.minimumBid,
  };
}

function validateEvidenceTimeline(
  manifest: YahooDraftFinalBoardManifest,
  context: YahooDraftConfirmationContext,
  evaluatedAt: Date,
): void {
  const selected = timestamp(context.holdoutSelectedAt);
  const implementationFrozen = timestamp(context.implementationFrozenAt);
  const manifestCaptured = timestamp(manifest.capturedAt);
  const artifactCaptured = timestamp(context.artifactCapturedAt);
  const evidenceFrozen = timestamp(context.evidenceFrozenAt);
  const evaluated = evaluatedAt.getTime();
  if (
    !Number.isFinite(evaluated) ||
    selected > implementationFrozen ||
    implementationFrozen > manifestCaptured ||
    manifestCaptured > artifactCaptured ||
    artifactCaptured > evidenceFrozen ||
    evidenceFrozen > evaluated
  ) {
    fail(
      "EVIDENCE_TIMELINE_INVALID",
      "Holdout selection, implementation freeze, independent-board capture, artifact capture, evidence freeze, and evaluation were not in the required order.",
    );
  }
}

function validateConfigScope(config: DraftConfig, expectedPicks: number): void {
  ensureUnique(
    config.teams.map((team) => team.id),
    "Configured team identities",
  );
  ensureUnique(
    config.players.map((player) => player.id),
    "Configured player identities",
  );
  for (const team of config.teams) {
    ensureUnique(
      team.rosterSlots.map((slot) => slot.id),
      "Roster-slot identities within each team",
    );
  }
  try {
    reduceDraft(config, []);
  } catch {
    fail("CONFIGURATION_INVALID", "The frozen draft configuration is invalid.");
  }

  const totalRosterSlots = config.teams.reduce((sum, team) => sum + team.rosterSlots.length, 0);
  if (expectedPicks !== totalRosterSlots) {
    fail(
      "CONFIGURATION_INVALID",
      "The completed board does not fill every configured roster slot.",
    );
  }

  if (config.mode === "SNAKE") {
    const teamCount = config.teams.length;
    if (config.pickOrder.length !== totalRosterSlots || totalRosterSlots % teamCount !== 0) {
      fail("CONFIGURATION_INVALID", "The standard snake configuration is not rectangular.");
    }
    const rounds = totalRosterSlots / teamCount;
    if (config.teams.some((team) => team.rosterSlots.length !== rounds)) {
      fail("CONFIGURATION_INVALID", "Standard snake teams do not have equal roster lengths.");
    }
    const firstRound = config.pickOrder.slice(0, teamCount);
    if (new Set(firstRound).size !== teamCount) {
      fail("CONFIGURATION_INVALID", "The snake first round does not contain every team once.");
    }
    const standardOrder = createSnakePickOrder(firstRound, rounds);
    if (standardOrder.some((owner, index) => owner !== config.pickOrder[index])) {
      fail("DRAFT_SCOPE_CONTRADICTION", "The snake pick order is not standard alternating order.");
    }
  }
}

function validateIdentityMappings(
  manifest: YahooDraftFinalBoardManifest,
  context: YahooDraftConfirmationContext,
  config: DraftConfig,
  snapshotPicks: readonly YahooDraftPick[],
): {
  readonly teamIdByKey: ReadonlyMap<string, string>;
  readonly playerIdByKey: ReadonlyMap<string, string>;
} {
  const configuredTeamIds = new Set(config.teams.map((team) => team.id));
  const configuredPlayerIds = new Set(config.players.map((player) => player.id));
  const observedTeamKeys = new Set(snapshotPicks.map((pick) => pick.teamKey));
  const observedPlayerKeys = new Set(snapshotPicks.map((pick) => pick.playerKey));
  ensureUnique(
    context.teamMappings.map((mapping) => mapping.yahooTeamKey),
    "Yahoo team mappings",
  );
  ensureUnique(
    context.teamMappings.map((mapping) => mapping.internalTeamId),
    "Internal team mappings",
  );
  ensureUnique(
    context.playerMappings.map((mapping) => mapping.yahooPlayerKey),
    "Yahoo player mappings",
  );
  ensureUnique(
    context.playerMappings.map((mapping) => mapping.internalPlayerId),
    "Internal player mappings",
  );
  if (
    context.teamMappings.length !== config.teams.length ||
    context.teamMappings.some(
      (mapping) =>
        !configuredTeamIds.has(teamId(mapping.internalTeamId)) ||
        !observedTeamKeys.has(mapping.yahooTeamKey) ||
        !mapping.yahooTeamKey.startsWith(`${context.yahooLeagueKey}.t.`),
    )
  ) {
    fail(
      "IDENTITY_MAPPING_INVALID",
      "Team mappings are not an exact bijection across Yahoo and the frozen configuration.",
    );
  }
  if (
    context.playerMappings.length !== snapshotPicks.length ||
    context.playerMappings.some(
      (mapping) =>
        !configuredPlayerIds.has(playerId(mapping.internalPlayerId)) ||
        !observedPlayerKeys.has(mapping.yahooPlayerKey) ||
        yahooGameScope(mapping.yahooPlayerKey) !== yahooGameScope(context.yahooLeagueKey),
    )
  ) {
    fail(
      "IDENTITY_MAPPING_INVALID",
      "Player mappings are not an exact bijection across Yahoo and the completed board.",
    );
  }
  if (
    manifest.picks.some(
      (pick) =>
        !observedTeamKeys.has(pick.yahooTeamKey) || !observedPlayerKeys.has(pick.yahooPlayerKey),
    )
  ) {
    fail(
      "IDENTITY_MAPPING_INVALID",
      "The independent board contains an identity outside the frozen mapping set.",
    );
  }
  return {
    teamIdByKey: new Map(
      context.teamMappings.map((mapping) => [mapping.yahooTeamKey, mapping.internalTeamId]),
    ),
    playerIdByKey: new Map(
      context.playerMappings.map((mapping) => [mapping.yahooPlayerKey, mapping.internalPlayerId]),
    ),
  };
}

function compareIndependentBoard(
  manifest: YahooDraftFinalBoardManifest,
  providerPicks: readonly YahooDraftPick[],
  teamCount: number,
): void {
  if (manifest.picks.length !== providerPicks.length) {
    fail(
      "INDEPENDENT_BOARD_MISMATCH",
      "The independent board and provider artifact have different pick counts.",
    );
  }
  for (const [index, expected] of manifest.picks.entries()) {
    const observed = providerPicks[index];
    if (
      observed === undefined ||
      expected.overallPick !== observed.pick ||
      expected.round !== observed.round ||
      expected.yahooTeamKey !== observed.teamKey ||
      expected.yahooPlayerKey !== observed.playerKey ||
      expected.cost !== observed.cost
    ) {
      fail(
        "INDEPENDENT_BOARD_MISMATCH",
        `The independent board disagrees with the provider artifact at overall pick ${index + 1}.`,
      );
    }
    if (manifest.format === "snake" && expected.round !== Math.ceil((index + 1) / teamCount)) {
      fail(
        "INDEPENDENT_BOARD_MISMATCH",
        `The independent snake board has an invalid round at overall pick ${index + 1}.`,
      );
    }
  }
}

function replayEveryPrefix(input: {
  readonly context: YahooDraftConfirmationContext;
  readonly config: DraftConfig;
  readonly picks: readonly YahooDraftPick[];
  readonly teamIdByKey: ReadonlyMap<string, string>;
  readonly playerIdByKey: ReadonlyMap<string, string>;
}): { readonly events: readonly DraftEvent[]; readonly replayChecks: number } {
  let activeEvents: readonly DraftEvent[] = [];
  let replayChecks = 0;
  const occurredAt = new Date(input.context.evidenceFrozenAt);
  for (let prefixLength = 0; prefixLength <= input.picks.length; prefixLength += 1) {
    const snapshot = {
      collectionComplete: true,
      picks: input.picks.slice(0, prefixLength),
    };
    const result = reconcileYahooDraftSnapshot({
      feedId: input.context.feedId,
      draftId: input.context.draftId,
      draftMode: input.context.format,
      config: input.config,
      snapshot,
      teamIdByKey: input.teamIdByKey,
      playerIdByKey: input.playerIdByKey,
      activeEvents,
      standardScopeConfirmed: true,
      occurredAt,
    });
    if (prefixLength === 0) {
      if (result.kind !== "idempotent") {
        fail("PREFIX_REPLAY_FAILED", "The empty cumulative prefix was not idempotent.");
      }
    } else {
      if (result.kind !== "append" || result.append.length !== 1) {
        fail(
          "PREFIX_REPLAY_FAILED",
          `Cumulative prefix ${prefixLength} did not append exactly its unseen pick.`,
        );
      }
      activeEvents = [...activeEvents, result.append[0]!.event];
    }

    const repeated = reconcileYahooDraftSnapshot({
      feedId: input.context.feedId,
      draftId: input.context.draftId,
      draftMode: input.context.format,
      config: input.config,
      snapshot,
      teamIdByKey: input.teamIdByKey,
      playerIdByKey: input.playerIdByKey,
      activeEvents,
      standardScopeConfirmed: true,
      occurredAt,
    });
    if (repeated.kind !== "idempotent") {
      fail(
        "PREFIX_REPLAY_FAILED",
        `Cumulative prefix ${prefixLength} was not idempotent when repeated.`,
      );
    }
    replayChecks += 1;
  }
  return { events: activeEvents, replayChecks };
}

/**
 * Evaluate one protected, frozen holdout entirely in memory. This function performs no database,
 * network, filesystem, release-policy, or other mutable operation.
 */
export function verifyYahooDraftConfirmation(
  input: VerifyYahooDraftConfirmationInput,
): YahooDraftConfirmationEvidence {
  if (
    input.sourceCapture.byteLength > MAX_SOURCE_CAPTURE_BYTES ||
    Buffer.byteLength(input.artifactXml, "utf8") > MAX_JSON_BYTES
  ) {
    fail("INPUT_TOO_LARGE", "A confirmation evidence file exceeded its input limit.");
  }
  const manifestSha256 = sha256(input.manifestJson);
  const contextSha256 = sha256(input.contextJson);
  const artifactRawSha256 = sha256(input.artifactXml);
  const manifest = parsedSchema(
    yahooDraftFinalBoardManifestSchema,
    parseJson(input.manifestJson, "Independent final-board manifest"),
    "Independent final-board manifest",
  );
  const context = parsedSchema(
    yahooDraftConfirmationContextSchema,
    parseJson(input.contextJson, "Frozen confirmation context"),
    "Frozen confirmation context",
  );

  if (
    manifest.sourceCaptureSha256 !== sha256(input.sourceCapture) ||
    context.expectedManifestSha256 !== manifestSha256 ||
    context.expectedArtifactSha256 !== artifactRawSha256
  ) {
    fail("EVIDENCE_HASH_MISMATCH", "A frozen evidence file did not match its expected SHA-256.");
  }
  if (
    input.actualPreregistrationSha256 !== YAHOO_DRAFT_PREREGISTRATION_CHECKSUM ||
    context.preregistrationSha256 !== input.actualPreregistrationSha256 ||
    input.actualImplementationGitRevision !== context.frozenImplementationGitRevision
  ) {
    fail(
      "IMPLEMENTATION_NOT_FROZEN",
      "The checkout does not match the frozen implementation and preregistration.",
    );
  }
  validateEvidenceTimeline(manifest, context, input.evaluatedAt);
  if (manifest.format !== context.format || manifest.season !== context.season) {
    fail("FORMAT_MISMATCH", "Manifest and confirmation context format or season differ.");
  }
  const expectedLeagueFingerprint = sha256(context.yahooLeagueKey);
  if (
    manifest.leagueFingerprintSha256 !== expectedLeagueFingerprint ||
    context.leagueFingerprintSha256 !== expectedLeagueFingerprint
  ) {
    fail(
      "LEAGUE_IDENTITY_MISMATCH",
      "Manifest and confirmation context do not identify the same Yahoo league.",
    );
  }

  let snapshot;
  try {
    snapshot = parseYahooDraftResultsXml(input.artifactXml, {
      expectedLeagueKey: context.yahooLeagueKey,
    });
  } catch {
    fail("ARTIFACT_NOT_COMPLETE", "The frozen Yahoo artifact failed strict parsing.");
  }
  if (
    snapshot.status !== "postdraft" ||
    !snapshot.collectionComplete ||
    snapshot.declaredCount !== snapshot.observedCount
  ) {
    fail("ARTIFACT_NOT_COMPLETE", "Yahoo does not report a complete final draft board.");
  }
  if (snapshot.picks.some((pick) => pick.keeper === true)) {
    fail("DRAFT_SCOPE_CONTRADICTION", "Yahoo explicitly marked a keeper pick.");
  }

  const config = draftConfig(context);
  validateConfigScope(config, snapshot.picks.length);
  if (
    (context.format === "snake" && config.mode !== "SNAKE") ||
    (context.format === "auction" && config.mode !== "AUCTION")
  ) {
    fail("FORMAT_MISMATCH", "The frozen production configuration has another draft format.");
  }
  const observedTeams = new Set(snapshot.picks.map((pick) => pick.teamKey));
  if (observedTeams.size !== config.teams.length) {
    fail("CONFIGURATION_INVALID", "The completed board does not include every configured team.");
  }
  const mappings = validateIdentityMappings(manifest, context, config, snapshot.picks);
  compareIndependentBoard(manifest, snapshot.picks, config.teams.length);

  const replay = replayEveryPrefix({
    context,
    config,
    picks: snapshot.picks,
    ...mappings,
  });
  let finalState;
  try {
    finalState = reduceDraft(config, replay.events);
  } catch {
    fail("PREFIX_REPLAY_FAILED", "The replayed final ledger violates a draft invariant.");
  }
  if (!finalState.complete || replay.events.length !== snapshot.picks.length) {
    fail("PREFIX_REPLAY_FAILED", "The replayed final ledger is not complete.");
  }

  const evaluatedAt = input.evaluatedAt.toISOString();
  const evidenceChecksumSha256 = sha256(
    JSON.stringify([
      "yahoo-draft-confirmation-checks-v1",
      context.format,
      context.leagueFingerprintSha256,
      context.frozenImplementationGitRevision,
      context.preregistrationSha256,
      contextSha256,
      manifestSha256,
      manifest.sourceCaptureSha256,
      artifactRawSha256,
      snapshot.checksumSha256,
      snapshot.picks.length,
      replay.replayChecks,
    ]),
  );
  return {
    schemaVersion: 1,
    evidenceClass: "yahoo-draft-confirmation-checks",
    format: context.format,
    status: "eligible-for-manual-release-review",
    releaseAdmission: false,
    releaseStateChanged: false,
    manualReviewRequired: true,
    leagueFingerprintSha256: context.leagueFingerprintSha256,
    frozenImplementationGitRevision: context.frozenImplementationGitRevision,
    preregistrationSha256: context.preregistrationSha256,
    contextSha256,
    manifestSha256,
    sourceCaptureSha256: manifest.sourceCaptureSha256,
    artifactRawSha256,
    artifactNormalizedSha256: snapshot.checksumSha256,
    picksCompared: snapshot.picks.length,
    prefixesEvaluated: snapshot.picks.length + 1,
    idempotentPrefixReplays: replay.replayChecks,
    finalDraftComplete: true,
    evaluatedAt,
    evidenceChecksumSha256,
  };
}
