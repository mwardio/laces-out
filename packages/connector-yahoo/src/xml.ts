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
} from "@fantasy/connectors";
import { XMLParser, XMLValidator } from "fast-xml-parser";

export const MAX_YAHOO_XML_BYTES = 5 * 1024 * 1024;

export class YahooXmlError extends Error {
  public readonly code: "TOO_LARGE" | "UNSAFE_XML" | "INVALID_XML" | "INVALID_CONTRACT";

  public constructor(
    code: "TOO_LARGE" | "UNSAFE_XML" | "INVALID_XML" | "INVALID_CONTRACT",
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
  "team_logo",
  "matchup",
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
  const categoryNames = new Map<string, string>();
  for (const candidate of asArray(categories)) {
    const record = asRecord(candidate);
    if (record === null) continue;
    const statId = text(record.stat_id);
    const name = text(record.name);
    if (statId !== null && name !== null) categoryNames.set(statId, name);
  }

  const modifiers = child(child(settings, "stat_modifiers"), "stats")?.stat;
  return asArray(modifiers).flatMap((candidate): NormalizedScoringRule[] => {
    const record = asRecord(candidate);
    if (record === null) return [];
    const statId = text(record.stat_id);
    const points = numeric(record.value);
    if (statId === null || points === null) return [];
    return [{ statId, name: categoryNames.get(statId) ?? null, points }];
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
  const managers = asArray(child(team, "managers")?.manager).flatMap(
    (candidate): NormalizedManager[] => {
      const record = asRecord(candidate);
      const normalized = record === null ? null : normalizeManager(record);
      return normalized === null ? [] : [normalized];
    },
  );
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
    isCurrentUser: truthy(team.is_owned_by_current_login),
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

function normalizeStandings(league: XmlRecord): NormalizedStandingsSnapshot {
  const standings = child(league, "standings");
  if (standings === null) {
    throw new YahooXmlError("INVALID_CONTRACT", "Yahoo standings response omitted standings");
  }
  const entries: NormalizedStandingEntry[] = [];
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
    entries.push({
      teamExternalId,
      providerTeamId,
      rank: positive(teamStandings.rank, "standings rank"),
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
  if (entries.length < 2 || new Set(entries.map((entry) => entry.rank)).size !== entries.length) {
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

function normalizeMatchups(league: XmlRecord, leagueKey: string): NormalizedMatchupSnapshot {
  const scoreboard = child(league, "scoreboard");
  if (scoreboard === null) {
    throw new YahooXmlError("INVALID_CONTRACT", "Yahoo scoreboard response omitted scoreboard");
  }
  const asOfWeek = integer(scoreboard.week) ?? integer(league.current_week);
  const matchups: NormalizedWeeklyMatchup[] = [];
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
    if (status === "scheduled" && (home.score !== null || away.score !== null)) {
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
    matchups.push({
      externalId: `${leagueKey}.w.${week}.m.${providerMatchupId}`,
      providerMatchupId,
      week,
      status,
      home,
      away,
      winnerTeamExternalId: status === "final" ? winnerTeamExternalId : null,
      tied: status === "final" ? tied : false,
    });
  }
  if (matchups.length < 1) {
    throw new YahooXmlError("INVALID_CONTRACT", "Yahoo scoreboard contained no matchups");
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
  const rosterMap = rosterByTeam(rostersLeague, warnings);
  const teams = normalizeTeams(teamsLeague, warnings).map((team) => ({
    ...team,
    roster: rosterMap.get(team.externalId) ?? [],
  }));
  if (teams.length < 2 || teams.length !== new Set(teams.map((team) => team.externalId)).size) {
    throw new YahooXmlError("INVALID_CONTRACT", "Yahoo team resource was incomplete or duplicated");
  }
  if (rosterMap.size !== teams.length || teams.some((team) => !rosterMap.has(team.externalId))) {
    throw new YahooXmlError("INVALID_CONTRACT", "Yahoo rosters did not match the league teams");
  }

  const settings = normalizeSettings(settingsLeague);
  if (settings.teamCount !== teams.length) {
    throw new YahooXmlError("INVALID_CONTRACT", "Yahoo team count did not match the team resource");
  }
  const standings = normalizeStandings(standingsLeague);
  const matchups = normalizeMatchups(matchupsLeague, reference.externalId);
  const knownTeams = new Set(teams.map((team) => team.externalId));
  if (
    standings.entries.length !== teams.length ||
    standings.entries.some((entry) => !knownTeams.has(entry.teamExternalId)) ||
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
    standings,
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
