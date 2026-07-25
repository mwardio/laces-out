/*
 * Laces Out service worker.
 *
 * Deliberately tiny and dependency-free: it shows the notification the API sent and opens the deep
 * link it carries. It caches nothing, intercepts no fetches, and never contacts the API itself, so
 * it cannot serve a stale league fact or hold a session.
 */

/* global self */

const FALLBACK_NOTIFICATION = {
  title: "Laces Out",
  body: "Open Laces Out for the details.",
  url: "/app",
  tag: "laces-out",
};

function readPayload(event) {
  if (!event.data) return FALLBACK_NOTIFICATION;
  let parsed;
  try {
    parsed = event.data.json();
  } catch {
    return FALLBACK_NOTIFICATION;
  }
  if (typeof parsed !== "object" || parsed === null) return FALLBACK_NOTIFICATION;
  const title = typeof parsed.title === "string" ? parsed.title : FALLBACK_NOTIFICATION.title;
  const body = typeof parsed.body === "string" ? parsed.body : FALLBACK_NOTIFICATION.body;
  const tag = typeof parsed.tag === "string" ? parsed.tag : FALLBACK_NOTIFICATION.tag;
  // Only same-origin, application-relative destinations are ever opened.
  const url =
    typeof parsed.url === "string" && parsed.url.startsWith("/") && !parsed.url.startsWith("//")
      ? parsed.url
      : FALLBACK_NOTIFICATION.url;
  return { title, body, url, tag };
}

self.addEventListener("install", () => {
  void self.skipWaiting();
});

self.addEventListener("activate", (event) => {
  event.waitUntil(self.clients.claim());
});

self.addEventListener("push", (event) => {
  const payload = readPayload(event);
  event.waitUntil(
    self.registration.showNotification(payload.title, {
      body: payload.body,
      tag: payload.tag,
      // A newer alert for the same league and week replaces the older one instead of stacking.
      renotify: true,
      icon: "/icon-192.png",
      badge: "/icon-192.png",
      data: { url: payload.url },
    }),
  );
});

self.addEventListener("notificationclick", (event) => {
  event.notification.close();
  const data = event.notification.data;
  const target = data && typeof data.url === "string" ? data.url : FALLBACK_NOTIFICATION.url;
  const destination = new URL(target, self.location.origin);
  event.waitUntil(
    self.clients
      .matchAll({ type: "window", includeUncontrolled: true })
      .then(async (windowClients) => {
        for (const client of windowClients) {
          if (new URL(client.url).origin !== destination.origin) continue;
          await client.focus();
          if ("navigate" in client) await client.navigate(destination.href);
          return;
        }
        await self.clients.openWindow(destination.href);
      }),
  );
});
