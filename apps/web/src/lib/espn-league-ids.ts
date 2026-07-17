export const maximumEspnBridgeLeagues = 32;

function parseEspnLeagueEntry(entry: string): string {
  if (/^\d{1,20}$/u.test(entry)) return entry;
  let url: URL;
  try {
    url = new URL(entry);
  } catch {
    throw new TypeError("Each ESPN league must be a league URL or a 1 to 20 digit ID.");
  }
  if (url.protocol !== "https:" || !url.hostname.endsWith("espn.com")) {
    throw new TypeError("Each ESPN league URL must point to espn.com.");
  }
  const candidate =
    url.searchParams.get("leagueId") ?? /\/leagues\/(\d{1,20})(?:\/|$)/u.exec(url.pathname)?.[1];
  if (!candidate || !/^\d{1,20}$/u.test(candidate)) {
    throw new TypeError("The ESPN league URL does not contain a numeric leagueId.");
  }
  return candidate;
}

export function parseEspnLeagueIds(value: string): readonly string[] {
  const leagueIds = value
    .split(/[\s,]+/u)
    .map((entry) => entry.trim())
    .filter(Boolean)
    .map(parseEspnLeagueEntry);
  if (leagueIds.length === 0) throw new TypeError("Enter at least one ESPN league ID.");
  if (leagueIds.length > maximumEspnBridgeLeagues) {
    throw new TypeError(`ESPN browser sync supports at most ${maximumEspnBridgeLeagues} leagues.`);
  }
  if (new Set(leagueIds).size !== leagueIds.length) {
    throw new TypeError("Remove duplicate ESPN league IDs.");
  }
  return leagueIds;
}
