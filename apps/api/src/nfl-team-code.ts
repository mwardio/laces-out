import { canonicalNflTeamCode } from "@laces-out/domain";

export { canonicalNflTeamCode };

export function nflverseNflTeamCode(team: string): string {
  const canonical = canonicalNflTeamCode(team);
  return canonical === "LAR" ? "LA" : canonical;
}
