import { YAHOO_IOS_COMPLETION_URLS, yahooAuthorizeResponseSchema } from "@fantasy/contracts";

export type YahooNativeConnectNavigation =
  | { readonly kind: "authorization"; readonly url: string }
  | { readonly kind: "completion"; readonly url: string };

type FetchLike = (input: string | URL, init?: RequestInit) => Promise<Response>;

/** Starts only the server-owned iOS mode; no callback or return URL is accepted from this page. */
export async function requestYahooNativeAuthorization(
  apiBaseUrl: string,
  fetcher: FetchLike = fetch,
): Promise<YahooNativeConnectNavigation> {
  let response: Response;
  try {
    response = await fetcher(`${apiBaseUrl}/v1/connections/yahoo/authorize`, {
      method: "POST",
      credentials: "include",
      cache: "no-store",
      headers: { Accept: "application/json", "Content-Type": "application/json" },
      body: JSON.stringify({ returnMode: "ios-app" }),
    });
  } catch {
    return { kind: "completion", url: YAHOO_IOS_COMPLETION_URLS.unavailable };
  }

  if ([502, 503, 504].includes(response.status)) {
    return { kind: "completion", url: YAHOO_IOS_COMPLETION_URLS.unavailable };
  }
  if (!response.ok) {
    return { kind: "completion", url: YAHOO_IOS_COMPLETION_URLS.failed };
  }

  try {
    const authorization = yahooAuthorizeResponseSchema.parse(await response.json());
    return { kind: "authorization", url: authorization.authorizationUrl };
  } catch {
    return { kind: "completion", url: YAHOO_IOS_COMPLETION_URLS.failed };
  }
}
