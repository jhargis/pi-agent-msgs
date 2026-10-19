#!/usr/bin/env python3
"""A local, single-consumer message inbox. No daemon and no third-party packages."""
import argparse
from contextlib import contextmanager
from datetime import datetime, timezone
import json
import hashlib
import os
from pathlib import Path
import sqlite3
import sys
import uuid


def now():
    return datetime.now(timezone.utc).isoformat(timespec="milliseconds")


def default_database():
    # Pi's state is writable both inside Pocket's sandbox and from host-side agents.
    # A single unconditional default avoids accidentally splitting the inbox by environment.
    return os.environ.get("PI_AGENT_MSGS_DB", str(Path.home() / ".pi/agent/pi-agent-msgs/messages.sqlite3"))


def database(path):
    path = Path(path).expanduser().resolve()
    path.parent.mkdir(parents=True, exist_ok=True, mode=0o700)
    db = sqlite3.connect(path, timeout=10, isolation_level=None)
    db.row_factory = sqlite3.Row
    db.execute("PRAGMA busy_timeout = 10000")
    db.execute("PRAGMA foreign_keys = ON")
    db.execute("PRAGMA journal_mode = WAL")
    if db.execute("PRAGMA user_version").fetchone()[0] not in (0, 1):
        db.close()
        raise ValueError("Unsupported message database version")
    db.executescript("""
        CREATE TABLE IF NOT EXISTS deliveries (
            id TEXT PRIMARY KEY,
            created_at TEXT NOT NULL,
            notified_at TEXT
        );
        CREATE TABLE IF NOT EXISTS messages (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            created_at TEXT NOT NULL,
            project TEXT NOT NULL,
            sender TEXT NOT NULL,
            kind TEXT NOT NULL CHECK(kind IN ('done','stopped','blocked','update')),
            body TEXT NOT NULL,
            reply_to INTEGER REFERENCES messages(id),
            dedupe_key TEXT UNIQUE,
            read_at TEXT,
            delivery_id TEXT REFERENCES deliveries(id),
            notified_at TEXT
        );
        CREATE INDEX IF NOT EXISTS messages_pending
            ON messages(read_at, notified_at, delivery_id);
        PRAGMA user_version = 1;
    """)
    os.chmod(path, 0o600)
    return db, str(path)


@contextmanager
def transaction(db):
    db.execute("BEGIN IMMEDIATE")
    try:
        yield
        db.execute("COMMIT")
    except BaseException:
        db.execute("ROLLBACK")
        raise


def bounded(value):
    number = int(value)
    if not 1 <= number <= 1000:
        raise argparse.ArgumentTypeError("Must be between 1 and 1000")
    return number


def parser():
    p = argparse.ArgumentParser(description=__doc__)
    p.add_argument("--db", default=default_database(), help="Database path (or PI_AGENT_MSGS_DB)")
    commands = p.add_subparsers(dest="command", required=True)
    send = commands.add_parser("send", help="Report completed work, a stopping point, or a blocker")
    send.add_argument("message", nargs="?")
    send.add_argument("--stdin", action="store_true", help="Read the message from stdin")
    send.add_argument("--project", default=str(Path.cwd()))
    send.add_argument("--sender", default=os.environ.get("PI_AGENT_MSGS_SENDER", "agent"))
    send.add_argument("--kind", choices=["done", "stopped", "blocked", "update"], default="update")
    send.add_argument("--reply-to", type=int)
    send.add_argument("--key", help="Optional unique key: repeating the send returns the original message")
    settled = commands.add_parser("settled", help="Record a harness-observed return of control, not task completion")
    settled.add_argument("--source", choices=["pi", "pocket"], required=True)
    settled.add_argument("--session", required=True)
    settled.add_argument("--run", required=True)
    settled.add_argument("--project", required=True)
    settled.add_argument("--response-ref", required=True)
    settled.add_argument("--outcome", choices=["settled", "aborted", "error"], default="settled")
    settled.add_argument("--stdin", action="store_true", help="Include up to 4000 characters of the final visible response")
    listing = commands.add_parser("list", help="List unread messages without marking them read")
    listing.add_argument("--all", action="store_true", help="Include already-read messages")
    listing.add_argument("--limit", type=bounded, default=100)
    ack = commands.add_parser("ack", help="Mark only these message IDs as reviewed")
    ack.add_argument("ids", type=int, nargs="+")
    commands.add_parser("status", help="Show the database path and inbox counts")
    # Only the Pocket extension uses these. A claim persists before sending; retries reuse its ID.
    claim = commands.add_parser("_claim", help=argparse.SUPPRESS)
    claim.add_argument("--limit", type=bounded, default=500)
    notified = commands.add_parser("_notified", help=argparse.SUPPRESS)
    notified.add_argument("id")
    return p


def run(args, db, path):
    if args.command == "settled":
        excerpt = sys.stdin.read(4001) if args.stdin else ""
        report = {
            "event": "agent_returned_control",
            "source": args.source,
            "session": args.session,
            "run": args.run,
            "outcome": args.outcome,
            "response_ref": args.response_ref,
            "response_excerpt": excerpt[:4000],
            "excerpt_truncated": len(excerpt) > 4000,
            "note": "The harness returned control. This does not establish that the task is complete.",
        }
        body = json.dumps(report, ensure_ascii=False)
        while len(body) > 16384 and report["response_excerpt"]:
            report["response_excerpt"] = report["response_excerpt"][:len(report["response_excerpt"]) * 3 // 4]
            report["excerpt_truncated"] = True
            body = json.dumps(report, ensure_ascii=False)
        key = hashlib.sha256(json.dumps([args.source, args.session, args.run]).encode()).hexdigest()
        return run(argparse.Namespace(
            command="send", message=body, stdin=False,
            project=args.project, sender=args.source + "-harness", kind="stopped",
            reply_to=None, key="harness-settled:" + key,
        ), db, path)

    if args.command == "send":
        if args.stdin and args.message is not None:
            raise ValueError("Use a message argument or --stdin, not both")
        body = (sys.stdin.read(16385) if args.stdin else (args.message or "")).strip()
        if not body or len(body) > 16384:
            raise ValueError("Message must contain 1–16384 characters")
        if not args.project.strip() or not args.sender.strip():
            raise ValueError("Project and sender must not be empty")
        with transaction(db):
            if args.key is not None:
                existing = db.execute("SELECT * FROM messages WHERE dedupe_key = ?", (args.key,)).fetchone()
                if existing:
                    return dict(existing)
            if args.reply_to is not None:
                parent = db.execute("SELECT id FROM messages WHERE id = ?", (args.reply_to,)).fetchone()
                if parent is None:
                    raise ValueError("Reply-to message does not exist")
            cursor = db.execute(
                "INSERT INTO messages(created_at,project,sender,kind,body,reply_to,dedupe_key) VALUES (?,?,?,?,?,?,?)",
                (now(), args.project, args.sender, args.kind, body, args.reply_to, args.key),
            )
            return dict(db.execute("SELECT * FROM messages WHERE id = ?", (cursor.lastrowid,)).fetchone())

    if args.command == "list":
        where = "" if args.all else "WHERE read_at IS NULL"
        rows = db.execute(f"SELECT * FROM messages {where} ORDER BY id LIMIT ?", (args.limit,))
        return {"messages": [dict(row) for row in rows]}

    if args.command == "ack":
        ids = sorted(set(args.ids))
        marks = ",".join("?" for _ in ids)
        with transaction(db):
            found = db.execute(f"SELECT COUNT(*) FROM messages WHERE id IN ({marks})", ids).fetchone()[0]
            if found != len(ids):
                raise ValueError("One or more message IDs do not exist; nothing acknowledged")
            db.execute(f"UPDATE messages SET read_at = COALESCE(read_at, ?) WHERE id IN ({marks})", [now(), *ids])
        return {"acknowledged": ids}

    if args.command == "status":
        row = db.execute("""
            SELECT COUNT(*) AS total,
                COALESCE(SUM(read_at IS NULL),0) AS unread,
                COALESCE(SUM(read_at IS NULL AND notified_at IS NULL),0) AS unnotified
            FROM messages
        """).fetchone()
        return {"database": path, **dict(row)}

    if args.command == "_claim":
        with transaction(db):
            pending = db.execute("SELECT id FROM deliveries WHERE notified_at IS NULL ORDER BY rowid LIMIT 1").fetchone()
            if pending:
                return {"delivery": pending["id"]}
            ids = [row[0] for row in db.execute(
                "SELECT id FROM messages WHERE read_at IS NULL AND notified_at IS NULL AND delivery_id IS NULL ORDER BY id LIMIT ?",
                (args.limit,),
            )]
            if not ids:
                return {"delivery": None}
            delivery = str(uuid.uuid4())
            db.execute("INSERT INTO deliveries(id,created_at) VALUES (?,?)", (delivery, now()))
            marks = ",".join("?" for _ in ids)
            db.execute(f"UPDATE messages SET delivery_id = ? WHERE id IN ({marks})", [delivery, *ids])
            return {"delivery": delivery}

    if args.command == "_notified":
        with transaction(db):
            delivery = db.execute("SELECT notified_at FROM deliveries WHERE id = ?", (args.id,)).fetchone()
            if delivery is None:
                raise ValueError("Delivery does not exist")
            stamp = delivery["notified_at"] or now()
            db.execute("UPDATE deliveries SET notified_at = ? WHERE id = ?", (stamp, args.id))
            db.execute("UPDATE messages SET notified_at = ? WHERE delivery_id = ?", (stamp, args.id))
        return {"notified": args.id}


def main():
    os.umask(0o077)
    args = parser().parse_args()
    db = None
    try:
        db, path = database(args.db)
        print(json.dumps(run(args, db, path), ensure_ascii=False, indent=2))
        return 0
    except (OSError, ValueError, sqlite3.Error) as error:
        print(f"pi-agent-msgs: {error}", file=sys.stderr)
        return 1
    finally:
        if db is not None:
            db.close()


if __name__ == "__main__":
    sys.exit(main())
