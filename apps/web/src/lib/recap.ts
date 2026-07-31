import {
  leagueRecapResponseSchema,
  recapPersonaCardListSchema,
  recapSettingsSchema,
  type LeagueRecapResponse,
  type LeagueWeeklyAwardsSection,
  type RecapPersonaCardList,
  type RecapSettings,
  type WeeklyRecap,
} from "@fantasy/contracts";

export function parseLeagueRecap(payload: unknown): LeagueRecapResponse | null {
  const result = leagueRecapResponseSchema.safeParse(payload);
  return result.success ? result.data : null;
}

export function parseRecapPersonaCards(payload: unknown): RecapPersonaCardList | null {
  const result = recapPersonaCardListSchema.safeParse(payload);
  return result.success ? result.data : null;
}

export function parseRecapSettings(payload: unknown): RecapSettings | null {
  const result = recapSettingsSchema.safeParse(payload);
  return result.success ? result.data : null;
}

const PROVIDER_LABELS: Readonly<Record<WeeklyRecap["provider"], string>> = {
  openai: "OpenAI",
  anthropic: "Anthropic",
  gemini: "Gemini",
  deepseek: "DeepSeek",
  grok: "Grok",
  openrouter: "OpenRouter",
};

/**
 * Provenance for one stored recap. The spice level is the recap's own, so moving the league dial
 * never relabels a recap that was written under a different setting.
 */
export function recapByline(recap: WeeklyRecap): string {
  const spice = recap.spiceLevel[0]!.toUpperCase() + recap.spiceLevel.slice(1);
  const requester = recap.generatedByDisplayName
    ? ` · requested by ${recap.generatedByDisplayName}`
    : "";
  return `Week ${recap.week} · written by ${PROVIDER_LABELS[recap.provider]} · ${spice}${requester}`;
}

export interface RecapMembershipView {
  readonly role: "owner" | "commissioner" | "manager" | "viewer";
  readonly claimedTeamId: string | null;
}

export function canManageLeagueIntel(membership: RecapMembershipView): boolean {
  return membership.role === "owner" || membership.role === "commissioner";
}

export function canEditSpice(membership: RecapMembershipView): boolean {
  return canManageLeagueIntel(membership);
}

export function canGenerateRecap(membership: RecapMembershipView): boolean {
  return membership.role !== "viewer";
}

export function awardableWeek(section: LeagueWeeklyAwardsSection): number | null {
  return section.state === "available" ? section.week : null;
}

export function recapUnavailableReasons(section: LeagueWeeklyAwardsSection): readonly string[] {
  return section.state === "unavailable" ? section.reasons.map((reason) => reason.message) : [];
}

/**
 * The week selector's options, newest first. `awarded` covers a snapshot that predates the
 * published week list; it is folded in rather than shown as a second, contradictory source.
 */
export function selectableRecapWeeks(
  weeks: readonly number[],
  awarded: number | null,
): readonly number[] {
  const unique = new Set(weeks);
  if (awarded !== null) unique.add(awarded);
  return [...unique].sort((left, right) => right - left);
}
