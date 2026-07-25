import type { DraftStreamInvalidation } from "@fantasy/contracts";

/**
 * In-process fan-out for draft invalidations.
 *
 * Deliberately small: the stream carries only "this draft moved, re-read it", never draft state.
 * That keeps one canonical response contract for the board and makes reconnect trivial.
 *
 * Scope limit worth being explicit about: this is per-process. The API runs as a single container
 * today, so every subscriber sees every publish. If the API is ever scaled horizontally, a
 * subscriber attached to a different instance than the ingesting one will simply not receive
 * pushes — which is why the five-second client poll remains a supported fallback rather than a
 * legacy path, and why nothing about correctness depends on delivery.
 */
export class DraftStreamHub {
  readonly #listeners = new Map<string, Set<(event: DraftStreamInvalidation) => void>>();
  readonly #maximumSubscribersPerDraft: number;

  constructor(maximumSubscribersPerDraft = 64) {
    this.#maximumSubscribersPerDraft = maximumSubscribersPerDraft;
  }

  subscriberCount(draftId: string): number {
    return this.#listeners.get(draftId)?.size ?? 0;
  }

  /** Returns an unsubscribe function, or undefined when this draft is at its subscriber ceiling. */
  subscribe(
    draftId: string,
    listener: (event: DraftStreamInvalidation) => void,
  ): (() => void) | undefined {
    const existing = this.#listeners.get(draftId) ?? new Set();
    if (existing.size >= this.#maximumSubscribersPerDraft) return undefined;
    existing.add(listener);
    this.#listeners.set(draftId, existing);
    return () => {
      const current = this.#listeners.get(draftId);
      if (!current) return;
      current.delete(listener);
      if (current.size === 0) this.#listeners.delete(draftId);
    };
  }

  publish(event: DraftStreamInvalidation): void {
    const listeners = this.#listeners.get(event.draftId);
    if (!listeners) return;
    for (const listener of [...listeners]) {
      // One bad subscriber must not stop the rest of the league from being told.
      try {
        listener(event);
      } catch {
        listeners.delete(listener);
      }
    }
  }
}

/** Serializes one invalidation as an SSE frame. */
export function serverSentEvent(event: DraftStreamInvalidation): string {
  return `id: ${event.sequence}\nevent: draft-invalidated\ndata: ${JSON.stringify(event)}\n\n`;
}
