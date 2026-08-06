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
 * Teams a member could pick for the claim `<select>`: their own already-claimed team (so a
 * provider-mapped confirmation still shows the target) plus every team nobody else has claimed.
 * Mirrors the filter the Overview "Your team identity" panel has always used.
 */
export function selectableClaimTeams(dashboard: LeagueDashboard): readonly LeagueTeamSnapshot[] {
  return dashboard.teams.filter(
    (team) => team.claimStatus === "current-user" || team.claimStatus === "available",
  );
}

/**
 * The team id to preselect in the claim `<select>`, in precedence order: an existing claim, then a
 * provider's own mapping (Yahoo tells us which team is the signed-in member's), then the first
 * unclaimed team, then nothing. Mirrors the precedence `LivePortfolio.loadDashboard` has always
 * applied in `dashboard-experience.tsx`.
 */
export function defaultClaimChoice(dashboard: LeagueDashboard): string {
  return (
    dashboard.membership.claimedFantasyTeamId ??
    (dashboard.teamClaim.mode === "provider-mapped" ? dashboard.teamClaim.claimableTeamId : null) ??
    dashboard.teams.find((team) => team.claimStatus === "available")?.id ??
    ""
  );
}

export type ClaimCalloutMode = "hidden" | "confirm-provider" | "choose";

/**
 * What (if anything) the shared claim callout should render for this dashboard:
 * - `"hidden"`: already claimed, the provider marked the claim `"unavailable"`, or there is nothing
 *   selectable to claim.
 * - `"confirm-provider"`: the provider (Yahoo) already mapped a team to this member; the callout only
 *   needs a confirmation, not a real choice.
 * - `"choose"`: a self-asserted claim — the member picks their team from the selectable list.
 */
export function claimCalloutMode(dashboard: LeagueDashboard): ClaimCalloutMode {
  if (!leagueIsUnclaimed(dashboard)) return "hidden";
  if (dashboard.teamClaim.mode === "unavailable") return "hidden";
  if (selectableClaimTeams(dashboard).length === 0) return "hidden";
  return dashboard.teamClaim.mode === "provider-mapped" ? "confirm-provider" : "choose";
}
