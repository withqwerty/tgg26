// Every preference lives in this device's localStorage. The server only ever
// sees a push subscription and the ids of starred sessions, and only once the
// user turns reminders on.

const UK_OFFSET = "+01:00";
const KEY = "tgg26:v1";
const KINDS = { talk: "Talk", panel: "Panel", breakout: "Break-out", host: "Host", social: "Social", fringe: "Fringe event", logistics: "Logistics" };

const state = load();
let agenda = null;
let openId = null;

function load() {
	const fallback = {
		starred: [],
		notes: {},
		lead: 10,
		day: null,
		mine: false,
		view: "agenda",
		push: false,
		hideInstall: false,
		me: null,
		qrPick: null,
		contacts: [],
	};
	try {
		return { ...fallback, ...JSON.parse(localStorage.getItem(KEY) || "{}") };
	} catch {
		return fallback;
	}
}

function save() {
	try {
		localStorage.setItem(KEY, JSON.stringify(state));
	} catch {
		// Private mode or blocked storage: the page still works for this visit.
	}
}

const $ = (sel) => document.querySelector(sel);
const esc = (s) =>
	String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]);
const at = (date, hhmm) => Date.parse(`${date}T${hhmm}:00${UK_OFFSET}`);
const isStarred = (id) => state.starred.includes(id);

// ---------------------------------------------------------------- rendering

function renderTabs() {
	const tabs = agenda.days
		.map((d) => {
			const date = new Date(`${d.date}T12:00:00${UK_OFFSET}`).toLocaleDateString("en-GB", {
				weekday: "short",
				day: "numeric",
				month: "short",
			});
			const selected = state.view === "agenda" && d.id === state.day;
			return `<button class="tab" role="tab" data-day="${d.id}" aria-selected="${selected}">${esc(d.label)}<small>${date}</small></button>`;
		})
		.join("");
	const count = state.starred.length;
	$("#tabs").innerHTML =
		tabs +
		`<button class="tab mine" data-mine aria-pressed="${state.mine && state.view === "agenda"}">My plan<small>${count} starred</small></button>` +
		`<button class="tab" role="tab" data-people aria-selected="${state.view === "people"}">People<small>${state.contacts.length} saved</small></button>`;
}

function clashes(day, item) {
	if (!isStarred(item.id)) return [];
	const s = at(day.date, item.start);
	const e = at(day.date, item.end);
	return day.items.filter(
		(o) => o.id !== item.id && isStarred(o.id) && at(day.date, o.start) < e && s < at(day.date, o.end),
	);
}

function renderList() {
	if (state.view === "people") {
		$("#list").innerHTML = renderPeople();
		return;
	}
	const day = agenda.days.find((d) => d.id === state.day);
	const now = Date.now();
	const items = day.items.filter((i) => !state.mine || isStarred(i.id));

	if (!items.length) {
		$("#list").innerHTML = `${renderInfo()}<p class="empty">Nothing starred on ${esc(day.label)} yet.<br>Tap ☆ on a session to add it to your plan.</p>`;
		return;
	}

	// Group parallel sessions (the break-outs) under one time.
	const slots = [];
	for (const item of items) {
		const last = slots[slots.length - 1];
		if (last && last.start === item.start && item.kind !== "break") last.items.push(item);
		else slots.push({ start: item.start, end: item.end, items: [item] });
	}

	let html = "";
	let placedNow = false;
	let prevEnd = null;
	for (const slot of slots) {
		const s = at(day.date, slot.start);
		const e = at(day.date, slot.end);
		if (state.mine && prevEnd !== null) html += gapRow((s - prevEnd) / 60_000);
		prevEnd = Math.max(prevEnd ?? e, e);
		if (!placedNow && now < s && now > at(day.date, day.items[0].start) - 3 * 3600_000 && sameDay(now, day.date)) {
			html += `<div class="nowline" aria-label="Now"></div>`;
			placedNow = true;
		}
		const past = now >= e;
		if (slot.items[0].kind === "break") {
			html += `<div class="break-row${past ? " past" : ""}"><div class="time">${slot.start}</div><div class="lbl">${esc(slot.items[0].title)}${slot.items[0].title === "Close" ? "" : ` · to ${slot.end}`}</div></div>`;
			continue;
		}
		const live = now >= s && now < e;
		if (live) placedNow = true;
		html += `<div class="slot"><div class="time">${slot.start}<small>${slot.end}</small></div><div class="cards">`;
		for (const item of slot.items) html += card(day, item, { past, live });
		html += `</div></div>`;
	}
	$("#list").innerHTML = renderInfo() + html;
}

/** In "My plan", the free time between one starred slot and the next. */
function gapRow(minutes) {
	const m = Math.round(minutes);
	const label =
		m < 0
			? `Overlaps by ${-m} min`
			: m === 0
				? "Back to back"
				: m >= 60
					? `${Math.floor(m / 60)} h${m % 60 ? ` ${m % 60} min` : ""} free`
					: `${m} min free`;
	// Height grows with the gap so long breaks read as long, capped to keep the list compact.
	const h = m <= 0 ? 0 : Math.round(Math.min(8 + Math.sqrt(m) * 6, 72));
	const cls = m < 0 ? "gap clash" : m === 0 ? "gap tight" : m < 10 ? "gap short" : "gap";
	return `<div class="${cls}"><div class="gap-bar" style="height:${h}px"></div><span>${label}</span></div>`;
}

function sameDay(ms, date) {
	return new Date(ms).toLocaleDateString("en-CA", { timeZone: "Europe/London" }) === date;
}

function card(day, item, { past, live }) {
	const starred = isStarred(item.id);
	const clash = clashes(day, item);
	const note = state.notes[item.id] || "";
	const cls = ["card", starred && "starred", past && "past", live && "now", openId === item.id && "open"]
		.filter(Boolean)
		.join(" ");
	const kicker = [
		live ? `<span class="k-now">Now</span>` : "",
		`<span class="${item.kind === "fringe" ? "k-fringe" : ""}">${KINDS[item.kind] || ""}</span>`,
		item.access ? `<span class="k-access">${esc(item.access)}</span>` : "",
		note ? `<span class="note-flag">· Note</span>` : "",
		clash.length ? `<span class="k-clash">· Clashes with ${esc(clash[0].title.replace(/^Break-out: /, ""))}</span>` : "",
	].join("");
	return `<article class="${cls}" id="${item.id}">
		<button class="card-main" data-toggle="${item.id}" aria-expanded="${openId === item.id}">
			<div class="kicker">${kicker}</div>
			<h3>${esc(item.title)}</h3>
			${item.speakers ? `<p class="who">${esc(item.speakers)}</p>` : ""}
			${where(item)}
			<div class="more" data-more>
				${item.note ? `<p>${esc(item.note)}</p>` : ""}
				${item.bio ? `<p>${esc(item.bio)}</p>` : ""}
				${item.location && item.room ? `<p>${esc(item.location)}</p>` : ""}
			</div>
		</button>
		<button class="star" data-star="${item.id}" aria-pressed="${starred}" aria-label="${starred ? "Remove from" : "Add to"} my plan: ${esc(item.title)}">
			<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linejoin="round" aria-hidden="true"><path d="M12 3.5l2.6 5.3 5.8.8-4.2 4.1 1 5.8-5.2-2.7-5.2 2.7 1-5.8-4.2-4.1 5.8-.8z"/></svg>
		</button>
	</article>
	${item.signup ? `<a class="btn signup" href="${esc(item.signup.url)}" target="_blank" rel="noopener">${esc(item.signup.label)} →</a>` : ""}
	${openId === item.id && item.room && agenda.slido ? `<a class="slido-link" href="${esc(agenda.slido)}" target="_blank" rel="noopener">Ask a question on Slido →</a>` : ""}
	${openId === item.id ? `<textarea class="note-input" data-note="${item.id}" placeholder="Notes: who to find, questions to ask…" aria-label="Notes for ${esc(item.title)}">${esc(note)}</textarea>` : ""}`;
}

function where(item) {
	const room = item.room && agenda.rooms?.[item.room];
	if (room) {
		return `<p class="where"><span class="room-dot" style="background:${room.colour}"></span>${esc(room.label)}</p>`;
	}
	return item.location ? `<p class="where">${esc(item.location)}</p>` : "";
}

function renderInfo() {
	if (!agenda.info?.length) return "";
	return `<details class="info"${state.infoOpen ? " open" : ""}>
		<summary>Need to know</summary>
		<a class="btn slido" href="${esc(agenda.slido)}" target="_blank" rel="noopener">Ask a question on Slido</a>
		<ul>${agenda.info.map((l) => `<li>${esc(l)}</li>`).join("")}</ul>
	</details>`;
}

function render() {
	renderTabs();
	renderList();
	renderBanner();
	$("#open-settings").classList.toggle("on", state.push);
}

function renderBanner() {
	const ios = /iPhone|iPad|iPod/.test(navigator.userAgent);
	const standalone = window.navigator.standalone === true || matchMedia("(display-mode: standalone)").matches;
	if (!ios || standalone || state.hideInstall) {
		$("#banner-slot").innerHTML = "";
		return;
	}
	$("#banner-slot").innerHTML = `<div class="banner"><div><b>For reminders, add this to your Home Screen.</b> Tap Share, then “Add to Home Screen”, then open it from there.</div><button data-hide-install aria-label="Dismiss">×</button></div>`;
}

// ---------------------------------------------------------------- events

document.addEventListener("click", (e) => {
	const t = e.target.closest("button, a");
	if (!t) return;
	if (t.dataset.day) {
		state.day = t.dataset.day;
		state.view = "agenda";
		save();
		render();
		scrollTo({ top: 0 });
	} else if (t.hasAttribute("data-people")) {
		state.view = "people";
		save();
		render();
		scrollTo({ top: 0 });
	} else if (t.dataset.contact) {
		contactAction(t.dataset.contact, t.dataset.act, t);
	} else if (t.hasAttribute("data-add-contact")) {
		openScanner({ manual: true });
	} else if (t.hasAttribute("data-export-all")) {
		downloadVcf(state.contacts, "tgg26-contacts.vcf");
	} else if (t.hasAttribute("data-mine")) {
		state.view = "agenda";
		state.mine = !state.mine;
		save();
		render();
	} else if (t.dataset.star) {
		const id = t.dataset.star;
		state.starred = isStarred(id) ? state.starred.filter((s) => s !== id) : [...state.starred, id];
		save();
		render();
		scheduleSync();
	} else if (t.dataset.toggle) {
		openId = openId === t.dataset.toggle ? null : t.dataset.toggle;
		renderList();
	} else if (t.hasAttribute("data-hide-install")) {
		state.hideInstall = true;
		save();
		renderBanner();
	} else if (t.dataset.lead) {
		state.lead = Number(t.dataset.lead);
		save();
		renderSettings();
		scheduleSync();
	} else if (t.dataset.kind) {
		state.qrPick = t.dataset.kind;
		save();
		showMyQr();
	}
});

document.addEventListener(
	"toggle",
	(e) => {
		if (!e.target.matches?.("details.info")) return;
		state.infoOpen = e.target.open;
		save();
	},
	true,
);

document.addEventListener("input", (e) => {
	const id = e.target.dataset?.note;
	if (!id) return;
	const v = e.target.value;
	if (v.trim()) state.notes[id] = v;
	else delete state.notes[id];
	save();
});

// Re-render on focus loss so the "Note" flag appears without stealing focus while typing.
document.addEventListener("focusout", (e) => {
	if (e.target.dataset?.note) renderList();
});

// ---------------------------------------------------------------- my card
// Each device holds its own card. The QR codes are drawn here, so nothing
// about the person is ever sent anywhere.

const FIELDS = [
	["name", "Name", "text", "name"],
	["role", "Role", "text", "organization-title"],
	["org", "Club / organisation", "text", "organization"],
	["phone", "Mobile (with country code)", "tel", "tel"],
	["email", "Email", "email", "email"],
	["url", "LinkedIn or website", "url", "url"],
];

let qrLib = null;
async function qrSvg(text, level = "M") {
	if (!qrLib) {
		qrLib = (await import("/vendor/qrcode.mjs")).default;
		// The library's default encoder drops non-Latin-1 characters (é, ø, ł…).
		qrLib.stringToBytes = (str) => Array.from(new TextEncoder().encode(str));
	}
	const q = qrLib(0, level);
	q.addData(text, "Byte");
	q.make();
	return q.createSvgTag({ cellSize: 4, margin: 8, scalable: true });
}

const vEsc = (v) => String(v).replace(/\\/g, "\\\\").replace(/\n/g, "\\n").replace(/([,;])/g, "\\$1");

function toVcard(c) {
	const parts = String(c.name || "").trim().split(/\s+/);
	const last = parts.length > 1 ? parts.pop() : "";
	const lines = ["BEGIN:VCARD", "VERSION:3.0", `FN:${vEsc(c.name)}`, `N:${vEsc(last)};${vEsc(parts.join(" "))};;;`];
	if (c.org) lines.push(`ORG:${vEsc(c.org)}`);
	if (c.role) lines.push(`TITLE:${vEsc(c.role)}`);
	if (c.phone) lines.push(`TEL;TYPE=CELL:${c.phone}`);
	if (c.email) lines.push(`EMAIL:${c.email}`);
	if (c.url) lines.push(`URL:${c.url}`);
	if (c.note) lines.push(`NOTE:${vEsc(c.note)}`);
	lines.push("END:VCARD");
	return lines.join("\r\n");
}

/** Digits only, in international form, for wa.me. Empty if the number has no country code. */
function waDigits(phone) {
	const p = String(phone || "").trim();
	if (p.startsWith("+")) return p.replace(/\D/g, "");
	if (p.startsWith("00")) return p.slice(2).replace(/\D/g, "");
	return "";
}

function normaliseUrl(u) {
	const v = String(u || "").trim();
	if (!v) return "";
	return /^https?:\/\//i.test(v) ? v : `https://${v.replace(/^\/+/, "")}`;
}

function myQrKinds() {
	const me = state.me;
	const kinds = [["card", "Contact card"]];
	if (waDigits(me.phone)) kinds.push(["whatsapp", "WhatsApp"]);
	if (me.email) kinds.push(["email", "Email"]);
	return kinds;
}

function qrPayload(kind) {
	const me = state.me;
	if (kind === "whatsapp") return { text: `https://wa.me/${waDigits(me.phone)}`, caption: me.phone };
	if (kind === "email") return { text: `mailto:${me.email}`, caption: me.email };
	return {
		text: toVcard({ ...me, note: "Met at TGG Live 2026" }),
		caption: [me.role, me.org].filter(Boolean).join(", "),
	};
}

async function showMyQr() {
	const kinds = myQrKinds();
	// WhatsApp first: one scan opens a chat, and their first message gives you their number too.
	const has = (k) => kinds.some(([x]) => x === k);
	const kind = has(state.qrPick) ? state.qrPick : has("whatsapp") ? "whatsapp" : "card";
	const { text, caption } = qrPayload(kind);
	$("#qr-title").textContent = state.me.name;
	$("#qr-body").innerHTML = `
		<div class="seg qr-seg" role="group" aria-label="What the code shares">
			${kinds.map(([k, label]) => `<button data-kind="${k}" aria-pressed="${k === kind}">${label}</button>`).join("")}
		</div>
		<div class="qr-box" id="qr-box" role="img" aria-label="QR code: ${esc(kinds.find(([k]) => k === kind)[1])}"></div>
		<p class="qr-caption">${esc(caption)}</p>
		<p class="qr-hint">${
			kind === "card"
				? "Any phone camera can scan this and save you as a contact. In this app, the camera button adds you to their People list."
				: kind === "whatsapp"
					? "Their camera opens a WhatsApp chat with you. When they say hi, you have their number too."
					: "Opens a new email to you."
		}</p>
		<button class="btn qr-edit" data-edit-me>Edit my details</button>`;
	// A phone screen is a clean surface, so low error correction keeps the dense contact card easy to scan.
	$("#qr-box").innerHTML = await qrSvg(text, kind === "card" ? "L" : "M");
}

function showMyForm() {
	const me = state.me || {};
	$("#qr-title").textContent = "Your contact card";
	$("#qr-body").innerHTML = `
		<p class="form-intro">Other people scan this to save your details. It stays on this phone and is never uploaded.</p>
		<form id="me-form" class="card-form" novalidate>
			${FIELDS.map(
				([key, label, type, ac]) => `<label>${label}${key === "name" ? " *" : ""}
				<input name="${key}" type="${type}" autocomplete="${ac}" value="${esc(me[key] || "")}"${key === "phone" ? ' placeholder="+44 7…"' : ""}${key === "url" ? ' placeholder="linkedin.com/in/…"' : ""}></label>`,
			).join("")}
			<p class="form-error" id="me-error" role="alert"></p>
			<div class="row"><button class="btn primary" type="submit">Save and show my QR</button>${
				state.me ? '<button class="btn" type="button" data-cancel-edit>Cancel</button>' : ""
			}</div>
		</form>`;
}

function readForm(form) {
	const data = Object.fromEntries(new FormData(form).entries());
	for (const k of Object.keys(data)) data[k] = String(data[k]).trim();
	if (data.url) data.url = normaliseUrl(data.url);
	return data;
}

document.addEventListener("submit", (e) => {
	// getAttribute: a field named "id" or "name" would shadow the form's own properties.
	const formId = e.target.getAttribute("id");
	if (formId === "me-form") {
		e.preventDefault();
		const data = readForm(e.target);
		const err = $("#me-error");
		if (!data.name) return void (err.textContent = "Add your name.");
		if (!data.phone && !data.email && !data.url) return void (err.textContent = "Add at least a mobile, an email or a link.");
		if (data.phone && !waDigits(data.phone)) {
			return void (err.textContent = "Start the mobile with a country code, for example +44.");
		}
		state.me = data;
		save();
		showMyQr();
	} else if (formId === "contact-form") {
		e.preventDefault();
		saveScanned(readForm(e.target));
	}
});

document.addEventListener("click", (e) => {
	if (e.target.closest("[data-edit-me]")) showMyForm();
	else if (e.target.closest("[data-cancel-edit]")) showMyQr();
});

$("#open-qr").addEventListener("click", () => {
	if (state.me) showMyQr();
	else showMyForm();
	$("#qr").showModal();
});
$("#close-qr").addEventListener("click", () => $("#qr").close());

// ---------------------------------------------------------------- scanning

/** Read the contact details out of whatever a QR code holds. */
function parseContact(raw) {
	const text = String(raw || "").trim();
	const c = { name: "", role: "", org: "", phone: "", email: "", url: "" };
	if (/^BEGIN:VCARD/i.test(text)) {
		const unfolded = text.replace(/\r?\n[ \t]/g, "");
		const un = (v) =>
			v
				.replace(/\\n/gi, "\n")
				.replace(/\\([,;\\])/g, "$1")
				.trim();
		for (const line of unfolded.split(/\r?\n/)) {
			const i = line.indexOf(":");
			if (i < 0) continue;
			const key = line.slice(0, i).split(";")[0].split(".").pop().toUpperCase();
			const val = line.slice(i + 1);
			if (key === "FN") c.name = un(val);
			else if (key === "N" && !c.name) {
				const [last, first] = val.split(";").map(un);
				c.name = [first, last].filter(Boolean).join(" ");
			} else if (key === "ORG" && !c.org) c.org = un(val.split(";")[0]);
			else if (key === "TITLE" && !c.role) c.role = un(val);
			else if (key === "TEL" && !c.phone) c.phone = un(val).replace(/^tel:/i, "");
			else if (key === "EMAIL" && !c.email) c.email = un(val);
			else if (key === "URL" && !c.url) c.url = un(val);
		}
		return c;
	}
	if (/^MECARD:/i.test(text)) {
		for (const part of text.slice(7).split(/(?<!\\);/)) {
			const i = part.indexOf(":");
			if (i < 0) continue;
			const key = part.slice(0, i).toUpperCase();
			const val = part.slice(i + 1).replace(/\\(.)/g, "$1");
			if (key === "N") c.name = val.includes(",") ? val.split(",").reverse().join(" ").trim() : val;
			else if (key === "TEL" && !c.phone) c.phone = val;
			else if (key === "EMAIL" && !c.email) c.email = val;
			else if (key === "URL" && !c.url) c.url = val;
			else if (key === "ORG") c.org = val;
		}
		return c;
	}
	if (/^https?:\/\/wa\.me\/qr\//i.test(text)) {
		return { ...c, url: text, hint: "This is a WhatsApp contact QR. WhatsApp hides the number in it, so add their name, and tap WhatsApp later to open the chat." };
	}
	const shared = readCardLink(text);
	if (shared) return { ...c, ...shared };
	const wa = text.match(/^https?:\/\/(?:api\.)?wa\.me\/(\d{6,15})/i) || text.match(/whatsapp\.com\/send\/?\?phone=(\d{6,15})/i);
	if (wa) return { ...c, phone: `+${wa[1]}` };
	if (/^mailto:/i.test(text)) return { ...c, email: decodeURIComponent(text.slice(7).split("?")[0]) };
	if (/^tel:/i.test(text)) return { ...c, phone: text.slice(4) };
	if (/^https?:\/\//i.test(text)) return { ...c, url: text };
	return null;
}

/** The session happening now (or the last one today), to remember where you met. */
function metContext() {
	if (!agenda) return "";
	const now = Date.now();
	let best = null;
	for (const day of agenda.days) {
		for (const item of day.items) {
			const s = at(day.date, item.start);
			if (s <= now && (!best || s > best.s)) best = { s, item, day };
		}
	}
	if (!best || now - best.s > 12 * 3600_000) return "Met at TGG Live 2026";
	return `Met at TGG Live 2026 (${best.item.title}, ${best.day.label})`;
}

let stream = null;
let scanning = false;
let jsQR = null;
let detector = null;

async function decoder() {
	if (detector === null && "BarcodeDetector" in window) {
		try {
			const formats = await window.BarcodeDetector.getSupportedFormats();
			detector = formats.includes("qr_code") ? new window.BarcodeDetector({ formats: ["qr_code"] }) : false;
		} catch {
			detector = false;
		}
	}
	if (!detector && !jsQR) jsQR = (await import("/vendor/jsqr.mjs")).default;
}

async function decodeSource(source, width, height, thorough = false) {
	if (detector) {
		const found = await detector.detect(source).catch(() => []);
		if (found[0]) return found[0].rawValue;
		if (!thorough) return null;
	}
	if (!jsQR) jsQR = (await import("/vendor/jsqr.mjs")).default;
	const scale = Math.min(1, (thorough ? 1400 : 720) / Math.max(width, height));
	const w = Math.round(width * scale);
	const h = Math.round(height * scale);
	const canvas = decodeSource.canvas || (decodeSource.canvas = document.createElement("canvas"));
	canvas.width = w;
	canvas.height = h;
	const ctx = canvas.getContext("2d", { willReadFrequently: true });
	ctx.drawImage(source, 0, 0, w, h);
	const hit = jsQR(ctx.getImageData(0, 0, w, h).data, w, h, {
		inversionAttempts: thorough ? "attemptBoth" : "dontInvert",
	});
	return hit ? hit.data : null;
}

function stopCamera() {
	scanning = false;
	if (stream) for (const t of stream.getTracks()) t.stop();
	stream = null;
}

function scanStatus(msg, kind = "") {
	const el = $("#scan-status");
	if (!el) return;
	el.textContent = msg;
	el.className = `status ${kind}`;
}

function showCameraView() {
	$("#scan-title").textContent = "Scan a contact";
	$("#scan-body").innerHTML = `
		<div class="viewfinder"><video id="scan-video" playsinline muted autoplay></video><div class="frame"></div></div>
		<p class="status" id="scan-status">Starting the camera…</p>
		<div class="row">
			<label class="btn file-btn">Use a photo instead<input type="file" accept="image/*" id="scan-file" hidden></label>
			<button class="btn" data-manual>Type it in</button>
		</div>`;
}

async function startCamera() {
	showCameraView();
	await decoder().catch(console.error);
	if (!navigator.mediaDevices?.getUserMedia) {
		scanStatus("This browser cannot use the camera here. Use a photo of the code instead.", "err");
		return;
	}
	try {
		stream = await navigator.mediaDevices.getUserMedia({
			video: { facingMode: { ideal: "environment" }, width: { ideal: 1280 }, height: { ideal: 720 } },
			audio: false,
		});
	} catch (err) {
		console.error(err);
		scanStatus(
			err.name === "NotAllowedError"
				? "Camera access was refused. Allow it in Settings, or use a photo of the code."
				: "Could not start the camera. Use a photo of the code instead.",
			"err",
		);
		return;
	}
	const video = $("#scan-video");
	if (!video || !$("#scan").open) return stopCamera();
	video.srcObject = stream;
	await video.play().catch(() => {});
	scanStatus("Point the camera at a QR code.");
	scanning = true;
	const tick = async () => {
		if (!scanning) return;
		if (video.readyState >= 2 && video.videoWidth) {
			const text = await decodeSource(video, video.videoWidth, video.videoHeight).catch(() => null);
			if (text && scanning) {
				handleScan(text);
				// A code with no contact in it: keep scanning, but pause so the message can be read.
				if (scanning) setTimeout(tick, 1500);
				return;
			}
		}
		setTimeout(tick, 180);
	};
	tick();
}

function handleScan(text) {
	const contact = parseContact(text);
	if (!contact || !(contact.name || contact.phone || contact.email || contact.url)) {
		scanStatus("That QR code has no contact details in it. Try another.", "err");
		return;
	}
	stopCamera();
	if (navigator.vibrate) navigator.vibrate(40);
	showContactForm(contact, "Scanned");
}

function showContactForm(c, heading) {
	$("#scan-title").textContent = heading;
	$("#scan-body").innerHTML = `
		${c.hint ? `<p class="form-intro">${esc(c.hint)}</p>` : ""}
		<form id="contact-form" class="card-form" novalidate>
			<input type="hidden" name="cid" value="${esc(c.id || "")}">
			${FIELDS.map(
				([key, label, type]) => `<label>${label}<input name="${key}" type="${type}" value="${esc(c[key] || "")}"></label>`,
			).join("")}
			<label>Note<textarea name="note" rows="3" placeholder="What you talked about, follow-ups…">${esc(c.note ?? metContext())}</textarea></label>
			<p class="form-error" id="contact-error" role="alert"></p>
			<div class="row">
				<button class="btn primary" type="submit">Save to People</button>
				${c.id ? "" : '<button class="btn" type="button" data-rescan>Scan again</button>'}
			</div>
		</form>`;
}

function saveScanned({ cid, ...data }) {
	if (!(data.name || data.phone || data.email || data.url)) {
		$("#contact-error").textContent = "Add at least a name, a number, an email or a link.";
		return;
	}
	let saved = cid && state.contacts.find((x) => x.id === cid);
	const isNew = !saved;
	if (saved) Object.assign(saved, data);
	else {
		saved = state.contacts.find(
			(x) => (data.email && x.email === data.email) || (data.phone && waDigits(x.phone) && waDigits(x.phone) === waDigits(data.phone)),
		);
		if (saved) Object.assign(saved, data);
		else {
			saved = { ...data, id: crypto.randomUUID?.() || String(Date.now()), added: Date.now() };
			state.contacts.unshift(saved);
		}
	}
	save();
	state.view = "people";
	render();
	scrollTo({ top: 0 });
	if (isNew) showShareBack(saved, `Saved ${saved.name || "contact"}`);
	else $("#scan").close();
}

// ---------------------------------------------------------------- sharing back

/** Your card as a link. The card rides in the #fragment, which browsers never send to the server. */
function cardLink(me) {
	const short = { n: me.name, r: me.role, o: me.org, p: me.phone, e: me.email, u: me.url };
	for (const k of Object.keys(short)) if (!short[k]) delete short[k];
	const bytes = new TextEncoder().encode(JSON.stringify(short));
	const b64 = btoa(String.fromCharCode(...bytes)).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
	return `${location.origin}/#card=${b64}`;
}

function readCardLink(text) {
	const m = String(text || "").match(/#card=([A-Za-z0-9_-]+)/);
	if (!m) return null;
	try {
		const bin = atob(m[1].replace(/-/g, "+").replace(/_/g, "/"));
		const j = JSON.parse(new TextDecoder().decode(Uint8Array.from(bin, (ch) => ch.charCodeAt(0))));
		const str = (v) => (typeof v === "string" ? v.slice(0, 200) : "");
		const c = { name: str(j.n), role: str(j.r), org: str(j.o), phone: str(j.p), email: str(j.e), url: str(j.u) };
		return c.name || c.phone || c.email || c.url ? c : null;
	} catch {
		return null;
	}
}

function shareMessage(to) {
	const me = state.me;
	const first = String(to.name || "").split(/\s+/)[0];
	return [
		`${first ? `Hi ${first}, good` : "Good"} to meet you at TGG Live. My details:`,
		"",
		[me.name, [me.role, me.org].filter(Boolean).join(", "), me.phone, me.email, me.url].filter(Boolean).join("\n"),
		"",
		`Save me in one tap: ${cardLink(me)}`,
	].join("\n");
}

function showShareBack(c, heading) {
	$("#scan-title").textContent = heading;
	if (!state.me) {
		$("#scan-body").innerHTML = `
			<p class="form-intro">To give ${esc(c.name || "them")} your details too, set up your contact card first. It takes a few seconds and stays on this phone.</p>
			<div class="stack"><button class="btn primary" data-setup-card>Set up my card</button><button class="btn" data-done>Done</button></div>`;
		return;
	}
	const msg = encodeURIComponent(shareMessage(c));
	const wa = waDigits(c.phone);
	const sms = c.phone ? c.phone.replace(/[^\d+]/g, "") : "";
	const links = [
		wa && `<a class="btn" href="https://wa.me/${wa}?text=${msg}" target="_blank" rel="noopener">Send my details on WhatsApp</a>`,
		c.email && `<a class="btn" href="mailto:${esc(c.email)}?subject=${encodeURIComponent("Good to meet you at TGG Live")}&body=${msg}">Send my details by email</a>`,
		// "?&body=" is the form that both iOS and Android Messages accept.
		sms && `<a class="btn" href="sms:${esc(sms)}?&body=${msg}">Send my details by text</a>`,
	].filter(Boolean);
	$("#scan-body").innerHTML = `
		<p class="form-intro">Give ${esc(c.name || "them")} your details too:</p>
		<div class="stack">
			<button class="btn primary" data-show-mine>Show them my QR</button>
			${links.join("")}
			${links.length ? "" : '<p class="form-intro">They shared no number or email, so the QR is the way to do it.</p>'}
			<button class="btn ghost" data-done>Done</button>
		</div>`;
}

/** Someone sent you their card as a link. */
function showReceivedCard(c) {
	$("#scan").showModal();
	$("#scan-title").textContent = c.name || "Shared contact";
	const wa = waDigits(c.phone);
	$("#scan-body").innerHTML = `
		<p class="form-intro">${esc([c.role, c.org].filter(Boolean).join(", "))}</p>
		<ul class="received">${[c.phone, c.email, c.url].filter(Boolean).map((v) => `<li>${esc(v)}</li>`).join("")}</ul>
		<div class="stack">
			<button class="btn primary" data-received="vcf">Add to Contacts</button>
			<button class="btn" data-received="people">Save to People in this app</button>
			${wa ? `<a class="btn" href="https://wa.me/${wa}" target="_blank" rel="noopener">Message on WhatsApp</a>` : ""}
			<button class="btn ghost" data-done>Close</button>
		</div>
		<p class="qr-hint">On iPhone, a link opens in Safari, which keeps separate storage from the Home Screen app. Add to Contacts works everywhere.</p>`;
	received = { ...c, note: "Shared their details after TGG Live 2026" };
}

let received = null;

document.addEventListener("click", (e) => {
	const t = e.target.closest("button");
	if (!t) return;
	if (t.hasAttribute("data-done")) $("#scan").close();
	else if (t.hasAttribute("data-show-mine")) {
		$("#scan").close();
		$("#open-qr").click();
	} else if (t.hasAttribute("data-setup-card")) {
		$("#scan").close();
		$("#open-qr").click();
	} else if (t.dataset.received === "vcf" && received) {
		downloadVcf([received], `${(received.name || "contact").replace(/[^\w-]+/g, "-")}.vcf`);
	} else if (t.dataset.received === "people" && received) {
		saveScanned({ cid: "", ...received });
	}
});

function openSharedCard() {
	if (!location.hash.startsWith("#card=")) return false;
	const c = readCardLink(location.hash);
	// Drop the card from the address bar so a reload or a shared screenshot does not carry it.
	history.replaceState(null, "", location.pathname);
	if (c) showReceivedCard(c);
	return true;
}

function openScanner({ manual = false } = {}) {
	$("#scan").showModal();
	if (manual) showContactForm({}, "Add a contact");
	else startCamera();
}

$("#open-scan").addEventListener("click", () => openScanner());
$("#close-scan").addEventListener("click", () => $("#scan").close());
$("#scan").addEventListener("close", stopCamera);

document.addEventListener("click", (e) => {
	if (e.target.closest("[data-rescan]")) startCamera();
	else if (e.target.closest("[data-manual]")) {
		stopCamera();
		showContactForm({}, "Add a contact");
	}
});

document.addEventListener("change", async (e) => {
	if (e.target.id !== "scan-file" || !e.target.files?.[0]) return;
	stopCamera();
	scanStatus("Reading the photo…");
	try {
		await decoder();
		const bitmap = await createImageBitmap(e.target.files[0]);
		const text = await decodeSource(bitmap, bitmap.width, bitmap.height, true);
		if (text) handleScan(text);
		else scanStatus("No QR code found in that photo. Try a closer, sharper one.", "err");
	} catch (err) {
		console.error(err);
		scanStatus("Could not read that photo.", "err");
	}
});

// ---------------------------------------------------------------- people

function renderPeople() {
	const head = `<div class="people-head">
		<button class="btn primary" data-add-contact>Add manually</button>
		${state.contacts.length ? '<button class="btn" data-export-all>Save all to phone (.vcf)</button>' : ""}
	</div>`;
	if (!state.contacts.length) {
		return `${head}<p class="empty">No one saved yet.<br>Tap the camera at the top to scan someone's QR code.</p>`;
	}
	return (
		head +
		state.contacts
			.map((c) => {
				const wa = waDigits(c.phone);
				const actions = [
					wa && `<a class="chip" href="https://wa.me/${wa}" target="_blank" rel="noopener">WhatsApp</a>`,
					c.phone && `<a class="chip" href="tel:${esc(c.phone.replace(/\s/g, ""))}">Call</a>`,
					c.email && `<a class="chip" href="mailto:${esc(c.email)}">Email</a>`,
					c.url && `<a class="chip" href="${esc(normaliseUrl(c.url))}" target="_blank" rel="noopener">${/linkedin\./i.test(c.url) ? "LinkedIn" : /wa\.me\/qr\//i.test(c.url) ? "WhatsApp" : "Link"}</a>`,
					`<button class="chip" data-contact="${c.id}" data-act="send">Send my details</button>`,
					`<button class="chip" data-contact="${c.id}" data-act="vcf">Save to phone</button>`,
					`<button class="chip" data-contact="${c.id}" data-act="edit">Edit</button>`,
					`<button class="chip danger" data-contact="${c.id}" data-act="delete">Delete</button>`,
				]
					.filter(Boolean)
					.join("");
				return `<article class="person">
				<h3>${esc(c.name || c.email || c.phone || "Unnamed")}</h3>
				${c.role || c.org ? `<p class="who">${esc([c.role, c.org].filter(Boolean).join(", "))}</p>` : ""}
				${c.note ? `<p class="where">${esc(c.note)}</p>` : ""}
				<div class="chips">${actions}</div>
			</article>`;
			})
			.join("")
	);
}

function contactAction(id, act, button) {
	const c = state.contacts.find((x) => x.id === id);
	if (!c) return;
	if (act === "send") {
		$("#scan").showModal();
		showShareBack(c, c.name || "Send my details");
	} else if (act === "vcf") downloadVcf([c], `${(c.name || "contact").replace(/[^\w-]+/g, "-")}.vcf`);
	else if (act === "edit") {
		$("#scan").showModal();
		showContactForm(c, "Edit contact");
	} else if (act === "delete") {
		// Two taps, so a stray tap cannot lose a contact.
		if (button.dataset.armed) {
			state.contacts = state.contacts.filter((x) => x.id !== id);
			save();
			render();
		} else {
			button.dataset.armed = "1";
			button.textContent = "Tap again to delete";
			setTimeout(() => {
				if (button.isConnected) {
					delete button.dataset.armed;
					button.textContent = "Delete";
				}
			}, 3000);
		}
	}
}

function downloadVcf(list, filename) {
	const blob = new Blob([list.map(toVcard).join("\r\n")], { type: "text/vcard" });
	const url = URL.createObjectURL(blob);
	const a = document.createElement("a");
	a.href = url;
	a.download = filename;
	document.body.append(a);
	a.click();
	a.remove();
	setTimeout(() => URL.revokeObjectURL(url), 10_000);
}

// ---------------------------------------------------------------- reminders

const pushSupported = "serviceWorker" in navigator && "PushManager" in window && "Notification" in window;

function renderSettings() {
	for (const b of document.querySelectorAll("#lead button")) b.setAttribute("aria-pressed", Number(b.dataset.lead) === state.lead);
	$("#ics").href = `/api/plan.ics?lead=${state.lead}&ids=${state.starred.join(",")}`;
	$("#ics").toggleAttribute("disabled", !state.starred.length);

	const toggle = $("#push-toggle");
	const help = $("#push-help");
	$("#push-test").hidden = !state.push;
	if (!pushSupported) {
		toggle.disabled = true;
		help.textContent = /iPhone|iPad/.test(navigator.userAgent)
			? "On iPhone, notifications work only after you add this page to your Home Screen (Share → Add to Home Screen) and open it from there. Until then, use the Calendar backup below."
			: "This browser cannot receive push notifications. Use the Calendar backup below.";
		return;
	}
	if (Notification.permission === "denied") {
		toggle.disabled = true;
		help.textContent = "Notifications are blocked for this app. Allow them in Settings → Notifications, then come back.";
		return;
	}
	toggle.disabled = false;
	toggle.textContent = state.push ? "Turn off" : "Turn on";
	toggle.classList.toggle("primary", !state.push);
	help.textContent = "Get a notification before each session you star.";
}

function setStatus(msg, kind = "") {
	const el = $("#push-status");
	el.textContent = msg;
	el.className = `status ${kind}`;
}

let vapidKey = null;
async function getVapidKey() {
	if (vapidKey) return vapidKey;
	const res = await fetch("/api/vapid");
	vapidKey = (await res.json()).publicKey;
	return vapidKey;
}

function b64ToBytes(b64) {
	const pad = "=".repeat((4 - (b64.length % 4)) % 4);
	const raw = atob((b64 + pad).replace(/-/g, "+").replace(/_/g, "/"));
	return Uint8Array.from(raw, (c) => c.charCodeAt(0));
}

async function subscription({ create }) {
	const reg = await navigator.serviceWorker.ready;
	const existing = await reg.pushManager.getSubscription();
	if (existing || !create) return existing;
	return reg.pushManager.subscribe({ userVisibleOnly: true, applicationServerKey: b64ToBytes(await getVapidKey()) });
}

async function post(path, body) {
	const res = await fetch(path, {
		method: "POST",
		headers: { "content-type": "application/json" },
		body: JSON.stringify(body),
	});
	if (!res.ok) throw new Error(`${path} ${res.status}`);
	return res.json();
}

let syncTimer = null;
function scheduleSync() {
	if (!state.push) return;
	clearTimeout(syncTimer);
	syncTimer = setTimeout(sync, 500);
}

async function sync() {
	try {
		const sub = await subscription({ create: false });
		if (!sub) {
			state.push = false;
			save();
			render();
			renderSettings();
			return;
		}
		const { scheduled } = await post("/api/sync", { subscription: sub.toJSON(), lead: state.lead, sessions: state.starred });
		setStatus(
			scheduled.length
				? `${scheduled.length} reminder${scheduled.length === 1 ? "" : "s"} scheduled, ${state.lead ? `${state.lead} min before` : "at the start"}.`
				: "Reminders are on. Star a session to schedule one.",
			"ok",
		);
	} catch (err) {
		console.error(err);
		setStatus("Could not reach the server. Your stars are saved; reminders will update when you are back online.", "err");
	}
}

$("#push-toggle").addEventListener("click", async () => {
	if (state.push) {
		try {
			const sub = await subscription({ create: false });
			if (sub) {
				await post("/api/unsubscribe", { subscription: sub.toJSON() }).catch(() => {});
				await sub.unsubscribe();
			}
		} catch (err) {
			console.error(err);
		}
		state.push = false;
		save();
		setStatus("Reminders are off. The server no longer has anything from this phone.");
		render();
		renderSettings();
		return;
	}
	try {
		setStatus("Asking for permission…");
		const perm = await Notification.requestPermission();
		if (perm !== "granted") {
			setStatus("Permission was not given.", "err");
			renderSettings();
			return;
		}
		await subscription({ create: true });
		state.push = true;
		save();
		render();
		renderSettings();
		await sync();
	} catch (err) {
		console.error(err);
		setStatus(`Could not turn on reminders (${err.message}).`, "err");
	}
});

$("#push-test").addEventListener("click", async () => {
	try {
		const sub = await subscription({ create: false });
		if (!sub) throw new Error("no subscription");
		await post("/api/test", { subscription: sub.toJSON() });
		setStatus("Test sent. It should arrive in a few seconds.", "ok");
	} catch (err) {
		console.error(err);
		setStatus("The test did not send. Try turning reminders off and on again.", "err");
	}
});

$("#open-settings").addEventListener("click", () => {
	renderSettings();
	$("#settings").showModal();
});
$("#close-settings").addEventListener("click", () => $("#settings").close());
for (const d of document.querySelectorAll("dialog")) {
	d.addEventListener("click", (e) => {
		if (e.target === d) d.close();
	});
}

// ---------------------------------------------------------------- boot

function focusHash() {
	if (openSharedCard()) return;
	const id = decodeURIComponent(location.hash.slice(1));
	if (!id || !agenda) return;
	const day = agenda.days.find((d) => d.items.some((i) => i.id === id));
	if (!day) return;
	state.day = day.id;
	state.view = "agenda";
	state.mine = false;
	openId = id;
	render();
	const el = document.getElementById(id);
	if (el) {
		el.scrollIntoView({ block: "center" });
		el.classList.add("flash");
	}
}

function defaultDay() {
	const today = new Date().toLocaleDateString("en-CA", { timeZone: "Europe/London" });
	return (agenda.days.find((d) => d.date === today) || agenda.days[0]).id;
}

async function boot() {
	if ("serviceWorker" in navigator) navigator.serviceWorker.register("/sw.js").catch(console.error);
	const res = await fetch("/agenda.json");
	agenda = await res.json();
	if (!state.day || !agenda.days.some((d) => d.id === state.day) || !sessionStorage.getItem("tgg26:seen")) {
		state.day = defaultDay();
		try {
			sessionStorage.setItem("tgg26:seen", "1");
		} catch {}
	}
	render();
	if (location.hash) focusHash();
	else {
		const live = document.querySelector(".card.now, .nowline");
		if (live) live.scrollIntoView({ block: "center" });
	}
	// Keep "now" current, and refresh a subscription the browser may have rotated.
	setInterval(renderList, 60_000);
	if (state.push) sync();
}

addEventListener("hashchange", focusHash);
navigator.serviceWorker?.addEventListener("message", (e) => {
	if (e.data?.type === "open" && e.data.url) {
		location.hash = new URL(e.data.url, location.origin).hash;
	}
});

boot().catch((err) => {
	console.error(err);
	$("#list").innerHTML = `<p class="empty">Could not load the agenda. Check your connection and reload.</p>`;
});
