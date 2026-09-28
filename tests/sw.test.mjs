import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import vm from "node:vm";

const source = readFileSync(new URL("../public/sw.js", import.meta.url), "utf8");
const deferred = () => {
	let resolve;
	const promise = new Promise((done) => { resolve = done; });
	return { promise, resolve };
};

test("cached response stays instant while refresh and cache write extend worker lifetime", async () => {
	const listeners = {};
	const network = deferred();
	const writing = deferred();
	const putStarted = deferred();
	const cached = new Response("old shell");
	const fresh = new Response("new shell");
	vm.runInNewContext(source, {
		URL, location: { origin: "https://agenda.example" },
		self: { addEventListener(type, handler) { listeners[type] = handler; } },
		fetch: () => network.promise,
		caches: { open: async () => ({
			match: async () => cached,
			put: async () => { putStarted.resolve(); await writing.promise; },
		}) },
	});
	const lifetimes = [];
	let response;
	listeners.fetch({
		request: new Request("https://agenda.example/app.js"),
		respondWith(promise) { response = promise; },
		waitUntil(promise) { lifetimes.push(promise); },
	});
	assert.equal(await response, cached);
	assert.ok(lifetimes.length > 0, "refresh must be registered with waitUntil");
	network.resolve(fresh);
	await putStarted.promise;
	let finished = false;
	const lifetime = Promise.all(lifetimes).then(() => { finished = true; });
	await new Promise((resolve) => setImmediate(resolve));
	assert.equal(finished, false, "lifetime must include cache.put completion");
	writing.resolve();
	await lifetime;
	assert.equal(finished, true);
});
