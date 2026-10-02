import json
import os
import sqlite3
import tempfile
import unittest
from datetime import datetime, timezone
from pathlib import Path

from collector.pppoe_collector import (
    CollectorError,
    Settings,
    create_snapshot,
    flush_outbox,
    open_state,
    parse_active_rows,
    parse_byte_pair,
    parse_uptime_seconds,
    post_snapshot,
    validate_private_router_url,
)


class FakeResponse:
    def __init__(self, payload):
        self.payload = payload

    def __enter__(self):
        return self

    def __exit__(self, *_args):
        return False

    def read(self, _maximum=-1):
        return self.payload


class CollectorTests(unittest.TestCase):
    def settings(self, **overrides):
        values = {
            "ROUTEROS_URL": "https://192.168.88.1",
            "ROUTEROS_USERNAME": "collector-reader",
            "ROUTEROS_PASSWORD": "test-only-placeholder",
            "SUPABASE_PROJECT_URL": "https://qkdsuvmlutkatcqoewkh.supabase.co",
            "SUPABASE_PUBLISHABLE_KEY": "public-test-key",
            "COLLECTOR_SITE_ID": "site-router-1",
            "COLLECTOR_SITE_TOKEN": "a" * 64,
            "POLL_SECONDS": "300",
            "STATE_DB": "/tmp/test.sqlite",
        }
        values.update(overrides)
        return Settings.from_env(values)

    def test_router_counter_order_maps_router_receive_to_upload(self):
        self.assertEqual(parse_byte_pair("1200,800"), (800, 1200))
        self.assertEqual(parse_byte_pair("1200/800"), (800, 1200))
        self.assertEqual(parse_byte_pair([1200, 800]), (800, 1200))

    def test_router_session_fields_accept_mikrotik_name_and_stable_session_id(self):
        rows = parse_active_rows([{
            "name": "synthetic-user",
            "session-id": "session-17",
            "uptime": "1d2h3m4s",
            "bytes": "1200/800",
        }])
        self.assertEqual(rows, [{
            "username": "synthetic-user",
            "session_id": "session-17",
            "bytes_in": "800",
            "bytes_out": "1200",
            "uptime_seconds": 93784,
        }])

    def test_uptime_parser_rejects_unknown_format(self):
        self.assertEqual(parse_uptime_seconds("2w1d3h"), 1306800)
        with self.assertRaises(CollectorError):
            parse_uptime_seconds("yesterday")

    def test_missing_identity_or_counters_fails_closed(self):
        with self.assertRaises(CollectorError):
            parse_active_rows([{"name": "synthetic-user", "uptime": "10s", "bytes": "1,2"}])
        with self.assertRaises(CollectorError):
            parse_byte_pair("123")

    def test_router_url_requires_literal_private_https_and_rejects_embedded_credentials(self):
        self.assertEqual(validate_private_router_url("https://10.0.0.1").hostname, "10.0.0.1")
        for value in (
            "http://10.0.0.1",
            "https://router.local",
            "https://8.8.8.8",
            "https://user:password@10.0.0.1",
        ):
            with self.subTest(value=value), self.assertRaises(CollectorError):
                validate_private_router_url(value)

    def test_configuration_rejects_non_supabase_cloud_endpoint(self):
        with self.assertRaises(CollectorError):
            self.settings(SUPABASE_PROJECT_URL="https://example.com")

    def test_snapshot_state_preserves_segment_and_starts_new_segment_after_reset(self):
        with tempfile.TemporaryDirectory() as directory:
            db = open_state(str(Path(directory) / "state.sqlite3"))
            t0 = datetime(2026, 10, 2, 10, 0, tzinfo=timezone.utc)
            first = {"username": "synthetic-user", "session_id": "s1", "bytes_in": "100", "bytes_out": "200", "uptime_seconds": 20}
            second = {**first, "bytes_in": "150", "bytes_out": "275", "uptime_seconds": 80}
            reset = {**first, "bytes_in": "12", "bytes_out": "30", "uptime_seconds": 3}
            key1 = create_snapshot([first], t0, db)["sessions"][0]["session_key"]
            key2 = create_snapshot([second], t0.replace(minute=1), db)["sessions"][0]["session_key"]
            key3 = create_snapshot([reset], t0.replace(minute=2), db)["sessions"][0]["session_key"]
            self.assertEqual(key1, key2)
            self.assertNotEqual(key2, key3)
            self.assertEqual(db.execute("SELECT count(*) FROM outbox").fetchone()[0], 3)
            db.close()

    def test_outbox_retry_keeps_identical_snapshot_body_until_confirmed(self):
        with tempfile.TemporaryDirectory() as directory:
            db = open_state(str(Path(directory) / "state.sqlite3"))
            body = create_snapshot([], datetime(2026, 10, 2, tzinfo=timezone.utc), db)
            original = db.execute("SELECT body FROM outbox WHERE snapshot_id = ?", (body["snapshot_id"],)).fetchone()[0]
            calls = []

            def fails(_settings, sent_body):
                calls.append(sent_body)
                raise CollectorError("offline")

            with self.assertRaises(CollectorError):
                flush_outbox(self.settings(), db, post=fails)
            self.assertEqual(db.execute("SELECT body FROM outbox WHERE snapshot_id = ?", (body["snapshot_id"],)).fetchone()[0], original)
            result = flush_outbox(self.settings(), db, post=lambda _settings, sent_body: {"accepted": True, "unmapped_sessions": 0})
            self.assertEqual(result, (1, 0))
            self.assertEqual(len(calls), 1)
            self.assertEqual(db.execute("SELECT count(*) FROM outbox").fetchone()[0], 0)
            db.close()

    def test_signed_upload_uses_publishable_key_and_per_site_headers(self):
        settings = self.settings()
        observed = {}

        def opener(request, timeout, context):
            observed["url"] = request.full_url
            observed["headers"] = dict(request.header_items())
            observed["body"] = request.data
            observed["timeout"] = timeout
            return FakeResponse(b'{"accepted":true,"duplicate":false,"unmapped_sessions":0}')

        payload = json.dumps({"snapshot_id": "123e4567-e89b-42d3-a456-426614174000", "sampled_at": "2026-10-02T00:00:00Z", "sessions": []}, separators=(",", ":"))
        result = post_snapshot(settings, payload, opener=opener, now=1790899200)
        self.assertTrue(result["accepted"])
        self.assertTrue(observed["url"].endswith("/functions/v1/pppoe-usage-ingest"))
        self.assertEqual(observed["headers"]["Apikey"], "public-test-key")
        self.assertEqual(observed["headers"]["X-usage-site"], "site-router-1")
        self.assertNotIn("Authorization", observed["headers"])
        self.assertEqual(observed["body"].decode(), payload)


if __name__ == "__main__":
    unittest.main()
