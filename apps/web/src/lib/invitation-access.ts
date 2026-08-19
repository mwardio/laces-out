import type { LeagueAccessRole } from "@laces-out/contracts";

export const FRIEND_INVITATION_LEAGUE_ROLES = [
  { value: "member", label: "Member (standard league access)" },
  { value: "commissioner", label: "Commissioner" },
] as const satisfies readonly { readonly value: LeagueAccessRole; readonly label: string }[];

export function leagueAccessLabel(role: LeagueAccessRole): string {
  return role === "commissioner" ? "Commissioner" : "Member";
}

export function friendInvitationRequest(input: {
  readonly email: string;
  readonly leagueId: string;
  readonly leagueRole: LeagueAccessRole;
  readonly expiresInDays: number;
}) {
  return {
    email: input.email.trim(),
    role: "member" as const,
    expiresInDays: input.expiresInDays,
    ...(input.leagueId ? { leagueId: input.leagueId, leagueRole: input.leagueRole } : {}),
  };
}
