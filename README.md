# JobManager

Personal job-application tracker that runs locally on this Mac. Track every application through applied → OA → interview rounds → accepted/rejected, with full timestamped history, OA scores and deadlines, interview notes, the resume/cover letter you actually submitted, snapshotted job descriptions, and native screen+audio interview recording.

It can also generate tailored resumes in bulk: a background worker runs your **Resume Builder** plugin through the Codex or Claude Code CLI (see [Application automation](#application-automation-queue-tab)).

Everything is local: a Next.js app talking to a SQLite file on disk. No accounts unless you [set a password](#deploying-behind-a-password) to host it. The only outbound traffic is fetching a job posting you paste in, and — if you use the automation worker — your own Codex/Claude session.

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
- The tracker, documents and URL search work anywhere. The parts that drive local tools — interview
  recording (macOS only) and the Codex/Claude worker — need those tools
  installed and logged in on the same machine.

## Adding jobs from your phone (share sheet)

An iOS Shortcut can send whatever you share (a job link, or a caption or message with links in it)
to `POST /api/import/inbox`. Each link is added to the applications list the same way the Add form does it:
company, title and description come from the posting page when it can be read, and its status starts
as **To apply** (click the company or title on the job page to fix either). Nothing is queued for
automation; to generate a resume, use **automate** on the job.

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

## Application automation (Queue tab)

Paste many job links at once, then let a local background worker extract each posting and generate a tailored
resume. The worker uses your installed **Resume Builder** plugin through the Codex CLI. You review every resume
before it's linked to an application.

Status, by phase:

| Phase | What | State |
| --- | --- | --- |
| 0 | Codex/plugin proof in the worker's non-interactive context | Plugin loads and produces a PDF + LaTeX. Blocked on missing TeX packages (see setup) |
| 1 | Migrations, URL import, durable queue, events, Queue UI | Done |
| 2 | Codex runner, isolation, verification, repair loop, PDF review | Done, plus Claude Code as a second engine (your call) |
| 3 | Verified profile + answer bank, form filling, browser takeover | Greenhouse, Lever and Ashby forms are filled and read back, **never submitted**. Written answers can be AI-drafted from your evidence, then edited by you |
| 4 | Review/submit, submission reconciliation, tracker updates | Not built. **Nothing is ever submitted** |
| 5 | Batch mode, Chrome tab importer, more adapters | Not built |

### Setup

```bash
npm install
npm run codex:doctor      # CLI version, login, plugin, resource hash, LaTeX/poppler, template packages
```

Doctor must print **All checks passed**. Things it can report:

- **Codex login** — run `codex login` yourself in a terminal as the same macOS user that runs the worker. The
  dashboard never asks for or stores a token.
- **Plugin missing/disabled** — the plugin comes from the local marketplace at
  `~/Coding/CodexPlugins/resume-builder-local` (`codex plugin marketplace list`). Keep that folder; the ZIP it came
  from can be deleted. If you move it: `codex plugin marketplace remove <marketplace>`, then
  `codex plugin marketplace add <new path>` and `codex plugin add $RESUME_PLUGIN_REF`.
- **Template packages** — `Example.tex` loads packages TinyTeX doesn't ship by default. Run the
  `tlmgr install …` command doctor prints (currently `preprint titlesec enumitem fancyhdr babel-english`).
  Without them the sandboxed run can't install anything, and the dashboard rejects output built with substitutes.

Settings are in `.env.local`; see `.env.local.example`. `RESUME_PLUGIN_REF` (your plugin's `<plugin>@<marketplace>`
from `codex plugin list`) is required; the rest are optional: `CODEX_BIN`, `CODEX_TIMEOUT_MS`, `RESUME_TARGET_MINUTES`, `CODEX_REASONING_EFFORT` (resume runs default to `medium` even if
your Codex config says `high`, which roughly doubled run time in testing), `RESUME_REPAIR_LIMIT`, `CODEX_MODEL`,
`JOBMANAGER_WORK_ROOT`.

### Codex or Claude

The Queue page has a **Codex | Claude** toggle for which CLI runs Resume Builder on new resumes. Each resume
version shows which engine made it. From any job you can **Generate a fresh version with** either one, or revise a
version on either, and see one pending version per engine side by side.

Both engines run **the same skill files**. For Claude, a small wrapper plugin in `~/.jobmanager/claude-plugin/`
symlinks to the installed Resume Builder skill folder, so edits to the plugin apply to both and the rules aren't
duplicated. Output from either engine goes through the same checks, repair loop, artifact store and review.

Claude runs are `claude -p` with `--restricted` (no personal settings, hooks, CLAUDE.md or MCP servers, and file
tools confined to the attempt folder and skill folder), `--permission-mode dontAsk`, and an OS sandbox for shell
commands with no unsandboxed fallback (no network; writes only in the attempt folder). Unlike Codex, reads of
`~/.ssh`, cloud credentials, browser profiles, Codex's login and this app's `data/` are also denied. They use your
Claude Code login and count against your Claude plan. `npm run codex:doctor` checks both engines;
`npm run codex:smoke -- --engine claude` does a timed Claude run.

### Running

Two processes: the dashboard and the worker.

```bash
npm run dev        # dashboard, bound to 127.0.0.1:3000
npm run worker     # background worker (Ctrl-C to stop; it hands its current step back)
```

1. **Queue → Import job links**: paste links, one per line, then **Preview**. Each link is labelled as new, already
   tracked (with a link to the existing application), invalid, or unsupported. **Import** creates a normal
   application row for each new link, so it also shows on the dashboard, and queues it.
2. The worker **extracts** the posting. Greenhouse, Lever, Ashby and Workday are read through their public posting
   APIs, which also report closed postings; other sites fall back to page parsing. Each capture is saved as a dated,
   hashed snapshot. If a description is too short, blocked or JS-only, the job waits for you: paste the description
   on the job page (**Edit manually**), then press **Continue** on the queue.
3. The worker runs **Resume Builder**. See [what the worker checks](#what-the-worker-checks).
4. **Review**: expand the row to preview the PDF, see each check and the plugin's own report, and then **Approve**
   (registers it as a resume document and links it to the application), **Request revision** (your notes go back
   through the plugin), or **Reject**.

Row controls: **Pause** (no new step starts), **Cancel/Stop** (a running Codex process is terminated), **Retry**. A
job page for an application you added by hand has a link to put it through the same resume flow.

Fill in **Profile** with facts you've confirmed (name, email, work authorization, sponsorship…). The resume check
compares the PDF's name/email against it; later phases will answer application questions from it.

### What the worker checks

For each attempt it:

- creates a private (0700) folder under `~/.jobmanager/work/job-<id>/`, outside this repo, containing
  `job.json`, the dated `job_description.md`, your verified contact facts, and any revision feedback;
- runs `codex exec --json --sandbox workspace-write --output-schema … -o result.json -` in that folder. Writes are
  limited to the folder (`/tmp` is excluded), there's no network access, and there are no bypass flags. The prompt
  goes through stdin, so no job text or URL ever appears on a command line. The environment is stripped down to
  what Codex needs to find its own login;
- reads **only** the final `-o` file as the result (progress events are just logged), validates it against the
  app's JSON Schema, then checks the files itself: paths must stay inside `output/` (no traversal, absolute paths
  or symlinks), files must be non-empty and newer than the run's start, the PDF must be exactly one page with
  extractable Education/Experience/Projects/Skills text and your verified name/email, and the `.tex` must
  recompile (shell escape off) to the same text as the PDF. It also requires evidence in the run's own commands
  that SKILL.md, the full spec, Example.tex and the content bank were read; the plugin naming itself isn't enough;
- if checks fail, reruns **the plugin** with the concrete failures, up to `RESUME_REPAIR_LIMIT` times, then asks
  you rather than claiming success. Login expiry, usage limits, a missing plugin and missing TeX packages each stop
  with a specific message instead of retrying.

Passing files are copied into `data/artifacts/job-<id>/v<n>/` (read-only, sha256 recorded) with the plugin version,
resource hash, CLI version and token usage. Later versions never overwrite earlier ones.

### Filling the application form (Greenhouse, Lever, Ashby)

Approving a resume on a Greenhouse, Lever or Ashby posting queues a **prepare** step. The worker opens the
application in its own visible Chrome window. That window uses a separate profile in `~/.jobmanager/browser-profile`,
not your normal Chrome, and can only load the employer's application site.

1. **Read the form:** the worker reads every field with its question text and options. It opens each dropdown to
   list its choices but types nothing.
2. **Decide each answer:**
   - **Facts** (name, email, phone, school, GPA, links…) come from your Profile, exactly as entered.
   - **Work authorization and sponsorship** are separate facts, answered only from your explicit Profile answers.
   - **Voluntary demographic questions** follow your Profile's policy. With "decline", it picks the decline option;
     if a question has none, it's asked (required) or left blank (optional). Nothing is inferred.
   - **Attestations** ("I certify…") and **written answers** always come from you, for this application.
   - **Everything else** comes from the answer bank, or it asks you.
   - **Password-like fields** are never filled from your Profile.
3. **Fill what it knows, pause for the rest:** every field it can answer is filled straight away. Anything it can't
   answer confidently is left blank in the tab and shows on the queue row under *Application form*, with the site's
   own options. You can also just type those answers in the browser tab. Search-style dropdowns (school lists,
   places) are searched for your value first; if several results match (e.g. University of Michigan's three
   campuses), you're asked once with the real results, and your pick is reused. Save your answers and pick where each is reused: all applications, this company, or
   this application only. The form is then filled without starting over. Questions that mention the company
   ("How did you hear about Tanium?") are saved with the company name abstracted, so "all applications" reuses them
   for other employers.
   **✨ Draft with AI:** written questions ("Why do you want to work here?", "Describe your experience…") have a
   draft button, for one question or all of them. It runs a short separate task on Codex or Claude. That task can
   read only your content bank, your STAR stories, the resume approved for this job, and the posting. It has no
   shell, no write access and no browser. Drafts land in the answer boxes for you to edit. Anything the answer would
   need that isn't in your evidence (a personal reason for choosing the company, experience the posting asks for
   that you haven't recorded) is flagged in amber. Nothing is saved until you press Save. It takes about 45 seconds
   on Claude or 1½–2 minutes on Codex.
   **🔎 AI-match leftovers:** for questions its rules couldn't answer, this sends only those questions (label, type,
   exact options) plus your Profile values and saved answers to Codex or Claude. The model says which of your facts
   answers which question; no page HTML is sent, and written, attestation and demographic questions are never
   included. Every match is checked: it must cite a real fact, an option must be one of the real options, and typed
   text must be your value word for word. Anything else is rejected and listed. **Stated** matches are saved for this
   application and the form is refilled. **Implied** ones (e.g. "Are you a UNL student?" → "No" because your school
   is Michigan) are only pre-selected for you to confirm. Preference questions (pay, on-site, relocation) are never
   inferred. Takes ~10 s on Claude (about $0.06 in testing).
4. **Fill:** the approved resume is uploaded first, named `<Name>_Resume_<Company>.pdf`, then the rest of the form.
   Follow-up questions revealed by a choice are picked up and answered too.
5. **Read back:** every value is checked against the page. Anything the site's resume parser overwrote is re-entered
   and reported. If a field won't take its value, the step stops and says which one.
6. **You submit, and it's recorded:** while the worker runs, it watches the tab. When the site shows its own
   confirmation ("Thank you for applying" / "Application submitted") and the form is gone, the job moves to *Done*
   as **Submitted**. It also gets an **Applied** entry in its status timeline and a receipt screenshot in
   `data/artifacts/job-<id>/`. If the site shows a warning instead (spam/VPN check, error), the queue row says so.
   Closed the tab, or applied somewhere else? Use **I submitted it** on the queue row.
   The tab is left open as *Ready to submit*. Review it in that window and click Submit yourself. The
   automation has no submit action, and native form submission is blocked while it's typing.

CAPTCHA challenges, sign-in walls and required uploads other than the resume stop with a message, and the tab stays
open for you to take over. Keep the worker running while you review; stopping it closes those tabs, but logins in
the automation profile persist.

### Parallel runs

The worker runs several steps at once, each kind with its own limit (all workers combined; set in `.env.local`):

| Setting | Default | What |
| --- | --- | --- |
| `RESUME_CONCURRENCY` | 2 | Resume generations (Codex or Claude). Higher = faster batches, faster usage burn |
| `FORM_CONCURRENCY` | 2 | Application forms filled at once, each in its own tab |
| `FETCH_CONCURRENCY` | 3 | Posting fetches |

So while two resumes generate, other jobs' postings are fetched and approved jobs' forms are filled. Each
application still has only one step in flight. Limits are enforced in the same atomic database claim that stops two
workers taking the same task. Submitting stays manual: submit each filled tab yourself, and the watcher records
each confirmation as it happens.

### Crash recovery

Queue state lives in SQLite (`tasks`, `workflow_events`, `codex_runs`), so a refresh or restart loses nothing.
Each running step holds a 2-minute lease renewed every 20s. If the worker dies, the next worker resumes the step
from the start in a fresh folder, first stopping any Codex process the dead worker left behind. That process is
only stopped when its pid *and* start time match the recorded run. Two workers can't claim the same task, and
never run two Codex or two browser tasks at once. Steps that can have external effects (future submission) are
never replayed after a crash; they go to `submission_unknown` for you to reconcile.

### Maintenance

```bash
npm run db:migrate -- --check   # migrate a VACUUM INTO copy of data/app.db and compare row counts
npm run db:migrate              # back up to data/backups/, then migrate (also happens on server start)
npm run codex:smoke             # one real plugin run on a synthetic posting in a throwaway data dir (uses quota)
npm test                        # uses a fake Codex/Claude and local form copies; never real quota, sites or submissions
```

**Refreshing the plugin** is deliberate; nothing syncs from ChatGPT automatically. Re-export it, replace the
marketplace folder's contents, then reinstall so Codex re-caches it:
`codex plugin remove $RESUME_PLUGIN_REF` followed by
`codex plugin add $RESUME_PLUGIN_REF`. (`marketplace upgrade` only applies to
Git marketplaces.) Run `npm run codex:doctor` afterwards. The version and resource hash it prints are recorded on
every run, so it's clear which runs used which bundle.

### Security notes

- Without a password set, the app only answers requests whose Host is `localhost`/`127.0.0.1`, which blocks DNS
  rebinding; with one set, everything requires a signed-in session instead (see
  [Deploying behind a password](#deploying-behind-a-password)). Writes must come from this same origin either
  way, which blocks other sites in your browser (`src/proxy.ts`). The server binds to loopback.
  `JOBMANAGER_ALLOWED_HOSTS` adds names.
- Pasted links, and every redirect they follow, may only reach public hosts on ports 80/443. Local, private,
  link-local and metadata addresses are refused.
- Job pages are treated as data. They reach Codex only as a file the prompt says to treat as untrusted.

### Known limitations

- Codex's macOS sandbox limits **writes and network**, not reads, so a run could still read other files on disk.
  Isolation from other jobs comes from separate folders, `/tmp` exclusion, and never reusing sessions.
- Posting extraction doesn't use the browser; JS-only career sites without a known API need manual paste.
- Form filling covers Greenhouse, Lever and Ashby only. Workday (accounts, multi-page), Oracle, SmartRecruiters
  and Workable are next.
- Visual layout (line wrapping, bottom whitespace) is judged by the plugin's own rendered-page inspection and
  reported in its report. The dashboard doesn't re-judge it.
- Codex usage is significant: the proof run used ~4.8M input tokens (mostly cached) and ~32k output tokens.

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
src/lib/extract.ts     posting extraction (ATS APIs, HTML fallback)
src/lib/queue.ts       durable task queue: leases, heartbeats, retry, pause/cancel
src/lib/automation.ts  import, snapshots, Codex runs, artifacts, profile
src/lib/steps.ts       worker step bodies (extract, resume)
src/lib/codex/*        Codex preflight, subprocess, result schema, artifact verification
src/proxy.ts           password/session gate (or loopback-host check) + same-origin guard
src/lib/auth.ts        password hashing and signed session cookies
worker/index.ts        the automation worker (npm run worker)
scripts/automation-cli.ts  migrate / doctor / smoke
scripts/hash-password.ts   npm run auth:hash
test/*                 node:test suite (npm test) with a fake Codex
src/app/api/*          route handlers: jobs, events, documents, recordings, parse, queue, import, auth
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
