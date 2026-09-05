import { createHash } from "node:crypto";

import {
  NORMALIZED_SYNC_SCHEMA_VERSION,
  type DraftType,
  type ExternalLeagueRef,
  type LeagueSyncBundle,
  type NormalizedLeagueSettings,
  type NormalizedManager,
  type NormalizedMatchupSnapshot,
  type NormalizedRosterPlayer,
  type NormalizedRosterSlot,
  type NormalizedScoringRule,
  type NormalizedStandingEntry,
  type NormalizedStandingsSnapshot,
  type NormalizedTeam,
  type NormalizedWeeklyMatchup,
  type WaiverType,
} from "@laces-out/connectors";
import { XMLParser, XMLValidator } from "fast-xml-parser";

export const MAX_YAHOO_XML_BYTES = 5 * 1024 * 1024;

export class YahooXmlError extends Error {
  public readonly code:
    "TOO_LARGE" | "UNSAFE_XML" | "INVALID_XML" | "INVALID_CONTRACT" | "LEAGUE_NOT_READY";

  public constructor(
    code: "TOO_LARGE" | "UNSAFE_XML" | "INVALID_XML" | "INVALID_CONTRACT" | "LEAGUE_NOT_READY",
    message: string,
  ) {
    super(message);
    this.name = "YahooXmlError";
    this.code = code;
  }
}

const REPEATED_YAHOO_ELEMENTS = new Set([
  "league",
  "user",
  "game",
  "team",
  "manager",
  "player",
  "roster_position",
  "stat",
  "stat_position_type",
  "team_logo",
  "matchup",
  "draft_result",
]);

/**
 * Exported for contract review. Doctype/entity declarations are rejected before
 * this parser is invoked, and entity processing is disabled as defense in depth.
 */
export const SECURE_YAHOO_XML_OPTIONS = Object.freeze({
  allowBooleanAttributes: false,
  attributeNamePrefix: "@_",
  htmlEntities: false,
  ignoreAttributes: false,
  ignoreDeclaration: true,
  ignorePiTags: true,
  parseAttributeValue: false,
  parseTagValue: false,
  preserveOrder: false,
  processEntities: false,
  removeNSPrefix: true,
  trimValues: true,
  isArray: (tagName: string) => REPEATED_YAHOO_ELEMENTS.has(tagName),
});

const yahooXmlParser = new XMLParser(SECURE_YAHOO_XML_OPTIONS);

type XmlRecord = Record<string, unknown>;

function asRecord(value: unknown): XmlRecord | null {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as XmlRecord)
    : null;
}

function asArray(value: unknown): readonly unknown[] {
  if (value === undefined || value === null) return [];
  return Array.isArray(value) ? value : [value];
}

function text(value: unknown): string | null {
  if (typeof value === "string") {
    const trimmed = value.trim();
    return trimmed === "" ? null : trimmed;
  }
  if (typeof value === "number" || typeof value === "boolean") return String(value);
  const record = asRecord(value);
  return record === null ? null : text(record["#text"]);
}

function child(record: XmlRecord | null, key: string): XmlRecord | null {
  return record === null ? null : asRecord(record[key]);
}

function requiredText(record: XmlRecord, key: string, label: string): string {
  const result = text(record[key]);
  if (result === null) {
    throw new YahooXmlError("INVALID_CONTRACT", `Yahoo response omitted ${label}`);
  }
  return result;
}

function integer(value: unknown): number | null {
  const stringValue = text(value);
  if (stringValue === null || !/^-?\d+$/u.test(stringValue)) return null;
  const parsed = Number(stringValue);
  return Number.isSafeInteger(parsed) ? parsed : null;
}

function numeric(value: unknown): number | null {
  const stringValue = text(value);
  if (stringValue === null || stringValue.trim() === "") return null;
  const parsed = Number(stringValue);
  return Number.isFinite(parsed) ? parsed : null;
}

function truthy(value: unknown): boolean {
  return ["1", "true", "yes"].includes(text(value)?.toLowerCase() ?? "");
}

function booleanSetting(value: unknown): boolean | null {
  const normalized = text(value)?.toLowerCase();
  if (["1", "true", "yes"].includes(normalized ?? "")) return true;
  if (["0", "false", "no"].includes(normalized ?? "")) return false;
  return null;
}

function firstRecord(value: unknown): XmlRecord | null {
  for (const candidate of asArray(value)) {
    const record = asRecord(candidate);
    if (record !== null) return record;
  }
  return null;
}

function assertSafeXml(xml: string): void {
  const size = Buffer.byteLength(xml, "utf8");
  if (size > MAX_YAHOO_XML_BYTES) {
    throw new YahooXmlError("TOO_LARGE", "Yahoo XML response exceeded the configured size limit");
  }
  if (/<!\s*(?:DOCTYPE|ENTITY)\b/iu.test(xml)) {
    throw new YahooXmlError(
      "UNSAFE_XML",
      "Yahoo XML response contained a forbidden doctype or entity declaration",
    );
  }
  const validation = XMLValidator.validate(xml, { allowBooleanAttributes: false });
  if (validation !== true) {
    throw new YahooXmlError("INVALID_XML", "Yahoo response was not well-formed XML");
  }
}

export function parseYahooXml(xml: string): unknown {
  assertSafeXml(xml);
  try {
    return yahooXmlParser.parse(xml) as unknown;
  } catch {
    throw new YahooXmlError("INVALID_XML", "Yahoo response could not be parsed as XML");
  }
}

function findLeagueNode(parsed: unknown): XmlRecord {
  const document = asRecord(parsed);
  const fantasyContent = child(document, "fantasy_content");
  if (fantasyContent === null) {
    throw new YahooXmlError("INVALID_CONTRACT", "Yahoo response omitted fantasy_content");
  }

  const direct = firstRecord(fantasyContent.league);
  if (direct !== null) return direct;
  const fromLeagues = firstRecord(child(fantasyContent, "leagues")?.league);
  if (fromLeagues !== null) return fromLeagues;
  throw new YahooXmlError("INVALID_CONTRACT", "Yahoo response did not contain a league");
}

function fantasyContent(parsed: unknown): XmlRecord {
  const document = asRecord(parsed);
  const content = child(document, "fantasy_content");
  if (content === null) {
    throw new YahooXmlError("INVALID_CONTRACT", "Yahoo response omitted fantasy_content");
  }
  return content;
}

function validSeason(value: unknown): number | null {
  const parsed = integer(value);
  return parsed !== null && parsed >= 2000 && parsed <= 2100 ? parsed : null;
}

function leagueReference(league: XmlRecord): ExternalLeagueRef {
  const externalId = requiredText(league, "league_key", "league_key");
  const providerLeagueId = requiredText(league, "league_id", "league_id");
  const name = requiredText(league, "name", "league name");
  const season = validSeason(league.season);
  if (!/^(?:[a-z][a-z0-9-]{0,15}|[0-9]{1,10})\.l\.[0-9]{1,20}$/u.test(externalId)) {
    throw new YahooXmlError("INVALID_CONTRACT", "Yahoo returned an invalid league_key");
  }
  if (!/^[0-9]{1,20}$/u.test(providerLeagueId) || season === null) {
    throw new YahooXmlError("INVALID_CONTRACT", "Yahoo returned an invalid league identity");
  }
  return { provider: "yahoo", externalId, providerLeagueId, season, name };
}

export interface YahooLeaguePage {
  readonly leagues: readonly ExternalLeagueRef[];
  readonly start: number;
  readonly returned: number;
}

export type YahooDraftStatus = "predraft" | "drafting" | "postdraft" | "unknown";

export interface YahooDraftResultPick {
  /** Yahoo's one-based overall pick sequence. */
  readonly pick: number;
  readonly round: number;
  /** Present only when Yahoo explicitly supplies it. */
  readonly roundPick?: number;
  readonly teamKey: string;
  readonly teamId: string;
  readonly playerKey: string;
  readonly playerId: string;
  /** Auction price in whole Yahoo budget units; absent for a standard draft. */
  readonly cost: number | null;
  /** Present only when Yahoo explicitly identifies a keeper. */
  readonly keeper: boolean | null;
}

export interface YahooDraftResultsSnapshot {
  readonly leagueKey: string;
  readonly leagueId: string;
  readonly status: YahooDraftStatus;
  readonly providerStatus: string | null;
  readonly declaredCount: number;
  readonly observedCount: number;
  /** False means the artifact was truncated and must not be admitted as a complete observation. */
  readonly collectionComplete: boolean;
  readonly refreshRateSeconds: number | null;
  readonly picks: readonly YahooDraftResultPick[];
  readonly checksumSha256: string;
}

export interface ParseYahooDraftResultsOptions {
  /** When provided, a response for any other league is rejected. */
  readonly expectedLeagueKey?: string;
}

export interface YahooDraftPlayer {
  readonly playerKey: string;
  readonly playerId: string;
  readonly fullName: string;
  readonly proTeamAbbreviation: string | null;
  readonly primaryPosition: string;
  readonly eligiblePositions: readonly string[];
}

export interface YahooDraftPlayersSnapshot {
  readonly leagueKey: string;
  readonly leagueId: string;
  readonly declaredCount: number;
  readonly observedCount: number;
  readonly collectionComplete: boolean;
  readonly players: readonly YahooDraftPlayer[];
  readonly checksumSha256: string;
}

export const MAX_YAHOO_DRAFT_PLAYER_KEYS = 25;
const MAX_YAHOO_DRAFT_RESULTS = 10_000;

export interface ParseYahooDraftPlayersOptions {
  /** When provided, a response for any other league is rejected. */
  readonly expectedLeagueKey?: string;
  /** When provided, the response must resolve this exact bounded set of keys. */
  readonly expectedPlayerKeys?: readonly string[];
}

interface YahooLeagueKeyIdentity {
  readonly leagueKey: string;
  readonly gameKey: string;
  readonly leagueId: string;
}

interface YahooScopedKeyIdentity {
  readonly key: string;
  readonly id: string;
}

const YAHOO_LEAGUE_KEY_PATTERN = /^((?:[a-z][a-z0-9-]{0,15}|[0-9]{1,10}))\.l\.([0-9]{1,20})$/u;
const YAHOO_TEAM_KEY_PATTERN =
  /^((?:[a-z][a-z0-9-]{0,15}|[0-9]{1,10}))\.l\.([0-9]{1,20})\.t\.([0-9]{1,20})$/u;
const YAHOO_PLAYER_KEY_PATTERN = /^((?:[a-z][a-z0-9-]{0,15}|[0-9]{1,10}))\.p\.([0-9]{1,20})$/u;

function yahooLeagueKeyIdentity(value: string, label: string): YahooLeagueKeyIdentity {
  const match = YAHOO_LEAGUE_KEY_PATTERN.exec(value);
  const gameKey = match?.[1];
  const leagueId = match?.[2];
  if (gameKey === undefined || leagueId === undefined) {
    throw new YahooXmlError("INVALID_CONTRACT", `Yahoo returned an invalid ${label}`);
  }
  return { leagueKey: value, gameKey, leagueId };
}

function yahooTeamKeyIdentity(
  value: string,
  league: YahooLeagueKeyIdentity,
): YahooScopedKeyIdentity {
  const match = YAHOO_TEAM_KEY_PATTERN.exec(value);
  const gameKey = match?.[1];
  const leagueId = match?.[2];
  const teamId = match?.[3];
  if (
    gameKey === undefined ||
    leagueId === undefined ||
    teamId === undefined ||
    gameKey !== league.gameKey ||
    leagueId !== league.leagueId
  ) {
    throw new YahooXmlError(
      "INVALID_CONTRACT",
      "Yahoo draft result contained an invalid or out-of-scope team_key",
    );
  }
  return { key: value, id: teamId };
}

function yahooPlayerKeyIdentity(
  value: string,
  gameKey: string,
  label = "player_key",
): YahooScopedKeyIdentity {
  const match = YAHOO_PLAYER_KEY_PATTERN.exec(value);
  const keyGame = match?.[1];
  const playerId = match?.[2];
  if (keyGame === undefined || playerId === undefined || keyGame !== gameKey) {
    throw new YahooXmlError(
      "INVALID_CONTRACT",
      `Yahoo returned an invalid or out-of-scope ${label}`,
    );
  }
  return { key: value, id: playerId };
}

function boundedOptionalInteger(
  record: XmlRecord,
  key: string,
  label: string,
  minimum: number,
  maximum = Number.MAX_SAFE_INTEGER,
): number | null {
  if (!Object.hasOwn(record, key)) return null;
  const parsed = integer(record[key]);
  if (parsed === null || parsed < minimum || parsed > maximum) {
    throw new YahooXmlError("INVALID_CONTRACT", `Yahoo returned invalid ${label}`);
  }
  return parsed;
}

function boundedRequiredText(value: unknown, label: string, maximum: number): string {
  const parsed = text(value);
  if (parsed === null || parsed.length > maximum || containsAsciiControl(parsed)) {
    throw new YahooXmlError("INVALID_CONTRACT", `Yahoo returned invalid ${label}`);
  }
  return parsed;
}

function containsAsciiControl(value: string): boolean {
  for (const character of value) {
    const codePoint = character.codePointAt(0) ?? 0;
    if (codePoint < 0x20 || codePoint === 0x7f) return true;
  }
  return false;
}

function boundedOptionalText(value: unknown, label: string, maximum: number): string | null {
  const parsed = text(value);
  return parsed === null ? null : boundedRequiredText(parsed, label, maximum);
}

function explicitBoolean(record: XmlRecord, key: string, label: string): boolean | null {
  if (!Object.hasOwn(record, key)) return null;
  const normalized = text(record[key])?.toLowerCase();
  if (normalized === "1" || normalized === "true" || normalized === "yes") return true;
  if (normalized === "0" || normalized === "false" || normalized === "no") return false;
  throw new YahooXmlError("INVALID_CONTRACT", `Yahoo returned invalid ${label}`);
}

function explicitDraftKeeper(result: XmlRecord): boolean | null {
  const isKeeper = explicitBoolean(result, "is_keeper", "draft result is_keeper");
  const keeper = explicitBoolean(result, "keeper", "draft result keeper");
  if (isKeeper !== null && keeper !== null && isKeeper !== keeper) {
    throw new YahooXmlError(
      "INVALID_CONTRACT",
      "Yahoo draft result contained conflicting keeper fields",
    );
  }
  return isKeeper ?? keeper;
}

function yahooDraftStatus(value: string | null): YahooDraftStatus {
  const normalized = value?.toLowerCase().replaceAll(/[\s_-]+/gu, "") ?? "";
  if (normalized === "predraft") return "predraft";
  if (normalized === "drafting" || normalized === "indraft") return "drafting";
  if (normalized === "postdraft") return "postdraft";
  return "unknown";
}

function checkedLeagueIdentity(
  league: XmlRecord,
  expectedLeagueKey: string | undefined,
): YahooLeagueKeyIdentity {
  const leagueKey = requiredText(league, "league_key", "league_key");
  const identity = yahooLeagueKeyIdentity(leagueKey, "league_key");
  const explicitLeagueId = requiredText(league, "league_id", "league_id");
  if (explicitLeagueId !== identity.leagueId) {
    throw new YahooXmlError(
      "INVALID_CONTRACT",
      "Yahoo league_id did not match its compound league_key",
    );
  }
  if (expectedLeagueKey !== undefined) {
    yahooLeagueKeyIdentity(expectedLeagueKey, "expected league_key");
    if (expectedLeagueKey !== leagueKey) {
      throw new YahooXmlError(
        "INVALID_CONTRACT",
        "Yahoo draft response belonged to a different league",
      );
    }
  }
  return identity;
}

/** Parse Yahoo's provider-shaped draft result collection without inferring draft completion. */
export function parseYahooDraftResultsXml(
  xml: string,
  options: ParseYahooDraftResultsOptions = {},
): YahooDraftResultsSnapshot {
  const parsed = parseYahooXml(xml);
  const content = fantasyContent(parsed);
  const leagueNode = findLeagueNode(parsed);
  const league = checkedLeagueIdentity(leagueNode, options.expectedLeagueKey);
  const providerStatus = boundedOptionalText(leagueNode.draft_status, "draft_status", 32);
  const status = yahooDraftStatus(providerStatus);
  const draftResults = child(leagueNode, "draft_results");
  const emptyPredraftCollection =
    status === "predraft" &&
    Object.hasOwn(leagueNode, "draft_results") &&
    text(leagueNode.draft_results) === null;
  if (draftResults === null && !emptyPredraftCollection) {
    throw new YahooXmlError("INVALID_CONTRACT", "Yahoo response omitted draft_results");
  }
  const declaredCount =
    draftResults === null
      ? 0
      : boundedOptionalInteger(
          draftResults,
          "@_count",
          "draft result count",
          0,
          MAX_YAHOO_DRAFT_RESULTS,
        );
  if (declaredCount === null) {
    throw new YahooXmlError("INVALID_CONTRACT", "Yahoo draft_results omitted its count");
  }
  const refreshRateSeconds = boundedOptionalInteger(
    content,
    "@_refresh_rate",
    "refresh_rate",
    1,
    3_600,
  );

  const picks: YahooDraftResultPick[] = [];
  for (const candidate of asArray(draftResults?.draft_result)) {
    const result = asRecord(candidate);
    if (result === null) {
      throw new YahooXmlError("INVALID_CONTRACT", "Yahoo returned an invalid draft_result");
    }
    const team = yahooTeamKeyIdentity(
      requiredText(result, "team_key", "draft result team_key"),
      league,
    );
    const player = yahooPlayerKeyIdentity(
      requiredText(result, "player_key", "draft result player_key"),
      league.gameKey,
      "draft result player_key",
    );
    const pick = boundedOptionalInteger(
      result,
      "pick",
      "draft result pick",
      1,
      MAX_YAHOO_DRAFT_RESULTS,
    );
    const round = boundedOptionalInteger(
      result,
      "round",
      "draft result round",
      1,
      MAX_YAHOO_DRAFT_RESULTS,
    );
    if (pick === null || round === null) {
      throw new YahooXmlError("INVALID_CONTRACT", "Yahoo draft_result omitted its pick or round");
    }
    const roundPick = boundedOptionalInteger(result, "round_pick", "draft result round_pick", 1);
    picks.push({
      pick,
      round,
      ...(roundPick === null ? {} : { roundPick }),
      teamKey: team.key,
      teamId: team.id,
      playerKey: player.key,
      playerId: player.id,
      cost: boundedOptionalInteger(result, "cost", "draft result cost", 0),
      keeper: explicitDraftKeeper(result),
    });
  }

  picks.sort((left, right) => left.pick - right.pick);
  if (picks.some((pick, index) => pick.pick !== index + 1)) {
    throw new YahooXmlError(
      "INVALID_CONTRACT",
      "Yahoo draft results contained duplicate or non-contiguous picks",
    );
  }
  if (new Set(picks.map((pick) => pick.playerKey)).size !== picks.length) {
    throw new YahooXmlError("INVALID_CONTRACT", "Yahoo draft results repeated a player_key");
  }
  if (picks.length > declaredCount) {
    throw new YahooXmlError(
      "INVALID_CONTRACT",
      "Yahoo draft results exceeded their declared count",
    );
  }
  if (picks.length === 0 && status === "postdraft") {
    throw new YahooXmlError(
      "INVALID_CONTRACT",
      "Yahoo returned empty draft results after the draft completed",
    );
  }
  if (picks.length > 0 && status === "predraft") {
    throw new YahooXmlError(
      "INVALID_CONTRACT",
      "Yahoo returned draft picks while the league was still predraft",
    );
  }

  const checksumSha256 = createHash("sha256")
    .update(
      JSON.stringify([
        "yahoo-draft-results-v1",
        league.leagueKey,
        status,
        providerStatus,
        declaredCount,
        picks.map((pick) => [
          pick.pick,
          pick.round,
          pick.roundPick ?? null,
          pick.teamKey,
          pick.playerKey,
          pick.cost,
          pick.keeper,
        ]),
      ]),
      "utf8",
    )
    .digest("hex");
  return {
    leagueKey: league.leagueKey,
    leagueId: league.leagueId,
    status,
    providerStatus,
    declaredCount,
    observedCount: picks.length,
    collectionComplete: declaredCount === picks.length,
    refreshRateSeconds,
    picks,
    checksumSha256,
  };
}

function normalizedPosition(value: unknown, label: string): string {
  const normalized = boundedRequiredText(value, label, 16).toUpperCase();
  if (!/^[A-Z0-9+./-]+$/u.test(normalized)) {
    throw new YahooXmlError("INVALID_CONTRACT", `Yahoo returned invalid ${label}`);
  }
  return normalized;
}

function yahooDraftPlayer(player: XmlRecord, gameKey: string): YahooDraftPlayer {
  const key = yahooPlayerKeyIdentity(
    requiredText(player, "player_key", "draft player player_key"),
    gameKey,
    "draft player player_key",
  );
  if (requiredText(player, "player_id", "draft player player_id") !== key.id) {
    throw new YahooXmlError(
      "INVALID_CONTRACT",
      "Yahoo draft player_id did not match its compound player_key",
    );
  }
  const fullName = boundedRequiredText(
    child(player, "name")?.full ?? player.name,
    "draft player name",
    200,
  );
  const providerEligiblePositions = asArray(child(player, "eligible_positions")?.position).map(
    (position) => normalizedPosition(position, "draft player eligible position"),
  );
  const displayPositions = (text(player.display_position) ?? "")
    .split(",")
    .map((position) => position.trim())
    .filter(Boolean)
    .map((position) => normalizedPosition(position, "draft player display position"));
  const eligiblePositions = [...new Set([...providerEligiblePositions, ...displayPositions])];
  if (eligiblePositions.length < 1 || eligiblePositions.length > 16) {
    throw new YahooXmlError("INVALID_CONTRACT", "Yahoo returned invalid draft player positions");
  }
  const primaryPosition =
    (Object.hasOwn(player, "primary_position")
      ? normalizedPosition(player.primary_position, "draft player primary position")
      : undefined) ?? eligiblePositions[0];
  if (primaryPosition === undefined) {
    throw new YahooXmlError(
      "INVALID_CONTRACT",
      "Yahoo response omitted draft player primary position",
    );
  }
  const proTeamAbbreviation = boundedOptionalText(
    player.editorial_team_abbr,
    "draft player team abbreviation",
    16,
  );
  return {
    playerKey: key.key,
    playerId: key.id,
    fullName,
    proTeamAbbreviation: proTeamAbbreviation?.toUpperCase() ?? null,
    primaryPosition,
    eligiblePositions,
  };
}

function checkedExpectedPlayerKeys(values: readonly string[], gameKey: string): readonly string[] {
  if (values.length < 1 || values.length > MAX_YAHOO_DRAFT_PLAYER_KEYS) {
    throw new TypeError(
      `Yahoo expected player keys must contain between 1 and ${MAX_YAHOO_DRAFT_PLAYER_KEYS} values`,
    );
  }
  if (new Set(values).size !== values.length) {
    throw new TypeError("Yahoo expected player keys cannot contain duplicates");
  }
  return values.map((value) => yahooPlayerKeyIdentity(value, gameKey, "expected player_key").key);
}

/** Parse a bounded league-scoped response that resolves exact Yahoo player keys. */
export function parseYahooDraftPlayersXml(
  xml: string,
  options: ParseYahooDraftPlayersOptions = {},
): YahooDraftPlayersSnapshot {
  const parsed = parseYahooXml(xml);
  const leagueNode = findLeagueNode(parsed);
  const league = checkedLeagueIdentity(leagueNode, options.expectedLeagueKey);
  const collection = child(leagueNode, "players");
  if (collection === null) {
    throw new YahooXmlError("INVALID_CONTRACT", "Yahoo response omitted players");
  }
  const declaredCount = boundedOptionalInteger(
    collection,
    "@_count",
    "player count",
    0,
    MAX_YAHOO_DRAFT_PLAYER_KEYS,
  );
  if (declaredCount === null) {
    throw new YahooXmlError("INVALID_CONTRACT", "Yahoo players omitted its count");
  }
  const players = asArray(collection.player).map((candidate) => {
    const player = asRecord(candidate);
    if (player === null) {
      throw new YahooXmlError("INVALID_CONTRACT", "Yahoo returned an invalid draft player");
    }
    return yahooDraftPlayer(player, league.gameKey);
  });
  if (new Set(players.map((player) => player.playerKey)).size !== players.length) {
    throw new YahooXmlError("INVALID_CONTRACT", "Yahoo draft players repeated a player_key");
  }
  if (players.length !== declaredCount) {
    throw new YahooXmlError(
      "INVALID_CONTRACT",
      "Yahoo draft player response did not match its declared count",
    );
  }

  let orderedPlayers = players;
  if (options.expectedPlayerKeys !== undefined) {
    const expectedKeys = checkedExpectedPlayerKeys(options.expectedPlayerKeys, league.gameKey);
    const byKey = new Map(players.map((player) => [player.playerKey, player]));
    if (
      byKey.size !== expectedKeys.length ||
      expectedKeys.some((playerKey) => !byKey.has(playerKey))
    ) {
      throw new YahooXmlError(
        "INVALID_CONTRACT",
        "Yahoo did not resolve the exact requested player keys",
      );
    }
    orderedPlayers = expectedKeys.map((playerKey) => {
      const resolved = byKey.get(playerKey);
      if (resolved === undefined) {
        throw new YahooXmlError(
          "INVALID_CONTRACT",
          "Yahoo did not resolve the exact requested player keys",
        );
      }
      return resolved;
    });
  }

  const checksumSha256 = createHash("sha256")
    .update(
      JSON.stringify([
        "yahoo-draft-players-v1",
        league.leagueKey,
        orderedPlayers.map((player) => [
          player.playerKey,
          player.fullName,
          player.proTeamAbbreviation,
          player.primaryPosition,
          player.eligiblePositions,
        ]),
      ]),
      "utf8",
    )
    .digest("hex");

  return {
    leagueKey: league.leagueKey,
    leagueId: league.leagueId,
    declaredCount,
    observedCount: orderedPlayers.length,
    collectionComplete: declaredCount === orderedPlayers.length,
    players: orderedPlayers,
    checksumSha256,
  };
}

/** Parse one bounded page from the logged-in user's Yahoo league collection. */
export function parseYahooLeaguePageXml(xml: string): YahooLeaguePage {
  const content = fantasyContent(parseYahooXml(xml));
  const discovered: ExternalLeagueRef[] = [];
  let collectionStart = 0;
  for (const userCandidate of asArray(child(content, "users")?.user)) {
    const user = asRecord(userCandidate);
    if (user === null) continue;
    for (const gameCandidate of asArray(child(user, "games")?.game)) {
      const game = asRecord(gameCandidate);
      const leagueCollection = child(game, "leagues");
      if (leagueCollection === null) continue;
      collectionStart = integer(leagueCollection["@_start"]) ?? collectionStart;
      for (const leagueCandidate of asArray(leagueCollection.league)) {
        const league = asRecord(leagueCandidate);
        if (league !== null) discovered.push(leagueReference(league));
      }
    }
  }

  const unique = new Map<string, ExternalLeagueRef>();
  for (const league of discovered) {
    const existing = unique.get(league.externalId);
    if (existing && JSON.stringify(existing) !== JSON.stringify(league)) {
      throw new YahooXmlError("INVALID_CONTRACT", "Yahoo returned conflicting league identities");
    }
    unique.set(league.externalId, league);
  }
  return { leagues: [...unique.values()], start: collectionStart, returned: discovered.length };
}

function normalizeDraftType(value: unknown): DraftType {
  const normalized =
    text(value)
      ?.toLowerCase()
      .replaceAll(/[\s_-]+/gu, "") ?? "";
  if (normalized.includes("auction") || normalized.includes("salarycap")) return "auction";
  if (
    normalized === "live" ||
    normalized.includes("snake") ||
    normalized.includes("livestandard") ||
    normalized.includes("autopick")
  )
    return "snake";
  if (normalized.includes("offline")) return "offline";
  return "unknown";
}

function normalizeWaiverType(settings: XmlRecord): WaiverType {
  if (truthy(settings.uses_faab)) return "faab";
  const normalized = [text(settings.waiver_type), text(settings.waiver_rule)]
    .filter((value): value is string => value !== null)
    .join(" ")
    .toLowerCase();
  if (normalized.includes("faab") || normalized.includes("budget")) return "faab";
  if (normalized.includes("reverse") || normalized.includes("worst")) return "reverse-standings";
  if (normalized.includes("continual") || normalized.includes("rolling")) return "rolling";
  if (normalized.includes("free agent") || normalized === "none") return "free-agent";
  return "unknown";
}

function normalizeRosterSlots(settings: XmlRecord): NormalizedRosterSlot[] {
  const positions = child(settings, "roster_positions")?.roster_position;
  const nonStarting = new Set(["BN", "IR", "IR+", "IL", "IL+", "NA"]);
  return asArray(positions).flatMap((candidate): NormalizedRosterSlot[] => {
    const record = asRecord(candidate);
    if (record === null) return [];
    const position = text(record.position);
    const count = integer(record.count);
    if (position === null || count === null || count < 1) return [];
    return [{ position, count, starting: !nonStarting.has(position.toUpperCase()) }];
  });
}

function normalizeScoring(settings: XmlRecord): NormalizedScoringRule[] {
  const categories = child(child(settings, "stat_categories"), "stats")?.stat;
  const categoryMetadata = new Map<
    string,
    { readonly name: string | null; readonly positionTypes: readonly string[] }
  >();
  for (const candidate of asArray(categories)) {
    const record = asRecord(candidate);
    if (record === null) continue;
    const statId = text(record.stat_id);
    const name = text(record.name);
    if (statId === null) continue;
    const positionTypes = new Set<string>();
    const directPositionType = text(record.position_type);
    if (directPositionType !== null) positionTypes.add(directPositionType);
    for (const positionCandidate of asArray(
      child(record, "stat_position_types")?.stat_position_type,
    )) {
      const positionType = text(asRecord(positionCandidate)?.position_type);
      if (positionType !== null) positionTypes.add(positionType);
    }
    categoryMetadata.set(statId, { name, positionTypes: [...positionTypes] });
  }

  const modifiers = child(child(settings, "stat_modifiers"), "stats")?.stat;
  return asArray(modifiers).flatMap((candidate): NormalizedScoringRule[] => {
    const record = asRecord(candidate);
    if (record === null) return [];
    const statId = text(record.stat_id);
    const points = numeric(record.value);
    if (statId === null || points === null) return [];
    const metadata = categoryMetadata.get(statId);
    return [
      {
        statId,
        name: metadata?.name ?? null,
        points,
        ...(metadata && metadata.positionTypes.length > 0
          ? { positionTypes: metadata.positionTypes }
          : {}),
      },
    ];
  });
}

function normalizeSettings(league: XmlRecord): NormalizedLeagueSettings {
  const settings = child(league, "settings") ?? league;
  return {
    teamCount: integer(league.num_teams) ?? integer(settings.num_teams) ?? 0,
    draftType: normalizeDraftType(settings.draft_type ?? league.draft_type),
    auctionBudget: numeric(settings.draft_budget),
    waiverType: normalizeWaiverType(settings),
    faabBudget: numeric(settings.waiver_budget),
    playoffTeamCount: integer(settings.num_playoff_teams),
    usesFractionalPoints: booleanSetting(settings.uses_fractional_points),
    usesNegativePoints: booleanSetting(settings.uses_negative_points),
    rosterSlots: normalizeRosterSlots(settings),
    scoringRules: normalizeScoring(settings),
  };
}

function playerName(player: XmlRecord): string | null {
  const name = child(player, "name");
  return text(name?.full) ?? text(player.name);
}

function splitPositions(value: unknown): string[] {
  const raw = text(value);
  if (raw === null) return [];
  return [
    ...new Set(
      raw
        .split(",")
        .map((position) => position.trim())
        .filter(Boolean),
    ),
  ];
}

function normalizePlayer(player: XmlRecord): NormalizedRosterPlayer | null {
  const externalId = text(player.player_key);
  const providerPlayerId = text(player.player_id);
  const fullName = playerName(player);
  if (externalId === null || providerPlayerId === null || fullName === null) return null;
  const eligiblePositions = splitPositions(player.display_position);
  const selectedPosition = child(player, "selected_position");
  const lineupSlot = text(selectedPosition?.position) ?? "BN";
  return {
    externalId,
    providerPlayerId,
    fullName,
    primaryPosition: eligiblePositions[0] ?? "UNKNOWN",
    eligiblePositions,
    lineupSlot,
    proTeamAbbreviation: text(player.editorial_team_abbr),
    status: text(player.status),
  };
}

function normalizeManager(manager: XmlRecord): NormalizedManager | null {
  const displayName = text(manager.nickname) ?? text(manager.display_name);
  if (displayName === null) return null;
  return {
    externalId: text(manager.manager_id) ?? text(manager.guid),
    displayName,
    // Yahoo's manager element carries one name only — the nickname above, which is whatever the
    // manager chose to be called. There is no separate given/family name to prefer over it.
    fullName: null,
    isCommissioner: truthy(manager.is_commissioner),
  };
}

function normalizeTeam(team: XmlRecord, warnings: string[]): NormalizedTeam | null {
  const externalId = text(team.team_key);
  const providerTeamId = text(team.team_id);
  const name = text(team.name);
  if (externalId === null || providerTeamId === null || name === null) {
    warnings.push("Skipped a Yahoo team missing team_key, team_id, or name");
    return null;
  }
  const managerRecords = asArray(child(team, "managers")?.manager)
    .map(asRecord)
    .filter((candidate): candidate is XmlRecord => candidate !== null);
  const managers = managerRecords.flatMap((record): NormalizedManager[] => {
    const normalized = normalizeManager(record);
    return normalized === null ? [] : [normalized];
  });
  const isCurrentUser = truthy(team.is_owned_by_current_login);
  const currentLoginManagers = managerRecords.filter((manager) => truthy(manager.is_current_login));
  const currentUserIsCommissioner =
    isCurrentUser && currentLoginManagers.length === 1
      ? truthy(currentLoginManagers[0]?.is_commissioner)
      : null;
  if (isCurrentUser && currentLoginManagers.length !== 1) {
    warnings.push(
      `Yahoo did not identify exactly one current manager on team ${externalId}; commissioner authority was not inferred`,
    );
  }
  const roster = child(team, "roster");
  const players = asArray(child(roster, "players")?.player).flatMap(
    (candidate): NormalizedRosterPlayer[] => {
      const record = asRecord(candidate);
      const normalized = record === null ? null : normalizePlayer(record);
      if (normalized === null) {
        warnings.push(
          `Skipped a Yahoo roster player with incomplete identity on team ${externalId}`,
        );
        return [];
      }
      return [normalized];
    },
  );
  const logo = firstRecord(child(team, "team_logos")?.team_logo);
  return {
    externalId,
    providerTeamId,
    name,
    abbreviation: text(team.team_abbr),
    url: text(team.url),
    logoUrl: text(logo?.url),
    isCurrentUser,
    currentUserIsCommissioner,
    managers,
    roster: players,
  };
}

function normalizeTeams(league: XmlRecord, warnings: string[]): NormalizedTeam[] {
  return asArray(child(league, "teams")?.team).flatMap((candidate): NormalizedTeam[] => {
    const record = asRecord(candidate);
    const normalized = record === null ? null : normalizeTeam(record, warnings);
    return normalized === null ? [] : [normalized];
  });
}

function rosterByTeam(
  league: XmlRecord,
  warnings: string[],
): Map<string, NormalizedRosterPlayer[]> {
  const result = new Map<string, NormalizedRosterPlayer[]>();
  for (const candidate of asArray(child(league, "teams")?.team)) {
    const team = asRecord(candidate);
    if (team === null) continue;
    const teamKey = text(team.team_key);
    if (teamKey === null) {
      warnings.push("Skipped a Yahoo roster whose team omitted team_key");
      continue;
    }
    const normalized = asArray(child(child(team, "roster"), "players")?.player).flatMap(
      (playerCandidate): NormalizedRosterPlayer[] => {
        const player = asRecord(playerCandidate);
        const value = player === null ? null : normalizePlayer(player);
        if (value === null) {
          warnings.push(
            `Skipped a Yahoo roster player with incomplete identity on team ${teamKey}`,
          );
          return [];
        }
        return [value];
      },
    );
    if (result.has(teamKey)) {
      throw new YahooXmlError("INVALID_CONTRACT", "Yahoo returned a duplicate team roster");
    }
    result.set(teamKey, normalized);
  }
  return result;
}

function nonNegative(value: unknown, label: string): number {
  const parsed = numeric(value);
  if (parsed === null || parsed < 0) {
    throw new YahooXmlError("INVALID_CONTRACT", `Yahoo returned invalid ${label}`);
  }
  return parsed;
}

function nonNegativeInteger(value: unknown, label: string): number {
  const parsed = integer(value);
  if (parsed === null || parsed < 0) {
    throw new YahooXmlError("INVALID_CONTRACT", `Yahoo returned invalid ${label}`);
  }
  return parsed;
}

function positive(value: unknown, label: string): number {
  const parsed = integer(value);
  if (parsed === null || parsed < 1) {
    throw new YahooXmlError("INVALID_CONTRACT", `Yahoo returned invalid ${label}`);
  }
  return parsed;
}

function normalizeStandings(
  league: XmlRecord,
  warnings: string[],
): NormalizedStandingsSnapshot | undefined {
  const standings = child(league, "standings");
  if (standings === null) {
    throw new YahooXmlError("INVALID_CONTRACT", "Yahoo standings response omitted standings");
  }
  const unresolvedEntries: (Omit<NormalizedStandingEntry, "rank"> & {
    readonly rank: number | null;
  })[] = [];
  for (const candidate of asArray(child(standings, "teams")?.team)) {
    const team = asRecord(candidate);
    if (team === null) continue;
    const teamExternalId = requiredText(team, "team_key", "standings team_key");
    const providerTeamId = requiredText(team, "team_id", "standings team_id");
    const teamStandings = child(team, "team_standings");
    if (teamStandings === null) {
      throw new YahooXmlError("INVALID_CONTRACT", "Yahoo standings omitted team_standings");
    }
    const totals = child(teamStandings, "outcome_totals");
    if (totals === null) {
      throw new YahooXmlError("INVALID_CONTRACT", "Yahoo standings omitted outcome_totals");
    }
    const streak = child(teamStandings, "streak");
    const rawStreak = text(streak?.type)?.toLowerCase();
    const streakType =
      rawStreak === "win" || rawStreak === "loss" || rawStreak === "tie" ? rawStreak : "none";
    const playoffSeed = integer(teamStandings.playoff_seed);
    if (playoffSeed !== null && playoffSeed < 1) {
      throw new YahooXmlError("INVALID_CONTRACT", "Yahoo returned invalid playoff seed");
    }
    const rawRank = integer(teamStandings.rank);
    if (rawRank !== null && rawRank < 0) {
      throw new YahooXmlError("INVALID_CONTRACT", "Yahoo returned invalid standings rank");
    }
    unresolvedEntries.push({
      teamExternalId,
      providerTeamId,
      // Yahoo represents an unranked preseason table as either an empty element or zero. Neither
      // is a real standing, so retain it as missing until the complete table can be assessed.
      rank: rawRank === 0 ? null : rawRank,
      playoffSeed,
      wins: nonNegativeInteger(totals.wins, "standings wins"),
      losses: nonNegativeInteger(totals.losses, "standings losses"),
      ties: nonNegativeInteger(totals.ties, "standings ties"),
      pointsFor: nonNegative(teamStandings.points_for, "standings points_for"),
      pointsAgainst: nonNegative(teamStandings.points_against, "standings points_against"),
      streakType,
      streakLength:
        streakType === "none" ? 0 : nonNegativeInteger(streak?.value, "standings streak"),
    });
  }
  if (unresolvedEntries.length < 2) {
    throw new YahooXmlError("INVALID_CONTRACT", "Yahoo standings were incomplete or duplicated");
  }

  const entriesWithMissingRank = unresolvedEntries.filter((entry) => entry.rank === null);
  if (entriesWithMissingRank.length > 0) {
    const whollyUnrankedPreseasonTable =
      entriesWithMissingRank.length === unresolvedEntries.length &&
      unresolvedEntries.every(
        (entry) =>
          entry.wins === 0 &&
          entry.losses === 0 &&
          entry.ties === 0 &&
          entry.pointsFor === 0 &&
          entry.pointsAgainst === 0 &&
          entry.streakType === "none" &&
          entry.streakLength === 0,
      );
    if (!whollyUnrankedPreseasonTable) {
      throw new YahooXmlError("INVALID_CONTRACT", "Yahoo returned invalid standings rank");
    }
    warnings.push("Yahoo has not ranked its preseason standings; no standings snapshot was stored");
    return undefined;
  }

  const entries = unresolvedEntries.map((entry): NormalizedStandingEntry => {
    if (entry.rank === null) {
      throw new YahooXmlError("INVALID_CONTRACT", "Yahoo returned invalid standings rank");
    }
    return { ...entry, rank: entry.rank };
  });
  if (new Set(entries.map((entry) => entry.rank)).size !== entries.length) {
    throw new YahooXmlError("INVALID_CONTRACT", "Yahoo standings were incomplete or duplicated");
  }
  return { asOfWeek: integer(league.current_week), entries };
}

function matchupStatus(value: unknown, hasOutcome: boolean): "scheduled" | "in-progress" | "final" {
  const normalized =
    text(value)
      ?.toLowerCase()
      .replaceAll(/[^a-z]/gu, "") ?? "";
  if (normalized.includes("post") || normalized.includes("final") || hasOutcome) return "final";
  if (
    normalized.includes("mid") ||
    normalized.includes("progress") ||
    normalized.includes("live")
  ) {
    return "in-progress";
  }
  return "scheduled";
}

function matchupTeam(team: XmlRecord): {
  readonly teamExternalId: string;
  readonly providerTeamId: string;
  readonly score: number | null;
} {
  return {
    teamExternalId: requiredText(team, "team_key", "matchup team_key"),
    providerTeamId: requiredText(team, "team_id", "matchup team_id"),
    score: numeric(child(team, "team_points")?.total),
  };
}

function normalizeMatchups(
  league: XmlRecord,
  leagueKey: string,
  warnings: string[],
): NormalizedMatchupSnapshot {
  const scoreboard = child(league, "scoreboard");
  if (scoreboard === null) {
    throw new YahooXmlError("INVALID_CONTRACT", "Yahoo scoreboard response omitted scoreboard");
  }
  const asOfWeek = integer(scoreboard.week) ?? integer(league.current_week);
  const matchups: NormalizedWeeklyMatchup[] = [];
  let sawScheduledZeroScore = false;
  let index = 0;
  for (const candidate of asArray(child(scoreboard, "matchups")?.matchup)) {
    const matchup = asRecord(candidate);
    if (matchup === null) continue;
    index += 1;
    const teams = asArray(child(matchup, "teams")?.team)
      .map(asRecord)
      .filter((team): team is XmlRecord => team !== null);
    if (teams.length !== 2 || !teams[0] || !teams[1]) {
      throw new YahooXmlError(
        "INVALID_CONTRACT",
        "Yahoo matchup did not contain exactly two teams",
      );
    }
    const home = matchupTeam(teams[0]);
    const away = matchupTeam(teams[1]);
    if (home.teamExternalId === away.teamExternalId) {
      throw new YahooXmlError("INVALID_CONTRACT", "Yahoo matchup repeated the same team");
    }
    const week = positive(matchup.week ?? scoreboard.week, "matchup week");
    const tied = truthy(matchup.is_tied);
    const winnerTeamExternalId = text(matchup.winner_team_key);
    const hasOutcome = tied || winnerTeamExternalId !== null;
    const status = matchupStatus(matchup.status, hasOutcome);
    if (
      status === "scheduled" &&
      ((home.score !== null && home.score !== 0) || (away.score !== null && away.score !== 0))
    ) {
      throw new YahooXmlError(
        "INVALID_CONTRACT",
        "Yahoo scheduled matchup unexpectedly included scores",
      );
    }
    if (status !== "scheduled" && (home.score === null || away.score === null)) {
      throw new YahooXmlError("INVALID_CONTRACT", "Yahoo active matchup omitted scores");
    }
    if (
      status === "final" &&
      ((tied && winnerTeamExternalId !== null) ||
        (!tied && ![home.teamExternalId, away.teamExternalId].includes(winnerTeamExternalId ?? "")))
    ) {
      throw new YahooXmlError("INVALID_CONTRACT", "Yahoo matchup outcome was inconsistent");
    }
    const providerMatchupId = text(matchup.matchup_id) ?? `${week}-${index}`;
    if (status === "scheduled" && (home.score === 0 || away.score === 0)) {
      sawScheduledZeroScore = true;
    }
    matchups.push({
      externalId: `${leagueKey}.w.${week}.m.${providerMatchupId}`,
      providerMatchupId,
      week,
      status,
      home: status === "scheduled" ? { ...home, score: null } : home,
      away: status === "scheduled" ? { ...away, score: null } : away,
      winnerTeamExternalId: status === "final" ? winnerTeamExternalId : null,
      tied: status === "final" ? tied : false,
    });
  }
  if (matchups.length < 1) {
    throw new YahooXmlError("INVALID_CONTRACT", "Yahoo scoreboard contained no matchups");
  }
  if (sawScheduledZeroScore) {
    warnings.push("Yahoo's scheduled matchup score placeholders were stored as unscored");
  }
  return { asOfWeek, matchups };
}

export interface YahooLeagueSyncArtifacts {
  readonly settingsXml: string;
  readonly teamsXml: string;
  readonly rostersXml: string;
  readonly standingsXml: string;
  readonly matchupsXml: string;
  readonly fetchedAt: Date;
  readonly endpoint: string;
}

/** Strictly join Yahoo's separate official read resources into one persistence contract. */
export function parseYahooLeagueSyncArtifacts(input: YahooLeagueSyncArtifacts): LeagueSyncBundle {
  const settingsLeague = findLeagueNode(parseYahooXml(input.settingsXml));
  const teamsLeague = findLeagueNode(parseYahooXml(input.teamsXml));
  const rostersLeague = findLeagueNode(parseYahooXml(input.rostersXml));
  const standingsLeague = findLeagueNode(parseYahooXml(input.standingsXml));
  const matchupsLeague = findLeagueNode(parseYahooXml(input.matchupsXml));
  const reference = leagueReference(settingsLeague);
  for (const resourceLeague of [teamsLeague, rostersLeague, standingsLeague, matchupsLeague]) {
    if (requiredText(resourceLeague, "league_key", "league_key") !== reference.externalId) {
      throw new YahooXmlError(
        "INVALID_CONTRACT",
        "Yahoo league resources belonged to different leagues",
      );
    }
  }

  const warnings: string[] = [];
  const normalizedTeams = normalizeTeams(teamsLeague, warnings);
  const settings = normalizeSettings(settingsLeague);
  if (settings.teamCount === 1 && normalizedTeams.length === 1) {
    throw new YahooXmlError(
      "LEAGUE_NOT_READY",
      "Yahoo league is not ready to sync until another team joins",
    );
  }
  if (
    normalizedTeams.length < 2 ||
    normalizedTeams.length !== new Set(normalizedTeams.map((team) => team.externalId)).size
  ) {
    throw new YahooXmlError("INVALID_CONTRACT", "Yahoo team resource was incomplete or duplicated");
  }

  const rosterMap = rosterByTeam(rostersLeague, warnings);
  const teams = normalizedTeams.map((team) => ({
    ...team,
    roster: rosterMap.get(team.externalId) ?? [],
  }));
  if (rosterMap.size !== teams.length || teams.some((team) => !rosterMap.has(team.externalId))) {
    throw new YahooXmlError("INVALID_CONTRACT", "Yahoo rosters did not match the league teams");
  }

  if (settings.teamCount !== teams.length) {
    throw new YahooXmlError("INVALID_CONTRACT", "Yahoo team count did not match the team resource");
  }
  const standings = normalizeStandings(standingsLeague, warnings);
  const matchups = normalizeMatchups(matchupsLeague, reference.externalId, warnings);
  const knownTeams = new Set(teams.map((team) => team.externalId));
  if (
    (standings !== undefined &&
      (standings.entries.length !== teams.length ||
        standings.entries.some((entry) => !knownTeams.has(entry.teamExternalId)))) ||
    matchups.matchups.some(
      (matchup) =>
        !knownTeams.has(matchup.home.teamExternalId) ||
        !knownTeams.has(matchup.away.teamExternalId),
    )
  ) {
    throw new YahooXmlError("INVALID_CONTRACT", "Yahoo weekly data referenced an unknown team");
  }

  const checksum = createHash("sha256");
  for (const xml of [
    input.settingsXml,
    input.teamsXml,
    input.rostersXml,
    input.standingsXml,
    input.matchupsXml,
  ]) {
    checksum
      .update(String(Buffer.byteLength(xml, "utf8")))
      .update(":")
      .update(xml);
  }
  return {
    schemaVersion: NORMALIZED_SYNC_SCHEMA_VERSION,
    provider: "yahoo",
    league: {
      externalId: reference.externalId,
      providerLeagueId: reference.providerLeagueId,
      provider: "yahoo",
      season: reference.season,
      name: reference.name,
      url: text(settingsLeague.url),
      currentWeek: integer(settingsLeague.current_week),
      settings,
    },
    teams,
    ...(standings === undefined ? {} : { standings }),
    matchups,
    provenance: {
      mode: "official-api",
      fetchedAt: input.fetchedAt.toISOString(),
      endpoint: input.endpoint,
      artifactChecksumSha256: checksum.digest("hex"),
    },
    warnings,
  };
}

export interface ParseYahooLeagueOptions {
  readonly fetchedAt?: Date;
  readonly endpoint?: string;
  readonly fallbackSeason?: number;
}

/** Normalize the league/settings/teams/rosters subset used by the first sync. */
export function parseYahooLeagueXml(
  xml: string,
  options: ParseYahooLeagueOptions = {},
): LeagueSyncBundle {
  const parsed = parseYahooXml(xml);
  const league = findLeagueNode(parsed);
  const leagueKey = requiredText(league, "league_key", "league_key");
  const providerLeagueId = requiredText(league, "league_id", "league_id");
  const leagueName = requiredText(league, "name", "league name");
  const season = integer(league.season) ?? options.fallbackSeason ?? null;
  if (season === null || season < 2000 || season > 2100) {
    throw new YahooXmlError("INVALID_CONTRACT", "Yahoo response omitted a valid league season");
  }
  const warnings: string[] = [];
  const teams = asArray(child(league, "teams")?.team).flatMap((candidate): NormalizedTeam[] => {
    const record = asRecord(candidate);
    const normalized = record === null ? null : normalizeTeam(record, warnings);
    return normalized === null ? [] : [normalized];
  });
  const parsedSettings = normalizeSettings(league);
  const settings =
    parsedSettings.teamCount === 0 && teams.length > 0
      ? { ...parsedSettings, teamCount: teams.length }
      : parsedSettings;
  if (parsedSettings.teamCount === 0 && teams.length > 0) {
    warnings.push("Yahoo omitted num_teams; inferred it from the returned teams");
  }
  if (settings.teamCount !== 0 && teams.length !== 0 && settings.teamCount !== teams.length) {
    warnings.push(
      `Yahoo returned ${teams.length} teams for a ${settings.teamCount}-team league; sync may be partial`,
    );
  }

  return {
    schemaVersion: NORMALIZED_SYNC_SCHEMA_VERSION,
    provider: "yahoo",
    league: {
      externalId: leagueKey,
      providerLeagueId,
      provider: "yahoo",
      season,
      name: leagueName,
      url: text(league.url),
      currentWeek: integer(league.current_week),
      settings,
    },
    teams,
    provenance: {
      mode: "official-api",
      fetchedAt: (options.fetchedAt ?? new Date()).toISOString(),
      endpoint: options.endpoint ?? null,
      artifactChecksumSha256: createHash("sha256").update(xml, "utf8").digest("hex"),
    },
    warnings,
  };
}
