# JobManager

Personal job-application tracker that runs locally on this Mac. Track every application through applied → OA → interview rounds → accepted/rejected, with full timestamped history, OA scores, interview notes, snapshotted job descriptions, and native screen+audio interview recording.

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

All data lives in `data/` (SQLite DB + recording `.mov` files) — back that folder up if you care about it.

## Features

- **Dashboard** — all applications with current status, time-in-state, search/filter, quick status updates
- **Status history** — every change is a timestamped event; the timeline shows elapsed time between updates. Timestamps can be backdated/edited if you log something late
- **Pending** — a waiting state that shows what it follows, e.g. "Pending — after Interview R1"
- **OA events** — record your score (free text: `3/4`, `270/300`, …)
- **Interview events** — round number plus pre-interview and post-interview notes
- **Posting snapshots** — pasting a URL fetches and stores the job description (JSON-LD `JobPosting` first, Readability fallback), so it survives the posting being taken down. Bot-blocked or JS-only pages: use *Edit manually* to paste the description
- **Interview recording** — records the full screen + system audio (interviewer) + your mic via ScreenCaptureKit, no matter where the interview runs (Zoom app, Teams, browser). Start/stop from the interview event card; playback inline

## Recording permissions (one-time)

The first recording will trigger macOS permission prompts for **Screen & System Audio Recording** and **Microphone**, attributed to whatever app hosts the server process (Terminal, iTerm, VS Code…). Grant them in System Settings → Privacy & Security, then start the recording again. If you switch to launching the server from a different app, you may be prompted once more.

## Notes

- Recordings are `.mov` (H.264 + AAC). Safari plays them natively; Chrome plays H.264/AAC fine too
- Only one recording can run at a time
- If the server restarts mid-recording, the orphaned recording row is marked `failed` on next startup
