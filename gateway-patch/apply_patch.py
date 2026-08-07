#!/usr/bin/env python3
"""
Patches a CatGPT-Gateway clone so JobManager can use it.

Upstream can't do two things we need:
  1. Talk to a *Custom GPT* — it hardcodes https://chatgpt.com and ignores `model`,
     so your GPT's system prompt and knowledge files never load.
  2. Return files the GPT generated — it only scrapes assistant text, and the
     browser context is created without accept_downloads, so a sandbox PDF is
     silently discarded.

Rather than a git diff — which rots the moment upstream moves — each change is an
anchored string replacement, verified against the real file. Re-running is safe:
patched files carry a marker and are skipped.

    python3 apply_patch.py /path/to/CatGPT-Gateway

Anchors were verified against upstream main as of 2026-08. If upstream changes
shape, this fails loudly with the anchor it wanted rather than silently no-op'ing.
"""

from __future__ import annotations

import shutil
import sys
from pathlib import Path

MARK = "# --- JobManager patch ---"


class PatchError(RuntimeError):
    pass


def _backup(path: Path) -> None:
    backup = path.with_suffix(path.suffix + ".orig")
    if not backup.exists():
        backup.write_text(path.read_text())


def _apply(path: Path, label: str, edits: list[tuple[str, str]], count: int = 1) -> bool:
    """Apply (anchor, replacement) edits; returns False when already patched."""
    if not path.exists():
        raise PatchError(f"{label}: missing file {path} — did upstream restructure?")
    original = path.read_text()
    if MARK in original:
        print(f"  · {label}: already patched")
        return False

    text = original
    for anchor, replacement in edits:
        if anchor not in text:
            raise PatchError(
                f"{label}: anchor not found in {path.name}. Upstream likely changed;\n"
                f"patch by hand, then re-run.\n--- wanted ---\n{anchor}\n--------------"
            )
        text = text.replace(anchor, replacement, count)

    _backup(path)
    path.write_text(text)
    print(f"  ✓ {label}: patched")
    return True


# ---------------------------------------------------------------------------
# 1. config.py — our settings, inserted next to the existing URL settings
# ---------------------------------------------------------------------------

CONFIG_ANCHOR = '    CHATGPT_URL: str = os.getenv("CHATGPT_URL", "https://chatgpt.com")'

CONFIG_NEW = (
    MARK
    + """
    # A Custom GPT, e.g. https://chatgpt.com/g/g-xxxx-resume-builder. When set,
    # every new chat opens here instead of the plain ChatGPT root, so the GPT's
    # system prompt and knowledge files are actually in play.
    CUSTOM_GPT_URL: str = os.getenv("CUSTOM_GPT_URL", "")
    # Where files the GPT generates are saved before being returned as base64.
    FILES_DIR: Path = _PROJECT_ROOT / os.getenv("FILES_DIR", "downloads/files")
    # How long to wait for a sandbox file once the reply is complete.
    DOWNLOAD_WAIT_MS: int = int(os.getenv("DOWNLOAD_WAIT_MS", "90000"))
    # When automatic capture fails or grabs the wrong file, how long to wait for
    # you to click the right download button in the browser. 0 disables it.
    MANUAL_DOWNLOAD_WAIT_MS: int = int(os.getenv("MANUAL_DOWNLOAD_WAIT_MS", "60000"))

"""
    + CONFIG_ANCHOR
)

# Config.ensure_dirs() creates the other directories; add ours alongside.
CONFIG_MKDIR_ANCHOR = "        cls.IMAGES_DIR.mkdir(parents=True, exist_ok=True)"
CONFIG_MKDIR_NEW = (
    CONFIG_MKDIR_ANCHOR + "\n        cls.FILES_DIR.mkdir(parents=True, exist_ok=True)  " + MARK
)

# provider_url() drives the startup navigation and the login check. Point it at
# the Custom GPT so the browser parks there instead of on a plain chat — which
# new_chat()'s "already on a fresh chat" shortcut would otherwise keep it on.
CONFIG_URL_ANCHOR = """        if cls.PROVIDER == "claude":
            return cls.CLAUDE_URL
        return cls.CHATGPT_URL"""

CONFIG_URL_NEW = """        if cls.PROVIDER == "claude":
            return cls.CLAUDE_URL
        """ + MARK + """
        if cls.CUSTOM_GPT_URL:
            return cls.CUSTOM_GPT_URL
        return cls.CHATGPT_URL"""


# ---------------------------------------------------------------------------
# 2. browser/manager.py — accept downloads
#
# launch_persistent_context is called twice (real Chrome, then bundled Chromium),
# both with **launch_kwargs — so setting the keys on the dict covers both.
# ---------------------------------------------------------------------------

MANAGER_ANCHOR = """        resolver_rules = _resolve_domains_for_chrome()
        if resolver_rules:
            chrome_args.append(f"--host-resolver-rules={resolver_rules}")

        launch_kwargs = dict(
            user_data_dir=str(Config.BROWSER_DATA_DIR),"""

MANAGER_NEW = (
    MARK
    + """
        # --host-resolver-rules is a Docker workaround for Chrome's DNS client.
        # Outside Docker it only earns an "unsupported flag" banner, and the IPs
        # are resolved once at launch, so Cloudflare rotating them breaks loads.
        # Harmless when it works — set SKIP_HOST_RESOLVER_RULES=true to drop it.
        resolver_rules = (
            "" if os.getenv("SKIP_HOST_RESOLVER_RULES", "").lower() in ("1", "true", "yes")
            else _resolve_domains_for_chrome()
        )
        if resolver_rules:
            chrome_args.append(f"--host-resolver-rules={resolver_rules}")

        # Without accept_downloads the sandbox PDF is discarded before we see it.
        Config.FILES_DIR.mkdir(parents=True, exist_ok=True)
        launch_kwargs = dict(
            accept_downloads=True,
            downloads_path=str(Config.FILES_DIR),
            user_data_dir=str(Config.BROWSER_DATA_DIR),"""
)


# ---------------------------------------------------------------------------
# 3. chatgpt/client.py — Custom GPT navigation + download capture
#
# Note: the page attribute on ChatGPTClient is `self._page`, and Selectors.*
# entries are lists of fallback selectors.
# ---------------------------------------------------------------------------

CLIENT_INIT_ANCHOR = """    def __init__(self, page: Page) -> None:
        self._page = page
        self._setup_network_logging()"""

CLIENT_INIT_NEW = (
    """    def __init__(self, page: Page) -> None:
        self._page = page
        self._setup_network_logging()
        """
    + MARK
    + """
        self._pending_downloads = []  # files the GPT generated, caught passively
        self._arm_download_listener()

    def _arm_download_listener(self) -> None:
        \"\"\"
        Catch downloads that start on their own — including ones *you* start by
        clicking in the browser window. Listens on the whole context, so a
        download from a preview tab is caught too, not just the chat page.
        \"\"\"
        if getattr(self, "_jm_download_hook", False):
            return
        if not hasattr(self, "_pending_downloads"):
            self._pending_downloads = []
        try:
            self._page.context.on("download", lambda d: self._pending_downloads.append(d))
            self._jm_download_hook = True
        except Exception:
            # Older Playwright exposes downloads per-page only.
            try:
                self._page.on("download", lambda d: self._pending_downloads.append(d))
                self._jm_download_hook = True
            except Exception as exc:
                log.warning(f"Could not attach download listener: {exc}")

    async def _goto_custom_gpt(self) -> bool:
        \"\"\"Open a fresh Custom GPT chat. False when none is configured.\"\"\"
        url = getattr(Config, "CUSTOM_GPT_URL", "")
        if not url:
            return False
        log.info(f"Opening Custom GPT: {url}")
        await self._page.goto(url, wait_until="domcontentloaded")
        self._arm_download_listener()
        # The composer only mounts once the GPT's splash screen settles.
        for selector in Selectors.CHAT_INPUT:
            try:
                await self._page.wait_for_selector(selector, timeout=Config.SELECTOR_TIMEOUT)
                break
            except Exception:
                continue
        else:
            log.warning("Custom GPT composer never appeared; continuing anyway")
        return True

    async def _download_via_api(self, reply_text: str) -> list[str]:
        \"\"\"
        Fetch sandbox files through ChatGPT's own API.

        The reply carries the path as a markdown link, e.g.
        `[Download](sandbox:/mnt/data/resume.pdf)`. ChatGPT exposes
        /backend-api/conversation/{id}/interpreter/download?file_path=… which
        returns a signed URL for it. Running the fetch inside the page means the
        session cookies apply automatically.

        Preferred over clicking the DOM: no dependence on how the link is
        rendered, and no race with ChatGPT's async rewrite of sandbox links into
        download buttons.
        \"\"\"
        import base64 as _b64
        import re as _re

        paths = _re.findall(r"sandbox:(/[^\\s)\\]]+)", reply_text or "")
        if not paths:
            return []
        # Same file can be linked twice; keep first-seen order, PDFs first.
        paths = list(dict.fromkeys(paths))
        paths.sort(key=lambda p: 0 if p.lower().endswith(".pdf") else 1)

        thread = ""
        match = _re.search(r"/c/([0-9a-f-]+)", self._page.url)
        if match:
            thread = match.group(1)
        if not thread:
            log.warning("No conversation id in URL; cannot use the download API")
            return []

        target = Config.FILES_DIR
        target.mkdir(parents=True, exist_ok=True)
        saved: list[str] = []

        for path in paths:
            try:
                result = await self._page.evaluate(
                    \"\"\"async ([threadId, filePath]) => {
                      // /backend-api needs a bearer token; cookies alone give a 401.
                      let token = '';
                      try {
                        const s = await fetch('/api/auth/session', { credentials: 'include' });
                        if (s.ok) token = (await s.json()).accessToken || '';
                      } catch (e) {}
                      const headers = token ? { Authorization: `Bearer ${token}` } : {};
                      const api = `/backend-api/conversation/${threadId}/interpreter/download`
                                + `?file_path=${encodeURIComponent(filePath)}`;
                      const meta = await fetch(api, { credentials: 'include', headers });
                      if (!meta.ok) return { error: `meta HTTP ${meta.status}` };
                      const { download_url } = await meta.json();
                      if (!download_url) return { error: 'no download_url' };
                      const file = await fetch(download_url);
                      if (!file.ok) return { error: `file HTTP ${file.status}` };
                      const buf = new Uint8Array(await file.arrayBuffer());
                      let bin = '';
                      const CHUNK = 0x8000;  // avoid blowing the arg limit on big files
                      for (let i = 0; i < buf.length; i += CHUNK) {
                        bin += String.fromCharCode.apply(null, buf.subarray(i, i + CHUNK));
                      }
                      return { b64: btoa(bin) };
                    }\"\"\",
                    [thread, path],
                )
            except Exception as exc:
                log.warning(f"Download API call failed for {path}: {exc}")
                continue

            if not result or result.get("error"):
                log.warning(f"Download API rejected {path}: {(result or {}).get('error')}")
                continue

            dest = target / Path(path).name
            dest.write_bytes(_b64.b64decode(result["b64"]))
            saved.append(str(dest))
            log.info(f"Downloaded via API: {dest.name} ({dest.stat().st_size} bytes)")
            # The PDF is the resume; the .tex source is not worth another
            # round-trip, and JobManager only ever uses the first file.
            if dest.suffix.lower() == ".pdf":
                break

        return saved

    async def _collect_downloads(
        self, timeout_ms: int | None = None, reply_text: str = ""
    ) -> list[str]:
        \"\"\"
        Paths of files the GPT produced, newest run only.

        Strategy order:
        1. The download API, using sandbox: paths in the reply — most reliable.
        2. Downloads the passive listener caught while the reply streamed.
        3. Clicking a download affordance in the DOM — last resort, and the part
           most likely to rot when ChatGPT changes its UI.
        \"\"\"
        self._arm_download_listener()
        timeout_ms = timeout_ms or getattr(Config, "DOWNLOAD_WAIT_MS", 90000)
        target = Config.FILES_DIR
        target.mkdir(parents=True, exist_ok=True)

        # (1) the API path
        saved = await self._download_via_api(reply_text)
        if saved:
            return saved

        # (2) whatever the passive listener already caught during the reply
        while self._pending_downloads:
            download = self._pending_downloads.pop(0)
            try:
                dest = target / download.suggested_filename
                await download.save_as(str(dest))
                saved.append(str(dest))
                log.info(f"Captured download: {dest.name}")
            except Exception as exc:
                log.warning(f"Could not save download: {exc}")
        if saved:
            return saved

        # (3) otherwise drive the UI exactly as a person would.
        #
        # ChatGPT renders generated files as <button>s, not links — there are no
        # anchors in the turn at all — so anchor selectors never match. Clicking
        # the file opens a preview pane whose toolbar holds the real download
        # control, labelled "Download file".
        clicked = await self._click_download_button(timeout_ms)
        if clicked:
            # Sanity-check against the filename the reply itself advertised. On a
            # revision the page is full of older resumes, so a mismatch means a
            # stale card was clicked — better to report nothing than the wrong file.
            import re as _re2

            wanted = _re2.findall(r"sandbox:/[^\\s)\\]]*?([^/\\s)\\]]+\\.pdf)", reply_text or "")
            if wanted and Path(clicked).name not in wanted:
                log.warning(
                    f"Downloaded {Path(clicked).name} but the reply promised {wanted[0]} — "
                    "ignoring it rather than saving a stale resume"
                )
            else:
                return [clicked]

        # (4) Hand over to the human. Automated capture either found nothing or
        # grabbed the wrong file; the browser window is right there, so wait for
        # a manual click on the correct download button and use that instead.
        manual = await self._await_manual_download()
        if manual:
            return [manual]

        log.info("No generated file in the reply — text-only answer")
        return saved

    async def _await_manual_download(self) -> str | None:
        \"\"\"
        Wait for the user to click a download button in the browser window.

        The window is visible (HEADLESS=false), so when automatic capture picks
        the wrong file — easy on a revision, where several resumes are on screen
        — you can just click the right one and it is picked up from here.

        Set MANUAL_DOWNLOAD_WAIT_MS=0 to disable, e.g. when running unattended.
        \"\"\"
        wait_ms = getattr(Config, "MANUAL_DOWNLOAD_WAIT_MS", 60000)
        if wait_ms <= 0:
            return None

        self._arm_download_listener()
        self._pending_downloads.clear()  # ignore anything captured earlier
        log.warning(
            f"Automatic download failed — waiting {wait_ms // 1000}s for you to click the "
            "correct download button in the browser window."
        )

        target = Config.FILES_DIR
        target.mkdir(parents=True, exist_ok=True)
        deadline = wait_ms / 1000
        waited = 0.0
        while waited < deadline:
            if self._pending_downloads:
                download = self._pending_downloads.pop(0)
                try:
                    dest = target / download.suggested_filename
                    await download.save_as(str(dest))
                    log.info(f"Picked up your manual download: {dest.name}")
                    return str(dest)
                except Exception as exc:
                    log.warning(f"Could not save the manual download: {exc}")
                    return None
            await asyncio.sleep(0.5)
            waited += 0.5

        log.info("No manual download within the wait window — giving up")
        return None

    async def _click_download_button(self, timeout_ms: int) -> str | None:
        \"\"\"
        Click through the preview pane to download. Returns the saved path.

        A click that starts a download does so within a couple of seconds, so
        probes use a short timeout. Waiting DOWNLOAD_WAIT_MS on each candidate
        is what used to make this take minutes: every wrong button burned the
        full 90s before moving on.
        \"\"\"
        target = Config.FILES_DIR
        probe_ms = 4000

        async def _click(handle, wait_ms: int) -> str | None:
            try:
                async with self._page.expect_download(timeout=wait_ms) as info:
                    await handle.click()
                download = await info.value
                dest = target / download.suggested_filename
                await download.save_as(str(dest))
                log.info(f"Downloaded via UI: {dest.name}")
                return str(dest)
            except Exception as exc:
                log.debug(f"No download from click: {exc}")

            # The control may open the file in a new tab instead of downloading.
            # Pull the bytes straight out of that tab and close it.
            try:
                pages = self._page.context.pages
                for extra in [p for p in pages if p is not self._page]:
                    url = extra.url
                    if not url or url == "about:blank":
                        await extra.close()
                        continue
                    log.info(f"Download opened a tab instead: {url[:120]}")
                    data = await extra.evaluate(
                        \"\"\"async () => {
                          const r = await fetch(location.href, { credentials: 'include' });
                          if (!r.ok) return null;
                          const buf = new Uint8Array(await r.arrayBuffer());
                          let bin = '';
                          const CHUNK = 0x8000;
                          for (let i = 0; i < buf.length; i += CHUNK) {
                            bin += String.fromCharCode.apply(null, buf.subarray(i, i + CHUNK));
                          }
                          return btoa(bin);
                        }\"\"\"
                    )
                    name = url.split("?")[0].rstrip("/").split("/")[-1] or "resume.pdf"
                    await extra.close()
                    if data:
                        import base64 as _b

                        dest = target / name
                        dest.write_bytes(_b.b64decode(data))
                        log.info(f"Downloaded from tab: {dest.name} ({dest.stat().st_size} bytes)")
                        return str(dest)
            except Exception as exc:
                log.debug(f"Tab-capture fallback failed: {exc}")
            return None

        # 1. Open the PDF card belonging to the *latest turn*. A revision leaves
        #    cards from every earlier reply on the page, and a "Download file"
        #    button may still be on screen from an older preview pane — clicking
        #    either re-downloads a previous resume. Scoping to the last turn is
        #    what makes revisions pick the right file.
        try:
            turns = await self._page.query_selector_all(
                "[data-testid^='conversation-turn-']"
            )
            cards = (
                await turns[-1].query_selector_all("button[aria-label$='.pdf']")
                if turns
                else []
            )
            # Deliberately no whole-page fallback: if the latest turn has no
            # card, the reply produced no file, and any card found elsewhere
            # belongs to an earlier resume.
            if not turns:
                cards = await self._page.query_selector_all("button[aria-label$='.pdf']")
        except Exception:
            cards = []
        if cards:
            try:
                await cards[-1].click()
                toolbar = await self._page.wait_for_selector(
                    "button[aria-label='Download file']", timeout=Config.SELECTOR_TIMEOUT
                )
                if toolbar:
                    saved = await _click(toolbar, min(timeout_ms, 15000))
                    if saved:
                        return saved
            except Exception as exc:
                log.debug(f"Could not open the preview pane: {exc}")

        # 2. Only if the latest turn had no card at all: whatever download
        #    control is already on screen. Skipped when a card existed, since
        #    that button would belong to some earlier file's preview pane.
        if not cards:
            try:
                toolbar = await self._page.query_selector("button[aria-label='Download file']")
            except Exception:
                toolbar = None
            if toolbar:
                saved = await _click(toolbar, min(timeout_ms, 15000))
                if saved:
                    return saved

        # 3. Last resort: any other download affordance, probed briefly.
        for selector in ("a[download]", "[data-testid*='file-download']", "a[aria-label*='Download']"):
            try:
                handles = await self._page.query_selector_all(selector)
            except Exception:
                continue
            if not handles:
                continue
            saved = await _click(handles[-1], probe_ms)
            if saved:
                return saved

        return None"""
)

# new_chat() opens with a docstring, then an "already on a fresh chat" shortcut.
# A Custom GPT must be reached by URL, and that shortcut would keep us on a plain
# chat, so our branch goes first — right after the docstring.
CLIENT_THREAD_ANCHOR = """        url = f"{Config.CHATGPT_URL}/c/{thread_id}\""""

CLIENT_THREAD_NEW = (
    "        "
    + MARK
    + """
        # A Custom GPT's threads live at /g/g-.../c/<id>. Using the plain
        # /c/<id> form still opens the conversation but drops the GPT context,
        # so a revision would be answered by vanilla ChatGPT.
        _base = getattr(Config, "CUSTOM_GPT_URL", "") or Config.CHATGPT_URL
        url = f"{_base.rstrip('/')}/c/{thread_id}\""""
)

# After navigating, the SPA keeps streaming prior turns in for a moment. If
# send_message() counts assistant messages while that is still happening, the
# rising count looks like a brand-new reply: it logs "auto-submitted", never
# clicks send, and immediately returns the *previous* answer. Wait for the count
# to hold steady before handing back control.
CLIENT_THREAD_SETTLE_ANCHOR = """        await random_delay(800, 1500)
        log.info(f"Thread {thread_id} loaded")"""

CLIENT_THREAD_SETTLE_NEW = (
    """        await random_delay(800, 1500)
        """
    + MARK
    + """
        _stable, _last = 0, -1
        for _ in range(40):  # up to ~20s
            _now = await count_assistant_messages(self._page)
            if _now == _last and _now > 0:
                _stable += 1
                if _stable >= 3:  # unchanged for ~1.5s
                    break
            else:
                _stable = 0
            _last = _now
            await asyncio.sleep(0.5)
        log.info(f"Thread {thread_id} settled with {_last} assistant messages")
        log.info(f"Thread {thread_id} loaded")"""
)

# The auto-submit poll treats *any* rise in assistant-message count as proof the
# message was sent. In a reopened thread that count can still be settling, so it
# false-positives: send is never clicked, and the previous answer is returned as
# if it were new. A real submit always clears the composer — require that too.
CLIENT_AUTOSUBMIT_ANCHOR = """        auto_submitted = False
        for _ in range(6):  # poll up to ~3s in 0.5s intervals
            await asyncio.sleep(0.5)
            post_count = await count_assistant_messages(self._page)
            if post_count > pre_count:
                auto_submitted = True
                break"""

CLIENT_AUTOSUBMIT_NEW = (
    "        "
    + MARK
    + """
        async def _composer_is_empty() -> bool:
            try:
                value = await self._page.evaluate(
                    \"\"\"(sel) => {
                      const el = document.querySelector(sel);
                      if (!el) return null;
                      return (el.value !== undefined ? el.value : el.innerText || '').trim();
                    }\"\"\",
                    input_selector,
                )
            except Exception:
                return False
            return value == ""

        auto_submitted = False
        for _ in range(6):  # poll up to ~3s in 0.5s intervals
            await asyncio.sleep(0.5)
            post_count = await count_assistant_messages(self._page)
            # Both conditions: a new turn *and* the box we just typed into is empty.
            if post_count > pre_count and await _composer_is_empty():
                auto_submitted = True
                break"""
)

CLIENT_NEWCHAT_ANCHOR = """        3. Full page.goto() (last resort — may fail with DNS errors)
        \"\"\"
        # Already on a fresh chat — nothing to do"""

CLIENT_NEWCHAT_NEW = (
    """        3. Full page.goto() (last resort — may fail with DNS errors)
        \"\"\"
        """
    + MARK
    + """
        # A Custom GPT lives at its own URL; the new-chat button and the
        # fresh-chat shortcut below would both strand us on a plain chat.
        if await self._goto_custom_gpt():
            return

        # Already on a fresh chat — nothing to do"""
)


def install_overlay(root: Path) -> None:
    """Install the route overlay adding `custom_gpt_url` and `files`."""
    src = Path(__file__).parent / "jobmanager_routes.py"
    shutil.copyfile(src, root / "src" / "api" / "jobmanager_routes.py")
    print("  ✓ src/api/jobmanager_routes.py: installed")

    server = root / "src" / "api" / "server.py"
    text = server.read_text()
    if "jobmanager_routes" in text:
        print("  · src/api/server.py: overlay already mounted")
        return
    anchor = "app.include_router(openai_router)"
    if anchor not in text:
        raise PatchError("server.py: could not find `app.include_router(openai_router)`")
    # FastAPI matches the FIRST registered route, not the last — so mounting ours
    # afterwards is not enough. Drop upstream's /v1/chat/completions from the app
    # first, then mount ours in its place.
    _backup(server)
    server.write_text(
        text.replace(
            anchor,
            MARK
            + """
# Upstream's /v1/chat/completions can't reach a Custom GPT or return generated
# files, and FastAPI matches the FIRST registered route — so mounting ours later
# is not enough. Strip upstream's route from its own router *before* it is
# mounted; every other upstream route is untouched. (Newer FastAPI stores
# included routers as opaque objects, so filtering app.router.routes afterwards
# would silently match nothing.)
from src.api.jobmanager_routes import router as jobmanager_router

openai_router.routes = [
    _r for _r in openai_router.routes
    if not (getattr(_r, "path", None) == "/v1/chat/completions"
            and "POST" in (getattr(_r, "methods", None) or set()))
]
"""
            + anchor
            + "\napp.include_router(jobmanager_router)",
            1,
        )
    )
    print("  ✓ src/api/server.py: overlay mounted (upstream chat route replaced)")


def main() -> int:
    if len(sys.argv) < 2:
        print(__doc__)
        return 2
    root = Path(sys.argv[1]).expanduser().resolve()
    if not (root / "src").is_dir():
        print(f"error: {root} is not a CatGPT-Gateway checkout")
        return 1

    print(f"Patching {root}")
    try:
        _apply(
            root / "src" / "config.py",
            "config.py",
            [
                (CONFIG_ANCHOR, CONFIG_NEW),
                (CONFIG_MKDIR_ANCHOR, CONFIG_MKDIR_NEW),
                (CONFIG_URL_ANCHOR, CONFIG_URL_NEW),
            ],
        )
        _apply(root / "src" / "browser" / "manager.py", "browser/manager.py",
               [(MANAGER_ANCHOR, MANAGER_NEW)])
        _apply(
            root / "src" / "chatgpt" / "client.py",
            "chatgpt/client.py",
            [
                (CLIENT_INIT_ANCHOR, CLIENT_INIT_NEW),
                (CLIENT_NEWCHAT_ANCHOR, CLIENT_NEWCHAT_NEW),
                (CLIENT_THREAD_ANCHOR, CLIENT_THREAD_NEW),
                (CLIENT_THREAD_SETTLE_ANCHOR, CLIENT_THREAD_SETTLE_NEW),
                (CLIENT_AUTOSUBMIT_ANCHOR, CLIENT_AUTOSUBMIT_NEW),
            ],
        )
        install_overlay(root)
    except PatchError as exc:
        print(f"\nPATCH FAILED\n{exc}\n")
        return 1

    print("\nDone. Restart the gateway for the changes to take effect.")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
