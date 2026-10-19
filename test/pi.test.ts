import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  rmSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { after, before, test } from "node:test";
import { promisify } from "node:util";
import extension from "../pi/index.ts";

const exec = promisify(execFile);
const root = mkdtempSync(join(tmpdir(), "pi-msgs-terminal-test-"));
const database = join(root, "messages.sqlite3");
const CLI = resolve(import.meta.dirname, "../bin/pi-agent-msgs");
const wrapper = join(root, "cli");
const fail = join(root, "fail");
const hold = join(root, "hold");
const started = join(root, "started");
let handlers: Record<string, Function[]>;
let commands: Record<string, { handler: Function }>;
let active: ReturnType<typeof session>;
const savedEnvironment = {
  cli: process.env.PI_AGENT_MSGS_CLI,
  db: process.env.PI_AGENT_MSGS_DB,
};
const notices: string[] = [];
let serial = 0;
function session(id: string, branch: any[] = []) {
  return {
    id,
    branch,
    ctx: {
      cwd: "/work/project",
      hasUI: true,
      ui: { notify: (text: string) => notices.push(text), setStatus: () => {} },
      sessionManager: {
        getSessionId: () => id,
        getSessionFile: () => join(root, `${id}.jsonl`),
        getBranch: () => branch,
      },
    },
  };
}
const message = (
  id: string,
  role: string,
  text: string,
  stopReason = "stop",
) => ({
  type: "message",
  id,
  message: { role, content: [{ type: "text", text }], stopReason },
});
function wire() {
  handlers = {};
  commands = {};
  extension({
    on: (name: string, handler: Function) => {
      (handlers[name] ??= []).push(handler);
      return () => {};
    },
    registerCommand: (name: string, command: { handler: Function }) => {
      commands[name] = command;
    },
    appendEntry: (customType: string, data: unknown) =>
      active.branch.push({
        type: "custom",
        id: `custom-${serial++}`,
        customType,
        data,
      }),
  } as never);
}
const event = async (name: string, data: object = {}, source = active) => {
  for (const handler of handlers[name] ?? [])
    await handler({ type: name, ...data }, source.ctx);
};
const command = (text: string) =>
  commands["agent-msgs"].handler(text, active.ctx);
const rows = async () =>
  JSON.parse((await exec(CLI, ["--db", database, "list", "--all"])).stdout)
    .messages;
const until = async (check: () => boolean) => {
  const start = Date.now();
  while (!check()) {
    if (Date.now() - start > 5000) throw new Error("Timed out");
    await new Promise((done) => setTimeout(done, 10));
  }
};

before(async () => {
  mkdirSync(root, { recursive: true });
  writeFileSync(
    wrapper,
    `#!/bin/sh\ncase "$*" in *" settled "*)\nif [ -f '${fail}' ]; then echo 'simulated SQLite outage' >&2; exit 1; fi\nif [ -f '${hold}' ]; then touch '${started}'; while [ -f '${hold}' ]; do sleep 0.02; done; fi;;\nesac\nexec '${CLI}' "$@"\n`,
    { mode: 0o700 },
  );
  process.env.PI_AGENT_MSGS_CLI = wrapper;
  process.env.PI_AGENT_MSGS_DB = database;
  active = session("one");
  wire();
  await event("session_start");
});
after(() => {
  for (const [key, value] of [
    ["PI_AGENT_MSGS_CLI", savedEnvironment.cli],
    ["PI_AGENT_MSGS_DB", savedEnvironment.db],
  ]) {
    if (value === undefined) delete process.env[key!];
    else process.env[key!] = value;
  }
  rmSync(root, { recursive: true, force: true });
});

test("terminal reporting is opt-in, settled-only, durable and deduplicated", async (t) => {
  await t.test("off by default; agent_end is not a trigger", async () => {
    active.branch.push(
      message("u0", "user", "hello"),
      message("a0", "assistant", "hello"),
    );
    assert.equal(handlers.agent_end, undefined);
    await event("agent_settled", { aborted: false });
    assert.equal((await rows()).length, 0);
  });
  await t.test(
    "on emits no event; final settled emits once with factual context",
    async () => {
      await command("on");
      await event("agent_settled", { aborted: false });
      assert.equal((await rows()).length, 0);
      active.branch.push(
        message("u1", "user", "do work"),
        message("tools", "assistant", "Working", "toolUse"),
      );
      await event("agent_end");
      assert.equal((await rows()).length, 0);
      active.branch.push(
        message("a1", "assistant", "I need your decision to proceed."),
      );
      await event("agent_settled", { aborted: false });
      await event("agent_settled", { aborted: false });
      const messages = await rows();
      assert.equal(messages.length, 1);
      assert.equal(messages[0].kind, "stopped");
      const body = JSON.parse(messages[0].body);
      assert.equal(body.event, "agent_returned_control");
      assert.equal(body.source, "pi");
      assert.equal(body.response_excerpt, "I need your decision to proceed.");
      assert.equal(body.response_ref, join(root, "one.jsonl#a1"));
    },
  );
  await t.test(
    "off suppresses further runs; enabling does not replay them",
    async () => {
      await command("off");
      active.branch.push(
        message("u2", "user", "unwatched"),
        message("a2", "assistant", "not reported"),
      );
      await event("agent_settled", { aborted: false });
      assert.equal((await rows()).length, 1);
      await command("on");
      assert.equal((await rows()).length, 1);
    },
  );
  await t.test(
    "abort and error outcomes are facts, not task-complete labels",
    async () => {
      active.branch.push(
        message("u3", "user", "work"),
        message("a3", "assistant", "Interrupted", "aborted"),
      );
      await event("agent_settled", { aborted: true });
      active.branch.push(
        message("u4", "user", "work"),
        message("a4", "assistant", "Provider failed", "error"),
      );
      await event("agent_settled", { aborted: false });
      const messages = await rows();
      assert.deepEqual(
        messages.slice(-2).map((row: any) => JSON.parse(row.body).outcome),
        ["aborted", "error"],
      );
      assert.ok(messages.every((row: any) => row.kind === "stopped"));
    },
  );
  await t.test(
    "reload restores opt-in, receipts and deduplication from session metadata",
    async () => {
      wire();
      await event("session_start");
      await event("agent_settled", { aborted: false });
      assert.equal((await rows()).length, 3);
      await command("status");
      assert.match(notices.at(-1)!, /on; 0 pending/);
    },
  );
  await t.test(
    "a new or forked session is off, even with copied custom entries",
    async () => {
      const original = active;
      active = session("fork", [...original.branch]);
      await event("session_start");
      active.branch.push(
        message("fork-u", "user", "work"),
        message("fork-a", "assistant", "fork result"),
      );
      await event("agent_settled", { aborted: false });
      assert.equal((await rows()).length, 3);
      await command("status");
      assert.match(notices.at(-1)!, /off/);
      active = original;
      await event("session_start");
    },
  );
  await t.test(
    "a failed write remains in a persistent outbox and retries after reload",
    async () => {
      writeFileSync(fail, "fail");
      active.branch.push(
        message("u5", "user", "work"),
        message("a5", "assistant", "pending result"),
      );
      await event("agent_settled", { aborted: false });
      assert.equal((await rows()).length, 3);
      assert.match(notices.at(-1)!, /pending report remains/);
      wire();
      unlinkSync(fail);
      await event("session_start");
      await event("agent_settled", { aborted: false });
      assert.equal((await rows()).length, 4);
    },
  );
  await t.test(
    "switching sessions during a send does not append receipts into the wrong session",
    async () => {
      writeFileSync(hold, "hold");
      active.branch.push(
        message("u6", "user", "work"),
        message("a6", "assistant", "switch result"),
      );
      const original = active;
      const sending = event("agent_settled", { aborted: false });
      await until(() => existsSync(started));
      active = session("other");
      const switching = event("session_start");
      unlinkSync(hold);
      await Promise.all([sending, switching]);
      assert.equal(active.branch.length, 0);
      assert.equal((await rows()).length, 5);
      active = original;
      await event("session_start");
      assert.equal((await rows()).length, 5);
      await command("status");
      assert.match(notices.at(-1)!, /0 pending/);
    },
  );
});
