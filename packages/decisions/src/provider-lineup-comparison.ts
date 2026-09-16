export interface ProviderProjectionSnapshot {
  readonly asOfWeek: number | null;
  readonly effectiveAt: Date;
  readonly artifact: Record<string, unknown>;
}

/** ESPN applied totals are already scored for this league; never blend them into model points. */
export function providerLineupComparison(input: {
  readonly snapshot?: ProviderProjectionSnapshot | undefined;
  readonly identities: readonly { playerId: string; source: string; externalId: string }[];
  readonly leagueSeasonId: string;
  readonly providerLeagueId: string;
  readonly season: number;
  readonly week: number | null;
  readonly now: Date;
}): { readonly observedAt: string; readonly points: ReadonlyMap<string, number> } | null {
  const row = input.snapshot;
  if (!row || input.week === null) return null;
  const age = input.now.getTime() - row.effectiveAt.getTime();
  const artifact = row.artifact;
  if (
    !Number.isFinite(age) ||
    age < 0 ||
    age > 24 * 3_600_000 ||
    row.asOfWeek !== input.week ||
    artifact.kind !== "weekly-box-scores" ||
    artifact.provider !== "espn" ||
    artifact.season !== input.season ||
    artifact.week !== input.week ||
    artifact.providerLeagueId !== input.providerLeagueId ||
    !Array.isArray(artifact.playerScores) ||
    artifact.playerScores.length > 1024
  )
    return null;
  const byProvider = new Map<string, number | null>();
  for (const value of artifact.playerScores) {
    if (!value || typeof value !== "object") continue;
    const score = value as Record<string, unknown>;
    if (
      typeof score.providerPlayerId !== "string" ||
      !/^-?\d{1,20}$/u.test(score.providerPlayerId) ||
      typeof score.projectedPoints !== "number" ||
      !Number.isFinite(score.projectedPoints)
    )
      continue;
    // Ambiguous duplicates are not evidence, even if their point estimates happen to agree.
    byProvider.set(
      score.providerPlayerId,
      byProvider.has(score.providerPlayerId) ? null : score.projectedPoints,
    );
  }
  const idsByPlayer = new Map<string, Set<string>>();
  const playersById = new Map<string, Set<string>>();
  const prefix = `${input.leagueSeasonId}:`;
  for (const identity of input.identities) {
    const id =
      identity.source === "espn"
        ? identity.externalId
        : identity.source === "espn-self-asserted" && identity.externalId.startsWith(prefix)
          ? identity.externalId.slice(prefix.length)
          : "";
    if (!/^-?\d{1,20}$/u.test(id)) continue;
    const ids = idsByPlayer.get(identity.playerId) ?? new Set<string>();
    ids.add(id);
    idsByPlayer.set(identity.playerId, ids);
    const players = playersById.get(id) ?? new Set<string>();
    players.add(identity.playerId);
    playersById.set(id, players);
  }
  const points = new Map<string, number>();
  for (const [player, ids] of idsByPlayer) {
    if (ids.size !== 1) continue;
    const id = [...ids][0]!;
    const value = byProvider.get(id);
    if (playersById.get(id)?.size === 1 && typeof value === "number") points.set(player, value);
  }
  return points.size ? { observedAt: row.effectiveAt.toISOString(), points } : null;
}
