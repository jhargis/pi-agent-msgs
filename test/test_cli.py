import concurrent.futures
import json
import os
from pathlib import Path
import subprocess
import tempfile
import unittest

CLI = Path(__file__).resolve().parents[1] / "bin/pi-agent-msgs"


class InboxTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory(prefix="pi-agent-msgs-test-")
        self.addCleanup(self.temp.cleanup)
        self.db = Path(self.temp.name) / "private/messages.sqlite3"

    def call(self, *args, ok=True, stdin=None):
        result = subprocess.run([str(CLI), "--db", str(self.db), *args],
                                input=stdin, text=True, capture_output=True)
        if ok:
            self.assertEqual(result.returncode, 0, result.stderr)
            return json.loads(result.stdout)
        self.assertNotEqual(result.returncode, 0)
        return result.stderr

    def send(self, text="Finished", **kwargs):
        extra = [item for key, value in kwargs.items() for item in ("--" + key.replace("_", "-"), str(value))]
        return self.call("send", "--kind", "done", *extra, text)

    def test_send_and_list_do_not_acknowledge(self):
        message = self.send("Done 👋; $(touch /nope)", project="project a", sender="builder")
        self.assertEqual(message["id"], 1)
        self.assertEqual(message["project"], "project a")
        self.assertEqual(message["sender"], "builder")
        self.assertEqual(self.call("list")["messages"], [message])
        self.assertEqual(self.call("list")["messages"], [message])
        self.assertIsNone(message["read_at"])
        self.assertIsNone(message["notified_at"])

    def test_ack_only_requested_ids_and_is_idempotent(self):
        self.send("one")
        self.send("two")
        self.call("ack", "1")
        stamp = self.call("list", "--all")["messages"][0]["read_at"]
        self.call("ack", "1")
        self.assertEqual(self.call("list", "--all")["messages"][0]["read_at"], stamp)
        self.assertEqual([m["id"] for m in self.call("list")["messages"]], [2])
        self.assertIsNone(self.call("list")["messages"][0]["notified_at"])

    def test_unknown_ack_changes_nothing(self):
        self.send()
        self.call("ack", "1", "999", ok=False)
        self.assertEqual(len(self.call("list")["messages"]), 1)

    def test_delivery_is_persistent_batched_and_separate_from_read(self):
        self.send("one")
        self.send("two")
        delivery = self.call("_claim")["delivery"]
        self.assertTrue(delivery)
        self.assertEqual(self.call("_claim")["delivery"], delivery)
        self.send("arrived during delivery")
        self.assertEqual(self.call("_claim")["delivery"], delivery)
        self.call("_notified", delivery)
        rows = self.call("list")["messages"]
        self.assertTrue(all(m["notified_at"] and m["read_at"] is None for m in rows[:2]))
        self.assertIsNone(rows[2]["notified_at"])
        second = self.call("_claim")["delivery"]
        self.assertNotEqual(second, delivery)
        self.call("_notified", second)
        self.assertIsNone(self.call("_claim")["delivery"])
        self.assertEqual(self.call("status")["unread"], 3)
        self.assertEqual(self.call("status")["unnotified"], 0)

    def test_read_before_poll_does_not_wake(self):
        self.send()
        self.call("ack", "1")
        self.assertIsNone(self.call("_claim")["delivery"])

    def test_repeated_delivery_ack_is_idempotent(self):
        self.send()
        delivery = self.call("_claim")["delivery"]
        self.call("_notified", delivery)
        stamp = self.call("list")["messages"][0]["notified_at"]
        self.call("_notified", delivery)
        self.assertEqual(self.call("list")["messages"][0]["notified_at"], stamp)
        self.call("_notified", "missing", ok=False)

    def test_replies_and_optional_send_deduplication(self):
        first = self.send("first", key="job-1")
        duplicate = self.send("retry", key="job-1")
        self.assertEqual(duplicate, first)
        reply = self.send("related", reply_to=first["id"])
        self.assertEqual(reply["reply_to"], first["id"])
        self.call("send", "--reply-to", "999", "bad", ok=False)
        self.assertEqual(self.call("status")["total"], 2)

    def test_concurrent_writers_and_claimers(self):
        self.call("status")
        with concurrent.futures.ThreadPoolExecutor(max_workers=12) as pool:
            messages = list(pool.map(lambda i: self.send(str(i)), range(36)))
            deliveries = list(pool.map(lambda _: self.call("_claim")["delivery"], range(12)))
        self.assertEqual(len({m["id"] for m in messages}), 36)
        self.assertEqual(len(set(deliveries)), 1)
        self.call("_notified", deliveries[0])
        self.assertEqual(self.call("status")["unnotified"], 0)

    def test_stdin_validation_and_permissions(self):
        result = self.call("send", "--stdin", stdin="multiline\nreport")
        self.assertEqual(result["body"], "multiline\nreport")
        self.call("send", "   ", ok=False)
        self.call("send", "--stdin", "also positional", stdin="input", ok=False)
        self.call("send", "x" * 16385, ok=False)
        self.call("list", "--limit", "0", ok=False)
        self.assertEqual(self.db.stat().st_mode & 0o777, 0o600)
        self.assertEqual(self.db.parent.stat().st_mode & 0o777, 0o700)

    def test_settled_is_a_factual_event_and_deduplicates_without_claiming_task_completion(self):
        args = ("settled", "--source", "pi", "--session", "session-one", "--run", "reply-one",
                "--project", "/project", "--response-ref", "/transcript#reply-one", "--stdin")
        first = self.call(*args, stdin="I need your decision before proceeding.")
        second = self.call(*args, stdin="retry")
        self.assertEqual(first, second)
        self.assertEqual(first["kind"], "stopped")
        self.assertEqual(first["sender"], "pi-harness")
        body = json.loads(first["body"])
        self.assertEqual(body["event"], "agent_returned_control")
        self.assertEqual(body["outcome"], "settled")
        self.assertEqual(body["response_excerpt"], "I need your decision before proceeding.")
        self.assertIn("does not establish", body["note"])
        self.assertIsNone(first["notified_at"])

    def test_settled_bounds_the_visible_response_even_with_escaped_characters(self):
        for run, text in enumerate(("x" * 5000, "\\0" * 5000)):
            result = self.call("settled", "--source", "pocket", "--session", "1", "--run", str(run),
                               "--project", "/project", "--response-ref", "/s/1", "--outcome", "error",
                               "--stdin", stdin=text)
            body = json.loads(result["body"])
            self.assertTrue(body["excerpt_truncated"])
            self.assertLessEqual(len(body["response_excerpt"]), 4000)
            self.assertLessEqual(len(result["body"]), 16384)
            self.assertEqual(body["outcome"], "error")

    def test_installer_uses_only_requested_paths_and_leaves_pocket_disabled(self):
        base = Path(self.temp.name)
        pocket = base / "pocket"
        pocket.mkdir()
        config = pocket / "config.json"
        config.write_text('{"enabledExtensions": []}\n')
        command = ["python3", str(CLI.parent.parent / "scripts/install.py"),
                   "--bin-dir", str(base / "bin"), "--skill-dir", str(base / "skills"),
                   "--pocket-data", str(pocket), "--pi-extension-dir", str(base / "extensions")]
        subprocess.run(command, check=True, capture_output=True)
        self.assertEqual((base / "bin/pi-agent-msgs").resolve(), CLI)
        self.assertEqual((base / "extensions/pi-agent-msgs/index.ts").resolve(), CLI.parent.parent / "pi/index.ts")
        self.assertTrue((base / "skills/pi-agent-msgs/SKILL.md").is_file())
        helper = base / "skills/pi-agent-msgs/scripts/pi-agent-msgs"
        result = subprocess.run([str(helper), "--db", str(self.db), "status"], check=True, text=True, capture_output=True)
        self.assertEqual(json.loads(result.stdout)["database"], str(self.db))
        extension = pocket / "extensions/pi-agent-msgs.ts"
        self.assertEqual(extension.read_bytes(), (CLI.parent.parent / "pocket/pi-agent-msgs.ts").read_bytes())
        self.assertEqual(config.read_text(), '{"enabledExtensions": []}\n')
        subprocess.run(command, check=True, capture_output=True)
        extension.write_text("unrelated existing extension")
        refused = subprocess.run(command, capture_output=True)
        self.assertNotEqual(refused.returncode, 0)
        self.assertEqual(extension.read_text(), "unrelated existing extension")

    def test_default_database_is_shared_pi_state(self):
        env = {**os.environ, "HOME": self.temp.name}
        env.pop("PI_AGENT_MSGS_DB", None)
        result = subprocess.run([str(CLI), "status"], env=env, text=True, capture_output=True, check=True)
        expected = Path(self.temp.name) / ".pi/agent/pi-agent-msgs/messages.sqlite3"
        self.assertEqual(json.loads(result.stdout)["database"], str(expected))

    def test_default_database_can_be_configured(self):
        env = {**os.environ, "PI_AGENT_MSGS_DB": str(self.db)}
        result = subprocess.run([str(CLI), "status"], env=env, text=True, capture_output=True, check=True)
        self.assertEqual(json.loads(result.stdout)["database"], str(self.db))


if __name__ == "__main__":
    unittest.main()
