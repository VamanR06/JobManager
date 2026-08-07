"""
JobManager overlay for CatGPT-Gateway.

Adds a single endpoint, POST /v1/chat/completions, that upstream's version can't
provide: it targets a *Custom GPT* and returns any file the GPT generated.

Mounted after upstream's router in server.py, so this definition wins for that
path while every other upstream route keeps working.

Request (OpenAI-shaped, plus one extra field):
    {
      "model": "catgpt-browser",
      "messages": [{"role": "user", "content": "<job description>"}],
      "custom_gpt_url": "https://chatgpt.com/g/g-xxxx-resume-builder"
    }

Response: an OpenAI chat completion, plus
    "files": [{"filename": ..., "mime_type": ..., "b64": ...}]
"""

from __future__ import annotations

import base64
import mimetypes
import time
from pathlib import Path
from typing import Any

from fastapi import APIRouter, HTTPException
from pydantic import BaseModel

from src.config import Config
from src.log import setup_logging

log = setup_logging("jobmanager")

router = APIRouter()


class Message(BaseModel):
    role: str
    content: Any


class ChatRequest(BaseModel):
    model: str = "catgpt-browser"
    messages: list[Message]
    stream: bool = False
    # The whole point of this overlay.
    custom_gpt_url: str | None = None
    # Continue an existing conversation instead of starting a new one, so a
    # revision keeps the resume's full context.
    thread_id: str | None = None


def _flatten(content: Any) -> str:
    """OpenAI allows content to be a string or a list of parts."""
    if isinstance(content, str):
        return content
    if isinstance(content, list):
        parts = []
        for part in content:
            if isinstance(part, dict) and part.get("type") == "text":
                parts.append(part.get("text", ""))
            elif isinstance(part, str):
                parts.append(part)
        return "\n".join(parts)
    return str(content or "")


def _encode(path: str) -> dict[str, str] | None:
    file = Path(path)
    if not file.exists():
        return None
    mime, _ = mimetypes.guess_type(file.name)
    return {
        "filename": file.name,
        "mime_type": mime or "application/octet-stream",
        "b64": base64.b64encode(file.read_bytes()).decode("ascii"),
    }


@router.get("/jm/probe")
async def probe() -> dict[str, Any]:
    """
    Dump the last reply's links/buttons from the live page.

    Diagnostic for the one thing that reliably rots: the download selectors in
    `_collect_downloads`. When generations start coming back as .md, hit this to
    see what the file affordance actually looks like now.
    """
    from src.api.routes import _get_client  # type: ignore

    page = _get_client()._page
    return {
        "url": page.url,
        **await page.evaluate(
            """() => {
          const turns = document.querySelectorAll('[data-testid^="conversation-turn-"]');
          const last = turns[turns.length - 1];
          if (!last) return { error: 'no turns' };
          const sel = (s) => [...last.querySelectorAll(s)];
          return {
            turns: turns.length,
            text: (last.innerText || '').slice(0, 800),
            anchors: sel('a').map(a => ({
              href: (a.getAttribute('href') || '').slice(0, 160),
              download: a.hasAttribute('download'),
              aria: a.getAttribute('aria-label'),
              text: (a.innerText || '').trim().slice(0, 80),
            })),
            buttons: sel('button').map(b => ({
              aria: b.getAttribute('aria-label'),
              testid: b.getAttribute('data-testid'),
              text: (b.innerText || '').trim().slice(0, 80),
            })).filter(b => b.aria || b.testid || b.text),
            html: last.innerHTML.slice(0, 4000),
          };
        }"""
        ),
    }


@router.post("/v1/chat/completions")
async def chat_completions(req: ChatRequest) -> dict[str, Any]:
    if req.stream:
        raise HTTPException(status_code=400, detail="Streaming is not supported")
    if not req.messages:
        raise HTTPException(status_code=400, detail="messages must not be empty")

    # Per-request Custom GPT overrides the env default.
    if req.custom_gpt_url:
        Config.CUSTOM_GPT_URL = req.custom_gpt_url

    prompt = _flatten(req.messages[-1].content)
    if not prompt.strip():
        raise HTTPException(status_code=400, detail="The last message is empty")

    # Imported lazily: upstream module paths shift between versions, and importing
    # at module load would take the whole server down on a mismatch.
    # `_lock` serialises browser access — the browser is a single shared resource,
    # so skipping it would let concurrent requests type into the same page.
    from src.api.routes import _get_client, _lock  # type: ignore

    async with _lock:
        client = _get_client()
        previous_reply = ""
        if req.thread_id:
            # A revision: reopen the original conversation so the GPT still has
            # the job description and the resume it just produced in context.
            log.info(f"Continuing thread {req.thread_id}")
            await client.navigate_to_thread(req.thread_id)
            # Remember the reply already on screen. If the send silently fails,
            # the scraper hands back this same text — better to fail loudly than
            # to overwrite a good resume with a re-download of the old one.
            try:
                from src.chatgpt.detector import extract_last_response_via_copy

                previous_reply = (await extract_last_response_via_copy(client._page)) or ""
            except Exception as exc:
                log.debug(f"Could not read the pre-revision reply: {exc}")
        else:
            await client.new_chat()
        response = await client.send_message(prompt)

        text = getattr(response, "message", "") or ""

        if previous_reply and text.strip() == previous_reply.strip():
            raise HTTPException(
                status_code=502,
                detail="The revision was typed but never sent — ChatGPT returned the previous "
                "answer unchanged. Nothing was overwritten; try again.",
            )

        files: list[dict[str, str]] = []
        try:
            # The reply text carries the sandbox: paths, so it drives the download.
            for path in await client._collect_downloads(reply_text=text):
                encoded = _encode(path)
                if encoded:
                    files.append(encoded)
        except Exception as exc:  # never fail the request over the file half
            log.warning(f"Download capture failed: {exc}")

        # A run can emit several files (e.g. the PDF plus its LaTeX source).
        # JobManager takes files[0], so put the resume itself first.
        files.sort(key=lambda f: 0 if f["filename"].lower().endswith(".pdf") else 1)
    return {
        "id": f"chatcmpl-{int(time.time() * 1000)}",
        "object": "chat.completion",
        "created": int(time.time()),
        "model": req.model,
        "choices": [
            {
                "index": 0,
                "message": {"role": "assistant", "content": text},
                "finish_reason": "stop",
            }
        ],
        "usage": {
            "prompt_tokens": len(prompt) // 4,
            "completion_tokens": len(text) // 4,
            "total_tokens": (len(prompt) + len(text)) // 4,
        },
        "files": files,
        # Lets the caller continue this conversation to revise the result.
        "thread_id": getattr(response, "thread_id", "") or req.thread_id or "",
    }
