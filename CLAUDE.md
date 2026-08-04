# JobManager

Local job-application tracker. Next.js (App Router, TS, Tailwind) + SQLite via `better-sqlite3`.

## Never run the dev/prod server

**Do not run `npm run dev`, `npm start`, or any command that starts the server.** The user runs it themselves. Only edit files. Use `npx tsc --noEmit` to check for errors instead of starting the app.

If a schema change is needed, add the `ALTER TABLE` migration in `src/lib/db.ts` (`open()`), and also apply it directly to `data/app.db` with the `sqlite3` CLI so the running server doesn't need a restart.

## Layout

- `src/lib/db.ts` — schema + migrations
- `src/lib/queries.ts` — all DB access
- `src/lib/types.ts` — shared types
- `src/app/api/*` — route handlers (jobs, events, documents, recordings, parse)
- `src/components/*` — client components (forms, event cards, etc.)
- `recorder/JobRecorder.swift` — native macOS screen/audio recorder, compiled via `npm run build:recorder`
- `data/` — gitignored: SQLite DB, uploaded documents, recordings

## Notes

- Auto-save fields (event notes/links/score) debounce ~600ms, then flush on blur and on page unload — don't remove the `beforeunload`/`pagehide` flush, it's what prevents lost edits on refresh.
- `updateEvent`/`updateJob` only overwrite fields explicitly passed (`undefined` = leave alone), so partial PATCHes are safe.
