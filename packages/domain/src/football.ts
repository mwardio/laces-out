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
