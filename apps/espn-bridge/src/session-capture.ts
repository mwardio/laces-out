// No credential is included in this notification. It only lets the service worker continue a
// short-lived, user-initiated opt-in after ESPN finishes a login/navigation cycle.
void chrome.runtime.sendMessage({ type: "ESPN_SESSION_PAGE_READY" }).catch(() => undefined);
