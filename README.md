# JobManager

Personal job-application tracker that runs locally on this Mac. Track every application through applied → OA → interview rounds → accepted/rejected, with full timestamped history, OA scores and deadlines, interview notes, the resume/cover letter you actually submitted, snapshotted job descriptions, and native screen+audio interview recording.

ChatGPT can read and update it, and apply for you through a headless browser on the server (see [Using it from ChatGPT](#using-it-from-chatgpt-mcp)). Tailored resumes are written in ChatGPT and saved here with `upload_document`.

Everything is local: a Next.js app talking to a SQLite file on disk. No accounts unless you [set a password](#deploying-behind-a-password) to host it. The only outbound traffic is fetching a job posting you paste in, and — if you turn on the browser tools — the application portals ChatGPT applies through.

## Setup

```bash
npm install
npm run build:recorder   # compiles the ScreenCaptureKit recorder (requires Xcode CLT)
npm run dev              # http://localhost:3000
```

For a faster production build instead of dev mode:

```bash
npm run build && npm start
```

All data lives in `data/` (SQLite DB, uploaded documents, recording `.mov` files) and is gitignored — back that folder up if you care about it.

## Deploying behind a password

Locally there's no login. To put it on your own server, set a password hash and the whole app
(every page and `/api` route) sits behind a sign-in page.

```bash
npm run auth:hash        # prompts for a password, prints JOBMANAGER_PASSWORD_HASH=scrypt:...
```

Put that line in `.env.local` on the server (or your host's environment settings), then:

```bash
npm ci && npm run build && npm start      # listens on 127.0.0.1:3000
```

and point a reverse proxy with HTTPS at it, e.g. Caddy:

```
jobs.example.com {
  reverse_proxy 127.0.0.1:3000
}
```

- Sessions are a signed, `httpOnly` cookie good for 30 days (`Secure` when served over HTTPS).
  Changing the password signs every session out. **Sign out** is in the nav bar.
- Five wrong passwords from one IP locks that IP out for 15 minutes.
- Nothing is indexed by search engines: every response (login page included) carries
  `X-Robots-Tag: noindex, nofollow`, and pages also have a robots `noindex` meta tag. There's
  intentionally no `robots.txt` Disallow, because a crawler that's blocked from fetching a page
  never sees its noindex.
- While a hash is set, the localhost-only Host check is skipped (the login replaces it); the
  same-origin check on writes stays on.
- The app needs a persistent disk for `data/` (SQLite + files), so use a VPS or a host with volumes
  (Fly.io, Railway, Render disk…), not a serverless platform like Vercel.
- Everything works on a Linux server except interview recording, which is macOS only.

## Adding jobs from your phone (share sheet)

An iOS Shortcut can send whatever you share (a job link, or a caption or message with links in it)
to `POST /api/import/inbox`. Each link is added to the applications list the same way the Add form does it:
company, title and description come from the posting page when it can be read, and its status starts
as **To apply** (click the company or title on the job page to fix either).

1. `npm run inbox:token` and put the printed `JOBMANAGER_INBOX_TOKEN=…` line in the server's `.env.local`,
   then restart the app.
2. On the iPhone, in Shortcuts, make a new shortcut named e.g. **Add to JobManager**:
   - Turn on **Show in Share Sheet** (in the shortcut's settings), accepting **URLs** and **Text**.
   - **Get Contents of URL**: `https://<your host>/api/import/inbox`, Method **POST**,
     Header `Authorization` = `Bearer <token>`, Request Body **JSON** with one Text field
     `text` = **Shortcut Input**.
   - **Get Dictionary Value** `message` from **Contents of URL**, then **Show Notification** with it.
3. Share a posting from Safari, LinkedIn, Instagram, etc. and pick **Add to JobManager**. You'll see
   "Added: Acme — Backend Intern", "Already tracked: …" or "Skipped: …".

- The token is the only check on that one route: it replaces the login, Host and same-origin checks
  there and opens nothing else. Anyone who has it can add jobs, so keep it private. Running
  `npm run inbox:token` again and swapping the value revokes the old one.
- Instagram, Threads, Facebook, TikTok and X post links are skipped, because those pages need a login to
  read. Share the job link from the post (caption or bio) instead.
- Your phone has to reach the server, so in practice this means the deployed app over HTTPS.
  `curl -X POST https://<host>/api/import/inbox -H "Authorization: Bearer <token>" -d 'https://…'`
  tests it without the phone.

## Using it from ChatGPT (MCP)

A small [MCP](https://modelcontextprotocol.io) server lives at `/api/mcp/<token>`. By default it's
read-only:

- `list_applications` lists or searches applications, newest first, with id, company, title, status,
  posting link, location and dates. Optional `status` (e.g. `to_apply`) filters by current status,
  `query` searches company, title and posting URL (every word must match), and `limit` caps the rows
  (default 50, max 500; the result says when it was cut short).
- `get_application` takes an `id` and returns that application in full: notes, the saved posting
  (location and description), its status history (each event with its id, OA scores and dates,
  interview rounds, notes), and which resume and cover letter it used.
- `list_documents` lists or searches resumes and cover letters (archived ones only on request).

Set `JOBMANAGER_MCP_WRITE=1` to also allow edits. Nothing can be deleted this way:

- `update_application` changes company, title, posting URL, general notes (`notes` replaces them,
  `append_notes` adds a paragraph) and the linked resume / cover letter. Only the fields passed change.
- `add_status_update` adds a status (OA, interview, rejected…) with its fields: dates, score, round,
  links, before/after notes. The newest one becomes the current status.
- `update_status_update` edits any field of an existing status event; `null` clears one.
- `upload_document` saves a file you attach in the chat (PDF, Word, text or Markdown, up to 10 MB) as a
  resume or cover letter, the same way the Documents page does: same name → next version, identical
  file → reused. Give it an `application_id` to link it to that application too. ChatGPT passes the
  attachment as a temporary download link (the tool declares `openai/fileParams`); if one has expired,
  attach the file again.

Dates must be ISO 8601 with a timezone (e.g. `2026-10-14T15:00:00-04:00`) and are stored in UTC.

A ChatGPT scheduled task can use it to send you the to-apply list each morning. Custom GPT Actions
can't run in scheduled tasks, but connected apps (including custom MCP connectors) can. Whether
ChatGPT lets a custom connector use write tools depends on your plan: some plans only allow
read-only tools, and ChatGPT asks you to confirm each write.

1. `npm run mcp:token` and put the printed `JOBMANAGER_MCP_TOKEN=…` line in the server's `.env.local`,
   then restart the app.
2. In ChatGPT: **Settings → Apps → Advanced settings → Developer mode** on, then **Create app**
   with MCP server URL `https://<your host>/api/mcp/<token>` and authentication **No authentication**.
3. Start a chat with the app enabled and check it, e.g. "List my to-apply jobs."
4. Schedule it: "Every weekday at 8am, use JobManager to list my to-apply applications as a
   checklist with links, oldest first."

- ChatGPT custom connectors can only use OAuth or no auth (they can't send a fixed header), so the
  token goes in the URL instead. The token is the only check on `/api/mcp/…`, and it opens nothing else.
  With `JOBMANAGER_MCP_WRITE=1`, anyone with the URL can also edit your applications, so keep it
  private. Running `npm run mcp:token` again and swapping the value revokes the old URL. Clients that can send
  headers can instead POST to `/api/mcp` with `Authorization: Bearer <token>`.
- ChatGPT calls from OpenAI's servers, so this needs the deployed app over HTTPS.
  `curl -X POST https://<host>/api/mcp/<token> -H 'Content-Type: application/json' -d '{"jsonrpc":"2.0","id":1,"method":"tools/call","params":{"name":"list_applications","arguments":{}}}'`
  tests it.

### Applying from ChatGPT (browser tools)

With `JOBMANAGER_MCP_BROWSER=1`, ChatGPT can apply for a tracked job by driving a browser on the server: open
the portal, sign up or sign in, fill the form, attach the resume and, if you also allow it, submit. ChatGPT does the
thinking; JobManager does the clicking and enforces the rules below. The browser is headless Chromium inside the
web server itself, so it works on a server with no display. It uses its own profile
(`~/.jobmanager/browser-profile-chatgpt`) and closes after 20 idle minutes.

| Tool | What it does |
| --- | --- |
| `browser_open` | Opens the application page (the ATS form for Greenhouse/Lever/Ashby, else the posting URL) and returns a snapshot |
| `browser_snapshot` / `browser_screenshot` | The page as a list of elements with refs (labels, values, options, errors, CAPTCHA blockers), or as an image |
| `browser_click` / `browser_type` / `browser_choose` / `browser_navigate` | Act on a ref; each returns a fresh snapshot |
| `browser_upload` | Attaches the application's linked resume or cover letter, or any document |
| `browser_autofill` | Fills everything your Profile and saved answers cover, and lists what's left |
| `portal_credentials` | `create`: generates a strong password, saves it encrypted, and fills the sign-up form. `sign_in`: fills the saved one |
| `submit_application` | Only with `JOBMANAGER_MCP_SUBMIT=1` as well. Submits with the checks below |

What it guarantees whatever ChatGPT asks:

- **Only the employer's sites.** A tab can go only to the application's own hosts (posting URL, application URL)
  and known ATS domains (`*.myworkdayjobs.com`, `*.greenhouse.io`, `*.icims.com`, …). Add others with
  `JOBMANAGER_BROWSER_EXTRA_HOSTS=careers.example.com,…`.
- **ChatGPT never sees a password.** Passwords are generated per portal, encrypted (AES-256-GCM) with
  `JOBMANAGER_VAULT_KEY`, and typed straight into the page. `browser_type` refuses password fields. Without the
  key, account creation is refused rather than storing anything in plain text. Verification codes sent by email or
  text are yours to give ChatGPT; it doesn't read your email.
- **Submitting is its own step.** `browser_click` refuses any button whose label says it submits the application.
  `submit_application` refuses while a required field is empty or a CAPTCHA is showing. It saves exactly what's
  being sent (`data/artifacts/job-<id>/submission-*.json`) before clicking, and counts the application as submitted
  only when the site shows its confirmation. That adds an **Applied** status and a receipt screenshot. If the site
  shows no confirmation, the application becomes **Submission unknown** and can't be submitted again until you
  check and press **I submitted it** or **It didn't go through** on the job page. ChatGPT is told to get your go-ahead
  before each submit, and ChatGPT itself asks you to confirm the call.
- **CAPTCHAs and bot checks stop it.** They're reported, never worked around. Many portals block headless browsers;
  apply to those yourself.

Setup, on the server:

1. `npm run vault:key` and put the printed `JOBMANAGER_VAULT_KEY=…` line in `.env.local`. Keep a copy: changing
   it makes saved portal passwords unreadable.
2. Add `JOBMANAGER_MCP_BROWSER=1` (and `JOBMANAGER_MCP_SUBMIT=1` if ChatGPT may submit).
3. `npx playwright install --with-deps chromium` once (Linux needs the system libraries `--with-deps` installs).
4. `npm run db:migrate`, then restart the app.

Then: "Apply to my Acme application with JobManager. Make an account if it needs one, and show me the answers
before submitting."

## Features

### Applications

- **Dashboard** — all applications with current status, time-in-state, search/filter, quick status updates
- **Status history** — every change is a timestamped event; the timeline shows elapsed time between stages. Timestamps can be backdated/edited if you log something late
- **Pending** — a waiting state that shows what it follows, e.g. "Pending — after Interview R1"
- **OA events** — score (free text: `3/4`, `270/300`, …), plus sent / submitted / deadline dates and a link to the assessment
- **Interview events** — round number, offered and held dates, a link to the call, and pre-interview / post-interview notes
- **Elapsed time** — measured *between* stages rather than within one: an OA's window runs sent → submitted, an interview's runs offered → held, so "waiting on them" time is what's reported (falls back to the logged timestamp when a milestone date isn't filled in)

### Documents

- **Resumes and cover letters** — upload files, name them, and link one of each to an application from the job page
- **Immutable snapshots** — deleting a document that some application already used only *archives* it. The application keeps pointing at the exact file that was submitted; archived documents just stop showing up in the picker for new applications
- **Usage view** — each document lists which applications reference it

### Job postings

- **Posting snapshots** — pasting a URL fetches and stores the job description (JSON-LD `JobPosting` first, Readability fallback), so it survives the posting being taken down. Bot-blocked or JS-only pages: use *Edit manually* to paste the description

### Interview recording

- Records the full screen + system audio (interviewer) + your mic via ScreenCaptureKit, no matter where the interview runs (Zoom app, Teams, browser). Start/stop from the interview event card; playback inline

### URL search

Any unmatched path is treated as a fuzzy search, so a browser keyword shortcut (e.g. `@jobs` in Chrome pointed at `http://localhost:3000/`) becomes a jump-to-application bar:

| You type | What happens |
| --- | --- |
| `/google` | Google's applications — or straight to it if there's only one |
| `/google/swe-intern` | Closest application at Google to "swe intern" |
| `/search google swe intern` | Free-text: the leading `search` is stripped, the rest is fuzzy-matched |

Matching is typo-tolerant (`gogle` → Google), understands acronyms (`swe` → Software Engineer, `ml` → Machine Learning), ignores company-name noise (`Inc`, `LLC`, `the`), and treats dashes, underscores, and `+` as spaces. A single confident match redirects straight to the job page; anything less shows a ranked results table with match percentages.

## Profile

The **Profile** page holds the facts application forms ask for (name, contact, links, school, work
authorization, demographic-question policy…), exactly as you type them. `browser_autofill` answers from it and
from answers saved earlier; it never infers a fact you haven't entered.

The resume-generation queue (Codex/Claude worker, LaTeX review) was removed in favour of ChatGPT. Every resume it
generated is on the Resumes page, the unapproved versions as archived documents; their LaTeX sources stay in
`data/artifacts/`.

## Recording permissions (one-time)

The first recording will trigger macOS permission prompts for **Screen & System Audio Recording** and **Microphone**, attributed to whatever app hosts the server process (Terminal, iTerm, VS Code…). Grant them in System Settings → Privacy & Security, then start the recording again. If you switch to launching the server from a different app, you may be prompted once more.

## Layout

```
src/lib/db.ts          SQLite schema + migrations (runs on first connection)
src/lib/queries.ts     all DB access
src/lib/search.ts      fuzzy scoring for URL search
src/lib/parser.ts      job-posting fetch/extract
src/lib/recorder.ts    spawns and tracks the native recorder process
src/lib/urls.ts        link normalisation, ATS detection, dedup keys
src/lib/netguard.ts    outbound-fetch guard (public hosts only, per-hop redirect checks)
src/lib/inbox.ts       share-sheet inbox: adds shared links as applications
src/lib/profile.ts     Profile facts
src/lib/submission.ts  submission state (workflow_state) for applying through ChatGPT
src/lib/mcp*.ts        MCP server: read, write and browser tools
src/lib/apply/*        browser harness, page snapshots, form reader/filler, answer bank, password vault
src/proxy.ts           password/session gate (or loopback-host check) + same-origin guard
src/lib/auth.ts        password hashing and signed session cookies
scripts/db-migrate.ts      npm run db:migrate
scripts/hash-password.ts   npm run auth:hash
test/*                 node:test suite (npm test), with local copies of application forms
src/app/api/*          route handlers: jobs, events, documents, recordings, parse, import inbox, mcp, auth
src/app/[...slug]/     URL-search catch-all
src/components/*       client components (forms, event cards, pickers)
recorder/JobRecorder.swift   native macOS screen/audio recorder
data/                  gitignored: app.db, documents/, recordings/, artifacts/, backups/
```

Schema changes are numbered entries in `MIGRATIONS` in `src/lib/db.ts`, tracked with `PRAGMA user_version`, so an existing `data/app.db` upgrades in place on the next start. `npm run db:migrate` applies them to the live DB (after a backup) without a restart.

## Notes

- Recordings are `.mov` (H.264 + AAC). Safari plays them natively; Chrome plays H.264/AAC fine too
- Only one recording can run at a time
- If the server restarts mid-recording, the orphaned recording row is marked `failed` on next startup
- Auto-saved fields (event notes, links, OA score) debounce ~600ms and also flush on blur and on page unload, so a refresh mid-typing doesn't lose the edit
- `PATCH` routes only overwrite fields you actually send — omitted fields are left alone
