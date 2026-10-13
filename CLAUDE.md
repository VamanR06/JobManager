# JobManager

Local job-application tracker. Next.js (App Router, TS, Tailwind) + SQLite via `better-sqlite3`.

## Never run the dev/prod server

**Do not run `npm run dev`, `npm start`, or any command that starts the server.** The user runs it themselves. Only edit files. Use `npx tsc --noEmit` to check for errors instead of starting the app.

If a schema change is needed, add it as a new numbered entry in `MIGRATIONS` in `src/lib/db.ts` (versioned via `PRAGMA user_version`), then apply it to the live DB with `npm run db:migrate` (backs up first) so the running server doesn't need a restart. `npm run db:migrate -- --check` tries it on a copy.

Don't start `npm run worker` or `npm run codex:smoke` against the real data unless asked — they spend Codex usage. `npm test` is safe (fake Codex, scratch DB).

## Layout

- `src/lib/db.ts` — schema + migrations
- `src/lib/queries.ts` — all DB access
- `src/lib/types.ts` — shared types
- `src/app/api/*` — route handlers (jobs, events, documents, recordings, parse)
- `src/components/*` — client components (forms, event cards, etc.)
- `recorder/JobRecorder.swift` — native macOS screen/audio recorder, compiled via `npm run build:recorder`
- `src/lib/queue.ts`, `automation.ts`, `steps.ts`, `codex/*` — application automation (import → extract → Resume Builder via Codex → review)
- `src/lib/apply/*` — form filling: `scan.ts` (in-page reader), `answers.ts` (classification + answer bank), `fill.ts` (adapter; no submit), `browser.ts` (dedicated profile + navigation guard)
- `worker/index.ts` — the automation worker
- `src/proxy.ts` + `src/lib/auth.ts` — request guard: password/session gate when `JOBMANAGER_PASSWORD_HASH` is set, otherwise loopback-host check; same-origin check on writes either way. `/login` and `/api/auth/login` are the only public paths. `/api/import/inbox` (iOS share-sheet Shortcut) skips all of that and instead requires `JOBMANAGER_INBOX_TOKEN` as a bearer token. `/api/mcp/<token>` (MCP server for ChatGPT, `src/lib/mcp.ts`) likewise skips it and requires `JOBMANAGER_MCP_TOKEN` in the path. It's read-only unless `JOBMANAGER_MCP_WRITE=1` turns on the edit tools in `src/lib/mcp-write.ts`; keep write tools behind that flag and don't add delete tools.
- `data/` — gitignored: SQLite DB, uploaded documents, recordings, resume artifacts, DB backups

## Notes

- Auto-save fields (event notes/links/score) debounce ~600ms, then flush on blur and on page unload — don't remove the `beforeunload`/`pagehide` flush, it's what prevents lost edits on refresh.
- `updateEvent`/`updateJob` only overwrite fields explicitly passed (`undefined` = leave alone), so partial PATCHes are safe.
- `jobs.workflow_state` (automation pipeline) is separate from `status_events` (recruiting outcome). NULL = manually tracked job.
- Code passed to Playwright's `page.evaluate` must be a `String.raw` string, not a TS function (tsx injects `__name` helpers, and normal template literals eat regex backslashes).
- Never add a submit action to the form adapter; submission is Phase 4 and must go through verified-submission logic.
- Resume writing belongs to the installed Resume Builder plugin, run through Codex or Claude Code (user's choice, `src/lib/codex/claude.ts`). Both use the same skill files; don't add a separate prompt/rules copy.
