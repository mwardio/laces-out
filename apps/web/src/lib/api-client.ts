import {
  aiAnalysisResponseSchema,
  aiFeatureResponseSchema,
  aiProviderConfigurationSchema,
  aiProviderListResponseSchema,
  draftMarketBaselineSchema,
  draftMutationResponseSchema,
  draftSessionSnapshotSchema,
  inSeasonDecisionSnapshotSchema,
  jobAcceptedSchema,
  leagueAnalyticsSnapshotSchema,
  leagueDashboardSchema,
  leagueListResponseSchema,
  projectionImportCommitResponseSchema,
  projectionImportPreviewResponseSchema,
  projectionSetListResponseSchema,
  statsCenterResponseSchema,
  type AiAnalysisResponse,
  type AiFeatureName,
  type AiFeatureResponse,
  type AiProviderConfiguration,
  type AiProviderListResponse,
  type DraftMutationResponse,
  type DraftMarketBaseline,
  type DraftSessionSnapshot,
  type InSeasonDecisionSnapshot,
  type JobAccepted,
  type LeagueAnalyticsSnapshot,
  type LeagueDashboard,
  type LeagueListResponse,
  type ProjectionImportCommitResponse,
  type ProjectionImportPreviewResponse,
  type ProjectionSetListResponse,
  type StatsCenterResponse,
} from "@fantasy/contracts";
import {
  rankingListSchema,
  rankingVersionSchema,
  type RankingList,
  type RankingVersion,
} from "@fantasy/rankings/model";

export { parseRosProjectionStatus, type RosProjectionStatus } from "./ros-projection-status";

const fallbackApiUrl = "http://localhost:4000";

export const apiBaseUrl = (process.env.NEXT_PUBLIC_API_URL ?? fallbackApiUrl).replace(/\/+$/, "");

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
  DraftMutationResponse,
  DraftMarketBaseline,
  DraftSessionSnapshot,
  InSeasonDecisionSnapshot,
  JobAccepted,
  LeagueAnalyticsSnapshot,
  LeagueDashboard,
  LeagueListResponse,
  ProjectionImportCommitResponse,
  ProjectionImportPreviewResponse,
  ProjectionSetListResponse,
  StatsCenterResponse,
  RankingList,
  RankingVersion,
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

export function parseAiFeature(value: unknown): AiFeatureResponse | null {
  const result = aiFeatureResponseSchema.safeParse(value);
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

export function parseLeagueListResponse(value: unknown): LeagueListResponse | null {
  const result = leagueListResponseSchema.safeParse(value);
  return result.success ? result.data : null;
}

export function parseLeagueDashboard(value: unknown): LeagueDashboard | null {
  const result = leagueDashboardSchema.safeParse(value);
  return result.success ? result.data : null;
}

export function parseInSeasonDecisionSnapshot(value: unknown): InSeasonDecisionSnapshot | null {
  const result = inSeasonDecisionSnapshotSchema.safeParse(value);
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

export function parseStatsCenterResponse(value: unknown): StatsCenterResponse | null {
  const result = statsCenterResponseSchema.safeParse(value);
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
