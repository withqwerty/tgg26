/**
 * tgg26.withqwerty.com — a pocket agenda for TGG Live 2026.
 *
 * The page keeps every preference on the device. The Worker exists only
 * because iOS cannot schedule a notification locally: a home-screen web app
 * can show one only in response to a push. So a device that turns reminders on
 * sends its push subscription and the ids of its starred sessions; the cron
 * sends each reminder at its time. No name, account or cookie is involved: a
 * device is identified only by a hash of its push endpoint.
 */
import { buildPushPayload, type PushSubscription, type VapidKeys } from "@block65/webcrypto-web-push";
import agenda from "./agenda.json";

interface Env {
	DB: D1Database;
	VAPID_PUBLIC_KEY: string;
	VAPID_PRIVATE_KEY: string;
	VAPID_SUBJECT: string;
}

type Item = (typeof agenda.days)[number]["items"][number] & { speakers?: string; location?: string };

// Every session is on UK time, and both days fall inside BST.
const UK_OFFSET = "+01:00";
const LEADS = new Set([0, 5, 10, 15, 30]);
// A reminder that the cron could not send within this window is dropped, not sent late.
const STALE_MS = 10 * 60_000;

const SESSIONS = new Map<string, { item: Item; startMs: number }>();
for (const day of agenda.days) {
	for (const item of day.items as Item[]) {
		if (item.kind === "break") continue;
		SESSIONS.set(item.id, { item, startMs: Date.parse(`${day.date}T${item.start}:00${UK_OFFSET}`) });
	}
}

export default {
	async fetch(request: Request, env: Env): Promise<Response> {
		const url = new URL(request.url);
		try {
			if (url.pathname === "/agenda.json") return json(agenda, { "cache-control": "no-cache" });
			if (url.pathname === "/api/vapid") return json({ publicKey: env.VAPID_PUBLIC_KEY });
			if (url.pathname === "/api/sync" && request.method === "POST") return await sync(request, env);
			if (url.pathname === "/api/test" && request.method === "POST") return await test(request, env);
			if (url.pathname === "/api/unsubscribe" && request.method === "POST") return await unsubscribe(request, env);
			if (url.pathname === "/api/plan.ics") return ics(url);
		} catch (err) {
			if (err instanceof BadRequest) return json({ error: err.message }, {}, 400);
			throw err;
		}
		return new Response("Not found", { status: 404 });
	},

	async scheduled(_event: ScheduledController, env: Env, ctx: ExecutionContext): Promise<void> {
		ctx.waitUntil(sendDue(env));
	},
} satisfies ExportedHandler<Env>;

class BadRequest extends Error {}

function json(data: unknown, headers: Record<string, string> = {}, status = 200): Response {
	return new Response(JSON.stringify(data), {
		status,
		headers: { "content-type": "application/json; charset=utf-8", ...headers },
	});
}

async function readSubscription(body: unknown): Promise<{ id: string; sub: PushSubscription }> {
	const sub = (body as { subscription?: PushSubscription })?.subscription;
	if (
		!sub ||
		typeof sub.endpoint !== "string" ||
		!sub.endpoint.startsWith("https://") ||
		sub.endpoint.length > 1000 ||
		typeof sub.keys?.p256dh !== "string" ||
		typeof sub.keys?.auth !== "string"
	) {
		throw new BadRequest("A valid push subscription is required");
	}
	const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(sub.endpoint));
	const id = [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, "0")).join("");
	return { id, sub: { endpoint: sub.endpoint, expirationTime: null, keys: sub.keys } };
}

function reminderText(item: Item, lead: number): { title: string; body: string } {
	const when = lead === 0 ? `Now · ${item.start}` : `In ${lead} min · ${item.start}`;
	const where = item.location ? ` · ${item.location.split(",")[0]}` : "";
	return {
		title: item.title,
		body: [`${when}${where}`, item.speakers].filter(Boolean).join("\n"),
	};
}

/** Replace this device's reminders with one per starred session. */
async function sync(request: Request, env: Env): Promise<Response> {
	const body = (await request.json()) as { lead?: number; sessions?: unknown };
	const { id, sub } = await readSubscription(body);
	const lead = Number(body.lead);
	if (!LEADS.has(lead)) throw new BadRequest("lead must be one of 0, 5, 10, 15, 30");
	const ids = Array.isArray(body.sessions) ? body.sessions.filter((s): s is string => typeof s === "string") : [];

	const now = Date.now();
	const rows = ids
		.map((sid) => SESSIONS.get(sid))
		.filter((s) => s !== undefined)
		.map(({ item, startMs }) => ({ item, fireAt: startMs - lead * 60_000 }))
		.filter(({ fireAt }) => fireAt > now);

	const stmts = [
		env.DB.prepare(
			"INSERT INTO subs (id, endpoint, p256dh, auth, updated) VALUES (?1, ?2, ?3, ?4, ?5) ON CONFLICT(id) DO UPDATE SET p256dh = ?3, auth = ?4, updated = ?5",
		).bind(id, sub.endpoint, sub.keys.p256dh, sub.keys.auth, now),
		env.DB.prepare("DELETE FROM reminders WHERE sub_id = ?1").bind(id),
		...rows.map(({ item, fireAt }) => {
			const { title, body: text } = reminderText(item, lead);
			return env.DB.prepare(
				"INSERT INTO reminders (sub_id, session_id, fire_at, title, body) VALUES (?1, ?2, ?3, ?4, ?5)",
			).bind(id, item.id, fireAt, title, text);
		}),
	];
	await env.DB.batch(stmts);
	return json({ scheduled: rows.map(({ item, fireAt }) => ({ id: item.id, fireAt })) });
}

async function unsubscribe(request: Request, env: Env): Promise<Response> {
	const { id } = await readSubscription(await request.json());
	await env.DB.batch([
		env.DB.prepare("DELETE FROM reminders WHERE sub_id = ?1").bind(id),
		env.DB.prepare("DELETE FROM subs WHERE id = ?1").bind(id),
	]);
	return json({ ok: true });
}

async function test(request: Request, env: Env): Promise<Response> {
	const { sub } = await readSubscription(await request.json());
	const res = await push(env, sub, {
		title: "Reminders are on",
		body: "This is how a session reminder will look.",
		tag: "test",
		url: "/",
	});
	return json({ status: res.status }, {}, res.ok ? 200 : 502);
}

async function push(
	env: Env,
	sub: PushSubscription,
	data: { title: string; body: string; tag: string; url: string },
): Promise<Response> {
	const vapid: VapidKeys = {
		subject: env.VAPID_SUBJECT,
		publicKey: env.VAPID_PUBLIC_KEY,
		privateKey: env.VAPID_PRIVATE_KEY,
	};
	const payload = await buildPushPayload({ data, options: { ttl: 900, urgency: "high" } }, sub, vapid);
	return fetch(sub.endpoint, payload);
}

type DueRow = {
	sub_id: string;
	session_id: string;
	title: string;
	body: string;
	endpoint: string;
	p256dh: string;
	auth: string;
};

async function sendDue(env: Env): Promise<void> {
	// The cron runs once a minute, so send anything due in the next 30 s rather
	// than up to a minute late.
	const now = Date.now();
	const { results } = await env.DB.prepare(
		`SELECT r.sub_id, r.session_id, r.title, r.body, s.endpoint, s.p256dh, s.auth
		 FROM reminders r JOIN subs s ON s.id = r.sub_id
		 WHERE r.sent = 0 AND r.fire_at <= ?1 AND r.fire_at > ?2`,
	)
		.bind(now + 30_000, now - STALE_MS)
		.all<DueRow>();
	if (!results.length) return;

	const done: D1PreparedStatement[] = [];
	await Promise.all(
		results.map(async (row) => {
			const sub = { endpoint: row.endpoint, expirationTime: null, keys: { p256dh: row.p256dh, auth: row.auth } };
			const res = await push(env, sub, {
				title: row.title,
				body: row.body,
				tag: row.session_id,
				url: `/#${row.session_id}`,
			}).catch((err: unknown) => {
				console.error("push failed", row.session_id, err);
				return null;
			});
			if (res && (res.status === 404 || res.status === 410)) {
				// The device unsubscribed or reinstalled; forget it.
				done.push(env.DB.prepare("DELETE FROM reminders WHERE sub_id = ?1").bind(row.sub_id));
				done.push(env.DB.prepare("DELETE FROM subs WHERE id = ?1").bind(row.sub_id));
				return;
			}
			if (res && !res.ok) console.error("push rejected", row.session_id, res.status, await res.text());
			// Mark sent even on a transient failure: a late reminder is worse than none.
			done.push(
				env.DB.prepare("UPDATE reminders SET sent = 1 WHERE sub_id = ?1 AND session_id = ?2").bind(
					row.sub_id,
					row.session_id,
				),
			);
		}),
	);
	await env.DB.batch(done);
}

/** A calendar file of the given sessions, for devices without push. Stateless. */
function ics(url: URL): Response {
	const ids = (url.searchParams.get("ids") ?? "").split(",").filter(Boolean);
	const leadParam = Number(url.searchParams.get("lead") ?? 10);
	const lead = LEADS.has(leadParam) ? leadParam : 10;
	const stamp = new Date().toISOString().replace(/[-:]/g, "").replace(/\.\d+/, "");
	const esc = (s: string) => s.replace(/\\/g, "\\\\").replace(/([,;])/g, "\\$1").replace(/\n/g, "\\n");
	const utc = (ms: number) => new Date(ms).toISOString().replace(/[-:]/g, "").replace(/\.\d+/, "");

	const lines = ["BEGIN:VCALENDAR", "VERSION:2.0", "PRODID:-//withqwerty//tgg26//EN", "CALSCALE:GREGORIAN"];
	for (const sid of ids) {
		const s = SESSIONS.get(sid);
		if (!s) continue;
		const day = agenda.days.find((d) => d.items.some((i) => i.id === sid));
		const endMs = Date.parse(`${day?.date}T${s.item.end}:00${UK_OFFSET}`);
		lines.push(
			"BEGIN:VEVENT",
			`UID:${sid}@tgg26.withqwerty.com`,
			`DTSTAMP:${stamp}`,
			`DTSTART:${utc(s.startMs)}`,
			`DTEND:${utc(endMs)}`,
			`SUMMARY:${esc(s.item.title)}`,
			`LOCATION:${esc(s.item.location ?? agenda.venue)}`,
			`DESCRIPTION:${esc([s.item.speakers, agenda.event].filter(Boolean).join("\n"))}`,
			"BEGIN:VALARM",
			"ACTION:DISPLAY",
			`DESCRIPTION:${esc(s.item.title)}`,
			`TRIGGER:-PT${lead}M`,
			"END:VALARM",
			"END:VEVENT",
		);
	}
	lines.push("END:VCALENDAR");
	return new Response(lines.join("\r\n"), {
		headers: {
			"content-type": "text/calendar; charset=utf-8",
			"content-disposition": 'inline; filename="tgg26-plan.ics"',
		},
	});
}
