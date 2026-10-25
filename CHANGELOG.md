# Changelog

Every change to `main` gets a version: a new minor version (`0.X.0`) for a feature, a patch (`0.X.Y`) for a fix.
Each version is a git tag (`git checkout v0.25.1`, `git diff v0.24.0 v0.25.0`), and the running version shows in
the page footer and the MCP server's info. `#N` is the pull request.

| Version | Date | What changed |
| --- | --- | --- |
| v0.30.0 | 2026-10-23 | #28 Fill applications in your own browser (NotchMan): match a page to its job, scan, resolve with the autofill rules |
| v0.29.2 | 2026-10-22 | Save to JobManager: "Fill in" also sets the job's title (and replaces a placeholder company) |
| v0.29.1 | 2026-10-22 | Fix: the Save to JobManager bookmark only opened /save (its address was never set); signing in keeps the posting |
| v0.29.0 | 2026-10-22 | Version numbers: every commit on main tagged, this changelog, version in the page footer and MCP server info |
| v0.28.0 | 2026-10-22 | #23 Save to JobManager bookmarklet for sites that refuse the server |
| v0.27.0 | 2026-10-22 | #21 MCP add_application |
| v0.26.0 | 2026-10-21 | #20 Duplicate checks in the Add form; keys kept current |
| v0.25.1 | 2026-10-21 | #19 Workday API first; closed postings named |
| v0.25.0 | 2026-10-21 | #18 Take over panel for solving CAPTCHAs yourself |
| v0.24.1 | 2026-10-21 | #17 JavaScript polyfills so Ashby forms render on Chromium 93 |
| v0.24.0 | 2026-10-20 | #16 Enter a site's verification code on the job page |
| v0.23.1 | 2026-10-20 | #15 Greenhouse dropdowns read correctly; the site decides what's required |
| v0.23.0 | 2026-10-20 | #14 Screenshot and receipt links |
| v0.22.1 | 2026-10-20 | #13 Pin Playwright 1.63.0 for Chromium 93 |
| v0.22.0 | 2026-10-20 | #12 Browser tool logging |
| v0.21.0 | 2026-10-20 | #11 Run Alpine's Chromium on the server; smaller browser memory |
| v0.20.0 | 2026-10-20 | #10 Remove the resume queue/worker; saved-answers editor on Profile |
| v0.19.0 | 2026-10-20 | #9 MCP browser tools: ChatGPT applies through a headless browser |
| v0.18.0 | 2026-10-13 | #8 MCP: upload_document |
| v0.17.0 | 2026-10-13 | #7 MCP: opt-in edit tools |
| v0.16.0 | 2026-10-13 | #6 MCP: search applications |
| v0.15.0 | 2026-10-13 | #5 MCP: list all applications; get_application |
| v0.14.0 | 2026-10-13 | #4 Read-only MCP server for ChatGPT |
| v0.13.0 | 2026-10-13 | #3 Edit company/title on the job page; "to apply" status |
| v0.12.0 | 2026-10-13 | #2 Inbox adds links without automation |
| v0.11.0 | 2026-10-13 | #1 Share-sheet inbox for adding jobs from an iOS Shortcut |
| v0.10.0 | 2026-10-13 | Deploy script |
| v0.9.1 | 2026-10-13 | Fix login redirect crashing with "Invalid URL" |
| v0.9.0 | 2026-10-12 | Optional password login for hosting |
| v0.8.0 | 2026-10-12 | Remove the ChatGPT gateway resume generator |
| v0.7.0 | 2026-10-12 | Application automation: queue, worker, Codex/Claude resume runs, form filling |
| v0.6.0 | 2026-08-07 | ChatGPT resume generation integration |
| v0.5.0 | 2026-08-04 | URL search shortcut |
| v0.4.1 | 2026-07-24 | Fix elapsed time to measure gaps between stages |
| v0.4.0 | 2026-07-24 | Milestone dates on OA and interview events |
| v0.3.0 | 2026-07-23 | Linked documents are immutable snapshots (archive instead of delete) |
| v0.2.0 | 2026-07-23 | Resumes/cover-letters tabs, document linking, today-default dates |
| v0.1.0 | 2026-07-23 | Local job application tracker with interview recording |
