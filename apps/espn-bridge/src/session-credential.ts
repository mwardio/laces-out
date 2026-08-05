export interface EspnCookieCandidate {
  readonly name: string;
  readonly value: string;
  readonly domain: string;
}

export interface CapturedEspnSession {
  readonly ok: true;
  readonly swid: string;
  readonly espnS2: string;
  readonly capturedAt: string;
}

const swidPattern =
  /^\{[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}\}$/iu;

function espnCookieDomain(value: string): boolean {
  const domain = value.trim().toLowerCase().replace(/^\.+/u, "");
  return domain === "espn.com" || domain.endsWith(".espn.com");
}

function decodeOnce(value: string): string {
  try {
    return decodeURIComponent(value);
  } catch {
    return value;
  }
}

/**
 * Reduces Chrome's cookie records to the only two values the server-session grant accepts.
 * Callers use `chrome.cookies.get` for each exact name, so no unrelated cookie is returned to this
 * boundary or copied into extension storage.
 */
export function capturedEspnSessionFromCookies(
  swidCookie: EspnCookieCandidate | null,
  espnS2Cookie: EspnCookieCandidate | null,
  capturedAt: string,
): CapturedEspnSession | undefined {
  if (
    swidCookie?.name !== "SWID" ||
    espnS2Cookie?.name !== "espn_s2" ||
    !espnCookieDomain(swidCookie.domain) ||
    !espnCookieDomain(espnS2Cookie.domain) ||
    !Number.isFinite(Date.parse(capturedAt))
  ) {
    return undefined;
  }
  const swid = decodeOnce(swidCookie.value).trim();
  const espnS2 = decodeOnce(espnS2Cookie.value).trim();
  if (
    !swidPattern.test(swid) ||
    espnS2.length < 32 ||
    espnS2.length > 4096 ||
    /[\s;\p{Cc}]/u.test(espnS2)
  ) {
    return undefined;
  }
  return { ok: true, swid, espnS2, capturedAt };
}
