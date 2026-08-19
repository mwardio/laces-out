import type { LeagueAccessRole } from "@laces-out/contracts";
import type { LeagueMembershipRole } from "@laces-out/db";

/** Legacy values remain readable during rollout, but never cross a public API boundary. */
export type StoredLeagueAccessRole = LeagueMembershipRole | "member" | "manager" | "viewer";

/**
 * Collapses storage and ownership distinctions into the two capabilities users can understand.
 * Authorization must always run against the stored role before this display/transport mapping.
 */
export function publicLeagueAccessRole(role: StoredLeagueAccessRole): LeagueAccessRole {
  switch (role) {
    case "owner":
    case "commissioner":
      return "commissioner";
    case "member":
    case "manager":
    case "viewer":
      return "member";
    default:
      throw new TypeError("Unknown stored league access role");
  }
}
