# JobManager

Local job-application tracker. Next.js (App Router, TS, Tailwind) + SQLite via `better-sqlite3`.

## Never run the dev/prod server

**Do not run `npm run dev`, `npm start`, or any command that starts the server.** The user runs it themselves. Only edit files. Use `npx tsc --noEmit` to check for errors instead of starting the app.

If a schema change is needed, add it as a new numbered entry in `MIGRATIONS` in `src/lib/db.ts` (versioned via `PRAGMA user_version`), then apply it to the live DB with `npm run db:migrate` (backs up first) so the running server doesn't need a restart. `npm run db:migrate -- --check` tries it on a copy.

`npm test` is safe (scratch DB, local copies of application forms, headless browser; never real sites or submissions).

## Layout

- `src/lib/db.ts` — schema + migrations
- `src/lib/queries.ts` — all DB access
- `src/lib/types.ts` — shared types
- `src/app/api/*` — route handlers (jobs, events, documents, recordings, parse, import inbox, mcp)
- `src/components/*` — client components (forms, event cards, etc.)
- `recorder/JobRecorder.swift` — native macOS screen/audio recorder, compiled via `npm run build:recorder`
- `src/lib/profile.ts` — Profile facts; `src/lib/submission.ts` — submission state (`workflow_state`) and `markSubmitted`; `src/lib/inbox.ts` — share-sheet link import
- `src/lib/apply/*` — applying through ChatGPT: `harness.ts` (browser actions + the submit path), `snapshot.ts` (page → element refs), `vault.ts` (portal passwords), `scan.ts` (in-page form reader), `answers.ts` (classification + answer bank), `fill.ts` (rule-based filler used by `browser_autofill`; no submit), `browser.ts` (dedicated profile + navigation guard)
- `src/proxy.ts` + `src/lib/auth.ts` — request guard: password/session gate when `JOBMANAGER_PASSWORD_HASH` is set, otherwise loopback-host check; same-origin check on writes either way. `/login` and `/api/auth/login` are the only public paths. `/api/import/inbox` (iOS share-sheet Shortcut) skips all of that and instead requires `JOBMANAGER_INBOX_TOKEN` as a bearer token. `/api/mcp/<token>` (MCP server for ChatGPT, `src/lib/mcp.ts`) likewise skips it and requires `JOBMANAGER_MCP_TOKEN` in the path. It's read-only unless `JOBMANAGER_MCP_WRITE=1` turns on the edit and document-upload tools in `src/lib/mcp-write.ts` (uploads go through `saveUploadedDocument` in `src/lib/documents.ts`, shared with the Documents page); keep write tools behind that flag and don't add delete tools. `JOBMANAGER_MCP_BROWSER=1` adds the browser tools in `src/lib/mcp-browser.ts` (ChatGPT applies through a headless browser in the web server: `src/lib/apply/harness.ts`, `snapshot.ts`, `vault.ts`); `submit_application` additionally needs `JOBMANAGER_MCP_SUBMIT=1`.
- `data/` — gitignored: SQLite DB, uploaded documents, recordings, artifacts (old generated resumes, submission payloads, receipts), DB backups

## Notes

- Auto-save fields (event notes/links/score) debounce ~600ms, then flush on blur and on page unload — don't remove the `beforeunload`/`pagehide` flush, it's what prevents lost edits on refresh.
- `updateEvent`/`updateJob` only overwrite fields explicitly passed (`undefined` = leave alone), so partial PATCHes are safe.
- `jobs.workflow_state` (applying through ChatGPT) is separate from `status_events` (recruiting outcome). NULL = manually tracked job.
- `playwright` is pinned to exactly 1.63.0: 1.64+ calls `element.checkVisibility()` unconditionally and can't drive the server's Chromium 93. Don't bump it unless the server's Chromium is 105+ (`checkPlaywrightFits` in `apply/browser.ts` guards this at launch).
- In-page scripts (`scan.ts`, `snapshot.ts`, `confirm.ts`) must run on Chromium 93: production uses Alpine's Chromium via `CHROMIUM_PATH`. No CSS `:has()` (Chrome 105), `structuredClone`, `findLast`, `toSorted` and the like.
- Code passed to Playwright's `page.evaluate` must be a `String.raw` string, not a TS function (tsx injects `__name` helpers, and normal template literals eat regex backslashes).
- Never add a submit action to the form adapter (`fill.ts`). The only submit path is `Harness.submit` in `apply/harness.ts`: CAPTCHA check, payload saved before the click, `submitting` claimed atomically, success only on the site's confirmation. Empty required fields are only a warning (the site validates); submit button still showing afterwards = rejected, back to `needs_input` (retryable); form gone with no confirmation = `submission_unknown` (never auto-retried). `browser_click` must keep refusing submit-labelled buttons.
- Portal passwords live only in `portal_accounts`, encrypted with `JOBMANAGER_VAULT_KEY`; never return them from a tool, log them, or add a plaintext fallback. CAPTCHAs and bot checks are reported to the user, never bypassed.
- Resumes are written in ChatGPT, not here; they come in through `upload_document` or the Documents page. The old Codex/Claude resume generator and its queue/worker were removed on purpose: don't bring them back. Their tables (`tasks`, `codex_runs`, `resume_artifacts`, `job_snapshots`, `application_fields`…) stay in the DB as history; don't drop them.
