export interface RequestIdentity {
  readonly sequence: number;
  readonly key: string;
}

/**
 * Tracks the one request whose result is still allowed to update local UI state.
 * Aborting transport is best-effort; this identity gate is the correctness check.
 */
export class LatestRequest {
  #sequence = 0;
  #key: string | null = null;

  begin(key: string): RequestIdentity {
    this.#key = key;
    return { sequence: ++this.#sequence, key };
  }

  invalidate(): void {
    this.#sequence += 1;
    this.#key = null;
  }

  isCurrent(identity: RequestIdentity): boolean {
    return identity.sequence === this.#sequence && identity.key === this.#key;
  }
}
