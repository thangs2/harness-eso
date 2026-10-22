"""
Capture the provider exchange that produces a wrapped reply, so the envelope can be attributed.

Run this on the machine where Cursor runs its agent, proxying only the custom provider's host:

    mitmproxy --listen-port 8080 \
              --mode upstream:https://api.river.ai \
              -s scripts/capture/river_capture.py

Then point Cursor's custom model base URL at the proxy (OpenAI-compatible path preserved):
    http://127.0.0.1:8080/v1

Each assistant **stream** body is written to `.capture/<timestamp>-<id>.sse` together with the request
that produced it (`.req.json`, headers redacted). Then attribute:

    node scripts/capture/diagnose-wrapped-stream.mjs .capture/<id>.sse

Nothing here talks to the network on its own; it only records what Cursor already sends.
"""
import json
import os
import time

from mitmproxy import http

OUT_DIR = os.environ.get("HARNESS_CAPTURE_DIR", ".capture")
SECRET_HEADERS = {"authorization", "x-api-key", "cookie", "proxy-authorization"}


def _stamp() -> str:
    return time.strftime("%Y%m%dT%H%M%S", time.gmtime())


def _safe_headers(headers) -> dict:
    return {k: ("<redacted>" if k.lower() in SECRET_HEADERS else v) for k, v in headers.items()}


def response(flow: http.HTTPFlow) -> None:
    # Only generation calls carry an assistant message; model lists and health checks are noise.
    if "/chat/completions" not in flow.request.path and "/messages" not in flow.request.path:
        return

    os.makedirs(OUT_DIR, exist_ok=True)
    # The request id is the join key between a captured body and the transcript line it became.
    rid = flow.response.headers.get("x-request-id") or flow.id
    stem = os.path.join(OUT_DIR, f"{_stamp()}-{rid}")

    body = flow.response.get_text(strict=False) or ""
    with open(f"{stem}.sse", "w", encoding="utf-8") as fh:
        fh.write(body)

    with open(f"{stem}.req.json", "w", encoding="utf-8") as fh:
        json.dump(
            {
                "method": flow.request.method,
                "url": flow.request.pretty_url,
                "status": flow.response.status_code,
                "request_headers": _safe_headers(flow.request.headers),
                "response_headers": dict(flow.response.headers),
                # Strip the base64 image/file payloads; keep the shape of the conversation.
                "messages": json.loads(flow.request.get_text(strict=False) or "{}").get("messages", []),
            },
            fh,
            indent=2,
            ensure_ascii=False,
        )
