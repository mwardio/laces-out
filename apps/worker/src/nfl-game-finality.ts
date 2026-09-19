import { createHash } from "node:crypto";

import { canonicalNflTeamCode, NFL_TEAMS } from "@laces-out/domain";

export const NFL_GAME_FINALITY_VERSION = "espn-nfl-explicit-finality-v1";
export const NFL_GAME_FINALITY_SOURCE = "espn.nfl-scoreboard";
const MAX_BYTES = 2 * 1024 * 1024;
const ORIGIN = "https://site.api.espn.com";
const PATH = "/apis/site/v2/sports/football/nfl/scoreboard";

export interface NflGameFinalitySchedule {
  readonly nflverseGameId: string;
  readonly season: number;
  readonly week: number;
  readonly seasonType: "REG";
  readonly homeTeam: string;
  readonly awayTeam: string;
  readonly kickoffAt: string;
}
export interface NflGameFinalitySource {
  readonly sourceKey: typeof NFL_GAME_FINALITY_SOURCE;
  readonly version: typeof NFL_GAME_FINALITY_VERSION;
  readonly url: string;
  /** Exact provider bytes decoded as UTF-8, retained for reproducible verification. */
  readonly payload: string;
  readonly payloadChecksum: string;
  readonly observedAt: string;
}
export interface VerifiedNflGameFinality extends NflGameFinalitySchedule {
  readonly state: "verified";
  readonly sourceKey: typeof NFL_GAME_FINALITY_SOURCE;
  readonly version: typeof NFL_GAME_FINALITY_VERSION;
  readonly payloadChecksum: string;
  readonly observedAt: string;
  readonly providerEventId: string;
  readonly providerStatus: {
    readonly completed: true;
    readonly state: "post";
    readonly name: "STATUS_FINAL";
  };
}
export type NflGameFinalityResult =
  | VerifiedNflGameFinality
  | {
      readonly state: "unavailable";
      readonly nflverseGameId: string;
      readonly reason: string;
    };

function object(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}
function timestamp(value: unknown): number | null {
  if (typeof value !== "string" || !/^\d{4}-\d\d-\d\dT.*(?:Z|[+-]\d\d:\d\d)$/u.test(value))
    return null;
  const parsed = Date.parse(value);
  return Number.isFinite(parsed) ? parsed : null;
}
function team(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const canonical = canonicalNflTeamCode(value);
  return (NFL_TEAMS as readonly string[]).includes(canonical) ? canonical : null;
}
function hash(payload: string): string {
  return createHash("sha256").update(payload, "utf8").digest("hex");
}
function sourceUrl(season: number, week: number): string {
  if (
    !Number.isInteger(season) ||
    season < 2000 ||
    season > 2100 ||
    !Number.isInteger(week) ||
    week < 1 ||
    week > 18
  )
    throw new RangeError("NFL finality requires a supported regular-season week");
  return `${ORIGIN}${PATH}?dates=${season}&seasontype=2&week=${week}&limit=1000`;
}
function terminal(value: unknown): boolean {
  const status = object(object(value)?.type);
  return status?.completed === true && status.state === "post" && status.name === "STATUS_FINAL";
}

/**
 * Reconstruct affirmative provider status from an exact captured source. Neither scores, elapsed
 * time, nor a caller-supplied `completed` flag establishes finality. Source provenance must be
 * retained by the caller; a checksum authenticates bytes, not who supplied those bytes.
 */
export function verifyNflGameFinality(input: {
  readonly source: NflGameFinalitySource;
  readonly schedule: NflGameFinalitySchedule;
}): NflGameFinalityResult {
  const { source, schedule } = input;
  const unavailable = (reason: string): NflGameFinalityResult => ({
    state: "unavailable",
    nflverseGameId: schedule.nflverseGameId,
    reason,
  });
  const home = team(schedule.homeTeam),
    away = team(schedule.awayTeam);
  const kickoff = timestamp(schedule.kickoffAt),
    observed = timestamp(source.observedAt);
  const id = /^(\d{4})_(\d{2})_([A-Z]{2,3})_([A-Z]{2,3})$/u.exec(schedule.nflverseGameId);
  if (
    schedule.seasonType !== "REG" ||
    !home ||
    !away ||
    home === away ||
    kickoff === null ||
    observed === null ||
    !id ||
    Number(id[1]) !== schedule.season ||
    Number(id[2]) !== schedule.week ||
    team(id[3]) !== away ||
    team(id[4]) !== home
  )
    return unavailable("invalid-frozen-game-identity");
  let expectedUrl: string;
  try {
    expectedUrl = sourceUrl(schedule.season, schedule.week);
  } catch {
    return unavailable("unsupported-season-or-week");
  }
  if (
    source.sourceKey !== NFL_GAME_FINALITY_SOURCE ||
    source.version !== NFL_GAME_FINALITY_VERSION ||
    source.url !== expectedUrl ||
    typeof source.payload !== "string" ||
    Buffer.byteLength(source.payload, "utf8") > MAX_BYTES ||
    source.payloadChecksum !== hash(source.payload)
  )
    return unavailable("invalid-finality-source-binding");
  let body: Record<string, unknown> | null;
  try {
    body = object(JSON.parse(source.payload) as unknown);
  } catch {
    return unavailable("invalid-provider-json");
  }
  if (
    object(body?.season)?.year !== schedule.season ||
    object(body?.season)?.type !== 2 ||
    object(body?.week)?.number !== schedule.week ||
    !Array.isArray(body?.leagues) ||
    body.leagues.length !== 1 ||
    object(body.leagues[0])?.slug !== "nfl" ||
    !Array.isArray(body.events) ||
    body.events.length > 32
  )
    return unavailable("provider-season-or-week-mismatch");
  const seen = new Set<string>();
  const candidates: { event: Record<string, unknown>; competition: Record<string, unknown> }[] = [];
  for (const value of body.events) {
    const event = object(value);
    const eventId = event?.id;
    if (typeof eventId !== "string" || !/^\d{1,20}$/u.test(eventId) || seen.has(eventId))
      return unavailable("invalid-or-duplicate-provider-event");
    seen.add(eventId);
    if (!Array.isArray(event?.competitions) || event.competitions.length !== 1)
      return unavailable("invalid-provider-competition");
    const competition = object(event.competitions[0]);
    const competitors = competition?.competitors;
    if (competition?.id !== eventId || !Array.isArray(competitors) || competitors.length !== 2)
      return unavailable("invalid-provider-competitors");
    const homes = competitors.filter((c: unknown) => object(c)?.homeAway === "home");
    const aways = competitors.filter((c: unknown) => object(c)?.homeAway === "away");
    if (homes.length !== 1 || aways.length !== 1)
      return unavailable("ambiguous-provider-home-away");
    const providerHome = team(object(object(homes[0])?.team)?.abbreviation);
    const providerAway = team(object(object(aways[0])?.team)?.abbreviation);
    if (!providerHome || !providerAway || providerHome === providerAway)
      return unavailable("invalid-provider-team");
    if (providerHome === home && providerAway === away) candidates.push({ event, competition });
  }
  if (candidates.length !== 1) return unavailable("provider-game-missing-or-ambiguous");
  const { event, competition } = candidates[0]!;
  if (
    object(event.season)?.year !== schedule.season ||
    object(event.season)?.type !== 2 ||
    object(event.week)?.number !== schedule.week ||
    timestamp(event.date) !== kickoff ||
    timestamp(competition.date) !== kickoff
  )
    return unavailable("provider-game-does-not-match-frozen-schedule");
  if (!terminal(event.status) || !terminal(competition.status))
    return unavailable("game-not-explicitly-final");
  if (observed <= kickoff) return unavailable("terminal-observation-precedes-kickoff");
  return Object.freeze({
    ...schedule,
    homeTeam: home,
    awayTeam: away,
    state: "verified",
    sourceKey: NFL_GAME_FINALITY_SOURCE,
    version: NFL_GAME_FINALITY_VERSION,
    payloadChecksum: source.payloadChecksum,
    observedAt: new Date(observed).toISOString(),
    providerEventId: event.id as string,
    providerStatus: Object.freeze({ completed: true, state: "post", name: "STATUS_FINAL" }),
  });
}

/** Public, credential-free GET. Redirects, oversized responses and non-JSON content fail closed. */
export async function fetchNflGameFinalitySource(input: {
  readonly season: number;
  readonly week: number;
  readonly fetch?: typeof fetch;
  readonly now?: () => Date;
  readonly signal?: AbortSignal;
}): Promise<NflGameFinalitySource> {
  const url = sourceUrl(input.season, input.week);
  const timeout = AbortSignal.timeout(12_000);
  const response = await (input.fetch ?? fetch)(url, {
    method: "GET",
    redirect: "error",
    credentials: "omit",
    headers: { Accept: "application/json" },
    signal: input.signal ? AbortSignal.any([input.signal, timeout]) : timeout,
  });
  const contentType = response.headers.get("content-type")?.split(";")[0]?.trim().toLowerCase();
  const length = response.headers.get("content-length");
  if (
    !response.ok ||
    contentType !== "application/json" ||
    !response.body ||
    (length !== null && (!/^\d+$/u.test(length) || Number(length) > MAX_BYTES))
  ) {
    await response.body?.cancel();
    throw new Error("NFL finality source did not return a bounded JSON response");
  }
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let bytes = 0;
  try {
    for (;;) {
      const chunk = await reader.read();
      if (chunk.done) break;
      bytes += chunk.value.byteLength;
      if (bytes > MAX_BYTES) throw new Error("NFL finality response exceeds its size limit");
      chunks.push(chunk.value);
    }
  } catch (error) {
    await reader.cancel().catch(() => undefined);
    throw error;
  } finally {
    reader.releaseLock();
  }
  const payload = new TextDecoder("utf-8", { fatal: true }).decode(Buffer.concat(chunks));
  const observedAt = (input.now?.() ?? new Date()).toISOString();
  return Object.freeze({
    sourceKey: NFL_GAME_FINALITY_SOURCE,
    version: NFL_GAME_FINALITY_VERSION,
    url,
    payload,
    payloadChecksum: hash(payload),
    observedAt,
  });
}
