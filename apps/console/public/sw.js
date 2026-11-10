/*
 * The console's service worker: Web Push and nothing else (ADR 0048).
 *
 * It has no fetch handler and opens no cache. A service worker that cached
 * pages would serve a signed-out person, or the next person on a shared
 * computer, what the last one saw; this one never holds a response, so there
 * is nothing to leak and nothing to clear on sign-out.
 *
 * A push for a tab that is open, focused and visible shows nothing: the page
 * already says it, with its own alert and badge. WebKit revokes a
 * subscription after a few pushes that show nothing, so there it is shown
 * and closed at once. Otherwise it is shown with the tag the open page's own
 * alert gives the same item, so one replaces the other instead of both.
 */

self.addEventListener('install', () => {
  self.skipWaiting();
});

self.addEventListener('activate', (event) => {
  event.waitUntil(self.clients.claim());
});

function readPayload(event) {
  try {
    const data = event.data ? event.data.json() : null;
    if (data && typeof data === 'object') return data;
  } catch (_) {
    // Not JSON: shown as a plain notice below.
  }
  return { title: 'OpenADLC', body: event.data ? event.data.text() : 'Something needs you', link: '/needs-you', tag: 'openadlc' };
}

function isWebKit() {
  const agent = (self.navigator && self.navigator.userAgent) || '';
  return /AppleWebKit/.test(agent) && !/Chrome|Chromium|Edg|Firefox|FxiOS|CriOS/.test(agent);
}

async function onPush(payload) {
  const windows = await self.clients.matchAll({ type: 'window', includeUncontrolled: true });
  const focused = windows.find((client) => client.focused && client.visibilityState === 'visible');
  const title = payload.title || 'OpenADLC';
  const options = { body: payload.body || '', tag: payload.tag || 'openadlc', data: { link: payload.link || '/' }, icon: '/icons/icon-192.png' };
  if (focused) {
    focused.postMessage({ type: 'openadlc-push', tag: options.tag });
    if (!isWebKit()) return;
    await self.registration.showNotification(title, options);
    const shown = await self.registration.getNotifications({ tag: options.tag });
    for (const one of shown) one.close();
    return;
  }
  await self.registration.showNotification(title, options);
}

self.addEventListener('push', (event) => {
  event.waitUntil(onPush(readPayload(event)));
});

/** The console's own address for a link, or its Needs you when the link goes anywhere else. */
function sameOrigin(link) {
  const origin = self.location.origin;
  try {
    const url = new URL(link, origin);
    if (url.origin === origin) return url.href;
  } catch (_) {
    // Not a URL: Needs you below.
  }
  return new URL('/needs-you', origin).href;
}

async function onClick(link) {
  const target = sameOrigin(link);
  const windows = await self.clients.matchAll({ type: 'window', includeUncontrolled: true });
  const open = windows.find((client) => new URL(client.url).origin === self.location.origin);
  if (open) {
    const focused = await open.focus();
    if (focused && typeof focused.navigate === 'function') return focused.navigate(target);
    return focused;
  }
  return self.clients.openWindow(target);
}

self.addEventListener('notificationclick', (event) => {
  event.notification.close();
  const link = event.notification.data && event.notification.data.link;
  event.waitUntil(onClick(link || '/'));
});
