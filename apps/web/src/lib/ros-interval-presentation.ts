import { parseRosIntervalDescriptor } from "@laces-out/contracts";

/** Point-only forecasts are explicit; otherwise only a validated descriptor identifies a method. */
export function rosIntervalPresentation(value: unknown, forecastKind?: unknown): string {
  if (forecastKind === "point-only")
    return "These are point estimates of each player's remaining-season total. Calibrated ranges are not available for this forecast.";
  const descriptor = parseRosIntervalDescriptor(value);
  if (descriptor?.kind === "legacy-block-cqr")
    return "These ranges are widened using historical forecast errors. They remain provisional and do not establish a 70% chance for an individual player.";
  if (descriptor?.kind === "player-marginal")
    return "Historical forecast errors adjust each player's estimated 15th, 50th, and 85th percentiles. The central range targets 70% coverage. These estimates remain provisional and do not establish a 70% chance for an individual player.";
  return "These ranges are provisional estimates. The method used to produce them and its supporting evidence are unavailable.";
}
