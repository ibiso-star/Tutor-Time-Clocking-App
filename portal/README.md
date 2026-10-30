# Shift Portal

A standalone, zero-login shift tracker. Employees record when they start, take breaks and finish, either from a **personal secure link** on their own phone or at a **shared tablet kiosk** by scanning a badge QR or typing its code. There are no accounts, passwords or sessions for employees.

It's a separate module from the main Tutor Time Clock app (`../`): its own package, database schema, API and frontend. It's designed to plug into a central website later through **webhooks** (push) or the **REST event feed** (pull).

```
 phone ──(personal link)──┐                                   ┌──▶ webhook POST (signed)  ──▶ central site
                          ├──▶  /api/v1  ──▶ PostgreSQL ──────┤
 tablet ─(kiosk + badge)──┘     stateless     shift.* schema  └──◀ GET /api/v1/events     ◀── central site
 admin ──(API key)────────────▶                append-only
```

## How identification works

| Who | Credential | Where it lives | Can do |
|---|---|---|---|
| Employee on their phone | Personal link: `https://…/s#t=<256-bit token>` | The URL **fragment**, which browsers never send to servers, in Referer headers, or into server logs. It isn't stored in browser storage. | Clock in/out and breaks for **that one employee**; see their own day |
| Shared tablet | Kiosk token, stored on the device after opening a one-time pairing link | `localStorage` on that tablet; stripped from the address bar on pairing | Identify an employee **by badge** and punch for them. It never shows history. |
| Employee at the kiosk | Badge code `XXXX-XXXX-XXXX` (60 bits), on a printed badge as a QR code | The badge | Nothing on its own: it only works together with a paired kiosk token |
| Admin / central system | API key (`PORTAL_API_KEY`) | Server env; the admin page keeps it in the tab's `sessionStorage` only | Manage people and kiosks, read events and timesheets, retry webhooks |

- The server stores only SHA-256 hashes of links, badges and kiosk tokens.
- Each credential can be **rotated or revoked on its own**, and the old one stops working immediately.
- Per employee, you can turn off personal links (for example, to require clocking in on site) or turn off kiosk access.
- Every request carries its own credential, so the API is stateless and scales horizontally.

## What's guaranteed

- **Official time is the server's.** The device's clock is stored only as `client_time`, for context.
- **One punch per tap.**
  - Every punch carries an `Idempotency-Key`; retrying it can't record twice.
  - Concurrent taps are serialized with a row lock.
- **Valid sequences only.** The order is OUT → IN → BREAK → IN → OUT. Ending a shift while on a break records the break end as its own event, and only when the person explicitly chooses "End break and end shift".
- **Append-only.** A database trigger rejects any UPDATE or DELETE on events. Corrections belong in the central system.
- **No lost or duplicated webhooks.** Each message is written to an outbox in the same transaction as its event. Deliveries are claimed with `SKIP LOCKED`, so concurrent workers never double-send, and failures retry with exponential backoff (30 s up to 6 h, 12 attempts).

## Run it

```bash
cd portal
npm install
cp .env.example .env                  # set PORTAL_API_KEY (32+ chars)
npm run db:migrate                    # creates the `shift` schema
npm run dev                           # API on :3010, web on :5180
```

Open `http://localhost:5180/admin`, enter the API key, then:

1. Add a person. You get their personal link (with a QR code) and a printable kiosk badge.
2. Open **Kiosks**, create one, and open its pairing link on the tablet.

Production: `npm run build && npm start` serves the API and the frontend from one process. A `Dockerfile` and a Vercel config are included.

| Script | Purpose |
|---|---|
| `npm test` | Unit + integration tests against PostgreSQL (`TEST_DATABASE_URL`, default `shift_test`; the schema is dropped and recreated) |
| `npm run typecheck` | Server and web |
| `npm run build` | `dist/server` + `dist/web` |

## Integrating with the central website

The full contract is in [`openapi.yaml`](openapi.yaml), also served at `/api/v1/openapi.yaml`.

### Mapping people
Give each employee an `external_ref` equal to their id in the central system, either in the admin page or with `POST /api/v1/employees`. Every event carries it in `employee.external_ref`.

### Pull: event feed
```bash
curl -H "Authorization: Bearer $PORTAL_API_KEY" "https://shift.example.org/api/v1/events?after=0&limit=500"
```
- Events come back in `seq` order.
- Store `next_cursor` and pass it as `after` next time. An empty page means you're caught up.
- `seq` and `id` are stable, so ingestion can be idempotent.

### Push: webhooks
Set `WEBHOOK_URL` and `WEBHOOK_SECRET` (`whsec_` followed by base64 of 32 random bytes). Each event is POSTed as:
```json
{ "type": "shift.clock_in", "schema_version": 1, "timestamp": "2026-10-30T09:02:13.123Z",
  "data": { "id": "…", "seq": 42, "type": "clock_in", "occurred_at": "…", "session_id": "…",
            "employee": { "id": "…", "external_ref": "user-42", "display_name": "Ada Lovelace" },
            "source": "kiosk", "kiosk_id": "…", "state_after": "IN", "client_time": "…" } }
```
The headers follow [Standard Webhooks](https://www.standardwebhooks.com):
- `webhook-id` is the event id; use it to de-duplicate retries.
- `webhook-timestamp` is the send time.
- `webhook-signature` is `v1,<base64 signature>`.

Verify the signature before trusting the body:

```js
import { createHmac, timingSafeEqual } from "node:crypto";

function verify(rawBody, headers, secret /* "whsec_..." */) {
  const key = Buffer.from(secret.replace(/^whsec_/, ""), "base64");
  const signed = `${headers["webhook-id"]}.${headers["webhook-timestamp"]}.${rawBody}`;
  const expected = Buffer.from(createHmac("sha256", key).update(signed).digest("base64"));
  const ageSeconds = Math.abs(Date.now() / 1000 - Number(headers["webhook-timestamp"]));
  return ageSeconds < 300 && headers["webhook-signature"].split(" ").some((sig) => {
    const given = Buffer.from(sig.replace(/^v1,/, ""));
    return given.length === expected.length && timingSafeEqual(given, expected);
  });
}
```

Delivery:
- **Long-running server:** it retries in the background.
- **Serverless (e.g. Vercel):** each punch is delivered immediately. Retries run whenever something calls `POST /api/v1/webhooks/deliver` with the API key. That can be the admin page's **Retry now** button, or a scheduler running every few minutes.

### Event meaning
`type` uses the same names as the main Tutor Time Clock (`clock_in`, `break_start`, `break_end`, `clock_out`). `session_id` groups one shift from clock-in to clock-out.

## Deploying on Vercel

1. Create a Vercel project with **Root Directory** `portal`. `vercel.json` sets up the API function, SPA routes and security headers.
2. Set the environment variables: `DATABASE_URL` (Supabase *transaction pooler*, port 6543), `DATABASE_SSL=require` or `DATABASE_CA_CERT`, `PORTAL_API_KEY`, `PUBLIC_BASE_URL`, `PORTAL_TIMEZONE`, and optionally `WEBHOOK_URL`/`WEBHOOK_SECRET`.
3. Run `npm run db:migrate` once against the database before the first deploy.

## Known limits and choices

- **A personal link is a bearer credential.** Anyone holding it can punch as that person. Send links privately, rotate them if one leaks, or turn links off for people who must clock in on site.
- **Kiosk "buddy punching".** At the kiosk, someone with a colleague's badge could punch for them. Badges are cheaper to reissue than passwords, and every punch records which kiosk it came from. Add a PIN step if this matters to you.
- **No offline punching.** Punches need a connection so the official time is the server's. The UI says so plainly and never claims a punch it couldn't confirm.
- **Rate limits are per process.** Add a shared store (e.g. Redis) before running several instances.
- **The kiosk camera** uses the front camera with on-device QR decoding. Nothing is uploaded, and typing the code always works as a fallback.
