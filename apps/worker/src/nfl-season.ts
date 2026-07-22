/**
 * Returns the NFL season associated with an instant. January and February still belong to the
 * season that began in the prior calendar year; March starts the new league/draft year.
 */
export function currentNflSeason(now = new Date()): number {
  const timestamp = now.getTime();
  if (!Number.isFinite(timestamp)) throw new RangeError("NFL season date must be valid");
  const year = now.getUTCFullYear();
  return now.getUTCMonth() < 2 ? year - 1 : year;
}
