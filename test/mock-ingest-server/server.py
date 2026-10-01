"""Standalone mock Codeskop ingest server.

A zero-dependency reflection of the locked ingest contract (docs/07 §7.5) so the
SDK team can develop `sample-android` end-to-end before the real backend phases
land. This is a development aid only: it does not persist, dedup, meter, or
authenticate against real keys, and it is not wired into Django.

Run it with::

    python mock-ingest-server/server.py

It serves ``POST /v1/events`` and ``GET /v1/config`` on port 8080 by default
(override with ``PORT``).
"""

from __future__ import annotations

import gzip
import json
import os
from datetime import datetime, timezone
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

# Contract limits (docs/07 §7.5).
MAX_EVENTS_PER_BATCH = 100
MAX_COMPRESSED_BYTES = 1 * 1024 * 1024
MAX_EVENT_BYTES = 64 * 1024

# The event types the SDK is allowed to emit.
ALLOWED_EVENT_TYPES = frozenset(
    {
        "api_error",
        "api_timing",
        "exception",
        "crash",
        "crash_native",
        "anr",
        "heartbeat",
        "track",
        "screen",
        "identify",
    }
)

# A static, contract-shaped config payload. The real backend derives this from
# the key's plan (Phase 6); here it is a fixed "everything on" response. Timings
# are kept at 100%: the SDK applies `sample_rates` (1.2+), and the e2e suites
# assert on every request's timing.
STATIC_CONFIG = {
    "enabled": True,
    "sample_rates": {"api_timing": 1.0},
    "features": {"anr": True, "network": True},
    "max_queue_mb": 10,
}

# In-memory record of every accepted `/v1/events` envelope, for the SDK
# integration suites' introspection (`web-sdk-workflow.md` Phase 10 asks for
# a debug endpoint, stdout, or stored state — the stdout log below only ever
# carried a coarse per-type count, not enough to assert *which* event landed
# with *which* user/context, so this is the "stored state" option). Test-only:
# unbounded, in-process, and gone the moment the server exits — exposed via
# `GET /__debug/received` and clearable via `POST /__debug/reset` so a suite
# can isolate itself within one long-lived server process if it needs to.
RECEIVED: list[dict] = []


def now_iso() -> str:
    """Return the current UTC time as an ISO-8601 string with millisecond precision."""
    return datetime.now(timezone.utc).isoformat(timespec="milliseconds")


def is_valid_public_key(authorization: str | None) -> tuple[bool, str]:
    """Validate the bearer credential against the locked auth rule.

    The SDK sends the public ingest key (``cs_*_pk_…``) and never the secret
    (``cs_*_sk_…``). Returns ``(ok, reason)``; ``reason`` is empty when ``ok``.
    """
    if not authorization or not authorization.startswith("Bearer "):
        return False, "missing or malformed Authorization header"
    token = authorization[len("Bearer ") :].strip()
    if not token.startswith("cs_"):
        return False, "credential is not a Codeskop key"
    if "_sk_" in token:
        return False, "secret keys (cs_*_sk_) must never be sent"
    if "_pk_" not in token:
        return False, "credential is not a public ingest key (cs_*_pk_)"
    return True, ""


def validate_event(event: object) -> str | None:
    """Validate a single event minimally; return a rejection reason or ``None``.

    Per-event failures are collected into the ``rejected`` list rather than
    failing the whole batch.
    """
    if not isinstance(event, dict):
        return "event is not an object"
    if not event.get("event_id"):
        return "missing event_id"
    event_type = event.get("type")
    if not event_type:
        return "missing type"
    if event_type not in ALLOWED_EVENT_TYPES:
        return f"unknown type '{event_type}'"
    if not event.get("occurred_at"):
        return "missing occurred_at"
    if len(json.dumps(event).encode("utf-8")) > MAX_EVENT_BYTES:
        return "event exceeds 64 KB"
    return None


class IngestHandler(BaseHTTPRequestHandler):
    """Handles the two contract endpoints and rejects everything else."""

    server_version = "CodeskopMockIngest/1.0"

    def _send_json(self, status: int, body: dict) -> None:
        payload = json.dumps(body).encode("utf-8")
        self.send_response(status)
        self.send_header("Content-Type", "application/json")
        self.send_header("Content-Length", str(len(payload)))
        self.end_headers()
        self.wfile.write(payload)

    def log_message(self, fmt: str, *args) -> None:
        """Silence the default per-request access log; batches are logged explicitly."""
        return

    def do_GET(self) -> None:
        path = self.path.split("?", 1)[0]
        if path == "/v1/config":
            self._send_json(200, STATIC_CONFIG)
            return
        if path == "/__debug/received":
            # Test-only introspection (see `RECEIVED` above) — every envelope
            # accepted by `/v1/events` so far, oldest first.
            self._send_json(200, {"batches": RECEIVED})
            return
        self._send_json(404, {"error": "not found"})

    def do_POST(self) -> None:
        path = self.path.split("?", 1)[0]
        if path == "/__debug/reset":
            # Test-only: clears `RECEIVED` for suites that reuse one server
            # process across multiple tests/files and want isolation.
            RECEIVED.clear()
            self._send_json(200, {})
            return
        if path != "/v1/events":
            self._send_json(404, {"error": "not found"})
            return

        ok, reason = is_valid_public_key(self.headers.get("Authorization"))
        if not ok:
            # 401 for a missing/malformed credential; 403 when a secret key is sent.
            status = 403 if "secret" in reason else 401
            self._send_json(status, {"error": reason})
            return

        # App-identity binding (doc 07 D10): the SDK reports its package and
        # signing-cert SHA-256 as headers. The mock has no registered allowlist,
        # so it enforces nothing (the server's enforce-if-configured fallback) but
        # logs what arrived so the SDK team can confirm the headers are sent.
        app_identity = (
            self.headers.get("X-Codeskop-Package"),
            self.headers.get("X-Codeskop-Cert-SHA256"),
        )

        length = int(self.headers.get("Content-Length") or 0)
        raw = self.rfile.read(length) if length else b""

        if len(raw) > MAX_COMPRESSED_BYTES:
            self._send_json(413, {"error": "payload exceeds 1 MB compressed"})
            return

        if self.headers.get("Content-Encoding", "").lower() == "gzip":
            try:
                raw = gzip.decompress(raw)
            except (OSError, EOFError):
                self._send_json(400, {"error": "body is not valid gzip"})
                return

        try:
            envelope = json.loads(raw.decode("utf-8"))
        except (json.JSONDecodeError, UnicodeDecodeError):
            self._send_json(400, {"error": "body is not valid JSON"})
            return

        error = self._validate_envelope(envelope)
        if error:
            self._send_json(400, {"error": error})
            return

        batch = envelope["batch"]
        if len(batch) > MAX_EVENTS_PER_BATCH:
            self._send_json(400, {"error": "batch exceeds 100 events"})
            return

        rejected: list[str] = []
        accepted_types: dict[str, int] = {}
        for index, event in enumerate(batch):
            why = validate_event(event)
            if why is not None:
                event_id = event.get("event_id") if isinstance(event, dict) else None
                rejected.append(event_id or f"index:{index}")
                continue
            accepted_types[event["type"]] = accepted_types.get(event["type"], 0) + 1

        self._log_batch(len(batch), accepted_types, rejected, app_identity)

        # Record the full accepted envelope for `/__debug/received` — the
        # per-event `user`/`payload`/`context` detail the stdout log above
        # deliberately doesn't carry (see `RECEIVED`'s comment).
        RECEIVED.append(
            {
                "received_at": now_iso(),
                "context": envelope.get("context"),
                "batch": [event for event in batch if isinstance(event, dict)],
                "rejected": rejected,
                "package": app_identity[0],
                "cert_sha256": app_identity[1],
            }
        )

        body = {"rejected": rejected} if rejected else {}
        self._send_json(200, body)

    def _validate_envelope(self, envelope: object) -> str | None:
        """Validate the envelope shape; return an error string or ``None``."""
        if not isinstance(envelope, dict):
            return "envelope is not an object"
        if not envelope.get("sent_at"):
            return "missing sent_at"
        context = envelope.get("context")
        if not isinstance(context, dict):
            return "missing or malformed context"
        batch = envelope.get("batch")
        if not isinstance(batch, list):
            return "missing or malformed batch"
        return None

    def _log_batch(
        self,
        received: int,
        accepted_types: dict[str, int],
        rejected: list[str],
        app_identity: tuple[str | None, str | None] = (None, None),
    ) -> None:
        """Log batch traffic to stdout so the SDK team can watch it land."""
        type_summary = (
            ", ".join(f"{name}={count}" for name, count in sorted(accepted_types.items()))
            or "none"
        )
        package, cert = app_identity
        identity_summary = f" identity[pkg={package or '-'} cert={cert or '-'}]"
        print(
            f"[{now_iso()}] batch received: {received} events "
            f"({received - len(rejected)} accepted, {len(rejected)} rejected) "
            f"types[{type_summary}]{identity_summary}",
            flush=True,
        )


def main() -> None:
    port = int(os.environ.get("PORT", "8080"))
    host = os.environ.get("HOST", "0.0.0.0")
    server = ThreadingHTTPServer((host, port), IngestHandler)
    print(f"Mock Codeskop ingest server listening on http://{host}:{port}", flush=True)
    print("  POST /v1/events   GET /v1/config   (Ctrl-C to stop)", flush=True)
    try:
        server.serve_forever()
    except KeyboardInterrupt:
        print("\nShutting down.", flush=True)
        server.shutdown()


if __name__ == "__main__":
    main()
