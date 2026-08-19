/**
 * Pure selectors over the already-parsed `LeagueDashboard` contract (see `parseLeagueDashboard` in
 * `./api-client`), shared by every surface that needs to know whether a league still needs a team
 * claim and, if so, what to offer.
 *
 * No parsing lives here: callers already hold a validated `LeagueDashboard`, either preloaded (the
 * Overview page's own fetch) or self-fetched by `TeamClaimCallout`.
 */
import type { LeagueTeamSnapshot } from "@laces-out/contracts";

import type { LeagueDashboard } from "./api-client";

/**
 * True when nobody has claimed a team in this league yet, from either signal the dashboard carries:
 * no team is flagged `claimStatus === "current-user"`, and the membership record itself has no
 * `claimedFantasyTeamId`. Both must agree — either alone can lag a moment behind the other right
 * after a claim mutation.
 */
export function leagueIsUnclaimed(dashboard: LeagueDashboard): boolean {
  const hasClaimedTeam = dashboard.teams.some((team) => team.claimStatus === "current-user");
  return !hasClaimedTeam && dashboard.membership.claimedFantasyTeamId === null;
}

/**
 * Teams a member could pick for the manual fallback in Settings: their own already-claimed team
 * plus every team nobody else has claimed. Provider-mapped identities do not use this selector.
 */
export function selectableClaimTeams(dashboard: LeagueDashboard): readonly LeagueTeamSnapshot[] {
  return dashboard.teams.filter(
    (team) => team.claimStatus === "current-user" || team.claimStatus === "available",
  );
}

/**
 * The team id to preselect in Settings, in precedence order: an existing claim, then an exact
 * provider mapping, then the first unclaimed team, then nothing.
 */
export function defaultClaimChoice(dashboard: LeagueDashboard): string {
  return (
    dashboard.membership.claimedFantasyTeamId ??
    (dashboard.teamClaim.mode === "provider-mapped" ? dashboard.teamClaim.claimableTeamId : null) ??
    dashboard.teams.find((team) => team.claimStatus === "available")?.id ??
    ""
  );
}

/** Settings repairs an exact provider mismatch toward the provider target, never another team. */
export function settingsTeamChoice(dashboard: LeagueDashboard): string {
  return dashboard.teamClaim.mode === "provider-mapped"
    ? dashboard.teamClaim.claimableTeamId
    : defaultClaimChoice(dashboard);
}

export type ProviderMappedTeamState = "not-mapped" | "matched" | "available" | "conflict";

/**
 * Whether the provider's exact team match is already applied, can be applied, or belongs to a
 * different member. Keeping this decision here prevents Overview and Settings from disagreeing.
 */
export function providerMappedTeamState(dashboard: LeagueDashboard): ProviderMappedTeamState {
  if (dashboard.teamClaim.mode !== "provider-mapped") return "not-mapped";

  const mappedTeam = dashboard.teams.find(
    (team) => team.id === dashboard.teamClaim.claimableTeamId,
  );
  if (
    dashboard.membership.claimedFantasyTeamId === dashboard.teamClaim.claimableTeamId ||
    mappedTeam?.claimStatus === "current-user"
  ) {
    return "matched";
  }
  return mappedTeam?.claimStatus === "taken" ? "conflict" : "available";
}

/** The only team safe to present as the member's own in the Overview identity panel. */
export function resolvedMemberTeam(dashboard: LeagueDashboard): LeagueTeamSnapshot | undefined {
  const selectedTeam = dashboard.teams.find(
    (team) =>
      team.claimStatus === "current-user" || team.id === dashboard.membership.claimedFantasyTeamId,
  );
  if (selectedTeam) return selectedTeam;
  if (dashboard.teamClaim.mode !== "provider-mapped") return undefined;

  const mappedTeam = dashboard.teams.find(
    (team) => team.id === dashboard.teamClaim.claimableTeamId,
  );
  return mappedTeam?.claimStatus === "taken" ? undefined : mappedTeam;
}

export type ClaimCalloutMode = "hidden" | "choose";

/**
 * What (if anything) the shared claim callout should render for this dashboard:
 * - `"hidden"`: already claimed, the provider marked the claim `"unavailable"`, or there is nothing
 *   selectable to claim.
 * - `"choose"`: provider identity is unresolved, so the member is directed to the manual fallback
 *   in Settings.
 */
export function claimCalloutMode(dashboard: LeagueDashboard): ClaimCalloutMode {
  if (!leagueIsUnclaimed(dashboard)) return "hidden";
  if (dashboard.teamClaim.mode === "unavailable") return "hidden";
  if (dashboard.teamClaim.mode === "provider-mapped") return "hidden";
  if (selectableClaimTeams(dashboard).length === 0) return "hidden";
  return "choose";
}
