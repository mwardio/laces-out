import { describe, expect, it, vi } from "vitest";

import {
  commitGuardedNavigation,
  guardedNavigationCommitEvent,
  guardedNavigationRequestEvent,
  requestGuardedNavigation,
} from "./navigation-guard";

describe("guarded navigation events", () => {
  it("allows navigation when no active workspace objects", () => {
    expect(requestGuardedNavigation(new EventTarget())).toBe(true);
  });

  it("reports a canceled navigation request", () => {
    const target = new EventTarget();
    target.addEventListener(guardedNavigationRequestEvent, (event) => event.preventDefault());

    expect(requestGuardedNavigation(target)).toBe(false);
  });

  it("publishes a separate commit only after the guarded action succeeds", () => {
    const target = new EventTarget();
    const committed = vi.fn();
    target.addEventListener(guardedNavigationCommitEvent, committed);

    commitGuardedNavigation(target);

    expect(committed).toHaveBeenCalledOnce();
  });
});
