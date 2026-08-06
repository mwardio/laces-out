import { NFL_TEAMS } from "@laces-out/contracts";

/**
 * The team filter reuses the contract's canonical list so a dropdown can never offer an
 * abbreviation the API would reject.
 */
export const NFL_TEAM_CHOICES: readonly string[] = [...NFL_TEAMS].sort((left, right) =>
  left.localeCompare(right),
);
