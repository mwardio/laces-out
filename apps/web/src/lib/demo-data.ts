export type Provider = "Yahoo" | "ESPN";
export type DraftFormat = "Auction" | "Snake";
export type Position = "ALL" | "QB" | "RB" | "WR" | "TE";
export type PlayerPosition = Exclude<Position, "ALL"> | "K";

export interface LeagueSummary {
  id: string;
  shortName: string;
  name: string;
  teamName: string;
  provider: Provider;
  format: DraftFormat;
  role: "Commissioner" | "Member";
  accent: "lime" | "blue" | "orange" | "violet";
  record: string;
  place: string;
  opponent: string;
  projected: number;
  opponentProjected: number;
  lineupGain: number;
  freshness: string;
  dataState: "Fresh demo" | "Import due" | "Needs connection";
}

export interface DecisionAction {
  id: string;
  leagueId: string;
  kind: "lineup" | "waiver" | "trade";
  eyebrow: string;
  title: string;
  summary: string;
  impact: string;
  confidence: "High" | "Medium" | "Exploratory";
  rationale: string;
  freshness: string;
}

export interface ExposurePlayer {
  name: string;
  meta: string;
  leagues: number;
  projectedShare: number;
  direction: "up" | "flat" | "down";
}

export interface DraftPlayer {
  id: string;
  rank: number;
  name: string;
  position: PlayerPosition;
  team: string;
  bye: number;
  tier: number;
  projected: number;
  floor: number;
  ceiling: number;
  aav: number;
  fairValue: number;
  adp: number;
  availability: number;
  note: string;
  signal: "target" | "value" | "neutral" | "risk";
  /** Kept off the board until a search names the player. */
  hidden?: true;
}

export interface DraftTeam {
  id: string;
  name: string;
  abbreviation: string;
  budget: number;
  maxBid: number;
  rostered: number;
  slots: number;
  isUser?: true;
}

export interface DraftEvent {
  id: string;
  playerId: string;
  player: string;
  team: string;
  detail: string;
  kind: DraftFormat;
}

export const leagues: readonly LeagueSummary[] = [
  {
    id: "lake-effect",
    shortName: "LE",
    name: "Lake Effect Legends",
    teamName: "Fourth & Long",
    provider: "Yahoo",
    format: "Auction",
    role: "Commissioner",
    accent: "lime",
    record: "8–5",
    place: "3rd of 12",
    opponent: "Sunday Scaries",
    projected: 126.4,
    opponentProjected: 121.8,
    lineupGain: 4.7,
    freshness: "Sampled 8 min ago",
    dataState: "Needs connection",
  },
  {
    id: "north-loop",
    shortName: "NL",
    name: "North Loop Auction",
    teamName: "Budget Ballers",
    provider: "ESPN",
    format: "Auction",
    role: "Member",
    accent: "blue",
    record: "9–4",
    place: "2nd of 10",
    opponent: "Gridiron Dept.",
    projected: 115.4,
    opponentProjected: 111.2,
    lineupGain: 3.6,
    freshness: "Demo import · 2h old",
    dataState: "Import due",
  },
  {
    id: "old-friends",
    shortName: "OF",
    name: "Old Friends League",
    teamName: "Red Zone Radio",
    provider: "Yahoo",
    format: "Snake",
    role: "Member",
    accent: "orange",
    record: "7–6",
    place: "5th of 12",
    opponent: "The Waiver Wire",
    projected: 133.7,
    opponentProjected: 129.5,
    lineupGain: 2.3,
    freshness: "Sampled 11 min ago",
    dataState: "Needs connection",
  },
  {
    id: "work-league",
    shortName: "WK",
    name: "Monday Standup",
    teamName: "Ship It Sundays",
    provider: "ESPN",
    format: "Snake",
    role: "Member",
    accent: "violet",
    record: "10–3",
    place: "1st of 10",
    opponent: "Merge Conflict",
    projected: 114.5,
    opponentProjected: 110.2,
    lineupGain: 1.8,
    freshness: "Demo import · 1d old",
    dataState: "Import due",
  },
] as const;

export const decisions: readonly DecisionAction[] = [
  {
    id: "lineup-01",
    leagueId: "north-loop",
    kind: "lineup",
    eyebrow: "Lineup · FLEX",
    title: "Start Quentin Johnston over Mike Evans",
    summary: "The sample model finds a small projection edge without changing roster structure.",
    impact: "+1.5 pts",
    confidence: "High",
    rationale:
      "Johnston leads the displayed mean projection. Evans remains the more proven option, so the choice can flip when your matchup calls for a different risk profile.",
    freshness: "Projection snapshot · demo",
  },
  {
    id: "waiver-01",
    leagueId: "lake-effect",
    kind: "waiver",
    eyebrow: "Waiver · Add / drop",
    title: "Add Jaylen Wright, drop your DST2",
    summary: "A bench stash improves rest-of-season optionality without weakening a starting slot.",
    impact: "$7–11 FAAB",
    confidence: "Medium",
    rationale:
      "The recommendation values contingent workload and your excess defense slot. Bid guidance is illustrative until league budgets and transaction history are synced.",
    freshness: "Availability snapshot · demo",
  },
  {
    id: "trade-01",
    leagueId: "old-friends",
    kind: "trade",
    eyebrow: "Trade · Mutual fit",
    title: "Explore a WR-for-RB swap with Sunday Scaries",
    summary: "Your modeled WR surplus aligns with their RB depth and both teams gain flex options.",
    impact: "+2.8% wins",
    confidence: "Exploratory",
    rationale:
      "This is a candidate-generation preview, not a live offer. Real proposals require synchronized rosters, rest-of-season projections, and forced-drop analysis.",
    freshness: "Roster fit · demo",
  },
  {
    id: "lineup-02",
    leagueId: "work-league",
    kind: "lineup",
    eyebrow: "Lineup · Contingency",
    title: "Move the late-game questionable player to FLEX",
    summary: "Preserve replacement flexibility if the final injury designation changes.",
    impact: "Flexibility",
    confidence: "High",
    rationale:
      "The same players can start, but moving the late kickoff into FLEX leaves more replacement positions available. Kickoff and injury data shown here are sample data.",
    freshness: "Schedule logic · demo",
  },
] as const;

export const exposurePlayers: readonly ExposurePlayer[] = [
  { name: "Amon-Ra St. Brown", meta: "WR · DET", leagues: 3, projectedShare: 18, direction: "up" },
  { name: "Breece Hall", meta: "RB · NYJ", leagues: 2, projectedShare: 12, direction: "flat" },
  { name: "Trey McBride", meta: "TE · ARI", leagues: 2, projectedShare: 9, direction: "up" },
  { name: "Jayden Daniels", meta: "QB · WAS", leagues: 2, projectedShare: 8, direction: "down" },
] as const;

export const draftPlayers: readonly DraftPlayer[] = [
  {
    id: "p01",
    rank: 1,
    name: "Bijan Robinson",
    position: "RB",
    team: "ATL",
    bye: 5,
    tier: 1,
    projected: 296.4,
    floor: 245,
    ceiling: 347,
    aav: 61,
    fairValue: 64,
    adp: 1.8,
    availability: 2,
    note: "Three-down profile keeps both floor and ceiling intact.",
    signal: "target",
  },
  {
    id: "p02",
    rank: 2,
    name: "Ja'Marr Chase",
    position: "WR",
    team: "CIN",
    bye: 10,
    tier: 1,
    projected: 311.8,
    floor: 254,
    ceiling: 369,
    aav: 59,
    fairValue: 62,
    adp: 2.2,
    availability: 3,
    note: "Elite target ceiling; fits balanced and zero-RB builds.",
    signal: "target",
  },
  {
    id: "p03",
    rank: 3,
    name: "Jahmyr Gibbs",
    position: "RB",
    team: "DET",
    bye: 8,
    tier: 1,
    projected: 287.1,
    floor: 231,
    ceiling: 344,
    aav: 58,
    fairValue: 59,
    adp: 3.6,
    availability: 4,
    note: "Premium efficiency with some goal-line share uncertainty.",
    signal: "neutral",
  },
  {
    id: "p04",
    rank: 4,
    name: "CeeDee Lamb",
    position: "WR",
    team: "DAL",
    bye: 10,
    tier: 1,
    projected: 300.6,
    floor: 246,
    ceiling: 354,
    aav: 57,
    fairValue: 61,
    adp: 4.3,
    availability: 5,
    note: "Volume anchors a safe first-round profile.",
    signal: "value",
  },
  {
    id: "p05",
    rank: 5,
    name: "Justin Jefferson",
    position: "WR",
    team: "MIN",
    bye: 6,
    tier: 1,
    projected: 292.7,
    floor: 233,
    ceiling: 352,
    aav: 55,
    fairValue: 58,
    adp: 5.1,
    availability: 7,
    note: "Quarterback range widens an otherwise elite outlook.",
    signal: "neutral",
  },
  {
    id: "p06",
    rank: 6,
    name: "Puka Nacua",
    position: "WR",
    team: "LAR",
    bye: 8,
    tier: 2,
    projected: 279.5,
    floor: 222,
    ceiling: 337,
    aav: 49,
    fairValue: 54,
    adp: 8.7,
    availability: 11,
    note: "AAV discount creates room versus the sample fair price.",
    signal: "value",
  },
  {
    id: "p07",
    rank: 7,
    name: "Malik Nabers",
    position: "WR",
    team: "NYG",
    bye: 14,
    tier: 2,
    projected: 276.2,
    floor: 214,
    ceiling: 339,
    aav: 51,
    fairValue: 52,
    adp: 7.9,
    availability: 10,
    note: "Target dominance offsets some offense-level volatility.",
    signal: "neutral",
  },
  {
    id: "p08",
    rank: 8,
    name: "Breece Hall",
    position: "RB",
    team: "NYJ",
    bye: 9,
    tier: 2,
    projected: 264.8,
    floor: 205,
    ceiling: 325,
    aav: 50,
    fairValue: 53,
    adp: 8.1,
    availability: 10,
    note: "Strong receiving role, but backfield allocation adds risk.",
    signal: "risk",
  },
  {
    id: "p09",
    rank: 9,
    name: "Trey McBride",
    position: "TE",
    team: "ARI",
    bye: 8,
    tier: 1,
    projected: 231.9,
    floor: 193,
    ceiling: 271,
    aav: 34,
    fairValue: 39,
    adp: 18.2,
    availability: 35,
    note: "Scarcity premium grows if the room waits at tight end.",
    signal: "value",
  },
  {
    id: "p10",
    rank: 10,
    name: "Lamar Jackson",
    position: "QB",
    team: "BAL",
    bye: 7,
    tier: 1,
    projected: 381.7,
    floor: 326,
    ceiling: 438,
    aav: 29,
    fairValue: 31,
    adp: 22.4,
    availability: 44,
    note: "Elite weekly ceiling; replacement depth caps the bid.",
    signal: "neutral",
  },
  {
    id: "p11",
    rank: 11,
    name: "Josh Jacobs",
    position: "RB",
    team: "GB",
    bye: 5,
    tier: 3,
    projected: 238.2,
    floor: 190,
    ceiling: 286,
    aav: 35,
    fairValue: 41,
    adp: 19.7,
    availability: 38,
    note: "Workload-based value if the room overpays for Tier 1.",
    signal: "value",
  },
  {
    id: "p12",
    rank: 12,
    name: "Brock Bowers",
    position: "TE",
    team: "LV",
    bye: 8,
    tier: 1,
    projected: 226.4,
    floor: 183,
    ceiling: 270,
    aav: 36,
    fairValue: 37,
    adp: 20.1,
    availability: 39,
    note: "High route participation; price is close to full value.",
    signal: "neutral",
  },
  {
    id: "p00",
    rank: 265,
    name: "Ray Finkle",
    position: "K",
    team: "MIA",
    bye: 5,
    tier: 26,
    projected: 0,
    floor: 0,
    ceiling: 0,
    aav: 1,
    fairValue: 1,
    adp: 265.9,
    availability: 100,
    note: "Stetson '80. One career attempt, wide right. The laces were in.",
    signal: "risk",
    hidden: true,
  },
] as const;

const finkleAliases = ["ray finkle", "finkle", "einhorn"];

/** True once the search names the hidden kicker — either name works; Finkle is Einhorn. */
export function revealsRayFinkle(query: string): boolean {
  const normalized = query.trim().toLowerCase();
  return (
    normalized.length >= 4 &&
    finkleAliases.some((alias) => alias.includes(normalized) || normalized.includes(alias))
  );
}

export const draftTeams: readonly DraftTeam[] = [
  {
    id: "you",
    name: "Budget Ballers",
    abbreviation: "YOU",
    budget: 163,
    maxBid: 151,
    rostered: 2,
    slots: 16,
    isUser: true,
  },
  {
    id: "grid",
    name: "Gridiron Dept.",
    abbreviation: "GRD",
    budget: 146,
    maxBid: 133,
    rostered: 3,
    slots: 16,
  },
  {
    id: "scary",
    name: "Sunday Scaries",
    abbreviation: "SUN",
    budget: 171,
    maxBid: 158,
    rostered: 2,
    slots: 16,
  },
  {
    id: "two",
    name: "Two Minute Drill",
    abbreviation: "2MD",
    budget: 119,
    maxBid: 107,
    rostered: 4,
    slots: 16,
  },
  {
    id: "north",
    name: "North Stars",
    abbreviation: "NST",
    budget: 154,
    maxBid: 141,
    rostered: 3,
    slots: 16,
  },
  {
    id: "waiver",
    name: "Waiver Theory",
    abbreviation: "WVT",
    budget: 132,
    maxBid: 119,
    rostered: 4,
    slots: 16,
  },
] as const;

export const initialDraftEvents: readonly DraftEvent[] = [
  {
    id: "e1",
    playerId: "sold-1",
    player: "Amon-Ra St. Brown",
    team: "Gridiron Dept.",
    detail: "$54",
    kind: "Auction",
  },
  {
    id: "e2",
    playerId: "sold-2",
    player: "Saquon Barkley",
    team: "Budget Ballers",
    detail: "$37",
    kind: "Auction",
  },
  {
    id: "e3",
    playerId: "sold-3",
    player: "Nico Collins",
    team: "Two Minute Drill",
    detail: "$43",
    kind: "Auction",
  },
] as const;
