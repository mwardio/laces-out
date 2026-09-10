interface LeagueChoice {
  readonly id: string;
}

/**
 * Resolve the league a page should open without letting a stale URL or preference
 * point at a league the member can no longer access.
 */
export function resolveInitialLeagueId(
  leagues: readonly LeagueChoice[],
  requestedLeagueId: string | null,
  defaultLeagueId: string | null,
): string {
  if (requestedLeagueId && leagues.some((league) => league.id === requestedLeagueId)) {
    return requestedLeagueId;
  }
  if (defaultLeagueId && leagues.some((league) => league.id === defaultLeagueId)) {
    return defaultLeagueId;
  }
  return leagues[0]?.id ?? "";
}
