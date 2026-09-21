# Slack Approval Chaser

A Slack-first approval bot for creative agencies. You send a creative for
sign-off from Slack; your client gets one email link, with no account and no
login; the bot chases them on a schedule and tells you in Slack the moment
something is approved, changed, or about to be late.

It does one thing. It is not project management, a CRM, file storage, or
proofing software.

```
Slack: /approval create
   ↓
client gets an email with a private link
   ↓
client approves  ──or──  requests changes
   ↓                          ↓
Slack thread updates     Slack thread updates, reminders stop
   ↓
no response? → 12h, 4h and 2h reminders → deadline warning → overdue → agency escalated in Slack
```

---

## What's here

| Layer | Where | What it does |
|---|---|---|
| Slack adapter | `src/app/api/slack/*`, `src/lib/slack/` | Signature checks, OAuth install, slash commands, buttons, modals |
| Approval engine | `src/lib/approvals/` | The state machine and every transition |
| Reminder engine | `src/lib/reminders/` | Deterministic planning, the sweep, escalation |
| Notifications | `src/lib/notifications/` | Posting and updating Slack messages |
| Email provider | `src/lib/email/` | `EmailProvider` port, Resend and mock adapters |
| Wording layer | `src/lib/ai/` | `ReminderMessageGenerator` port, template and Anthropic adapters |
| Data layer | `src/lib/db/` | Org-scoped SQL over `pg` |
| Audit | `approval_events`, via `appendEvent` | Every significant action |
| Public client page | `src/app/approve/` | The one page clients ever see |
| Agency view | `src/app/a/[token]` | Read-only detail and history |
| Scheduler | `src/app/api/cron` | Driven by Vercel Cron |

Adding WhatsApp, Teams or Discord later means a new adapter next to
`src/lib/slack/` and `src/lib/email/`. Nothing else has to move.

---

## Running it locally

You need [Node.js](https://nodejs.org) 20.9+ installed. You do **not** need a
Postgres server, an account, or any API keys to start.

**Windows:** double-click **`start.bat`**.
**Mac / Linux:** run **`./start.sh`** in a terminal in this folder.

Either one installs dependencies, generates your local config, loads three
demo approvals, and starts the app — in that order, only doing the steps
that haven't been done yet. Run it again later and it just starts the app.
When it says `Ready`, open <http://localhost:3000>, then paste in one of the
demo links it printed to see a real approval page.

<details>
<summary>Or, step by step (what the script above is doing)</summary>

```bash
npm install
npm run setup    # creates .env.local and generates its random secrets
npm run db:seed  # optional: three demo approvals
npm run dev
```

`npm run setup` is the whole "generate secrets and paste them in the right
place" step done for you — it's safe to run again later, and leaves anything
you've already filled in alone. The only things left to type by hand are the
Slack app credentials (below), and only if you want Slack; the client side
works without them.

With `DATABASE_URL` left blank, the app runs **PGlite** — real Postgres,
compiled to WASM, persisted in `.pgdata/`. The schema in `db/schema.sql` is
applied automatically. With `RESEND_API_KEY` blank, emails are printed to your
terminal with the approval link included, so you can click straight through.

`npm run db:seed` prints three working client links. Open one and the whole
client side works immediately — including with JavaScript disabled.

</details>

```bash
npm run check       # typecheck + lint + tests
npm test            # 182 tests
npm run db:migrate  # apply db/schema.sql to DATABASE_URL
```

### The minimum to fill in

For the client side alone, nothing: `npm run setup` plus the seed script and
the approval page work out of the box. For Slack you need a Slack app (below).
For real email you need a Resend key and a verified sending domain.

---

## Setting up the Slack app

At <https://api.slack.com/apps>, **Create New App → From scratch**.

**Basic Information** → copy the **Signing Secret**, **Client ID** and
**Client Secret** into `.env.local`.

**OAuth & Permissions** → *Redirect URLs*, add:

```
https://your-app.example.com/api/slack/oauth
```

*Bot Token Scopes*, add these four:

| Scope | Why |
|---|---|
| `commands` | the `/approval` slash command |
| `chat:write` | post and update approval messages |
| `chat:write.public` | post in a channel without being invited first |
| `users:read` | resolve who pressed a button, for the audit trail |

**Slash Commands** → Create, command `/approval`, request URL:

```
https://your-app.example.com/api/slack/commands
```

**Interactivity & Shortcuts** → on, request URL:

```
https://your-app.example.com/api/slack/interactions
```

Then visit `https://your-app.example.com/api/slack/install` and approve. That
one workspace becomes one organization, and the installer gets a **DM in
Slack** the moment it's done — with a button that opens the create modal
directly, so there's no webpage to remember and no command to recall from a
README to send the first approval.

> Slack must reach your machine, so local Slack development needs a tunnel
> (`ngrok http 3000` or similar) and `APP_URL` set to the tunnel's address.

### Commands

| Command | What it does |
|---|---|
| `/approval create` | Opens the modal: client, email, creative, URL, deadline, reminder schedule, notes |
| `/approval list` | What's still open. `list all` includes approved |
| `/approval remind` | Pick an approval and chase it now |
| `/approval cancel` | Pick an approval and close it |

The create modal **prefills the client, email and contact name** from
whichever client you most recently sent an approval to. Most agencies chase
the same handful of clients repeatedly — a second approval to the same client
is then just the creative and the deadline, not the whole form again. Clear
the field yourself the rare time it's someone new.

Each approval posts one message, which is **updated in place** as its status
changes. Reminders, approvals and escalations are **threaded replies** under
it, so one approval is one thread rather than a stream of channel noise.

---

## Environment variables

| Variable | Required | What it is |
|---|---|---|
| `DATABASE_URL` | production | Postgres connection string. Blank in development uses PGlite |
| `APP_URL` | yes | Public origin. Client links are built from it |
| `SLACK_SIGNING_SECRET` | for Slack | Verifies every inbound Slack request |
| `SLACK_CLIENT_ID` | for Slack | OAuth |
| `SLACK_CLIENT_SECRET` | for Slack | OAuth |
| `SLACK_STATE_SECRET` | for Slack | Signs the OAuth `state` and the agency links |
| `TOKEN_ENCRYPTION_KEY` | for Slack | 32 bytes, base64. Encrypts bot tokens at rest |
| `RESEND_API_KEY` | production | Blank in development uses the mock provider |
| `EMAIL_FROM` | for real email | Address on a domain verified with Resend |
| `CRON_SECRET` | yes | Bearer token the scheduler must present |
| `ANTHROPIC_API_KEY` | no | Reminder wording only. Templates are used without it |
| `APPROVAL_TOKEN_TTL_DAYS` | no | Link lifetime, default 30 days |

`npm run setup` generates `SLACK_STATE_SECRET`, `TOKEN_ENCRYPTION_KEY` and
`CRON_SECRET` for you. To generate one by hand instead:

```bash
openssl rand -base64 32                                                   # SLACK_STATE_SECRET / TOKEN_ENCRYPTION_KEY
node -e "console.log(require('crypto').randomBytes(32).toString('hex'))"     # CRON_SECRET
```

---

## The database

Seven tables, in `db/schema.sql`: `organizations`, `users`,
`slack_installations`, `clients`, `approvals`, `reminders`, `approval_events`,
plus `rate_limit_counters`.

Every organization-owned row carries `organization_id` **directly**, even where
a join could reach it. That is deliberate: scoping is then one `WHERE` clause on
every query, which is far harder to forget than a join path. There is exactly
one query in the whole data layer that is not organization-scoped —
`findApprovalByTokenHash` — because the client has no organization context and
their token identifies exactly one row. It is commented as such where it sits.

Apply it with `npm run db:migrate`. Every statement uses `IF NOT EXISTS`, so
re-running is a no-op.

### Approval states

```
draft ──► waiting ──► viewed ──► approved          (terminal)
            │           │    └──► changes_requested ──► waiting   (new cycle)
            └──► overdue ┘
                  └────────────► approved / changes_requested
anything open ─────────────────► cancelled         (terminal)
```

`overdue → approved` is allowed on purpose: a late yes is still a yes.
Transitions are enforced in `src/lib/approvals/state.ts` and every write goes
through a compare-and-set that includes the expected current status, so two
simultaneous decisions cannot both land.

---

## How reminders work

Creating an approval writes one `reminders` row per offset, each with a time on
it. Nothing lives in memory, so the sequence survives a restart, a redeploy and
a cold start. `setTimeout` would not.

`/api/cron` runs every five minutes (`vercel.json`) and:

1. Sends every reminder whose time has come and whose approval is still open.
2. Marks past-deadline approvals overdue and escalates them to Slack once.
3. Prunes old rate-limit windows.

Properties it holds:

- **Deterministic.** A reminder fires because its row says so. The AI is called
  *after* that decision, only to word the message.
- **Idempotent.** `claimReminder` is a conditional `UPDATE`; two overlapping
  cron runs both try, one gets a row, one gets nothing. Exactly one email.
- **Self-cancelling.** Approving, requesting changes or cancelling drops the
  pending rows in the same call.
- **Recalculating.** Moving a deadline rewrites the future rows in place and
  leaves sent ones alone. A deadline pushed further out revives reminders that
  were previously too late to send.
- **Non-retroactive.** An approval created an hour before its deadline records
  the 12h and 4h nudges as `skipped` rather than firing three emails at once.
- **Cycle-aware.** Reopening after a change request starts cycle 2 with a fresh
  sequence, leaving cycle 1's record intact.

Reminders are sent by the agency's own schedule; the client is never emailed
more than the sequence allows, plus any reminder someone sends by hand.

---

## Security

- **Approval tokens** are 32 random bytes (256 bits), base64url. Only their
  SHA-256 is stored, so a database leak yields no working links.
- **Slack requests** are verified against the raw body with a constant-time
  HMAC comparison and a five-minute replay window, before anything is parsed.
- **OAuth install** is CSRF-guarded by a signed, expiring `state` parameter.
- **Bot tokens** are encrypted at rest with AES-256-GCM.
- **The cron endpoint** requires a bearer secret; without it, it would be a
  public button that emails every agency's clients.
- **Public endpoints** are rate-limited by a counter in Postgres — not in
  memory, which across serverless instances would limit nothing.
- **SQL injection** is structurally impossible in the data layer: every value
  is a bound parameter and nothing is interpolated.
- **XSS** is handled at the boundary. Email HTML escapes every interpolated
  value, React escapes by default, generated wording is stripped of markup and
  links, and creative URLs are rejected unless they are `http(s)` — so a pasted
  `javascript:` URL can never become an `href`.
- **Authorization** is derived from the signed Slack `team_id`, never from a
  button value or a form field. A forged approval id reaches a query scoped to
  the *sender's* organization and finds nothing.
- **Clickjacking and leakage**: the approval page sends `X-Frame-Options:
  DENY`, `Referrer-Policy: no-referrer` and `X-Robots-Tag: noindex`.

Reported the same way for any bad link: an expired link, a wrong link and a
rate-limited visitor all get the same page, so guessing gives no signal.

---

## Deploying

Built for Vercel, but it is an ordinary Next.js app.

1. Create a Postgres database (Supabase, Neon, RDS) and run
   `npm run db:migrate` against it.
2. Set every variable from the table above in your host's environment.
   `APP_URL` must be the real public origin.
3. Deploy. `vercel.json` registers the five-minute cron automatically.
4. Point your Slack app's three URLs at the deployed origin and install.

On another host, call `GET /api/cron` every five minutes with
`Authorization: Bearer $CRON_SECRET` from any scheduler.

`GET /api/health` reports process and database health.

---

## Tests

```bash
npm test     # 182 tests
```

The suite runs against **real Postgres in-process** (PGlite), applying
`db/schema.sql` verbatim — so constraints, partial indexes, `ON CONFLICT`
clauses and the organization scoping are all genuinely exercised, not mocked.

Covered: the state machine and every illegal transition; token generation,
hashing and validation; bot-token encryption and tamper detection; signed
agency and reminder links; Slack signature verification including forgery,
replay and a modified body; OAuth state; reminder planning and rescheduling,
including an overdue approval's deadline being pushed out into a genuinely
new reminder cycle; the full loop from create → email → open → approve →
Slack; change requests; cancellation; concurrent decisions; duplicate-reminder
prevention under concurrent sweeps; a claimed reminder being resolved rather
than left stuck when its approval is decided out from under it; reminder
retry and give-up; deadline escalation; overdue escalation firing exactly
once; reopening into a new cycle; organization isolation across ten
scenarios; list pagination carrying its mode and status set across pages;
email templates and escaping; Resend's real idempotency option (not a
lookalike custom header); rate limiting under concurrency; the create-modal
client prefill, including its own cross-organization isolation check; the
install welcome DM, sent exactly once even when two install callbacks race
for the same workspace.

---

## Known limitations

- **One workspace is one organization.** There is no way to merge two
  workspaces into one agency, or to invite a second workspace into an existing
  one.
- **No agency login.** Slack *is* the interface. The web view is read-only and
  reached through a one-hour signed link minted inside Slack. Anything that
  changes state happens in Slack, where the request is signature-verified.
- **Reminder granularity is the cron interval**, five minutes by default.
- **Reminder offsets are relative to the deadline only.** There is no "every
  two days until they answer" mode, and no quiet hours — a 3am deadline gets
  3am reminders.
- **Escalation goes to the approval's thread**, not to a nominated account
  manager. `slack_installations.default_channel_id` exists for this and is not
  yet used.
- **No client-side preview for video.** Images render inline; everything else
  is a link, because framing an arbitrary client-supplied URL is not a preview
  feature.
- **Change requests are one round trip.** The client writes one comment;
  there is no back-and-forth thread on the approval page.
- **`users.email` is never populated** — the Slack profile lookup that would
  fill it is not called, since nothing needs it yet.

## Extension points

- **Another channel**: implement `SlackGateway`'s equivalent for WhatsApp,
  Teams, Discord or Telegram next to `src/lib/slack/client.ts`, and resolve it
  the way `notifications/service.ts` resolves Slack.
- **Another email provider**: implement `EmailProvider` and add one line to
  `src/lib/email/index.ts`.
- **Another wording model**: implement `ReminderMessageGenerator`. The port is
  deliberately narrow — a string in, a string out — so no generator can ever
  change an approval's status, a deadline, or whether a reminder is sent.
- **Per-organization reminder defaults**: `approvals.reminder_offsets` is
  already per-approval; a column on `organizations` would set the default.
