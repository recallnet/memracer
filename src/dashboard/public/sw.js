/* memracer dashboard service worker — Web Push for human-attention episodes. */
/* global self, clients */

self.addEventListener("push", (event) => {
  let data = { title: "memracer", body: "Something needs your attention.", url: "/dashboard", tag: "memracer" };
  try {
    if (event.data) data = { ...data, ...event.data.json() };
  } catch {
    try {
      if (event.data) data.body = event.data.text();
    } catch {
      /* keep defaults */
    }
  }
  const title = data.title || "memracer";
  const options = {
    body: data.body || "",
    tag: data.tag || data.episode_id || "memracer-attention",
    data: { url: data.url || "/dashboard", episode_id: data.episode_id, project: data.project },
    renotify: false,
  };
  event.waitUntil(self.registration.showNotification(title, options));
});

self.addEventListener("notificationclick", (event) => {
  event.notification.close();
  const target = (event.notification.data && event.notification.data.url) || "/dashboard";
  event.waitUntil(
    clients.matchAll({ type: "window", includeUncontrolled: true }).then((windowClients) => {
      for (const client of windowClients) {
        if ("focus" in client) {
          if ("navigate" in client && target) {
            try {
              return client.navigate(target).then((c) => (c && c.focus ? c.focus() : client.focus()));
            } catch {
              return client.focus();
            }
          }
          return client.focus();
        }
      }
      if (clients.openWindow) return clients.openWindow(target);
      return undefined;
    }),
  );
});
