# Gateway patches

JobManager generates resumes by driving your **Resume Builder** Custom GPT through
[CatGPT-Gateway](https://github.com/GautamVhavle/CatGPT-Gateway), which automates a real
browser session instead of the paid OpenAI API.

Upstream can't do this on its own, hence these patches.

## What upstream is missing

| Gap | Why it matters | Fix |
|---|---|---|
| `config.py` hardcodes `https://chatgpt.com`; `new_chat()` navigates there, and `openai_routes.py` ignores `model` | You'd get plain ChatGPT — none of your GPT's system prompt or knowledge files | `CUSTOM_GPT_URL`, and `new_chat()` goes there first |
| Only DALL·E image downloads are handled; replies are scraped as text | Your GPT's PDF is never captured | `accept_downloads` + a download listener + `_collect_downloads()` |
| No per-request GPT selection | — | `custom_gpt_url` field on `/v1/chat/completions` |

## Files

- **`apply_patch.py`** — edits a clone in place via anchored replacements. Idempotent (patched
  files carry a marker), keeps `.orig` backups, and **fails loudly** with the anchor it wanted if
  upstream shifts, rather than silently doing nothing.
- **`jobmanager_routes.py`** — a standalone FastAPI router that takes over `/v1/chat/completions`.
  Upstream's `openai_routes.py` file is left untouched; instead `server.py` strips that one route
  from `openai_router` *before* mounting it, and mounts ours in its place. All other upstream
  routes keep working.

  > FastAPI matches the **first** registered route, so simply mounting ours afterwards does
  > nothing — upstream's handler would keep serving every request. FastAPI ≥0.141 also stores
  > included routers as opaque `_IncludedRouter` objects, so filtering `app.router.routes` after
  > the fact silently matches nothing. Editing `openai_router.routes` before mounting is what
  > actually works. Verify with the snippet under [When it breaks](#when-it-breaks).

Applied automatically by `npm run start:all`; run by hand with:

```bash
python3 gateway-patch/apply_patch.py ../CatGPT-Gateway
```

## First-time setup

`npm run start:all` clones, installs, and patches the gateway, but ChatGPT login is interactive
and must be done once by hand:

```bash
cd ../CatGPT-Gateway
./.venv/bin/python scripts/first_login.py   # log in to ChatGPT in the window that opens
```

The session persists in `browser_data/` for days-to-weeks. When it expires, generation starts
failing — re-run that command. Then `npm run start:all` again.

## Config

Everything is driven from JobManager's `.env.local` (see `.env.local.example`); the start script
writes the gateway's `.env` from it, so that file is not a second source of truth.

`HEADLESS` is deliberately pinned to `false` — headless Chrome is markedly easier to fingerprint.

## The response contract

```jsonc
{
  "choices": [{ "message": { "role": "assistant", "content": "…" } }],
  "files": [{ "filename": "resume.pdf", "mime_type": "application/pdf", "b64": "…" }]
}
```

`files` is empty when the GPT replies with text only. JobManager then saves the reply as `.md`
and flags it in the UI, so a broken download never loses a generation.

## "You are using an unsupported command-line flag: --host-resolver-rules=…"

**Expected, and harmless — ignore it.** That yellow Chrome banner comes from upstream, not these
patches: `_resolve_domains_for_chrome()` pre-resolves ChatGPT's domains via the OS and pins the
IPs so Chrome's own DNS client never runs. It's a Docker workaround for `ERR_NAME_NOT_RESOLVED`,
applied unconditionally. Chrome shows that infobar for any non-standard flag. Log in as normal.

It only matters if **pages fail to load**. The IPs are resolved once at launch and Cloudflare
rotates them, so a stale mapping can cause connection errors. On macOS the flag isn't needed at
all — drop it by adding this to `.env.local`:

```
SKIP_HOST_RESOLVER_RULES=true
```

## When it breaks

Download capture depends on ChatGPT's DOM, so expect occasional breakage after a UI change.

- **Generations still work but always produce `.md`** — the file never got downloaded. Check the
  log for what the collector did:

  ```bash
  grep -E "Downloaded via API|Captured download|No generated file" ../CatGPT-Gateway/logs/gateway.log | tail
  ```

  Downloads are attempted in three ways, in order:
  1. **The download API** — sandbox paths are parsed out of the reply text
     (`[Download](sandbox:/mnt/data/x.pdf)`) and fetched through
     `/backend-api/conversation/{id}/interpreter/download`. Needs a bearer token from
     `/api/auth/session`; cookies alone return **401**.
  2. **Passive download events** caught while the reply streamed.
  3. **Driving the UI**, exactly as a person would: click the file card in the *latest turn*,
     then the `aria-label="Download file"` button in the preview toolbar. The downloaded name is
     checked against the one the reply advertised, so a stale card is rejected rather than saved.
  4. **You.** If all of the above fail, the gateway waits ~60s for you to click the correct
     download button in the browser window and uses whatever you download. Handy on revisions,
     where several resumes are on screen at once. Set `MANUAL_DOWNLOAD_WAIT_MS=0` in `.env.local`
     to disable (e.g. unattended runs); the log says `waiting Ns for you to click…` when it's
     waiting on you.

  > ChatGPT renders generated files as `<button>` elements — a finished reply contains **no
  > anchors at all**, so `a[href^='sandbox:']` and friends can never match. Confirm with
  > `GET /jm/probe`, which lists the last reply's anchors and buttons.

  If the log shows `No generated file in the reply`, first confirm the reply *actually* contained a
  `sandbox:` link — check `sqlite3 data/app.db "SELECT response_text FROM generations ORDER BY id
  DESC LIMIT 1;"`. No link means the GPT answered with text instead of building a file, which is a
  prompt problem, not a gateway one. If the link is there but nothing downloaded, the API shape
  likely changed — the `GET /jm/probe` endpoint dumps the last reply's links and buttons to help.
- **`PATCH FAILED` with an anchor** — upstream changed the code around it. Apply that one edit
  by hand in the clone, or update the anchor here.
- **Reply looks like plain ChatGPT / the log shows `openai_routes | Response:`** — upstream's
  handler is serving the request instead of ours, so the Custom GPT navigation never runs. Confirm
  which handler owns the path:

  ```bash
  cd ../CatGPT-Gateway && ./.venv/bin/python -c "
  import src.api.server as s
  from fastapi.routing import APIRoute
  for r in s.app.router.routes:
      for sub in (getattr(r, 'original_router', None) or r).routes if hasattr(getattr(r, 'original_router', None) or r, 'routes') else []:
          if isinstance(sub, APIRoute) and sub.path == '/v1/chat/completions':
              print(sub.endpoint.__module__)"
  ```

  It must print `src.api.jobmanager_routes` exactly once. If it prints `src.api.openai_routes`,
  the route strip in `server.py` didn't take — re-run `apply_patch.py`. A correct run logs
  `jobmanager | Opening Custom GPT: …` and navigates to `/g/g-…`.

To start over: `rm -rf ../CatGPT-Gateway` and re-run `npm run start:all` (this discards the saved
login too).

## Verifying the gateway alone

Before blaming JobManager, check the gateway directly:

```bash
curl -sX POST localhost:8000/v1/chat/completions \
  -H "Authorization: Bearer $GATEWAY_TOKEN" -H 'Content-Type: application/json' \
  -d '{"model":"catgpt-browser","messages":[{"role":"user","content":"Software engineer at Acme"}],
       "custom_gpt_url":"https://chatgpt.com/g/g-6a727130b8a88191a9cfdae38a33d230-resume-builder"}' \
  | python3 -c 'import json,sys; b=json.load(sys.stdin); print(b["choices"][0]["message"]["content"][:200]); print("files:", [f["filename"] for f in b["files"]])'
```

Expect your GPT's voice in the text and a filename under `files`.

## Account risk

Automating the ChatGPT web UI is against OpenAI's Terms of Use. Low-volume personal use rarely
draws action and the usual escalation is a warning or temporary block, but a permanent ban is
possible and would take the Plus subscription with it. Keep `HEADLESS=false`, leave the
human-typing delays and `RATE_LIMIT_SECONDS` at their defaults, and don't batch-generate.

Leaving the gateway *running* is fine — idle, it makes no requests to ChatGPT; it only acts when
JobManager posts to it. What distinguishes automation is the pattern of messages sent, not uptime.
