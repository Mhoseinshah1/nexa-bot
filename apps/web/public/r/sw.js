/*
 * Service worker of the reseller panel (`/r/`).
 *
 * The rule, in one sentence: it keeps a copy of the panel's STATIC SHELL — the hashed build
 * files under /assets/ and the webfont under /fonts/ — and touches nothing else. It never sees
 * an `/api` response (the API answers `Cache-Control: no-store` and carries the reseller's
 * money, sessions and connection files), never serves the HTML document, and has no offline
 * mode: without a network the browser shows its own error, as it would for any site.
 *
 * Everything that is not a same-origin GET of a shell file returns WITHOUT calling
 * `respondWith`, so the browser handles it exactly as if no worker existed.
 * `tests/web/reseller-pwa.test.ts` evaluates this file and pins that.
 */
'use strict';

var CACHE = 'nexa-reseller-shell-v1';
var SHELL_PREFIXES = ['/assets/', '/fonts/'];

function isShellRequest(request, origin) {
  if (request.method !== 'GET') return false;
  var url;
  try {
    url = new URL(request.url);
  } catch (error) {
    return false;
  }
  if (url.origin !== origin) return false;
  // `new URL` has already resolved any `..`, so the prefix test sees the real path.
  for (var index = 0; index < SHELL_PREFIXES.length; index += 1) {
    if (url.pathname.indexOf(SHELL_PREFIXES[index]) === 0) return true;
  }
  return false;
}

self.addEventListener('install', function () {
  self.skipWaiting();
});

self.addEventListener('activate', function (event) {
  event.waitUntil(
    caches
      .keys()
      .then(function (names) {
        return Promise.all(
          names
            .filter(function (name) {
              return name !== CACHE;
            })
            .map(function (name) {
              return caches.delete(name);
            }),
        );
      })
      .then(function () {
        return self.clients.claim();
      }),
  );
});

self.addEventListener('fetch', function (event) {
  var request = event.request;
  if (!isShellRequest(request, self.location.origin)) return;
  event.respondWith(
    caches.open(CACHE).then(function (cache) {
      return cache.match(request).then(function (hit) {
        if (hit) return hit;
        return fetch(request).then(function (response) {
          var cacheControl = response.headers.get('Cache-Control') || '';
          // Only a plain, successful, cacheable same-origin answer is kept.
          if (response.ok && response.type === 'basic' && cacheControl.indexOf('no-store') < 0) {
            cache.put(request, response.clone());
          }
          return response;
        });
      });
    }),
  );
});
