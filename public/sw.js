function issueUrl(value) {
  const home = self.location.origin + "/";
  try {
    const url = new URL(value || "/", home);
    if (url.origin === self.location.origin && url.pathname === "/") return url.href;
  } catch { /* Open the overview for an invalid link. */ }
  return home;
}

self.addEventListener("push", event => {
  const notice = event.data?.json() || {};
  event.waitUntil(self.registration.showNotification("A move needs your attention", {
    body: notice.body || "", data: { url: issueUrl(notice.url) },
  }));
});

self.addEventListener("notificationclick", event => {
  event.notification.close();
  const url = issueUrl(event.notification.data?.url);
  event.waitUntil((async () => {
    const windows = await self.clients.matchAll({ type: "window", includeUncontrolled: true });
    for (const client of windows) {
      if (new URL(client.url).origin !== self.location.origin) continue;
      try {
        const opened = await client.navigate(url);
        if (opened) return await opened.focus();
      } catch { /* The window may have closed. */ }
    }
    return self.clients.openWindow(url);
  })());
});
