import assert from "node:assert/strict";
import { createECDH, randomBytes, generateKeyPairSync } from "node:crypto";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import ts from "typescript";

const agenda = readFileSync(new URL("../src/agenda.json", import.meta.url), "utf8");
const source = readFileSync(new URL("../src/index.ts", import.meta.url), "utf8")
	.replace('import agenda from "./agenda.json";', `const agenda = ${agenda};`);
const compiled = ts.transpileModule(source, { compilerOptions: { module: ts.ModuleKind.ES2022, target: ts.ScriptTarget.ES2022 } }).outputText
	.replace('"@block65/webcrypto-web-push"', JSON.stringify(import.meta.resolve("@block65/webcrypto-web-push")));
const { default: worker } = await import(`data:text/javascript;base64,${Buffer.from(compiled).toString("base64")}`);

function subscription(endpoint) {
	const ecdh = createECDH("prime256v1");
	ecdh.generateKeys();
	return { endpoint, keys: { p256dh: ecdh.getPublicKey().toString("base64url"), auth: randomBytes(16).toString("base64url") } };
}

function environment() {
	const key = generateKeyPairSync("ec", { namedCurve: "prime256v1" }).privateKey.export({ format: "jwk" });
	return {
		VAPID_SUBJECT: "mailto:test@example.com",
		VAPID_PUBLIC_KEY: Buffer.concat([Buffer.from([4]), Buffer.from(key.x, "base64url"), Buffer.from(key.y, "base64url")]).toString("base64url"),
		VAPID_PRIVATE_KEY: key.d,
		DB: {
			prepare() { return { bind() { return this; }, all: async () => ({ results: [] }) }; },
			batch: async () => [],
		},
	};
}

const request = (path, sub) => new Request(`https://agenda.example${path}`, {
	method: "POST", headers: { "content-type": "application/json" },
	body: JSON.stringify({ subscription: sub, lead: 10, sessions: [] }),
});

test("push sync accepts documented provider endpoint families", async () => {
	for (const endpoint of [
		"https://fcm.googleapis.com/fcm/send/token",
		"https://fcm.googleapis.com/wp/token",
		"https://updates.push.services.mozilla.com/wpush/v2/token",
		"https://web.push.apple.com/token",
		"https://other.push.apple.com/token",
		"https://wns2-db5p.notify.windows.com/w/?token=example",
	]) {
		const response = await worker.fetch(request("/api/sync", subscription(endpoint)), environment());
		assert.equal(response.status, 200, endpoint);
	}
});

test("arbitrary destinations and provider-lookalike URLs are rejected before storage", async () => {
	for (const endpoint of [
		"https://attacker.example/push", "https://127.0.0.1/push",
		"https://fcm.googleapis.com.attacker.example/push",
		"https://notpush.apple.com/push", "https://fcm.googleapis.com@attacker.example/push",
		"https://user:password@fcm.googleapis.com/push", "https://fcm.googleapis.com:444/push",
	]) {
		const env = environment();
		let writes = 0;
		env.DB.batch = async () => { writes++; return []; };
		const response = await worker.fetch(request("/api/sync", subscription(endpoint)), env);
		assert.equal(response.status, 400, endpoint);
		assert.equal(writes, 0, endpoint);
	}
});

test("push delivery disables redirects to destinations outside the provider", async () => {
	const previousFetch = globalThis.fetch;
	let sent;
	globalThis.fetch = async (url, options) => { sent = { url, options }; return new Response(null, { status: 201 }); };
	try {
		const response = await worker.fetch(request("/api/test", subscription("https://fcm.googleapis.com/fcm/send/token")), environment());
		assert.equal(response.status, 200);
		assert.equal(sent.url, "https://fcm.googleapis.com/fcm/send/token");
		assert.equal(sent.options.redirect, "error");
	} finally {
		globalThis.fetch = previousFetch;
	}
});

test("cron does not deliver to arbitrary endpoints already stored in the database", async () => {
	const sub = subscription("https://attacker.example/push");
	const env = environment();
	env.DB.prepare = () => ({
		bind() { return this; },
		all: async () => ({ results: [{ sub_id: "device", session_id: "session", title: "Talk", body: "Starts soon", endpoint: sub.endpoint, ...sub.keys }] }),
	});
	const pending = [];
	let sent = 0;
	const previousFetch = globalThis.fetch;
	const previousError = console.error;
	globalThis.fetch = async () => { sent++; return new Response(null, { status: 201 }); };
	console.error = () => {};
	try {
		await worker.scheduled({}, env, { waitUntil(promise) { pending.push(promise); } });
		await Promise.all(pending);
		assert.equal(sent, 0);
	} finally {
		globalThis.fetch = previousFetch;
		console.error = previousError;
	}
});
