import {
  aiAnalysisResponseSchema,
  aiFeatureOutcomeWithToolsSchema,
  aiFeatureResponseSchema,
  aiProviderConfigurationSchema,
  aiToolUseSchema,
  aiProviderListResponseSchema,
  draftAnalysisResponseSchema,
  draftMarketBaselineSchema,
  draftMutationResponseSchema,
  draftSessionSnapshotSchema,
  espnBridgeDeviceListResponseSchema,
  espnBridgeDeviceResponseSchema,
  espnBridgePairingSessionResponseSchema,
  espnLeagueRefreshStatusSchema,
  espnSessionConnectionListSchema,
  inSeasonDecisionSnapshotSchema,
  jobAcceptedSchema,
  leagueAnalyticsSnapshotSchema,
  leagueDashboardSchema,
  leagueListResponseSchema,
  projectionPlayerListResponseSchema,
  projectionImportCommitResponseSchema,
  projectionImportPreviewResponseSchema,
  projectionSetListResponseSchema,
  pushConfigurationSchema,
  pushDeviceListResponseSchema,
  pushDeviceStatusSchema,
  pushTestResponseSchema,
  scheduleByesResponseSchema,
  scheduleEdgeMatrixResponseSchema,
  scheduleEdgeResponseSchema,
  scheduleResponseSchema,
  statsCenterPlayerDetailResponseSchema,
  statsCenterResponseSchema,
  tradeEvaluationResponseSchema,
  type AiAnalysisResponse,
  type AiFeatureName,
  type AiFeatureResponse,
  type AiProviderConfiguration,
  type AiProviderListResponse,
  type DraftAnalysisResponse,
  type DraftMutationResponse,
  type DraftMarketBaseline,
  type DraftSessionSnapshot,
  type InSeasonDecisionSnapshot,
  type EspnLeagueRefreshStatus,
  type EspnSessionConnectionList,
  type JobAccepted,
  type LeagueAnalyticsSnapshot,
  type LeagueDashboard,
  type LeagueListResponse,
  type ProjectionPlayerListResponse,
  type ProjectionImportCommitResponse,
  type ProjectionImportPreviewResponse,
  type ProjectionSetListResponse,
  type PushConfiguration,
  type PushDeviceStatus,
  type PushTestResponse,
  type ScheduleByesResponse,
  type ScheduleEdgeMatrixResponse,
  type ScheduleEdgeResponse,
  type ScheduleResponse,
  type StatsCenterPlayerDetailResponse,
  type StatsCenterResponse,
  type TradeEvaluationResponse,
} from "@fantasy/contracts";
import {
  dataQualityResponseSchema,
  unresolvedIdentityResponseSchema,
  type DataQualityResponse,
  type DataQualitySource,
  type UnresolvedIdentityResponse,
} from "@fantasy/contracts";
import {
  rankingListSchema,
  rankingVersionSchema,
  type RankingList,
  type RankingVersion,
} from "@fantasy/rankings/model";
import type { z } from "zod";

export { parseRosReleaseStatus, type RosReleaseStatus } from "./ros-release-status";
export { parseChangeFeed, prioritizeChangeEvents } from "./change-feed";
export type {
  ChangeEvent,
  ChangeEventFeedResponse,
  ChangeEventReceiptResponse,
} from "@fantasy/contracts";

const fallbackApiUrl = "http://localhost:4000";

const configuredApiBaseUrl = (process.env.NEXT_PUBLIC_API_URL ?? fallbackApiUrl).replace(
  /\/+$/,
  "",
);

/**
 * Where browser requests go. One image is served from more than one domain, so a base URL baked in
 * at build time would send every browser on the second domain cross-origin. In same-origin mode the
 * browser uses a relative `/v1` path instead and reaches whichever domain it loaded the app from;
 * the gateway in front of both domains routes `/v1` to the API. Anything that is not a browser —
 * server rendering, local development, tests — keeps the configured absolute base.
 */
export function resolveApiBaseUrl(
  configured: string,
  sameOrigin: string | undefined,
  inBrowser: boolean,
): string {
  return sameOrigin === "true" && inBrowser ? "" : configured;
}

export const apiBaseUrl = resolveApiBaseUrl(
  configuredApiBaseUrl,
  process.env.NEXT_PUBLIC_API_SAME_ORIGIN,
  typeof window !== "undefined",
);

/**
 * An absolute origin for the few places a relative path cannot work, such as a self-hosted pairing
 * value displayed to another client or a `new URL()` that has no base to resolve against.
 */
export function absoluteApiOrigin(): string {
  if (apiBaseUrl !== "") return apiBaseUrl;
  return typeof window === "undefined" ? configuredApiBaseUrl : window.location.origin;
}

export interface SessionUser {
  readonly id: string;
  readonly email: string;
  readonly displayName: string;
  readonly role: "member" | "admin";
}

export interface AuthenticatedSession {
  readonly authenticated: true;
  readonly user: SessionUser;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

function isSessionUser(value: unknown): value is SessionUser {
  return (
    isRecord(value) &&
    typeof value.id === "string" &&
    typeof value.email === "string" &&
    typeof value.displayName === "string" &&
    (value.role === "member" || value.role === "admin")
  );
}

export function parseAuthenticatedSession(value: unknown): AuthenticatedSession | null {
  if (!isRecord(value) || value.authenticated !== true || !isSessionUser(value.user)) return null;
  return { authenticated: true, user: value.user };
}

export type {
  AiAnalysisResponse,
  AiFeatureName,
  AiFeatureResponse,
  AiProviderConfiguration,
  AiProviderListResponse,
  DraftAnalysisResponse,
  DraftMutationResponse,
  DraftMarketBaseline,
  DraftSessionSnapshot,
  InSeasonDecisionSnapshot,
  EspnLeagueRefreshStatus,
  JobAccepted,
  LeagueAnalyticsSnapshot,
  LeagueDashboard,
  LeagueListResponse,
  ProjectionPlayerListResponse,
  ProjectionImportCommitResponse,
  ProjectionImportPreviewResponse,
  ProjectionSetListResponse,
  PushConfiguration,
  PushDeviceStatus,
  PushTestResponse,
  ScheduleByesResponse,
  ScheduleEdgeMatrixResponse,
  ScheduleEdgeResponse,
  ScheduleResponse,
  StatsCenterPlayerDetailResponse,
  StatsCenterResponse,
  RankingList,
  RankingVersion,
  DataQualityResponse,
  DataQualitySource,
  UnresolvedIdentityResponse,
};

export function parseAiProviderList(value: unknown): AiProviderListResponse | null {
  const result = aiProviderListResponseSchema.safeParse(value);
  return result.success ? result.data : null;
}

export function parseAiProviderConfiguration(value: unknown): AiProviderConfiguration | null {
  const result = aiProviderConfigurationSchema.safeParse(value);
  return result.success ? result.data : null;
}

export function parseAiAnalysis(value: unknown): AiAnalysisResponse | null {
  const result = aiAnalysisResponseSchema.safeParse(value);
  return result.success ? result.data : null;
}

/**
 * The feature response, widened with tool-use provenance.
 *
 * Parsed with the extended schema rather than the base one: `aiFeatureResponseSchema` is strict, so
 * a response carrying `toolUse` would fail the base parse and silently blank the Film Room.
 */
const aiFeatureWithToolUseResponseSchema = aiFeatureResponseSchema.extend({
  outcome: aiFeatureOutcomeWithToolsSchema,
  toolUse: aiToolUseSchema,
});

export type AiFeatureWithToolUseResponse = z.infer<typeof aiFeatureWithToolUseResponseSchema>;

export function parseAiFeature(value: unknown): AiFeatureWithToolUseResponse | null {
  const result = aiFeatureWithToolUseResponseSchema.safeParse(value);
  return result.success ? result.data : null;
}

export function parseDraftSession(value: unknown): DraftSessionSnapshot | null {
  const result = draftSessionSnapshotSchema.safeParse(value);
  return result.success ? result.data : null;
}

export function parseDraftMutation(value: unknown): DraftMutationResponse | null {
  const result = draftMutationResponseSchema.safeParse(value);
  return result.success ? result.data : null;
}

export function parseDraftMarketBaseline(value: unknown): DraftMarketBaseline | null {
  const result = draftMarketBaselineSchema.safeParse(value);
  return result.success ? result.data : null;
}

export function parseDraftAnalysis(value: unknown): DraftAnalysisResponse | null {
  const result = draftAnalysisResponseSchema.safeParse(value);
  return result.success ? result.data : null;
}

/**
 * Bridge responses are validated with the same schemas the API serves them through, so a shape
 * change fails in one place instead of silently rendering `undefined` in the device list.
 */
export type EspnBridgeDeviceStatus = ReturnType<
  typeof espnBridgeDeviceListResponseSchema.parse
>["devices"][number];
export type EspnBridgeDeviceCredential = ReturnType<typeof espnBridgeDeviceResponseSchema.parse>;
export type EspnBridgePairingSession = ReturnType<
  typeof espnBridgePairingSessionResponseSchema.parse
>;

export function parseEspnBridgeDeviceList(
  value: unknown,
): readonly EspnBridgeDeviceStatus[] | null {
  const result = espnBridgeDeviceListResponseSchema.safeParse(value);
  return result.success ? result.data.devices : null;
}

export function parseEspnBridgeDeviceCredential(value: unknown): EspnBridgeDeviceCredential | null {
  const result = espnBridgeDeviceResponseSchema.safeParse(value);
  return result.success ? result.data : null;
}

export function parseEspnBridgePairingSession(value: unknown): EspnBridgePairingSession | null {
  const result = espnBridgePairingSessionResponseSchema.safeParse(value);
  return result.success ? result.data : null;
}

export function parseLeagueListResponse(value: unknown): LeagueListResponse | null {
  const result = leagueListResponseSchema.safeParse(value);
  return result.success ? result.data : null;
}

export function parseLeagueDashboard(value: unknown): LeagueDashboard | null {
  const result = leagueDashboardSchema.safeParse(value);
  return result.success ? result.data : null;
}

export function parseEspnLeagueRefreshStatus(value: unknown): EspnLeagueRefreshStatus | null {
  const result = espnLeagueRefreshStatusSchema.safeParse(value);
  return result.success ? result.data : null;
}

export type { EspnSessionConnectionList };

export function parseEspnSessionConnectionList(value: unknown): EspnSessionConnectionList | null {
  const result = espnSessionConnectionListSchema.safeParse(value);
  return result.success ? result.data : null;
}

export function parseInSeasonDecisionSnapshot(value: unknown): InSeasonDecisionSnapshot | null {
  const result = inSeasonDecisionSnapshotSchema.safeParse(value);
  return result.success ? result.data : null;
}

export function parseTradeEvaluationResponse(value: unknown): TradeEvaluationResponse | null {
  const result = tradeEvaluationResponseSchema.safeParse(value);
  return result.success ? result.data : null;
}

export function parseJobAccepted(value: unknown): JobAccepted | null {
  const result = jobAcceptedSchema.safeParse(value);
  return result.success ? result.data : null;
}

export function parseLeagueAnalyticsSnapshot(value: unknown): LeagueAnalyticsSnapshot | null {
  const result = leagueAnalyticsSnapshotSchema.safeParse(value);
  return result.success ? result.data : null;
}

export function parseProjectionSetList(value: unknown): ProjectionSetListResponse | null {
  const result = projectionSetListResponseSchema.safeParse(value);
  return result.success ? result.data : null;
}

export function parseProjectionPlayerList(value: unknown): ProjectionPlayerListResponse | null {
  const result = projectionPlayerListResponseSchema.safeParse(value);
  return result.success ? result.data : null;
}

export function parseStatsCenterResponse(value: unknown): StatsCenterResponse | null {
  const result = statsCenterResponseSchema.safeParse(value);
  return result.success ? result.data : null;
}

export function parseStatsCenterPlayerDetail(
  value: unknown,
): StatsCenterPlayerDetailResponse | null {
  const result = statsCenterPlayerDetailResponseSchema.safeParse(value);
  return result.success ? result.data : null;
}

export function parseScheduleResponse(value: unknown): ScheduleResponse | null {
  const result = scheduleResponseSchema.safeParse(value);
  return result.success ? result.data : null;
}

export function parseScheduleByes(value: unknown): ScheduleByesResponse | null {
  const result = scheduleByesResponseSchema.safeParse(value);
  return result.success ? result.data : null;
}

export function parseScheduleEdgeResponse(value: unknown): ScheduleEdgeResponse | null {
  const result = scheduleEdgeResponseSchema.safeParse(value);
  return result.success ? result.data : null;
}

export function parseScheduleEdgeMatrixResponse(value: unknown): ScheduleEdgeMatrixResponse | null {
  const result = scheduleEdgeMatrixResponseSchema.safeParse(value);
  return result.success ? result.data : null;
}

/**
 * Push responses are validated with the API's own schemas. The device list deliberately carries no
 * endpoint or key, so nothing here can render one by accident.
 */
export function parsePushConfiguration(value: unknown): PushConfiguration | null {
  const result = pushConfigurationSchema.safeParse(value);
  return result.success ? result.data : null;
}

export function parsePushDeviceList(value: unknown): readonly PushDeviceStatus[] | null {
  const result = pushDeviceListResponseSchema.safeParse(value);
  return result.success ? result.data.devices : null;
}

export function parsePushDevice(value: unknown): PushDeviceStatus | null {
  const result = pushDeviceStatusSchema.safeParse(value);
  return result.success ? result.data : null;
}

export function parsePushTestResult(value: unknown): PushTestResponse | null {
  const result = pushTestResponseSchema.safeParse(value);
  return result.success ? result.data : null;
}

export function parseProjectionImportPreview(
  value: unknown,
): ProjectionImportPreviewResponse | null {
  const result = projectionImportPreviewResponseSchema.safeParse(value);
  return result.success ? result.data : null;
}

export function parseProjectionImportCommit(value: unknown): ProjectionImportCommitResponse | null {
  const result = projectionImportCommitResponseSchema.safeParse(value);
  return result.success ? result.data : null;
}

export function parseRankingListResponse(value: unknown): readonly RankingList[] | null {
  if (!isRecord(value) || !Array.isArray(value.lists)) return null;
  const parsed = value.lists.map((list) => rankingListSchema.safeParse(list));
  return parsed.every((result) => result.success) ? parsed.map((result) => result.data) : null;
}

export function parseRankingVersionResponse(value: unknown): RankingVersion | null {
  if (!isRecord(value)) return null;
  const result = rankingVersionSchema.safeParse(value.version);
  return result.success ? result.data : null;
}

/**
 * Source identity quality. Both responses are validated with the API's own schemas: the summary
 * carries no source rows at all, and `unresolvedIdentitySampleSchema` is `.strict()`, so a future
 * free-text column added upstream fails parsing here rather than rendering.
 */
export function parseDataQualitySources(value: unknown): DataQualityResponse | null {
  const result = dataQualityResponseSchema.safeParse(value);
  return result.success ? result.data : null;
}

export function parseUnresolvedIdentities(value: unknown): UnresolvedIdentityResponse | null {
  const result = unresolvedIdentityResponseSchema.safeParse(value);
  return result.success ? result.data : null;
}
