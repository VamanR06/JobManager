# JobManager

Personal job-application tracker that runs locally on this Mac. Track every application through applied → OA → interview rounds → accepted/rejected, with full timestamped history, OA scores and deadlines, interview notes, the resume/cover letter you actually submitted, snapshotted job descriptions, and native screen+audio interview recording.

Everything is local: a Next.js app talking to a SQLite file on disk. No accounts, no network calls except fetching a job posting you paste in.

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

## Recording permissions (one-time)

The first recording will trigger macOS permission prompts for **Screen & System Audio Recording** and **Microphone**, attributed to whatever app hosts the server process (Terminal, iTerm, VS Code…). Grant them in System Settings → Privacy & Security, then start the recording again. If you switch to launching the server from a different app, you may be prompted once more.

## Layout

```
src/lib/db.ts          SQLite schema + migrations (runs on first connection)
src/lib/queries.ts     all DB access
src/lib/search.ts      fuzzy scoring for URL search
src/lib/parser.ts      job-posting fetch/extract
src/lib/recorder.ts    spawns and tracks the native recorder process
src/app/api/*          route handlers: jobs, events, documents, recordings, parse
src/app/[...slug]/     URL-search catch-all
src/components/*       client components (forms, event cards, pickers)
recorder/JobRecorder.swift   native macOS screen/audio recorder
data/                  gitignored: app.db, documents/, recordings/
```

Schema changes are additive `ALTER TABLE` migrations applied in `open()` in `src/lib/db.ts`, guarded by a `PRAGMA table_info` check, so an existing `data/app.db` upgrades in place on the next server start.

## Notes

- Recordings are `.mov` (H.264 + AAC). Safari plays them natively; Chrome plays H.264/AAC fine too
- Only one recording can run at a time
- If the server restarts mid-recording, the orphaned recording row is marked `failed` on next startup
- Auto-saved fields (event notes, links, OA score) debounce ~600ms and also flush on blur and on page unload, so a refresh mid-typing doesn't lose the edit
- `PATCH` routes only overwrite fields you actually send — omitted fields are left alone
