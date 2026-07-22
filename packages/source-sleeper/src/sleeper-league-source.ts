import { createHash } from "node:crypto";

import { SleeperSourceError } from "./sleeper-source.js";

export const SLEEPER_API_BASE_URL = "https://api.sleeper.app/v1/" as const;
export const SLEEPER_LEAGUE_ATTRIBUTION = "League data provided by Sleeper" as const;
export const SLEEPER_LEAGUE_ATTRIBUTION_URL = "https://sleeper.com/" as const;
export const SLEEPER_DOCUMENTED_CALLS_PER_MINUTE = 1_000 as const;

const DEFAULT_TIMEOUT_MS = 15_000;
const MAX_TIMEOUT_MS = 60_000;
const SINGLE_RESPONSE_BYTES = 1024 * 1024;
const COLLECTION_RESPONSE_BYTES = 4 * 1024 * 1024;
const LARGE_COLLECTION_RESPONSE_BYTES = 8 * 1024 * 1024;

type FetchLike = (input: string | URL, init?: RequestInit) => Promise<Response>;
export type SleeperScalar = string | number | boolean | null;

export interface SleeperResponseProvenance {
  readonly provider: "sleeper";
  readonly endpoint: string;
  readonly fetchedAt: string;
  readonly checksumSha256: string;
}

export interface SleeperReadResult<T> {
  readonly data: T;
  readonly rowsRead: number;
  readonly rowsRejected: number;
  readonly provenance: SleeperResponseProvenance;
}

export interface SleeperUser {
  readonly userId: string;
  readonly username: string | null;
  readonly displayName: string | null;
  readonly avatarId: string | null;
}

export interface SleeperLeagueUser extends SleeperUser {
  readonly isCommissioner: boolean;
  readonly metadata: Readonly<Record<string, SleeperScalar>>;
}

export interface SleeperLeague {
  readonly leagueId: string;
  readonly draftId: string | null;
  readonly previousLeagueId: string | null;
  readonly name: string;
  readonly avatarId: string | null;
  readonly sport: "nfl";
  readonly season: string;
  readonly seasonType: string | null;
  readonly status: string | null;
  readonly totalRosters: number;
  readonly rosterPositions: readonly string[];
  readonly settings: Readonly<Record<string, number>>;
  readonly scoringSettings: Readonly<Record<string, number>>;
}

export interface SleeperRoster {
  readonly rosterId: number;
  readonly leagueId: string | null;
  readonly ownerId: string | null;
  readonly coOwnerIds: readonly string[];
  readonly playerIds: readonly string[];
  readonly starterIds: readonly string[];
  readonly reserveIds: readonly string[];
  readonly taxiIds: readonly string[];
  readonly settings: Readonly<Record<string, number>>;
  readonly metadata: Readonly<Record<string, SleeperScalar>>;
}

export interface SleeperMatchup {
  readonly rosterId: number;
  readonly matchupId: number | null;
  readonly points: number;
  readonly customPoints: number | null;
  readonly playerIds: readonly string[];
  readonly starterIds: readonly string[];
  readonly playerPoints: Readonly<Record<string, number>>;
  readonly starterPoints: readonly number[];
}

export interface SleeperTradedPick {
  readonly season: string;
  readonly round: number;
  readonly originalRosterId: number;
  readonly previousOwnerRosterId: number;
  readonly ownerRosterId: number;
}

export interface SleeperWaiverBudgetTransfer {
  readonly senderRosterId: number;
  readonly receiverRosterId: number;
  readonly amount: number;
}

export interface SleeperTransaction {
  readonly transactionId: string;
  readonly type: string;
  readonly status: string;
  readonly week: number;
  readonly creatorUserId: string | null;
  readonly createdAtMs: number | null;
  readonly statusUpdatedAtMs: number | null;
  readonly rosterIds: readonly number[];
  readonly consentingRosterIds: readonly number[];
  readonly adds: Readonly<Record<string, number>>;
  readonly drops: Readonly<Record<string, number>>;
  readonly draftPicks: readonly SleeperTradedPick[];
  readonly waiverBudgetTransfers: readonly SleeperWaiverBudgetTransfer[];
  readonly settings: Readonly<Record<string, SleeperScalar>>;
  readonly metadata: Readonly<Record<string, SleeperScalar>>;
}

export interface SleeperDraft {
  readonly draftId: string;
  readonly leagueId: string | null;
  readonly sport: "nfl";
  readonly season: string;
  readonly seasonType: string | null;
  readonly type: string;
  readonly status: string;
  readonly startTimeMs: number | null;
  readonly createdAtMs: number | null;
  readonly lastPickedAtMs: number | null;
  readonly settings: Readonly<Record<string, number>>;
  readonly metadata: Readonly<Record<string, SleeperScalar>>;
  readonly draftOrder: Readonly<Record<string, number>>;
  readonly slotToRosterId: Readonly<Record<string, number>>;
  readonly creatorUserIds: readonly string[];
}

export interface SleeperDraftPick {
  readonly draftId: string;
  readonly playerId: string;
  readonly pickedByUserId: string | null;
  readonly rosterId: number | null;
  readonly round: number;
  readonly draftSlot: number;
  readonly pickNumber: number;
  readonly isKeeper: boolean | null;
  readonly metadata: Readonly<Record<string, SleeperScalar>>;
}

interface RawResponse {
  readonly value: unknown;
  readonly provenance: SleeperResponseProvenance;
}

function object(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

function string(value: unknown, maximum = 256): string | null {
  if (typeof value !== "string") return null;
  const normalized = value.trim();
  return normalized.length > 0 && normalized.length <= maximum ? normalized : null;
}

function externalId(value: unknown): string | null {
  if (typeof value === "number" && Number.isSafeInteger(value) && value >= 0) return String(value);
  const normalized = string(value, 64);
  return normalized && /^[A-Za-z0-9._-]{1,64}$/u.test(normalized) ? normalized : null;
}

function providerId(value: unknown): string | null {
  const normalized = externalId(value);
  return normalized && /^\d{1,32}$/u.test(normalized) ? normalized : null;
}

function integer(value: unknown, minimum = 0, maximum = 1_000_000): number | null {
  const parsed =
    typeof value === "string" && /^-?\d{1,16}$/u.test(value.trim()) ? Number(value) : value;
  return typeof parsed === "number" &&
    Number.isSafeInteger(parsed) &&
    parsed >= minimum &&
    parsed <= maximum
    ? parsed
    : null;
}

function finiteNumber(value: unknown, minimum = -1_000_000, maximum = 1_000_000): number | null {
  return typeof value === "number" && Number.isFinite(value) && value >= minimum && value <= maximum
    ? value
    : null;
}

function timestamp(value: unknown): number | null {
  return integer(value, 0, 9_999_999_999_999);
}

function season(value: unknown): string | null {
  const normalized =
    typeof value === "number" && Number.isInteger(value) ? String(value) : string(value, 4);
  return normalized && /^(?:19|20|21)\d{2}$/u.test(normalized) ? normalized : null;
}

function scalar(value: unknown, maximumStringLength = 512): SleeperScalar | undefined {
  if (value === null || typeof value === "boolean") return value;
  if (typeof value === "number" && Number.isFinite(value) && Math.abs(value) <= 1_000_000_000) {
    return value;
  }
  return string(value, maximumStringLength) ?? undefined;
}

function scalarRecord(
  value: unknown,
  maximumEntries = 256,
): Readonly<Record<string, SleeperScalar>> {
  const source = object(value);
  if (!source || Object.keys(source).length > maximumEntries) return {};
  const result: Record<string, SleeperScalar> = {};
  for (const [key, raw] of Object.entries(source)) {
    if (!/^[A-Za-z0-9_.:-]{1,96}$/u.test(key)) continue;
    const parsed = scalar(raw);
    if (parsed !== undefined) result[key] = parsed;
  }
  return result;
}

function numberRecord(value: unknown, maximumEntries = 512): Readonly<Record<string, number>> {
  const source = object(value);
  if (!source || Object.keys(source).length > maximumEntries) return {};
  const result: Record<string, number> = {};
  for (const [key, raw] of Object.entries(source)) {
    if (!/^[A-Za-z0-9_.:-]{1,96}$/u.test(key)) continue;
    const parsed = finiteNumber(raw, -1_000_000_000, 1_000_000_000);
    if (parsed !== null) result[key] = parsed;
  }
  return result;
}

function idNumberRecord(value: unknown, maximumEntries = 256): Readonly<Record<string, number>> {
  const source = object(value);
  if (!source || Object.keys(source).length > maximumEntries) return {};
  const result: Record<string, number> = {};
  for (const [key, raw] of Object.entries(source)) {
    const parsedKey = externalId(key);
    const parsedValue = integer(raw, 0, 10_000);
    if (parsedKey && parsedValue !== null) result[parsedKey] = parsedValue;
  }
  return result;
}

function idArray(value: unknown, maximumRows = 1_000): readonly string[] {
  if (!Array.isArray(value) || value.length > maximumRows) return [];
  return value.flatMap((item) => {
    const parsed = externalId(item);
    return parsed ? [parsed] : [];
  });
}

function intArray(value: unknown, maximumRows = 256): readonly number[] {
  if (!Array.isArray(value) || value.length > maximumRows) return [];
  return value.flatMap((item) => {
    const parsed = integer(item, 0, 10_000);
    return parsed === null ? [] : [parsed];
  });
}

function stringArray(value: unknown, maximumRows = 128): readonly string[] {
  if (!Array.isArray(value) || value.length > maximumRows) return [];
  return value.flatMap((item) => {
    const parsed = string(item, 32)?.toUpperCase();
    return parsed && /^[A-Z0-9_/-]{1,32}$/u.test(parsed) ? [parsed] : [];
  });
}

function playerRosterMap(value: unknown): Readonly<Record<string, number>> {
  const source = object(value);
  if (!source || Object.keys(source).length > 1_000) return {};
  const result: Record<string, number> = {};
  for (const [key, raw] of Object.entries(source)) {
    const playerId = externalId(key);
    const rosterId = integer(raw, 0, 10_000);
    if (playerId && rosterId !== null) result[playerId] = rosterId;
  }
  return result;
}

function normalizeUser(value: unknown): SleeperUser | null {
  const source = object(value);
  const userId = providerId(source?.user_id);
  if (!source || !userId) return null;
  return {
    userId,
    username: string(source.username, 64),
    displayName: string(source.display_name, 160),
    avatarId: externalId(source.avatar),
  };
}

function normalizeLeagueUser(value: unknown): SleeperLeagueUser | null {
  const user = normalizeUser(value);
  const source = object(value);
  if (!user || !source) return null;
  return {
    ...user,
    isCommissioner: source.is_owner === true,
    metadata: scalarRecord(source.metadata, 64),
  };
}

function normalizeLeague(value: unknown): SleeperLeague | null {
  const source = object(value);
  const leagueId = providerId(source?.league_id);
  const leagueSeason = season(source?.season);
  const name = string(source?.name, 200);
  const totalRosters = integer(source?.total_rosters, 1, 64);
  if (!source || !leagueId || !leagueSeason || !name || totalRosters === null) return null;
  if (string(source.sport, 16)?.toLowerCase() !== "nfl") return null;
  return {
    leagueId,
    draftId: providerId(source.draft_id),
    previousLeagueId: providerId(source.previous_league_id),
    name,
    avatarId: externalId(source.avatar),
    sport: "nfl",
    season: leagueSeason,
    seasonType: string(source.season_type, 32),
    status: string(source.status, 32),
    totalRosters,
    rosterPositions: stringArray(source.roster_positions, 128),
    settings: numberRecord(source.settings),
    scoringSettings: numberRecord(source.scoring_settings),
  };
}

function normalizeRoster(value: unknown): SleeperRoster | null {
  const source = object(value);
  const rosterId = integer(source?.roster_id, 1, 10_000);
  if (!source || rosterId === null) return null;
  return {
    rosterId,
    leagueId: providerId(source.league_id),
    ownerId: providerId(source.owner_id),
    coOwnerIds: idArray(source.co_owners, 64).filter((id) => /^\d{1,32}$/u.test(id)),
    playerIds: idArray(source.players),
    starterIds: idArray(source.starters),
    reserveIds: idArray(source.reserve),
    taxiIds: idArray(source.taxi),
    settings: numberRecord(source.settings),
    metadata: scalarRecord(source.metadata, 128),
  };
}

function normalizeMatchup(value: unknown): SleeperMatchup | null {
  const source = object(value);
  const rosterId = integer(source?.roster_id, 1, 10_000);
  const points = finiteNumber(source?.points);
  if (!source || rosterId === null || points === null) return null;
  const rawStarterPoints = Array.isArray(source.starters_points) ? source.starters_points : [];
  return {
    rosterId,
    matchupId: integer(source.matchup_id, 1, 10_000),
    points,
    customPoints: source.custom_points === null ? null : finiteNumber(source.custom_points),
    playerIds: idArray(source.players),
    starterIds: idArray(source.starters),
    playerPoints: numberRecord(source.players_points, 1_000),
    starterPoints: rawStarterPoints.slice(0, 128).flatMap((item) => {
      const parsed = finiteNumber(item);
      return parsed === null ? [] : [parsed];
    }),
  };
}

function normalizeTradedPick(value: unknown): SleeperTradedPick | null {
  const source = object(value);
  const pickSeason = season(source?.season);
  const round = integer(source?.round, 1, 100);
  const originalRosterId = integer(source?.roster_id, 1, 10_000);
  const previousOwnerRosterId = integer(source?.previous_owner_id, 1, 10_000);
  const ownerRosterId = integer(source?.owner_id, 1, 10_000);
  if (
    !source ||
    !pickSeason ||
    round === null ||
    originalRosterId === null ||
    previousOwnerRosterId === null ||
    ownerRosterId === null
  ) {
    return null;
  }
  return { season: pickSeason, round, originalRosterId, previousOwnerRosterId, ownerRosterId };
}

function normalizeBudgetTransfer(value: unknown): SleeperWaiverBudgetTransfer | null {
  const source = object(value);
  const senderRosterId = integer(source?.sender, 1, 10_000);
  const receiverRosterId = integer(source?.receiver, 1, 10_000);
  const amount = finiteNumber(source?.amount, 0, 1_000_000);
  return source && senderRosterId !== null && receiverRosterId !== null && amount !== null
    ? { senderRosterId, receiverRosterId, amount }
    : null;
}

function normalizeTransaction(value: unknown): SleeperTransaction | null {
  const source = object(value);
  const transactionId = providerId(source?.transaction_id);
  const type = string(source?.type, 32);
  const status = string(source?.status, 32);
  const week = integer(source?.leg, 0, 25);
  if (!source || !transactionId || !type || !status || week === null) return null;
  const rawDraftPicks = Array.isArray(source.draft_picks) ? source.draft_picks : [];
  const rawBudget = Array.isArray(source.waiver_budget) ? source.waiver_budget : [];
  return {
    transactionId,
    type,
    status,
    week,
    creatorUserId: providerId(source.creator),
    createdAtMs: timestamp(source.created),
    statusUpdatedAtMs: timestamp(source.status_updated),
    rosterIds: intArray(source.roster_ids),
    consentingRosterIds: intArray(source.consenter_ids),
    adds: playerRosterMap(source.adds),
    drops: playerRosterMap(source.drops),
    draftPicks: rawDraftPicks.slice(0, 256).flatMap((item) => {
      const parsed = normalizeTradedPick(item);
      return parsed ? [parsed] : [];
    }),
    waiverBudgetTransfers: rawBudget.slice(0, 256).flatMap((item) => {
      const parsed = normalizeBudgetTransfer(item);
      return parsed ? [parsed] : [];
    }),
    settings: scalarRecord(source.settings, 128),
    metadata: scalarRecord(source.metadata, 128),
  };
}

function normalizeDraft(value: unknown): SleeperDraft | null {
  const source = object(value);
  const draftId = providerId(source?.draft_id);
  const draftSeason = season(source?.season);
  const type = string(source?.type, 32);
  const status = string(source?.status, 32);
  if (!source || !draftId || !draftSeason || !type || !status) return null;
  if (string(source.sport, 16)?.toLowerCase() !== "nfl") return null;
  return {
    draftId,
    leagueId: providerId(source.league_id),
    sport: "nfl",
    season: draftSeason,
    seasonType: string(source.season_type, 32),
    type,
    status,
    startTimeMs: timestamp(source.start_time),
    createdAtMs: timestamp(source.created),
    lastPickedAtMs: timestamp(source.last_picked),
    settings: numberRecord(source.settings),
    metadata: scalarRecord(source.metadata, 128),
    draftOrder: idNumberRecord(source.draft_order),
    slotToRosterId: idNumberRecord(source.slot_to_roster_id),
    creatorUserIds: idArray(source.creators, 64).filter((id) => /^\d{1,32}$/u.test(id)),
  };
}

function normalizeDraftPick(value: unknown): SleeperDraftPick | null {
  const source = object(value);
  const draftId = providerId(source?.draft_id);
  const playerId = externalId(source?.player_id);
  const round = integer(source?.round, 1, 100);
  const draftSlot = integer(source?.draft_slot, 1, 10_000);
  const pickNumber = integer(source?.pick_no, 1, 10_000);
  if (
    !source ||
    !draftId ||
    !playerId ||
    round === null ||
    draftSlot === null ||
    pickNumber === null
  ) {
    return null;
  }
  return {
    draftId,
    playerId,
    pickedByUserId: providerId(source.picked_by),
    rosterId: integer(source.roster_id, 1, 10_000),
    round,
    draftSlot,
    pickNumber,
    isKeeper: typeof source.is_keeper === "boolean" ? source.is_keeper : null,
    metadata: scalarRecord(source.metadata, 128),
  };
}

function parseArray<T>(
  value: unknown,
  maximumRows: number,
  normalize: (row: unknown) => T | null,
  description: string,
): { readonly data: readonly T[]; readonly rowsRead: number; readonly rowsRejected: number } {
  if (!Array.isArray(value) || value.length > maximumRows) {
    throw new SleeperSourceError("INVALID_JSON", `Sleeper ${description} row count is invalid`);
  }
  const data: T[] = [];
  let rowsRejected = 0;
  for (const row of value) {
    const parsed = normalize(row);
    if (parsed) data.push(parsed);
    else rowsRejected += 1;
  }
  return { data, rowsRead: value.length, rowsRejected };
}

function validateProviderId(value: string, label: string): string {
  if (!/^\d{1,32}$/u.test(value)) throw new RangeError(`${label} must be a Sleeper numeric ID`);
  return value;
}

function validateSeason(value: number): string {
  if (!Number.isSafeInteger(value) || value < 1999 || value > 2199) {
    throw new RangeError("Sleeper season must be between 1999 and 2199");
  }
  return String(value);
}

function validateWeek(value: number): string {
  if (!Number.isSafeInteger(value) || value < 0 || value > 25) {
    throw new RangeError("Sleeper week must be between 0 and 25");
  }
  return String(value);
}

function validateUserLookup(value: string): string {
  const normalized = value.trim();
  if (!/^[A-Za-z0-9_.-]{1,64}$/u.test(normalized)) {
    throw new RangeError("Sleeper user lookup must be a username or numeric user ID");
  }
  return normalized;
}

async function readBounded(response: Response, maximumBytes: number): Promise<string> {
  const declared = Number(response.headers.get("content-length"));
  if (Number.isFinite(declared) && declared > maximumBytes) {
    throw new SleeperSourceError("TOO_LARGE", "Sleeper response exceeded its size limit");
  }
  if (!response.body) return "";
  const reader = response.body.getReader();
  const chunks: Buffer[] = [];
  let total = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    if (!value) continue;
    total += value.byteLength;
    if (total > maximumBytes) {
      await reader.cancel().catch(() => undefined);
      throw new SleeperSourceError("TOO_LARGE", "Sleeper response exceeded its size limit");
    }
    chunks.push(Buffer.from(value));
  }
  return Buffer.concat(chunks, total).toString("utf8");
}

function parseJson(body: string): unknown {
  try {
    return JSON.parse(body) as unknown;
  } catch {
    throw new SleeperSourceError("INVALID_JSON", "Sleeper returned malformed JSON");
  }
}

export class SleeperLeagueSource {
  readonly #fetch: FetchLike;
  readonly #now: () => Date;
  readonly #timeoutMs: number;

  constructor(
    options: {
      readonly fetch?: FetchLike;
      readonly now?: () => Date;
      readonly timeoutMs?: number;
    } = {},
  ) {
    this.#fetch = options.fetch ?? globalThis.fetch;
    this.#now = options.now ?? (() => new Date());
    this.#timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
    if (
      !Number.isSafeInteger(this.#timeoutMs) ||
      this.#timeoutMs < 1_000 ||
      this.#timeoutMs > MAX_TIMEOUT_MS
    ) {
      throw new RangeError("Sleeper request timeout must be between 1,000 and 60,000 milliseconds");
    }
  }

  async #request(path: string, maximumBytes: number): Promise<RawResponse> {
    const endpoint = new URL(path, SLEEPER_API_BASE_URL);
    if (endpoint.origin !== "https://api.sleeper.app" || !endpoint.pathname.startsWith("/v1/")) {
      throw new RangeError("Sleeper endpoint escaped the official API origin");
    }
    let response: Response;
    try {
      response = await this.#fetch(endpoint, {
        method: "GET",
        headers: { Accept: "application/json" },
        redirect: "error",
        signal: AbortSignal.timeout(this.#timeoutMs),
      });
    } catch {
      throw new SleeperSourceError("NETWORK", "Sleeper league request failed", true);
    }
    if (!response.ok) {
      throw new SleeperSourceError(
        "UPSTREAM",
        `Sleeper league request returned status ${response.status}`,
        response.status === 408 || response.status === 429 || response.status >= 500,
      );
    }
    const body = await readBounded(response, maximumBytes);
    return {
      value: parseJson(body),
      provenance: {
        provider: "sleeper",
        endpoint: endpoint.toString(),
        fetchedAt: this.#now().toISOString(),
        checksumSha256: createHash("sha256").update(body, "utf8").digest("hex"),
      },
    };
  }

  async findUser(usernameOrUserId: string): Promise<SleeperReadResult<SleeperUser | null>> {
    const lookup = validateUserLookup(usernameOrUserId);
    const response = await this.#request(
      `user/${encodeURIComponent(lookup)}`,
      SINGLE_RESPONSE_BYTES,
    );
    if (response.value === null) {
      return { data: null, rowsRead: 0, rowsRejected: 0, provenance: response.provenance };
    }
    const user = normalizeUser(response.value);
    if (!user) throw new SleeperSourceError("INVALID_JSON", "Sleeper user response is invalid");
    return { data: user, rowsRead: 1, rowsRejected: 0, provenance: response.provenance };
  }

  async getUserLeagues(userId: string, leagueSeason: number) {
    const id = validateProviderId(userId, "Sleeper user ID");
    const year = validateSeason(leagueSeason);
    const response = await this.#request(
      `user/${id}/leagues/nfl/${year}`,
      COLLECTION_RESPONSE_BYTES,
    );
    const parsed = parseArray(response.value, 250, normalizeLeague, "user league");
    return { ...parsed, provenance: response.provenance };
  }

  async getLeague(leagueId: string): Promise<SleeperReadResult<SleeperLeague | null>> {
    const id = validateProviderId(leagueId, "Sleeper league ID");
    const response = await this.#request(`league/${id}`, SINGLE_RESPONSE_BYTES);
    if (response.value === null) {
      return { data: null, rowsRead: 0, rowsRejected: 0, provenance: response.provenance };
    }
    const league = normalizeLeague(response.value);
    if (!league || league.leagueId !== id) {
      throw new SleeperSourceError("INVALID_JSON", "Sleeper league response is invalid");
    }
    return { data: league, rowsRead: 1, rowsRejected: 0, provenance: response.provenance };
  }

  async getUserDrafts(userId: string, draftSeason: number) {
    const id = validateProviderId(userId, "Sleeper user ID");
    const year = validateSeason(draftSeason);
    const response = await this.#request(
      `user/${id}/drafts/nfl/${year}`,
      COLLECTION_RESPONSE_BYTES,
    );
    const parsed = parseArray(response.value, 250, normalizeDraft, "user draft");
    return { ...parsed, provenance: response.provenance };
  }

  async getLeagueUsers(leagueId: string) {
    const id = validateProviderId(leagueId, "Sleeper league ID");
    const response = await this.#request(`league/${id}/users`, COLLECTION_RESPONSE_BYTES);
    const parsed = parseArray(response.value, 256, normalizeLeagueUser, "league user");
    return { ...parsed, provenance: response.provenance };
  }

  async getLeagueRosters(leagueId: string) {
    const id = validateProviderId(leagueId, "Sleeper league ID");
    const response = await this.#request(`league/${id}/rosters`, COLLECTION_RESPONSE_BYTES);
    const parsed = parseArray(response.value, 256, normalizeRoster, "roster");
    const mismatched = parsed.data.some((roster) => roster.leagueId && roster.leagueId !== id);
    if (mismatched) {
      throw new SleeperSourceError("INVALID_JSON", "Sleeper roster response changed league IDs");
    }
    return { ...parsed, provenance: response.provenance };
  }

  async getMatchups(leagueId: string, week: number) {
    const id = validateProviderId(leagueId, "Sleeper league ID");
    const round = validateWeek(week);
    const response = await this.#request(
      `league/${id}/matchups/${round}`,
      COLLECTION_RESPONSE_BYTES,
    );
    const parsed = parseArray(response.value, 256, normalizeMatchup, "matchup");
    return { ...parsed, provenance: response.provenance };
  }

  async getTransactions(leagueId: string, week: number) {
    const id = validateProviderId(leagueId, "Sleeper league ID");
    const round = validateWeek(week);
    const response = await this.#request(
      `league/${id}/transactions/${round}`,
      LARGE_COLLECTION_RESPONSE_BYTES,
    );
    const parsed = parseArray(response.value, 5_000, normalizeTransaction, "transaction");
    return { ...parsed, provenance: response.provenance };
  }

  async getLeagueDrafts(leagueId: string) {
    const id = validateProviderId(leagueId, "Sleeper league ID");
    const response = await this.#request(`league/${id}/drafts`, COLLECTION_RESPONSE_BYTES);
    const parsed = parseArray(response.value, 250, normalizeDraft, "league draft");
    const mismatched = parsed.data.some((draft) => draft.leagueId && draft.leagueId !== id);
    if (mismatched) {
      throw new SleeperSourceError("INVALID_JSON", "Sleeper draft response changed league IDs");
    }
    return { ...parsed, provenance: response.provenance };
  }

  async getDraft(draftId: string): Promise<SleeperReadResult<SleeperDraft | null>> {
    const id = validateProviderId(draftId, "Sleeper draft ID");
    const response = await this.#request(`draft/${id}`, SINGLE_RESPONSE_BYTES);
    if (response.value === null) {
      return { data: null, rowsRead: 0, rowsRejected: 0, provenance: response.provenance };
    }
    const draft = normalizeDraft(response.value);
    if (!draft || draft.draftId !== id) {
      throw new SleeperSourceError("INVALID_JSON", "Sleeper draft response is invalid");
    }
    return { data: draft, rowsRead: 1, rowsRejected: 0, provenance: response.provenance };
  }

  async getDraftPicks(draftId: string) {
    const id = validateProviderId(draftId, "Sleeper draft ID");
    const response = await this.#request(`draft/${id}/picks`, LARGE_COLLECTION_RESPONSE_BYTES);
    const parsed = parseArray(response.value, 2_000, normalizeDraftPick, "draft pick");
    const mismatched = parsed.data.some((pick) => pick.draftId !== id);
    if (mismatched) {
      throw new SleeperSourceError("INVALID_JSON", "Sleeper pick response changed draft IDs");
    }
    return { ...parsed, provenance: response.provenance };
  }

  async getLeagueTradedPicks(leagueId: string) {
    const id = validateProviderId(leagueId, "Sleeper league ID");
    const response = await this.#request(`league/${id}/traded_picks`, COLLECTION_RESPONSE_BYTES);
    const parsed = parseArray(response.value, 2_000, normalizeTradedPick, "league traded pick");
    return { ...parsed, provenance: response.provenance };
  }

  async getDraftTradedPicks(draftId: string) {
    const id = validateProviderId(draftId, "Sleeper draft ID");
    const response = await this.#request(`draft/${id}/traded_picks`, COLLECTION_RESPONSE_BYTES);
    const parsed = parseArray(response.value, 2_000, normalizeTradedPick, "draft traded pick");
    return { ...parsed, provenance: response.provenance };
  }
}
