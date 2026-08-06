import { checksumSha256 } from "@laces-out/rankings";

/**
 * Prior-versus-next roster comparison.
 *
 * `roster_snapshots` stores no checksum, so the only honest way to tell a real roster move from a
 * re-sync of the same roster is to hash both snapshots' entries and compare. A producer that skipped
 * this and emitted on every write would be exactly the "emit on every write" this package forbids.
 */

export interface RosterMember {
  readonly playerId: string;
  readonly slotCode: string;
  readonly isStarter: boolean;
}

export interface RosterDiff {
  readonly added: readonly string[];
  readonly removed: readonly string[];
  readonly promoted: readonly string[];
  readonly benched: readonly string[];
}

/**
 * The same normalization `apps/worker/src/lineup-lock-alerts.ts` applies, so the lineup-lock sweep
 * and the change feed cannot disagree about whether a slot changed.
 */
function normalizeSlot(slotCode: string): string {
  return slotCode.trim().toUpperCase().replaceAll(" ", "");
}

/** Order-insensitive: a re-sync that returns the same roster in a different order is not a change. */
export function rosterChecksum(entries: readonly RosterMember[]): string {
  const rows = entries
    .map((entry) => [entry.playerId, normalizeSlot(entry.slotCode), entry.isStarter] as const)
    .toSorted((left, right) => (left[0] < right[0] ? -1 : left[0] > right[0] ? 1 : 0));
  return checksumSha256(rows);
}

/**
 * `null` when there is no prior snapshot. A first-ever roster is a baseline, not fifteen additions,
 * and announcing it as a change would make the very first sync the noisiest event a member ever
 * receives.
 */
export function diffRoster(
  prior: readonly RosterMember[] | null,
  next: readonly RosterMember[],
): RosterDiff | null {
  if (prior === null) return null;
  const priorById = new Map(prior.map((entry) => [entry.playerId, entry]));
  const nextById = new Map(next.map((entry) => [entry.playerId, entry]));

  const added: string[] = [];
  const removed: string[] = [];
  const promoted: string[] = [];
  const benched: string[] = [];

  for (const [playerId, entry] of nextById) {
    const before = priorById.get(playerId);
    if (!before) {
      added.push(playerId);
      continue;
    }
    if (!before.isStarter && entry.isStarter) promoted.push(playerId);
    else if (before.isStarter && !entry.isStarter) benched.push(playerId);
  }
  for (const playerId of priorById.keys()) {
    if (!nextById.has(playerId)) removed.push(playerId);
  }

  return {
    added: added.toSorted(),
    removed: removed.toSorted(),
    promoted: promoted.toSorted(),
    benched: benched.toSorted(),
  };
}

export function isEmptyRosterDiff(diff: RosterDiff): boolean {
  return (
    diff.added.length === 0 &&
    diff.removed.length === 0 &&
    diff.promoted.length === 0 &&
    diff.benched.length === 0
  );
}
