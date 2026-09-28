// Offline shell (conference wi-fi) and push display.
const CACHE = "tgg26-v4";
const SHELL = ["/", "/app.js", "/agenda.json", "/manifest.webmanifest", "/icon-192.png", "/wq-mark.svg", "/wq-mark-dark.svg", "/vendor/qrcode.mjs", "/vendor/jsqr.mjs"];

self.addEventListener("install", (e) => {
	e.waitUntil(caches.open(CACHE).then((c) => c.addAll(SHELL)).then(() => self.skipWaiting()));
});

self.addEventListener("activate", (e) => {
	e.waitUntil(
		caches
			.keys()
			.then((keys) => Promise.all(keys.filter((k) => k !== CACHE).map((k) => caches.delete(k))))
			.then(() => self.clients.claim()),
	);
});

// Stale-while-revalidate for same-origin GETs, so the agenda opens instantly
// with no signal and picks up any change on the next visit.
self.addEventListener("fetch", (e) => {
	const url = new URL(e.request.url);
	if (e.request.method !== "GET" || url.origin !== location.origin || url.pathname.startsWith("/api/")) return;
	const key = e.request.mode === "navigate" ? "/" : e.request;
	e.respondWith(
		caches.open(CACHE).then(async (cache) => {
			const cached = await cache.match(key, { ignoreSearch: e.request.mode === "navigate" });
			const fresh = fetch(e.request)
				.then((res) => {
					if (res.ok) cache.put(key, res.clone());
					return res;
				})
				.catch(() => cached);
			return cached || fresh;
		}),
	);
});

self.addEventListener("push", (e) => {
	let data = {};
	try {
		data = e.data ? e.data.json() : {};
	} catch {
		data = { title: "TGG Live 26", body: e.data ? e.data.text() : "" };
	}
	e.waitUntil(
		self.registration.showNotification(data.title || "TGG Live 26", {
			body: data.body || "",
			tag: data.tag,
			icon: "/icon-192.png",
			badge: "/icon-192.png",
			data: { url: data.url || "/" },
		}),
	);
});

self.addEventListener("notificationclick", (e) => {
	e.notification.close();
	const url = e.notification.data?.url || "/";
	e.waitUntil(
		self.clients.matchAll({ type: "window", includeUncontrolled: true }).then((list) => {
			for (const c of list) {
				if ("focus" in c) {
					c.postMessage({ type: "open", url });
					return c.focus();
				}
			}
			return self.clients.openWindow(url);
		}),
	);
});
