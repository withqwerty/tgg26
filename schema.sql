-- One row per push subscription (one per device). No user identity is stored.
CREATE TABLE IF NOT EXISTS subs (
	id TEXT PRIMARY KEY,
	endpoint TEXT NOT NULL,
	p256dh TEXT NOT NULL,
	auth TEXT NOT NULL,
	updated INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS reminders (
	sub_id TEXT NOT NULL,
	session_id TEXT NOT NULL,
	fire_at INTEGER NOT NULL,
	title TEXT NOT NULL,
	body TEXT NOT NULL,
	sent INTEGER NOT NULL DEFAULT 0,
	PRIMARY KEY (sub_id, session_id)
);

CREATE INDEX IF NOT EXISTS idx_reminders_due ON reminders (sent, fire_at);
