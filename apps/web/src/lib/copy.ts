export const TOUR_BANNER = {
  title: "Locker room tour",
  detail: "Illustrative data. Nothing here affects a live league.",
} as const;

export const AUTH_ERRORS = {
  unavailable: "The private API can’t be reached right now.",
  rateLimit: "Too many attempts. Try again later.",
  tryAgain: "Try again in a moment.",
} as const;

export const CONNECT_LEAGUE_FIRST = "Connect a league first.";
export const BACK_TO_SIGN_IN = "Back to sign in";

export function providerLabel(provider: string | null | undefined): string {
  if (provider === "espn") return "ESPN";
  if (provider === "yahoo") return "Yahoo";
  if (provider === "sleeper") return "Sleeper";
  return "League host";
}

export function compactDate(value: string | null): string {
  if (!value) return "Not available";
  return new Intl.DateTimeFormat(undefined, {
    month: "short",
    day: "numeric",
    hour: "numeric",
    minute: "2-digit",
  }).format(new Date(value));
}
