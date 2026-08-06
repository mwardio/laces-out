import type { ChangeEventVisibility } from "@laces-out/contracts";

/**
 * Who a change event is written *to*.
 *
 * This is the write half of the visibility rule; the read half is the SQL predicate in
 * `apps/api/src/change-events.ts`. A `private` event is reachable only through a receipt, so the
 * list this function returns is literally the set of people who can ever see that event. Getting it
 * wrong is a cross-user leak, which is why it is pure and separately tested.
 */

export interface RecipientMember {
  readonly userId: string;
  readonly claimedFantasyTeamId: string | null;
}

export interface RecipientPolicy {
  readonly visibility: ChangeEventVisibility;
  readonly members: readonly RecipientMember[];
  /** When set, a `private` event reaches only the member who claimed this team. */
  readonly affectedTeamId: string | null;
  readonly actorUserId: string | null;
}

export function resolveRecipients(policy: RecipientPolicy): readonly string[] {
  // A global event deliberately fans out to no receipts. The read path makes it visible to every
  // authenticated caller and creates a receipt lazily on first read or dismiss, so a source-health
  // announcement costs one row rather than one row per member.
  if (policy.visibility === "global") return [];

  const selected =
    policy.visibility === "league"
      ? policy.members.map((member) => member.userId)
      : policy.affectedTeamId === null
        ? // No team named: the actor is the only defensible recipient, and only if they are a member.
          policy.members
            .filter((member) => member.userId === policy.actorUserId)
            .map((member) => member.userId)
        : policy.members
            .filter((member) => member.claimedFantasyTeamId === policy.affectedTeamId)
            .map((member) => member.userId);

  // Input-ordered and de-duplicated so the writer's receipt insert is deterministic.
  return [...new Set(selected)];
}
