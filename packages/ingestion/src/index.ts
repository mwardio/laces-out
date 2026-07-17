export interface CanonicalPlayerIdentity {
  readonly id: string;
  readonly fullName: string;
  readonly nflTeam?: string;
  readonly position?: string;
  readonly birthDate?: string;
  readonly externalIds: Readonly<Record<string, string>>;
}

export interface IncomingPlayerIdentity {
  readonly fullName: string;
  readonly nflTeam?: string;
  readonly position?: string;
  readonly birthDate?: string;
  readonly source: string;
  readonly sourceId: string;
}

export interface IdentityCandidate {
  readonly playerId: string;
  readonly confidence: number;
  readonly reasons: readonly string[];
}

export type IdentityResolution =
  | { readonly status: "matched"; readonly candidate: IdentityCandidate }
  | { readonly status: "review"; readonly candidates: readonly IdentityCandidate[] }
  | { readonly status: "unmatched"; readonly candidates: readonly [] };

function normalizeName(name: string): string {
  return name
    .normalize("NFKD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLowerCase()
    .replace(/\b(jr|sr|ii|iii|iv)\b\.?/g, "")
    .replace(/[^a-z0-9]/g, "");
}

function scoreCandidate(
  incoming: IncomingPlayerIdentity,
  candidate: CanonicalPlayerIdentity,
): IdentityCandidate | undefined {
  const exactExternalId = candidate.externalIds[incoming.source] === incoming.sourceId;
  if (exactExternalId) {
    return { playerId: candidate.id, confidence: 1, reasons: ["verified external ID"] };
  }

  if (normalizeName(incoming.fullName) !== normalizeName(candidate.fullName)) return undefined;

  let confidence = 0.78;
  const reasons = ["normalized full name"];
  if (incoming.birthDate && candidate.birthDate && incoming.birthDate === candidate.birthDate) {
    confidence += 0.14;
    reasons.push("birth date");
  }
  if (incoming.position && candidate.position && incoming.position === candidate.position) {
    confidence += 0.05;
    reasons.push("position");
  }
  if (incoming.nflTeam && candidate.nflTeam && incoming.nflTeam === candidate.nflTeam) {
    confidence += 0.03;
    reasons.push("NFL team");
  }

  return { playerId: candidate.id, confidence: Math.min(0.99, confidence), reasons };
}

/** Low-confidence or tied identity matches are deliberately routed to review. */
export function resolvePlayerIdentity(
  incoming: IncomingPlayerIdentity,
  knownPlayers: readonly CanonicalPlayerIdentity[],
): IdentityResolution {
  const candidates = knownPlayers
    .map((candidate) => scoreCandidate(incoming, candidate))
    .filter((candidate): candidate is IdentityCandidate => candidate !== undefined)
    .sort((left, right) => right.confidence - left.confidence);

  const best = candidates[0];
  if (!best) return { status: "unmatched", candidates: [] };

  const runnerUp = candidates[1];
  const unambiguous = !runnerUp || best.confidence - runnerUp.confidence >= 0.08;
  if (best.confidence >= 0.9 && unambiguous) return { status: "matched", candidate: best };

  return { status: "review", candidates };
}
