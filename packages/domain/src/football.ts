export const NFL_POSITIONS = ["QB", "RB", "WR", "TE", "K", "DST", "DL", "LB", "DB", "IDP"] as const;

export type Position = (typeof NFL_POSITIONS)[number];

export const NFL_TEAMS = [
  "ARI",
  "ATL",
  "BAL",
  "BUF",
  "CAR",
  "CHI",
  "CIN",
  "CLE",
  "DAL",
  "DEN",
  "DET",
  "GB",
  "HOU",
  "IND",
  "JAX",
  "KC",
  "LV",
  "LAC",
  "LAR",
  "MIA",
  "MIN",
  "NE",
  "NO",
  "NYG",
  "NYJ",
  "PHI",
  "PIT",
  "SEA",
  "SF",
  "TB",
  "TEN",
  "WAS",
] as const;

export type NflTeam = (typeof NFL_TEAMS)[number];

/**
 * Converts source/provider aliases into the team-code vocabulary used by Laces Out contracts.
 * nflverse still emits `LA` for the Rams while fantasy providers use `LAR`.
 */
export function canonicalNflTeamCode(team: string): string {
  const normalized = team.trim().toUpperCase();
  return normalized === "LA" ? "LAR" : normalized;
}

export const PLAYER_STATUSES = [
  "ACTIVE",
  "QUESTIONABLE",
  "DOUBTFUL",
  "OUT",
  "IR",
  "PUP",
  "SUSPENDED",
  "NA",
  "UNKNOWN",
] as const;

export type PlayerStatus = (typeof PLAYER_STATUSES)[number];

/**
 * Returns the NFL season associated with an instant. January and February still belong to the
 * season that began in the prior calendar year; March starts the new league and draft year.
 */
export function currentNflSeason(now = new Date()): number {
  const timestamp = now.getTime();
  if (!Number.isFinite(timestamp)) throw new RangeError("NFL season date must be valid");
  const year = now.getUTCFullYear();
  return now.getUTCMonth() < 2 ? year - 1 : year;
}
