#!/usr/bin/env python3
"""Read-only RouterOS PPP active counter poller for the isolated cloud edition."""
from __future__ import annotations

import base64
import hashlib
import hmac
import ipaddress
import json
import logging
import os
import re
import signal
import sqlite3
import ssl
import sys
import time
import urllib.error
import urllib.parse
import urllib.request
import uuid
from dataclasses import dataclass
from datetime import datetime, timezone
from pathlib import Path
from typing import Any

MAX_RESPONSE_BYTES = 1_000_000
MAX_SESSIONS = 500
SITE_ID_RE = re.compile(r"^[A-Za-z0-9][A-Za-z0-9._-]{2,63}$")
UUID_RE = re.compile(r"^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$", re.I)
UINT_RE = re.compile(r"^\d{1,19}$")
UPTIME_PART_RE = re.compile(r"(\d+)([wdhms])")


class CollectorError(Exception):
    """Safe operational error; messages must not include credentials or PPPoE identities."""


def parse_uptime_seconds(value: Any) -> int:
    if isinstance(value, int) and not isinstance(value, bool) and value >= 0:
        return value
    if not isinstance(value, str) or not value:
        raise CollectorError("RouterOS returned an invalid PPP session uptime")
    if value.isdigit():
        return int(value)
    parts = list(UPTIME_PART_RE.finditer(value))
    if not parts or "".join(part.group(0) for part in parts) != value:
        raise CollectorError("RouterOS returned an unsupported PPP session uptime format")
    multipliers = {"w": 604800, "d": 86400, "h": 3600, "m": 60, "s": 1}
    total = sum(int(part.group(1)) * multipliers[part.group(2)] for part in parts)
    if total < 0 or total > 10**12:
        raise CollectorError("RouterOS returned an out-of-range PPP session uptime")
    return total


def parse_byte_pair(value: Any) -> tuple[int, int]:
    """Return (router_received/upload bytes_in, router_sent/download bytes_out)."""
    if isinstance(value, dict):
        sent = value.get("tx", value.get("sent"))
        received = value.get("rx", value.get("received"))
        pair = (sent, received)
    elif isinstance(value, (list, tuple)) and len(value) == 2:
        pair = value
    elif isinstance(value, str):
        separator = "," if "," in value else "/" if "/" in value else None
        if not separator:
            raise CollectorError("RouterOS PPP counter pair is missing")
        pair = tuple(piece.strip() for piece in value.split(separator))
        if len(pair) != 2:
            raise CollectorError("RouterOS PPP counter pair is malformed")
    else:
        raise CollectorError("RouterOS PPP counter pair is malformed")
    if any(isinstance(item, bool) or not str(item).isdigit() for item in pair):
        raise CollectorError("RouterOS PPP counter contains an invalid byte value")
    sent, received = (int(item) for item in pair)
    if sent < 0 or received < 0 or sent >= 2**63 or received >= 2**63:
        raise CollectorError("RouterOS PPP byte counter is outside the supported range")
    # MikroTik PPP active's first value is transmitted by the router (customer
    # download); the second is received by the router (customer upload).
    return received, sent


def parse_active_rows(payload: Any) -> list[dict[str, Any]]:
    if not isinstance(payload, list) or len(payload) > MAX_SESSIONS:
        raise CollectorError("RouterOS returned an invalid or oversized active-session response")
    sessions: list[dict[str, Any]] = []
    seen: set[str] = set()
    for row in payload:
        if not isinstance(row, dict):
            raise CollectorError("RouterOS active-session response is malformed")
        username = row.get("name") or row.get("username")
        session_id = row.get("session-id") or row.get("session_id")
        if not isinstance(username, str) or not username.strip() or len(username) > 255:
            raise CollectorError("RouterOS active session has no usable PPPoE username")
        if not isinstance(session_id, str) or not session_id.strip() or len(session_id) > 200:
            raise CollectorError("RouterOS active session has no stable session id")
        if session_id in seen:
            raise CollectorError("RouterOS returned duplicate active session ids")
        seen.add(session_id)
        if "bytes" not in row:
            raise CollectorError("RouterOS active session is missing byte counters")
        bytes_in, bytes_out = parse_byte_pair(row["bytes"])
        uptime_value = row.get("uptime")
        if uptime_value is None:
            raise CollectorError("RouterOS active session is missing uptime")
        sessions.append({
            "username": username,
            "session_id": session_id,
            "bytes_in": str(bytes_in),
            "bytes_out": str(bytes_out),
            "uptime_seconds": parse_uptime_seconds(uptime_value),
        })
    return sessions


def validate_private_router_url(value: str) -> urllib.parse.SplitResult:
    parsed = urllib.parse.urlsplit(value)
    if parsed.scheme != "https" or not parsed.hostname or parsed.username or parsed.password or parsed.query or parsed.fragment:
        raise CollectorError("RouterOS URL must be a private-address HTTPS URL without embedded credentials")
    try:
        address = ipaddress.ip_address(parsed.hostname)
    except ValueError as exc:
        raise CollectorError("RouterOS hostname must be a literal private LAN IP address") from exc
    if not address.is_private or address.is_loopback or address.is_link_local or address.is_multicast or address.is_reserved:
        raise CollectorError("RouterOS address is not an allowed private LAN address")
    return parsed


@dataclass(frozen=True)
class Settings:
    router_url: str
    router_username: str
    router_password: str
    router_ca_cert: str | None
    supabase_project_url: str
    supabase_publishable_key: str
    site_id: str
    site_token: str
    poll_seconds: int
    state_db: str

    @classmethod
    def from_env(cls, env: dict[str, str] | None = None) -> "Settings":
        values = os.environ if env is None else env
        required = ["ROUTEROS_URL", "ROUTEROS_USERNAME", "ROUTEROS_PASSWORD", "SUPABASE_PROJECT_URL", "SUPABASE_PUBLISHABLE_KEY", "COLLECTOR_SITE_ID", "COLLECTOR_SITE_TOKEN"]
        if any(not values.get(name) for name in required):
            raise CollectorError("Required collector configuration is missing")
        router_url = values["ROUTEROS_URL"].rstrip("/")
        validate_private_router_url(router_url)
        project = urllib.parse.urlsplit(values["SUPABASE_PROJECT_URL"])
        if project.scheme != "https" or not project.hostname or not project.hostname.endswith(".supabase.co") or project.path not in ("", "/") or project.query or project.fragment:
            raise CollectorError("Supabase project URL must be an HTTPS Supabase project host")
        site_id = values["COLLECTOR_SITE_ID"]
        if not SITE_ID_RE.fullmatch(site_id) or not re.fullmatch(r"[0-9a-f]{64}", values["COLLECTOR_SITE_TOKEN"], re.I):
            raise CollectorError("Collector site id or site token is invalid")
        try:
            poll_seconds = int(values.get("POLL_SECONDS", "300"))
        except ValueError as exc:
            raise CollectorError("POLL_SECONDS must be an integer") from exc
        if not 30 <= poll_seconds <= 3600:
            raise CollectorError("POLL_SECONDS must be between 30 and 3600")
        return cls(
            router_url=router_url,
            router_username=values["ROUTEROS_USERNAME"],
            router_password=values["ROUTEROS_PASSWORD"],
            router_ca_cert=values.get("ROUTEROS_CA_CERT") or None,
            supabase_project_url=values["SUPABASE_PROJECT_URL"].rstrip("/"),
            supabase_publishable_key=values["SUPABASE_PUBLISHABLE_KEY"],
            site_id=site_id,
            site_token=values["COLLECTOR_SITE_TOKEN"].lower(),
            poll_seconds=poll_seconds,
            state_db=values.get("STATE_DB", "/var/lib/shahdara-pppoe-collector/state.sqlite3"),
        )


def open_state(path: str) -> sqlite3.Connection:
    db_path = Path(path)
    db_path.parent.mkdir(mode=0o700, parents=True, exist_ok=True)
    try:
        os.chmod(db_path.parent, 0o700)
    except OSError:
        pass
    connection = sqlite3.connect(db_path, timeout=15)
    connection.row_factory = sqlite3.Row
    connection.execute("PRAGMA journal_mode=WAL")
    connection.execute("PRAGMA synchronous=FULL")
    connection.executescript("""
      CREATE TABLE IF NOT EXISTS session_state (
        session_id TEXT PRIMARY KEY,
        username TEXT NOT NULL,
        session_key TEXT NOT NULL,
        bytes_in INTEGER NOT NULL,
        bytes_out INTEGER NOT NULL,
        uptime_seconds INTEGER NOT NULL,
        sampled_at TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS outbox (
        snapshot_id TEXT PRIMARY KEY,
        sampled_at TEXT NOT NULL,
        body TEXT NOT NULL,
        queued_at TEXT NOT NULL
      );
    """)
    connection.commit()
    os.chmod(db_path, 0o600)
    return connection


def create_snapshot(sessions: list[dict[str, Any]], sampled_at: datetime, connection: sqlite3.Connection) -> dict[str, Any]:
    if sampled_at.tzinfo is None:
        raise CollectorError("Snapshot timestamp must be timezone-aware")
    timestamp = sampled_at.astimezone(timezone.utc).isoformat(timespec="seconds").replace("+00:00", "Z")
    snapshot_id = str(uuid.uuid4())
    snapshot_sessions: list[dict[str, Any]] = []
    with connection:
        for item in sessions:
            previous = connection.execute("SELECT * FROM session_state WHERE session_id = ?", (item["session_id"],)).fetchone()
            reset = previous is None
            if previous is not None:
                reset = (
                    item["username"] != previous["username"]
                    or int(item["bytes_in"]) < previous["bytes_in"]
                    or int(item["bytes_out"]) < previous["bytes_out"]
                    or item["uptime_seconds"] + 5 < previous["uptime_seconds"]
                )
            session_key = str(uuid.uuid4()) if reset else previous["session_key"]
            snapshot_sessions.append({
                "username": item["username"],
                "session_id": item["session_id"],
                "session_key": session_key,
                "uptime_seconds": item["uptime_seconds"],
                "bytes_in": str(item["bytes_in"]),
                "bytes_out": str(item["bytes_out"]),
            })
            connection.execute("""
              INSERT INTO session_state(session_id, username, session_key, bytes_in, bytes_out, uptime_seconds, sampled_at)
              VALUES (?, ?, ?, ?, ?, ?, ?)
              ON CONFLICT(session_id) DO UPDATE SET username=excluded.username, session_key=excluded.session_key,
                bytes_in=excluded.bytes_in, bytes_out=excluded.bytes_out,
                uptime_seconds=excluded.uptime_seconds, sampled_at=excluded.sampled_at
            """, (item["session_id"], item["username"], session_key, int(item["bytes_in"]), int(item["bytes_out"]), item["uptime_seconds"], timestamp))
        body = {"snapshot_id": snapshot_id, "sampled_at": timestamp, "sessions": snapshot_sessions}
        body_text = json.dumps(body, ensure_ascii=False, separators=(",", ":"), sort_keys=True)
        connection.execute("INSERT INTO outbox(snapshot_id, sampled_at, body, queued_at) VALUES (?, ?, ?, ?)",
                           (snapshot_id, timestamp, body_text, datetime.now(timezone.utc).isoformat()))
    return body


def build_ssl_context(ca_cert: str | None) -> ssl.SSLContext:
    return ssl.create_default_context(cafile=ca_cert) if ca_cert else ssl.create_default_context()


def fetch_router_sessions(settings: Settings, *, opener: Any = urllib.request.urlopen) -> list[dict[str, Any]]:
    router = validate_private_router_url(settings.router_url)
    base = f"{router.scheme}://{router.netloc}{router.path.rstrip('/')}"
    credentials = base64.b64encode(f"{settings.router_username}:{settings.router_password}".encode()).decode("ascii")
    request = urllib.request.Request(
        f"{base}/rest/ppp/active",
        headers={"Authorization": f"Basic {credentials}", "Accept": "application/json"},
        method="GET",
    )
    context = build_ssl_context(settings.router_ca_cert)
    try:
        with opener(request, timeout=10, context=context) as response:
            raw = response.read(MAX_RESPONSE_BYTES + 1)
    except (urllib.error.URLError, TimeoutError, OSError) as exc:
        raise CollectorError("RouterOS private HTTPS poll failed") from exc
    if len(raw) > MAX_RESPONSE_BYTES:
        raise CollectorError("RouterOS response exceeded the safe size limit")
    try:
        payload = json.loads(raw)
    except (json.JSONDecodeError, UnicodeDecodeError) as exc:
        raise CollectorError("RouterOS returned invalid JSON") from exc
    return parse_active_rows(payload)


def sign_upload(site_token: str, timestamp_text: str, nonce: str, raw_body: bytes) -> str:
    key = bytes.fromhex(site_token)
    message = timestamp_text.encode("ascii") + b"\n" + nonce.encode("ascii") + b"\n" + raw_body
    return hmac.new(key, message, hashlib.sha256).hexdigest()


def post_snapshot(settings: Settings, body: str, *, opener: Any = urllib.request.urlopen, now: float | None = None) -> dict[str, Any]:
    raw_body = body.encode("utf-8")
    timestamp_text = str(int(time.time() if now is None else now))
    nonce = str(uuid.uuid4())
    signature = sign_upload(settings.site_token, timestamp_text, nonce, raw_body)
    request = urllib.request.Request(
        f"{settings.supabase_project_url}/functions/v1/pppoe-usage-ingest",
        data=raw_body,
        headers={
            "Content-Type": "application/json",
            "apikey": settings.supabase_publishable_key,
            "X-Usage-Site": settings.site_id,
            "X-Usage-Timestamp": timestamp_text,
            "X-Usage-Nonce": nonce,
            "X-Usage-Signature": signature,
        },
        method="POST",
    )
    try:
        with opener(request, timeout=15, context=ssl.create_default_context()) as response:
            raw = response.read(65536)
    except (urllib.error.URLError, TimeoutError, OSError) as exc:
        raise CollectorError("Signed usage upload failed; snapshot remains queued") from exc
    try:
        result = json.loads(raw)
    except (json.JSONDecodeError, UnicodeDecodeError) as exc:
        raise CollectorError("Usage endpoint returned an invalid response; snapshot remains queued") from exc
    if not isinstance(result, dict) or result.get("accepted") is not True:
        raise CollectorError("Usage endpoint did not confirm snapshot acceptance; snapshot remains queued")
    return result


def flush_outbox(settings: Settings, connection: sqlite3.Connection, *, post: Any = post_snapshot, limit: int = 100) -> tuple[int, int]:
    rows = connection.execute("SELECT snapshot_id, body FROM outbox ORDER BY queued_at, snapshot_id LIMIT ?", (limit,)).fetchall()
    sent = 0
    unmapped = 0
    for row in rows:
        result = post(settings, row["body"])
        with connection:
            connection.execute("DELETE FROM outbox WHERE snapshot_id = ?", (row["snapshot_id"],))
        sent += 1
        unmapped += int(result.get("unmapped_sessions", 0))
    return sent, unmapped


def poll_once(settings: Settings, connection: sqlite3.Connection, *, fetch: Any = fetch_router_sessions, post: Any = post_snapshot, now: datetime | None = None) -> dict[str, int]:
    sampled_at = now or datetime.now(timezone.utc)
    sessions = fetch(settings)
    create_snapshot(sessions, sampled_at, connection)
    sent, unmapped = flush_outbox(settings, connection, post=post)
    return {"active_sessions": len(sessions), "snapshots_sent": sent, "unmapped_sessions": unmapped}


def main() -> int:
    try:
        settings = Settings.from_env()
        connection = open_state(settings.state_db)
    except CollectorError as exc:
        logging.error("Collector configuration error: %s", exc)
        return 2
    except OSError:
        logging.error("Collector state database could not be opened")
        return 2
    stopped = False

    def stop(_signum: int, _frame: Any) -> None:
        nonlocal stopped
        stopped = True

    signal.signal(signal.SIGTERM, stop)
    signal.signal(signal.SIGINT, stop)
    logging.basicConfig(level=os.environ.get("LOG_LEVEL", "INFO"), format="%(asctime)s %(levelname)s %(message)s")
    logging.info("Read-only PPPoE usage collector started for site_id=%s", settings.site_id)
    while not stopped:
        started = time.monotonic()
        try:
            stats = poll_once(settings, connection)
            logging.info("Poll complete active_sessions=%d snapshots_sent=%d unmapped_sessions=%d", stats["active_sessions"], stats["snapshots_sent"], stats["unmapped_sessions"])
        except CollectorError as exc:
            logging.warning("Poll did not complete: %s", exc)
        except Exception as exc:
            # Exception text can include a request, subscriber identity, or local path.
            logging.error("Unexpected collector failure (%s)", type(exc).__name__)
        time.sleep(max(1, settings.poll_seconds - int(time.monotonic() - started)))
    connection.close()
    return 0


if __name__ == "__main__":
    sys.exit(main())
