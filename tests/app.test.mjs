import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import vm from "node:vm";

const source = readFileSync(new URL("../public/app.js", import.meta.url), "utf8");

function app() {
	const listeners = new Map();
	const elements = new Map();
	const timers = new Map();
	let nextTimer = 0;
	const element = (selector) => {
		if (!elements.has(selector)) elements.set(selector, {
			textContent: "", innerHTML: "", className: "", dataset: {},
			addEventListener(type, handler) { listeners.set(`${selector}:${type}`, handler); },
			close() { this.open = false; }, showModal() { this.open = true; }, classList: { toggle() {} },
		});
		return elements.get(selector);
	};
	const context = vm.createContext({
		console: { error() {} }, URL, TextEncoder, TextDecoder, crypto: globalThis.crypto,
		atob: globalThis.atob, btoa: globalThis.btoa,
		location: { origin: "https://agenda.example", pathname: "/", hash: "" },
		history: { replaceState() {} },
		localStorage: { getItem() { return null; }, setItem() {} },
		document: {
			querySelector: element, querySelectorAll() { return []; },
			addEventListener(type, handler) { listeners.set(`document:${type}`, handler); },
		},
		navigator: {}, window: {}, scrollTo() {},
		addEventListener(type, handler) { listeners.set(type, handler); },
		setTimeout(handler) { timers.set(++nextTimer, handler); return nextTimer; },
		clearTimeout(id) { timers.delete(id); },
	});
	vm.runInContext(source.slice(0, source.lastIndexOf("boot().catch")), context);
	vm.runInContext("render = () => {}; renderSettings = () => {}; showShareBack = () => {};", context);
	return {
		context, elements, listeners,
		run: (code) => vm.runInContext(code, context),
		async flushTimers() {
			const pending = [...timers.values()];
			timers.clear();
			for (const handler of pending) await handler();
		},
	};
}

test("a partial rescan preserves saved contact details and personal notes", () => {
	const a = app();
	a.run(`state.contacts = [{ id: 'jane', name: 'Jane Smith', role: 'Analyst', org: 'Example FC', phone: '+447700900123', email: 'jane@example.com', url: 'https://example.com', note: 'Send the report' }];
		saveScanned({cid: '', ...parseContact('mailto:jane@example.com'), note: 'Met at TGG Live 2026'});`);
	assert.equal(a.run("state.contacts.length"), 1);
	assert.equal(a.run("state.contacts[0].name"), "Jane Smith");
	assert.equal(a.run("state.contacts[0].phone"), "+447700900123");
	assert.equal(a.run("state.contacts[0].role"), "Analyst");
	assert.equal(a.run("state.contacts[0].org"), "Example FC");
	assert.equal(a.run("state.contacts[0].url"), "https://example.com");
	assert.equal(a.run("state.contacts[0].note"), "Send the report");
});

test("explicit contact edits can still clear fields", () => {
	const a = app();
	a.run(`state.contacts = [{ id: 'jane', name: 'Jane Smith', phone: '+447700900123', email: 'jane@example.com', note: 'Old note' }];
		saveScanned({cid: 'jane', name: 'Jane Smith', phone: '', email: 'jane@example.com', note: ''});`);
	assert.equal(a.run("state.contacts[0].phone"), "");
	assert.equal(a.run("state.contacts[0].note"), "");
});

test("vCard exports cannot inject records or properties through contact fields", () => {
	const a = app();
	const contact = {
		name: "Jane\rInjected: value", role: "Analyst", org: "Example FC",
		phone: "+447700900123\r\nEMAIL:injected@example.com",
		email: "jane@example.com\nTEL:+440000000000",
		url: "https://example.com\r\nEND:VCARD\r\nBEGIN:VCARD\r\nFN:Injected",
	};
	const vcard = a.run(`toVcard(${JSON.stringify(contact)})`);
	const lines = vcard.split(/\r\n|\r|\n/);
	assert.equal(lines.filter((line) => line === "BEGIN:VCARD").length, 1);
	assert.equal(lines.filter((line) => line === "END:VCARD").length, 1);
	assert.equal(lines.filter((line) => line.startsWith("EMAIL:")).length, 1);
	assert.equal(lines.filter((line) => line.startsWith("TEL")).length, 1);
	assert.equal(lines.filter((line) => line.startsWith("FN:")).length, 1);
	assert.ok(!lines.some((line) => line.startsWith("Injected:")));
});

test("a shared contact opens even if the unrelated agenda request fails", async () => {
	const a = app();
	const hash = "#card=" + Buffer.from(JSON.stringify({ n: "Jane Smith", e: "jane@example.com" })).toString("base64url");
	a.context.location.hash = hash;
	a.context.fetch = async () => { throw new Error("agenda unavailable"); };
	a.run("globalThis.opened = null; showReceivedCard = (card) => { opened = card; };");
	await a.run("boot()").catch(() => {});
	assert.equal(a.run("opened?.name"), "Jane Smith");
});

test("an unreadable shared contact gives visible feedback", () => {
	const a = app();
	a.context.location.hash = "#card=eyJuIjo";
	assert.equal(a.run("openSharedCard()"), true);
	assert.equal(a.elements.get("#scan").open, true);
	assert.match(a.elements.get("#scan-body").innerHTML, /could not|cannot|invalid|cut short/i);
});

test("shared cards retain Unicode names and URLs with query parameters", () => {
	const a = app();
	const contact = { name: "Zoë Łukasz", role: "Analyst", org: "Équipe", phone: "+447700900123", email: "zoe@example.com", url: "https://example.com/profile?a=1&b=2" };
	const parsed = a.run(`JSON.stringify(readCardLink(cardLink(${JSON.stringify(contact)})))`);
	assert.deepEqual(JSON.parse(parsed), contact);
	assert.ok(a.run(`toVcard(${JSON.stringify(contact)})`).includes(`URL:${contact.url}\r\n`));
});

test("offline reminder changes retry on reconnection without another edit", async () => {
	const a = app();
	a.run(`state.push = true; state.starred = ['session-a'];
		subscription = async () => ({toJSON: () => ({endpoint: 'https://example.invalid'})});
		globalThis.requests = [];
		post = async (path, body) => { requests.push(body); throw new Error('offline'); };`);
	await a.run("sync()");
	assert.equal(a.run("requests.length"), 1);
	a.run("post = async (path, body) => { requests.push(body); return { scheduled: [{id: 'session-a'}] }; };");
	await a.listeners.get("online")?.();
	await a.flushTimers();
	assert.equal(a.run("requests.length"), 2);
	assert.deepEqual(JSON.parse(a.run("JSON.stringify(requests[1].sessions)")), ["session-a"]);
});

test("failed reminder deletion keeps a retryable subscription and reports failure", async () => {
	const a = app();
	a.run(`state.push = true; globalThis.unsubscribed = false;
		subscription = async () => ({toJSON: () => ({endpoint: 'https://example.invalid'}), unsubscribe: async () => { unsubscribed = true; return true; }});
		post = async () => { throw new Error('offline'); };`);
	await a.listeners.get("#push-toggle:click")();
	assert.equal(a.run("state.push"), true, "keep the off action available to retry");
	assert.equal(a.run("unsubscribed"), false, "retain endpoint until server deletion is acknowledged");
	assert.ok(!a.elements.get("#push-status").textContent.includes("no longer has anything"));
});

test("overlapping reminder changes reach the server in preference order", async () => {
	const a = app();
	let release;
	let started;
	a.context.firstRequest = new Promise((resolve) => { started = resolve; });
	a.context.releaseRequest = new Promise((resolve) => { release = resolve; });
	a.context.started = started;
	a.run(`state.push = true; state.starred = ['old-session'];
		subscription = async () => ({toJSON: () => ({endpoint: 'https://example.invalid'})});
		globalThis.requests = [];
		post = async (path, body) => {
			requests.push(JSON.parse(JSON.stringify(body)));
			if (requests.length === 1) { started(); await releaseRequest; }
			return {scheduled: body.sessions.map(id => ({id}))};
		};`);
	const first = a.run("sync()");
	await a.context.firstRequest;
	a.run("state.starred = ['new-session']");
	const second = a.run("sync()");
	await new Promise((resolve) => setImmediate(resolve));
	assert.equal(a.run("requests.length"), 1, "a newer request must wait for the earlier write");
	release();
	await Promise.all([first, second]);
	await a.flushTimers();
	assert.equal(a.run("requests.length"), 2);
	assert.deepEqual(JSON.parse(a.run("JSON.stringify(requests[1].sessions)")), ["new-session"]);
});

test("turning reminders off waits for the last sync before deleting server data", async () => {
	const a = app();
	let release;
	let started;
	a.context.firstRequest = new Promise((resolve) => { started = resolve; });
	a.context.releaseRequest = new Promise((resolve) => { release = resolve; });
	a.context.started = started;
	a.run(`state.push = true; state.starred = ['session']; globalThis.events = [];
		subscription = async () => ({toJSON: () => ({endpoint: 'https://example.invalid'}), unsubscribe: async () => {events.push('browser-unsubscribe'); return true;}});
		post = async (path) => {
			events.push(path);
			if (path === '/api/sync') { started(); await releaseRequest; events.push('sync-complete'); }
			return {scheduled: [{id: 'session'}]};
		};`);
	const syncing = a.run("sync()");
	await a.context.firstRequest;
	const disabling = a.listeners.get("#push-toggle:click")();
	await new Promise((resolve) => setImmediate(resolve));
	assert.equal(a.run("events.length"), 1, "deletion must not race with an earlier sync");
	release();
	await Promise.all([syncing, disabling]);
	await a.flushTimers();
	assert.deepEqual(JSON.parse(a.run("JSON.stringify(events)")), ["/api/sync", "sync-complete", "/api/unsubscribe", "browser-unsubscribe"]);
	assert.equal(a.run("state.push"), false);
});
