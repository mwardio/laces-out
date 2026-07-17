export const guardedNavigationRequestEvent = "laces-out:guarded-navigation-request";
export const guardedNavigationCommitEvent = "laces-out:guarded-navigation-commit";

export function requestGuardedNavigation(target: EventTarget = window): boolean {
  return target.dispatchEvent(new Event(guardedNavigationRequestEvent, { cancelable: true }));
}

export function commitGuardedNavigation(target: EventTarget = window): void {
  target.dispatchEvent(new Event(guardedNavigationCommitEvent));
}
