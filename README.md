# tgg26

An unofficial pocket agenda for [TGG Live 2026](https://trainingground.guru/tgg-live/) at Old Trafford, live at **[tgg26.withqwerty.com](https://tgg26.withqwerty.com)**. Not affiliated with Training Ground Guru.

Add it to your phone's home screen and it works like an app:

- **Agenda**: both days, with rooms, logistics and speaker bios. It works offline once loaded.
- **My plan**: star sessions to see just your day, with clashes flagged and the free time between sessions.
- **Reminders**: a push notification before each starred session (iPhone: the app must be opened from the home screen). A calendar (.ics) export is the fallback.
- **Notes**: a notes box on every session.
- **Your contact card**: enter your name, role, club, mobile, email and link once. The app draws QR codes for a contact card (any phone camera can save it to contacts), a WhatsApp chat and an email.
- **Scan people**: the camera button reads someone else's code into your People list, noting the session you met in. You can export contacts as .vcf.

## Privacy

Stars, notes, your card and your contacts live in the phone's `localStorage` and never leave it. The QR codes are drawn on the device. The server stores something only if you turn reminders on: an anonymous push subscription and the ids of your starred sessions. Turning reminders off deletes both.

## How it works

A Cloudflare Worker serves the static app from `public/` and a small API:

| Route | Purpose |
| --- | --- |
| `GET /agenda.json` | The agenda (`src/agenda.json`), shared by the page and the Worker |
| `GET /api/vapid` | The VAPID public key |
| `POST /api/sync` | Replace a device's reminders: `{ subscription, lead, sessions }` |
| `POST /api/test` | Send a test notification |
| `POST /api/unsubscribe` | Forget a device |
| `GET /api/plan.ics?ids=…&lead=…` | Calendar file for the given sessions (stateless) |

iOS web apps cannot schedule local notifications, so reminders use Web Push. A cron runs every minute and sends what is due from D1. Payloads are encrypted with [`@block65/webcrypto-web-push`](https://github.com/block65/webcrypto-web-push).

QR generation uses [qrcode-generator](https://github.com/kazuhikoarase/qrcode-generator) (MIT). Scanning uses the browser's `BarcodeDetector` where it exists, and [jsQR](https://github.com/cozmo/jsQR) (Apache-2.0) elsewhere, including on iPhone. Both are vendored in `public/vendor/`.

## Run your own

```bash
pnpm install
npx wrangler d1 create tgg26                          # put the id in wrangler.jsonc
npx wrangler d1 execute tgg26 --remote --file=schema.sql
node -e "const {generateKeyPairSync:g}=require('crypto');const j=g('ec',{namedCurve:'prime256v1'}).privateKey.export({format:'jwk'});console.log('VAPID_PUBLIC_KEY='+Buffer.concat([Buffer.from([4]),Buffer.from(j.x,'base64url'),Buffer.from(j.y,'base64url')]).toString('base64url')+'\nVAPID_PRIVATE_KEY='+j.d)" > .dev.vars
npx wrangler secret put VAPID_PUBLIC_KEY               # values from .dev.vars
npx wrangler secret put VAPID_PRIVATE_KEY
npx wrangler deploy
```

Change `routes` and `VAPID_SUBJECT` in `wrangler.jsonc` to your own domain and email. For local work, `npx wrangler dev` reads `.dev.vars`.

To reuse it for another event, edit `src/agenda.json`. Times are local UK time; the offset is `UK_OFFSET` in `src/index.ts` and `public/app.js`.

## Licence

MIT. See [LICENSE](LICENSE). Made by [Rahul Keerthi](https://www.linkedin.com/in/rahulkeerthi) · [withqwerty](https://www.withqwerty.com).
