const localOrigin = "https://laces-out.invalid";

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
