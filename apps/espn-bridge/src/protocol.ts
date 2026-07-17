export const maximumLeagueCount = 32;

export interface BridgeConfiguration {
  readonly apiBaseUrl: string;
  readonly deviceToken: string;
  readonly leagueIds: readonly string[];
  readonly season: number;
  readonly automaticSync: boolean;
}

export type BridgeLeagueResultState =
  "synced" | "espn-login-required" | "laces-out-auth-failed" | "error";

export interface BridgeLeagueResult {
  readonly leagueId: string;
  readonly state: BridgeLeagueResultState;
  readonly message: string;
}

export type BridgeStatusState =
  | "not-configured"
  | "ready"
  | "syncing"
  | "healthy"
  | "partial-failure"
  | "espn-login-required"
  | "laces-out-auth-failed"
  | "error";

export interface BridgeStatus {
  readonly configured: boolean;
  readonly state: BridgeStatusState;
  readonly message: string;
  readonly lastAttemptAt: string | null;
  readonly lastSuccessfulAt: string | null;
  readonly results: readonly BridgeLeagueResult[];
}

export type BridgeRequest =
  | { readonly type: "GET_STATUS" }
  | { readonly type: "CONFIGURE"; readonly configuration: BridgeConfiguration }
  | { readonly type: "SYNC_NOW" }
  | { readonly type: "DISCONNECT" };

export interface BridgeResponse {
  readonly ok: boolean;
  readonly status: BridgeStatus;
}

export interface BridgeResultSummary {
  readonly state: Extract<
    BridgeStatusState,
    "healthy" | "partial-failure" | "espn-login-required" | "laces-out-auth-failed" | "error"
  >;
  readonly message: string;
}

export const configurationStorageKey = "lacesOutEspnConfiguration";
export const statusStorageKey = "lacesOutEspnStatus";
export const syncAlarmName = "laces-out-espn-sync";

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

export function parseLeagueIds(value: string): readonly string[] {
  const leagueIds = value
    .split(/[\s,]+/u)
    .map((leagueId) => leagueId.trim())
    .filter(Boolean);
  return validateLeagueIds(leagueIds);
}

export function validateLeagueIds(value: unknown): readonly string[] {
  if (!Array.isArray(value) || value.length === 0) {
    throw new TypeError("Enter at least one ESPN league ID");
  }
  if (value.length > maximumLeagueCount) {
    throw new TypeError(`A bridge can sync at most ${maximumLeagueCount} ESPN leagues`);
  }
  const leagueIds = value.map((candidate) => {
    if (typeof candidate !== "string") throw new TypeError("ESPN league IDs must be text");
    const leagueId = candidate.trim();
    if (!/^\d{1,20}$/u.test(leagueId)) {
      throw new TypeError("Each ESPN league ID must contain 1 to 20 digits");
    }
    return leagueId;
  });
  if (new Set(leagueIds).size !== leagueIds.length) {
    throw new TypeError("ESPN league IDs must be unique");
  }
  return leagueIds;
}

export function validateBridgeConfiguration(value: unknown): BridgeConfiguration {
  if (!isRecord(value)) throw new TypeError("Bridge configuration is missing");
  const apiBaseUrl = typeof value.apiBaseUrl === "string" ? value.apiBaseUrl.trim() : "";
  const deviceToken = typeof value.deviceToken === "string" ? value.deviceToken.trim() : "";
  const leagueIds = validateLeagueIds(value.leagueIds);
  const season = value.season;
  const automaticSync = value.automaticSync;
  const apiUrl = new URL(apiBaseUrl);
  const localDevelopment =
    apiUrl.protocol === "http:" && ["localhost", "127.0.0.1"].includes(apiUrl.hostname);
  if (
    (apiUrl.protocol !== "https:" && !localDevelopment) ||
    apiUrl.username !== "" ||
    apiUrl.password !== "" ||
    apiUrl.search !== "" ||
    apiUrl.hash !== ""
  ) {
    throw new TypeError("Laces Out URL must be HTTPS or a loopback development URL");
  }
  if (deviceToken.length < 32 || deviceToken.length > 512) {
    throw new TypeError("Laces Out device token is invalid");
  }
  if (
    typeof season !== "number" ||
    !Number.isSafeInteger(season) ||
    season < 2000 ||
    season > 2100
  ) {
    throw new TypeError("ESPN season is invalid");
  }
  if (typeof automaticSync !== "boolean") throw new TypeError("Automatic sync setting is invalid");
  return {
    apiBaseUrl: apiUrl.origin,
    deviceToken,
    leagueIds,
    season,
    automaticSync,
  };
}

export function summarizeBridgeResults(
  results: readonly BridgeLeagueResult[],
): BridgeResultSummary {
  if (results.length === 0) throw new TypeError("Bridge sync results cannot be empty");
  const synced = results.filter((result) => result.state === "synced").length;
  const loginRequired = results.filter((result) => result.state === "espn-login-required").length;
  const pairingFailed = results.filter((result) => result.state === "laces-out-auth-failed").length;
  if (synced === results.length) {
    return {
      state: "healthy",
      message: `Synced ${synced} ESPN ${synced === 1 ? "league" : "leagues"}.`,
    };
  }
  if (synced > 0) {
    return {
      state: "partial-failure",
      message: `Synced ${synced} of ${results.length} ESPN leagues; ${results.length - synced} ${results.length - synced === 1 ? "needs" : "need"} attention.`,
    };
  }
  if (loginRequired > 0) {
    return {
      state: "espn-login-required",
      message:
        loginRequired === results.length
          ? "Sign in to ESPN in this browser, then sync again."
          : `${loginRequired} of ${results.length} leagues require ESPN sign-in; review the league results.`,
    };
  }
  if (pairingFailed > 0) {
    return {
      state: "laces-out-auth-failed",
      message: "Laces Out pairing was rejected. Create and configure a new bridge device token.",
    };
  }
  return {
    state: "error",
    message: `None of the ${results.length} ESPN leagues synced; review the league results.`,
  };
}
