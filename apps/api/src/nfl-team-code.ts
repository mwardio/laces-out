/**
 * nflverse still identifies the Los Angeles Rams as `LA`, while Laces Out and its public
 * contracts use the NFL's canonical `LAR`. Keep that provider alias at the data boundary so
 * filters, player identities, schedule rows, and bye lookups all join on one code.
 */
export function canonicalNflTeamCode(team: string): string {
  const normalized = team.trim().toUpperCase();
  return normalized === "LA" ? "LAR" : normalized;
}

export function nflverseNflTeamCode(team: string): string {
  const canonical = canonicalNflTeamCode(team);
  return canonical === "LAR" ? "LA" : canonical;
}
