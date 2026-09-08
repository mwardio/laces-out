const ESPN_CANDIDATE_POOL_NOTE =
  /^Evaluated \d+ projected players confirmed in ESPN's latest available-player feeds\.$/;

interface WaiverDropCandidate {
  readonly id: string;
}

interface WaiverDropRecommendation {
  readonly drop: WaiverDropCandidate;
}

function comparisonImpact(
  subject: string,
  value: number,
): { readonly copy: string; readonly sign: number } {
  const rounded = Math.abs(value).toFixed(1);
  if (value > 1e-9) return { copy: `improves ${subject} by ${rounded} points`, sign: 1 };
  if (value < -1e-9) return { copy: `reduces ${subject} by ${rounded} points`, sign: -1 };
  return { copy: `leaves ${subject} unchanged`, sign: 0 };
}

/** Complete, directional copy for a user-selected drop comparison. */
export function waiverComparisonRationale(input: {
  readonly addName: string;
  readonly dropName: string;
  readonly weightedGain: number;
  readonly lineupGain: number;
  readonly horizon: { readonly kind: "week"; readonly label: string } | { readonly kind: "ros" };
}): string {
  const weighted = comparisonImpact(
    input.horizon.kind === "ros"
      ? "rest-of-season weighted roster value"
      : `${input.horizon.label} weighted roster value`,
    input.weightedGain,
  );
  const lineup = comparisonImpact(
    input.horizon.kind === "ros" ? "the projected starting core" : "the projected starting lineup",
    input.lineupGain,
  );
  const connector =
    weighted.sign !== 0 && lineup.sign !== 0 && weighted.sign !== lineup.sign ? " but " : " and ";
  return `Adding ${input.addName} while dropping ${input.dropName} ${weighted.copy}${connector}${lineup.copy}.`;
}

/** Hides the redundant ESPN feed sentence while retaining all other waiver notes. */
export function visibleWaiverNotes(notes: readonly string[]): readonly string[] {
  return notes.filter((note) => !ESPN_CANDIDATE_POOL_NOTE.test(note));
}

/** Resolves one shared drop selection against the candidates in the active horizon. */
export function resolveWaiverDropId(
  dropCandidates: readonly WaiverDropCandidate[],
  recommendations: readonly WaiverDropRecommendation[],
  requestedDropId: string | null,
): string | null {
  const candidateIds = new Set(dropCandidates.map((candidate) => candidate.id));
  if (requestedDropId !== null && candidateIds.has(requestedDropId)) return requestedDropId;
  const recommendedDropId = recommendations[0]?.drop.id;
  if (recommendedDropId !== undefined && candidateIds.has(recommendedDropId)) {
    return recommendedDropId;
  }
  return dropCandidates[0]?.id ?? null;
}
