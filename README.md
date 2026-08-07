# JobManager

Personal job-application tracker that runs locally on this Mac. Track every application through applied → OA → interview rounds → accepted/rejected, with full timestamped history, OA scores and deadlines, interview notes, the resume/cover letter you actually submitted, snapshotted job descriptions, and native screen+audio interview recording.

It also generates tailored resumes by driving your ChatGPT **Resume Builder** Custom GPT through a local browser-automation gateway — no OpenAI API credits needed.

Everything is local: a Next.js app talking to a SQLite file on disk. No accounts. The only outbound traffic is fetching a job posting you paste in, and — if you use resume generation — your own ChatGPT session.

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

To run the tracker **and** the resume generator together, use `npm run start:all` instead — see
[Resume generation](#resume-generation) below.

All data lives in `data/` (SQLite DB, uploaded documents, recording `.mov` files) and is gitignored — back that folder up if you care about it.

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

### Resume generation

Paste a job description, get back a resume tailored to it by your own ChatGPT Custom GPT — saved
as a document and linked to the application, like any resume you'd upload.

It uses your existing **ChatGPT Plus** subscription rather than the paid API. See
[How resume generation works](#how-resume-generation-works) for the setup and the caveats.

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

## How resume generation works

### The problem it solves

The resume tailoring lives in a ChatGPT **Custom GPT** ("Resume Builder") with its own system
prompt and knowledge files. Using it from an app would normally mean the OpenAI API — a separate
paid product, on top of the ChatGPT Plus subscription that already includes that GPT.

So instead of calling the API, this drives the *real* ChatGPT web session in an automated browser.

### The pieces

```
JobManager (Next.js, :3000)
  └── POST /api/generate-resume
        └── CatGPT-Gateway (Python + Playwright, :8000)   ← cloned as a sibling directory
              └── a real Chrome window, logged into your ChatGPT account
                    └── your Resume Builder Custom GPT
```

[CatGPT-Gateway](https://github.com/GautamVhavle/CatGPT-Gateway) exposes an OpenAI-shaped
`/v1/chat/completions` endpoint, but instead of calling OpenAI it types into a real ChatGPT page
and scrapes the reply. Upstream can't do two things this needs, so it's patched on clone:

1. **Reach a Custom GPT.** Upstream hardcodes `chatgpt.com` and ignores the `model` field, so you'd
   get plain ChatGPT with none of your GPT's prompt or knowledge files.
2. **Return the generated PDF.** Upstream only handles DALL·E image downloads and otherwise scrapes
   text, so the resume PDF was discarded.

Patches live in [`gateway-patch/`](gateway-patch/) and are re-applied on every start, so a fresh
clone or an upstream pull stays patched. Details and troubleshooting:
[`gateway-patch/README.md`](gateway-patch/README.md).

### First-time setup

```bash
cp .env.local.example .env.local    # set GATEWAY_TOKEN; CUSTOM_GPT_URL is prefilled
npm run start:all
```

`start:all` clones the gateway next to this repo, installs it, applies the patches, writes its
config from your `.env.local`, waits for it to be healthy, then starts JobManager.

The first run stops and asks you to log in once — that part is interactive:

```bash
cd ../CatGPT-Gateway
./.venv/bin/python scripts/first_login.py   # log into ChatGPT in the window that opens
```

Then `npm run start:all` again. The session persists in `browser_data/` for days-to-weeks; when it
expires, generation starts failing and you re-run that command.

> A Chrome banner reading **"unsupported command-line flag: --host-resolver-rules"** is expected
> and harmless — it's upstream's Docker DNS workaround. Ignore it. Only if pages *fail to load*,
> set `SKIP_HOST_RESOLVER_RULES=true` in `.env.local`.

### Using it

**From an application** — open a job with a saved description and click **Generate resume** on the
job-description section. The result is saved as a resume *and* linked to that application, exactly
as if you'd uploaded it and picked it from the dropdown.

**Standalone** — the **Generate** tab takes a pasted description and saves the resume unlinked,
for when there's no application yet. It also lists recent generations, including failed ones.

Either way a run takes roughly a minute: page load, human-paced typing, the model thinking, then
the PDF being built. Requests are queued one at a time; keep the Chrome window open but ignore it.

### Preview and revising

A generated resume gets a **Generated resume** panel — on the job page, and right after generating
on the Generate tab. It previews the PDF inline and has a message box under it.

Sending a message there continues the *same ChatGPT conversation*, so the GPT still has the job
description and the resume it just produced in context — "move projects above experience" is enough.
The new PDF **overwrites the file in place**, keeping the same document row, so anything already
linked to that resume follows the new version.

Revising needs a linked conversation, so it only works on resumes generated after this feature
landed; older ones show a note instead of the message box.

### What gets saved

A generated resume is an ordinary document row — it appears on the Resumes tab, opens through
`/api/documents/{id}/file`, and can be renamed or archived like an upload. It's marked with a
`generated` pill, remembers which posting it came from, and takes the job's resume slot (the
previous one is unlinked, not deleted).

Files are named **`<RESUME_NAME>_Resume_<Company>.pdf`** — e.g. `Vaman_Rajagopal_Resume_Roblox.pdf`.
`RESUME_NAME` comes from `.env.local`; the company comes from the job, or from the optional company
field on the Generate tab.

Every run also writes a `generations` row — input, reply text, success/failure — so failures leave
a visible trace instead of vanishing.

**If no PDF comes back**, the reply is saved as a `.md` resume and flagged with a warning rather
than erroring out. That's the normal symptom of ChatGPT changing its UI and breaking download
capture; nothing is lost, and the fix is in
[`gateway-patch/README.md`](gateway-patch/README.md#when-it-breaks).

### Caveats

- **Brittle by nature.** Download capture depends on ChatGPT's DOM and will break on UI changes.
  The `.md` fallback exists so a break costs you formatting, not work.
- **Slow and serial.** One request at a time, ~1 min each. Not for bulk generation.
- **Against OpenAI's ToS.** Automating the ChatGPT web UI violates the Terms of Use. Low-volume
  personal use rarely draws action and the usual escalation is a warning or temporary block, but a
  permanent ban is possible and would take the Plus subscription with it. `HEADLESS=false` and the
  default typing delays are set deliberately — leave them alone, and don't batch-generate. The
  zero-risk alternative is the OpenAI API.
- Leaving the gateway running is fine. Idle, it makes no requests to ChatGPT; it only acts when
  JobManager posts to it.

## Recording permissions (one-time)

The first recording will trigger macOS permission prompts for **Screen & System Audio Recording** and **Microphone**, attributed to whatever app hosts the server process (Terminal, iTerm, VS Code…). Grant them in System Settings → Privacy & Security, then start the recording again. If you switch to launching the server from a different app, you may be prompted once more.

## Layout

```
src/lib/db.ts          SQLite schema + migrations (runs on first connection)
src/lib/queries.ts     all DB access
src/lib/search.ts      fuzzy scoring for URL search
src/lib/parser.ts      job-posting fetch/extract
src/lib/recorder.ts    spawns and tracks the native recorder process
src/lib/gateway.ts     talks to the CatGPT gateway (resume generation)
src/app/api/*          route handlers: jobs, events, documents, recordings, parse, generate-resume
src/app/[...slug]/     URL-search catch-all
src/components/*       client components (forms, event cards, pickers)
recorder/JobRecorder.swift   native macOS screen/audio recorder
gateway-patch/         patches + overlay applied to the CatGPT-Gateway clone
scripts/start-all.sh   brings up the gateway and the app together
data/                  gitignored: app.db, documents/, recordings/
../CatGPT-Gateway/     gitignored sibling: the patched Python gateway (cloned by start:all)
```

Schema changes are additive `ALTER TABLE` migrations applied in `open()` in `src/lib/db.ts`, guarded by a `PRAGMA table_info` check, so an existing `data/app.db` upgrades in place on the next server start.

## Notes

- Recordings are `.mov` (H.264 + AAC). Safari plays them natively; Chrome plays H.264/AAC fine too
- Only one recording can run at a time
- If the server restarts mid-recording, the orphaned recording row is marked `failed` on next startup
- Auto-saved fields (event notes, links, OA score) debounce ~600ms and also flush on blur and on page unload, so a refresh mid-typing doesn't lose the edit
- `PATCH` routes only overwrite fields you actually send — omitted fields are left alone
- Resume generation needs `.env.local` (`GATEWAY_TOKEN`, `CUSTOM_GPT_URL`); without it the Generate button returns a clear error rather than failing silently
- If the server restarts mid-generation, the orphaned `pending` row is marked `failed` on next startup, same as recordings
