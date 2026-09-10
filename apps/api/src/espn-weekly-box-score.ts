interface StoredPlayerScore {
  readonly providerTeamId: string;
  readonly starter: boolean;
  readonly actualPoints: number | null;
}

export interface EspnWeeklyBoxScoreMatchup {
  readonly providerMatchupId: string;
  readonly homeProviderTeamId: string;
  readonly awayProviderTeamId: string;
  readonly homeScore: number;
  readonly awayScore: number;
}

export interface EspnWeeklyBoxScoreArtifact {
  readonly week: number;
  readonly matchups: readonly EspnWeeklyBoxScoreMatchup[];
}

function record(value: unknown): Record<string, unknown> | null {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

function finiteNumber(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

function playerScore(value: unknown): StoredPlayerScore | null {
  const candidate = record(value);
  if (!candidate) return null;
  const actualPoints =
    candidate.actualPoints === null ? null : finiteNumber(candidate.actualPoints);
  if (
    typeof candidate.providerTeamId !== "string" ||
    candidate.providerTeamId.length === 0 ||
    typeof candidate.starter !== "boolean" ||
    (candidate.actualPoints !== null && actualPoints === null)
  ) {
    return null;
  }
  return {
    providerTeamId: candidate.providerTeamId,
    starter: candidate.starter,
    actualPoints,
  };
}

/**
 * Reads only the score fields from our own normalized ESPN supplemental artifact. Older stored
 * artifacts can contain a zero matchup total while their starter rows already contain live
 * actuals, so a non-zero sum of observed starter actuals repairs that known provider placeholder.
 */
export function parseEspnWeeklyBoxScoreArtifact(value: unknown): EspnWeeklyBoxScoreArtifact | null {
  const artifact = record(value);
  if (
    !artifact ||
    artifact.kind !== "weekly-box-scores" ||
    !Number.isInteger(artifact.week) ||
    (artifact.week as number) < 1 ||
    (artifact.week as number) > 30 ||
    !Array.isArray(artifact.matchups) ||
    !Array.isArray(artifact.playerScores)
  ) {
    return null;
  }

  const observedStarterTotals = new Map<string, number>();
  for (const value of artifact.playerScores) {
    const player = playerScore(value);
    if (!player) return null;
    if (!player.starter || player.actualPoints === null) continue;
    observedStarterTotals.set(
      player.providerTeamId,
      (observedStarterTotals.get(player.providerTeamId) ?? 0) + player.actualPoints,
    );
  }

  const matchups: EspnWeeklyBoxScoreMatchup[] = [];
  for (const value of artifact.matchups) {
    const matchup = record(value);
    const home = record(matchup?.home);
    const away = record(matchup?.away);
    const homeTotal = finiteNumber(home?.totalPoints);
    const awayTotal = finiteNumber(away?.totalPoints);
    if (
      !matchup ||
      typeof matchup.providerMatchupId !== "string" ||
      matchup.providerMatchupId.length === 0 ||
      !home ||
      !away ||
      typeof home.providerTeamId !== "string" ||
      home.providerTeamId.length === 0 ||
      typeof away.providerTeamId !== "string" ||
      away.providerTeamId.length === 0 ||
      homeTotal === null ||
      awayTotal === null
    ) {
      return null;
    }
    const observedHome = observedStarterTotals.get(home.providerTeamId);
    const observedAway = observedStarterTotals.get(away.providerTeamId);
    matchups.push({
      providerMatchupId: matchup.providerMatchupId,
      homeProviderTeamId: home.providerTeamId,
      awayProviderTeamId: away.providerTeamId,
      homeScore: homeTotal === 0 && observedHome !== undefined ? observedHome : homeTotal,
      awayScore: awayTotal === 0 && observedAway !== undefined ? observedAway : awayTotal,
    });
  }

  return { week: artifact.week as number, matchups };
}

export interface ProviderMatchupScoreRow {
  readonly providerMatchupId: string;
  readonly week: number;
  readonly homeProviderTeamId: string;
  readonly awayProviderTeamId: string;
  readonly homeScore: string | null;
  readonly awayScore: string | null;
  readonly effectiveAt?: Date;
}

/** Overlay only exact matchup/team identities; a drifting artifact never guesses by row order. */
export function mergeEspnWeeklyBoxScores<T extends ProviderMatchupScoreRow>(
  rows: readonly T[],
  artifact: EspnWeeklyBoxScoreArtifact | null,
  artifactEffectiveAt: Date,
): readonly T[] {
  if (!artifact) return rows;
  const byMatchup = new Map(
    artifact.matchups.map((matchup) => [matchup.providerMatchupId, matchup]),
  );
  return rows.map((row) => {
    if (row.week !== artifact.week) return row;
    const score = byMatchup.get(row.providerMatchupId);
    if (
      !score ||
      score.homeProviderTeamId !== row.homeProviderTeamId ||
      score.awayProviderTeamId !== row.awayProviderTeamId
    ) {
      return row;
    }
    const coreHasPoints = Number(row.homeScore ?? 0) !== 0 || Number(row.awayScore ?? 0) !== 0;
    if (row.effectiveAt && row.effectiveAt > artifactEffectiveAt && coreHasPoints) return row;
    return {
      ...row,
      homeScore: String(score.homeScore),
      awayScore: String(score.awayScore),
      ...(row.effectiveAt ? { effectiveAt: artifactEffectiveAt } : {}),
    };
  });
}
