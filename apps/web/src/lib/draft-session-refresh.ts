export interface SequencedDraftSnapshot {
  readonly id: string;
  readonly sequence: number;
  readonly updatedAt: string;
}

/**
 * Background reads may finish after a local mutation. Keep the current room
 * unless the same-room response is provably newer.
 */
export function preferNewerDraftSnapshot<Snapshot extends SequencedDraftSnapshot>(
  current: Snapshot | null,
  incoming: Snapshot,
): Snapshot | null {
  if (!current || current.id !== incoming.id) return current;
  if (incoming.sequence > current.sequence) return incoming;
  if (incoming.sequence < current.sequence) return current;
  const currentTime = Date.parse(current.updatedAt);
  const incomingTime = Date.parse(incoming.updatedAt);
  return Number.isFinite(incomingTime) && Number.isFinite(currentTime) && incomingTime > currentTime
    ? incoming
    : current;
}
