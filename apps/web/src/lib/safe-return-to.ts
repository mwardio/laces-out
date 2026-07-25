const localOrigin = "https://laces-out.invalid";

/**
 * Sign-in URL that returns the visitor to the page they were on. Without this a
 * session that expires mid-task drops the user on /app with no explanation.
 */
export function loginUrlForCurrentPath(): string {
  if (typeof window === "undefined") return "/login";
  const here = `${window.location.pathname}${window.location.search}`;
  const destination = safeReturnTo(here);
  return destination === "/app" ? "/login" : `/login?returnTo=${encodeURIComponent(destination)}`;
}

export function safeReturnTo(value: string | null): string {
  if (!value || !value.startsWith("/") || value.startsWith("//")) return "/app";
  try {
    const destination = new URL(value, localOrigin);
    if (destination.origin !== localOrigin || destination.pathname === "/login") return "/app";
    return `${destination.pathname}${destination.search}${destination.hash}`;
  } catch {
    return "/app";
  }
}
