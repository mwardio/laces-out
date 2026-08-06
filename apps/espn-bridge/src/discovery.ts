import { isValidSwid } from "./session-credential.js";
import { maximumLeagueCount, type DiscoveredEspnLeague } from "./protocol.js";

// ESPN's fan profile API lists every fantasy entry (team) on the signed-in
// account, including the league ("group") each entry belongs to. The endpoint
// is community-documented rather than official (RotoWire/FantasyPros-style
// league importers rely on it), so the parser below treats every field as
// optional and extracts leagues from whichever of the known shapes it finds.
export const FAN_API_ORIGIN = "https://fan.api.espn.com";

// Fantasy football's numeric game identifier in fan-profile entries.
const FANTASY_FOOTBALL_GAME_ID = 1;

const leagueIdPattern = /^\d{1,20}$/u;
const maximumNameLength = 120;

export interface DiscoveredLeagueSet {
  readonly leagues: readonly DiscoveredEspnLeague[];
  readonly seasonMatched: boolean;
}

export function fanProfileEndpoint(swid: string): URL {
  if (!isValidSwid(swid)) throw new TypeError("ESPN SWID cookie is invalid");
  return new URL(`/apis/v2/fans/${encodeURIComponent(swid)}`, FAN_API_ORIGIN);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function cleanName(value: unknown): string | undefined {
  if (typeof value !== "string") return undefined;
  const name = value.trim().replace(/\s+/gu, " ");
  if (name === "") return undefined;
  return name.slice(0, maximumNameLength);
}

function leagueIdFrom(value: unknown): string | undefined {
  if (typeof value === "number" && Number.isSafeInteger(value) && value > 0) {
    return String(value);
  }
  if (typeof value === "string" && leagueIdPattern.test(value.trim())) {
    return value.trim();
  }
  return undefined;
}

// Game markers vary between fan-profile revisions: a numeric `gameId`, a string
// game code, or an abbreviation such as "FFL2025". When a marker is present it
// must indicate football; when no marker exists at all the entry is kept — the
// league picker shows names and lets the member untick anything foreign, which
// beats silently hiding every league because ESPN renamed a field.
function isFootballEntry(
  entry: Record<string, unknown>,
  preference: Record<string, unknown>,
): boolean {
  const gameId = entry.gameId;
  if (typeof gameId === "number") return gameId === FANTASY_FOOTBALL_GAME_ID;
  if (typeof gameId === "string" && gameId.trim() !== "") {
    const code = gameId.trim().toLowerCase();
    return code === "ffl" || code === String(FANTASY_FOOTBALL_GAME_ID);
  }
  for (const marker of [entry.abbrev, entry.gameAbbrev, preference.abbrev]) {
    if (typeof marker === "string" && marker.trim() !== "") {
      return marker.trim().toLowerCase().includes("ffl");
    }
  }
  return true;
}

function seasonFrom(
  entry: Record<string, unknown>,
  preference: Record<string, unknown>,
  requestedSeason: number,
): number {
  for (const candidate of [entry.seasonId, preference.seasonId]) {
    if (
      typeof candidate === "number" &&
      Number.isSafeInteger(candidate) &&
      candidate >= 2000 &&
      candidate <= 2100
    ) {
      return candidate;
    }
  }
  // No parseable season on the entry: assume the requested one. The picker
  // shows the league name either way, and an unwanted league stays untickable.
  return requestedSeason;
}

function leaguesFromEntry(
  entry: Record<string, unknown>,
  preference: Record<string, unknown>,
  requestedSeason: number,
): DiscoveredEspnLeague[] {
  if (!isFootballEntry(entry, preference)) return [];
  const seasonId = seasonFrom(entry, preference, requestedSeason);
  const metadata = isRecord(entry.entryMetadata) ? entry.entryMetadata : {};
  const teamName = cleanName(metadata.teamName) ?? cleanName(entry.entryLocation);
  const groups = Array.isArray(entry.groups) ? entry.groups : [];
  const leagues: DiscoveredEspnLeague[] = [];
  for (const group of groups) {
    if (!isRecord(group)) continue;
    const leagueId = leagueIdFrom(group.groupId ?? group.id);
    if (leagueId === undefined) continue;
    const leagueName =
      cleanName(group.groupName) ?? cleanName(metadata.leagueName) ?? `ESPN league ${leagueId}`;
    leagues.push(
      teamName === undefined
        ? { leagueId, leagueName, seasonId }
        : { leagueId, leagueName, teamName, seasonId },
    );
  }
  return leagues;
}

/**
 * Extracts the account's fantasy-football leagues from a fan-profile payload.
 * Returns leagues for `requestedSeason` when any exist (`seasonMatched: true`);
 * otherwise falls back to everything found so the caller can say "no leagues
 * for {season}" while still offering what the account does have.
 */
export function parseFanProfileLeagues(
  payload: unknown,
  requestedSeason: number,
): DiscoveredLeagueSet {
  const preferences =
    isRecord(payload) && Array.isArray(payload.preferences) ? payload.preferences : [];
  const found = new Map<string, DiscoveredEspnLeague>();
  for (const preference of preferences) {
    if (!isRecord(preference)) continue;
    const metaData = isRecord(preference.metaData) ? preference.metaData : {};
    const entry = isRecord(metaData.entry)
      ? metaData.entry
      : isRecord(preference.entry)
        ? preference.entry
        : undefined;
    if (entry === undefined) continue;
    for (const league of leaguesFromEntry(entry, preference, requestedSeason)) {
      const key = `${league.leagueId}:${league.seasonId}`;
      if (!found.has(key)) found.set(key, league);
    }
  }
  const all = [...found.values()].sort((a, b) => a.leagueName.localeCompare(b.leagueName));
  const matching = all.filter((league) => league.seasonId === requestedSeason);
  const seasonMatched = matching.length > 0 || all.length === 0;
  const leagues = (seasonMatched ? matching : all).slice(0, maximumLeagueCount);
  return { leagues, seasonMatched };
}
