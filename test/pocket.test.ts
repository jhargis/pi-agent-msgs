// Pocket's helpers isolate its data, sign-ins, skills, and provider before app code loads.
import {
  cleanUp,
  context,
  lastText,
  modelTexts,
  newSession,
  openApp,
  owner,
  root,
  recordCost,
  say,
  scriptedModel,
  until,
} from "../../pi-pocket/test/helpers.ts";
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import {
  copyFileSync,
  existsSync,
  mkdirSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { join, resolve } from "node:path";
import { after, before, test } from "node:test";
import { promisify } from "node:util";
import {
  fauxAssistantMessage,
  fauxText,
  fauxToolCall,
} from "@earendil-works/pi-ai/providers/faux";
import type { ConversationId } from "@earendil-works/pi-durable";

const exec = promisify(execFile);
const CLI = resolve(import.meta.dirname, "../bin/pi-agent-msgs");
const EXTENSION = resolve(import.meta.dirname, "../pocket/pi-agent-msgs.ts");
const NOTICE = "New messages are available on the agent message bus.";
const data = join(root, "msgs-data");
const database = join(root, "bus.sqlite3");
const blockAck = join(root, "block-ack");
const blockClaim = join(root, "block-claim");
const claimStarted = join(root, "claim-started");
const wrapper = join(root, "test-cli");
let requests = 0;
const model = () =>
  scriptedModel((input) => {
    requests++;
    const last = lastText(input as never);
    const text = last.text.replace(/^\[from: [^\]]+\] /, "");
    const action =
      text === "receive here"
        ? "receive_here"
        : text === "bus status"
          ? "status"
          : text === "stop bus"
            ? "stop"
            : undefined;

    if (last.role !== "toolResult" && action !== undefined) {
      return fauxAssistantMessage([fauxToolCall("agent_msgs", { action })], {
        stopReason: "toolUse",
      });
    }

    return fauxAssistantMessage([fauxText(`echo: ${last.text}`)]);
  });
let app: Awaited<ReturnType<typeof openApp>>;
let first: ConversationId;
let second: ConversationId;
const pause = (ms = 250) => new Promise((done) => setTimeout(done, ms));
const cli = async (...args: string[]) =>
  JSON.parse((await exec(CLI, ["--db", database, ...args])).stdout);
const notices = async (id: ConversationId) => {
  const view = await (await app.harness.conversation(id, context))!.context(
    context,
  );

  return view.messages.filter((message) => {
    if (message.role !== "user") return false;
    const text =
      typeof message.content === "string"
        ? message.content
        : message.content
            .filter((part) => part.type === "text")
            .map((part) => part.text)
            .join("");

    return text === NOTICE;
  }).length;
};
const notified = async () => (await cli("status")).unnotified === 0;

before(async () => {
  mkdirSync(join(data, "extensions"), { recursive: true });
  copyFileSync(EXTENSION, join(data, "extensions/pi-agent-msgs.ts"));
  writeFileSync(
    wrapper,
    `#!/bin/sh\ncase "$*" in\n*"_claim"*) if [ -f '${blockClaim}' ]; then touch '${claimStarted}'; while [ -f '${blockClaim}' ]; do sleep 0.02; done; fi;;\n*"_notified"*) if [ -f '${blockAck}' ]; then echo 'simulated acknowledgment outage' >&2; exit 1; fi;;\nesac\nexec '${CLI}' "$@"\n`,
    { mode: 0o700 },
  );
  process.env.PI_AGENT_MSGS_CLI = wrapper;
  process.env.PI_AGENT_MSGS_DB = database;
  process.env.PI_AGENT_MSGS_POLL_MS = "80";
  app = await openApp(model(), data);
  first = await newSession(app);
  second = await newSession(app);
});

after(async () => {
  await app?.close();
  delete process.env.PI_AGENT_MSGS_CLI;
  delete process.env.PI_AGENT_MSGS_DB;
  delete process.env.PI_AGENT_MSGS_POLL_MS;
  cleanUp();
});

test("owner selection, payload-free delivery, on/off, rebinding, recovery, and access checks", async (t) => {
  await t.test(
    "drop-in starts off; selecting a receiver persists one worker; empty checks do not invoke models",
    async () => {
      const module = (await app.extensions(owner(app))).modules.find(
        (item) => item.file === "pi-agent-msgs.ts",
      )!;
      assert.equal(module.enabled, false);
      await app.setExtensionEnabled(owner(app), "pi-agent-msgs.ts", true);
      await say(app, first, "receive here");
      assert.match(
        (await modelTexts(app, first)).at(-1)!,
        /This conversation receives agent message notices/,
      );
      const before = requests;
      await pause();
      assert.equal(requests, before);
      assert.equal(await notices(first), 0);
    },
  );

  await t.test(
    "disabled checks leave a backlog; re-enabling sends one literal notice, not a digest",
    async () => {
      await app.setExtensionEnabled(owner(app), "pi-agent-msgs.ts", false);
      // Let any CLI check admitted just before disabling finish; it may have claimed a partial batch.
      await pause();
      await cli(
        "send",
        "--project",
        "secret-project",
        "--kind",
        "blocked",
        "PRIVATE_PAYLOAD_ONE",
      );
      await cli("send", "--kind", "done", "PRIVATE_PAYLOAD_TWO");
      await pause();
      assert.equal(await notices(first), 0);
      assert.equal((await cli("status")).unnotified, 2);
      await app.setExtensionEnabled(owner(app), "pi-agent-msgs.ts", true);
      await until(
        async () => (await notices(first)) === 1 && (await notified()),
        "one payload-free notice",
      );
      const transcript = (await modelTexts(app, first)).join("\n");
      assert.doesNotMatch(transcript, /PRIVATE_PAYLOAD|secret-project/);
      const rows = (await cli("list")).messages;
      assert.equal(rows.length, 2);
      assert.ok(
        rows.every(
          (row: { read_at: unknown; notified_at: unknown }) =>
            row.read_at === null && row.notified_at !== null,
        ),
      );
      await pause();
      assert.equal(
        await notices(first),
        1,
        "already-notified unread messages do not repeatedly wake the receiver",
      );
    },
  );

  await t.test(
    "new arrivals wake the receiver even when earlier messages remain unread",
    async () => {
      await cli("send", "new outcome");
      await until(
        async () => (await notices(first)) === 2 && (await notified()),
        "new arrival notice",
      );
      assert.equal((await cli("list")).messages.length, 3);
    },
  );

  await t.test(
    "opening another session and selecting it moves the sole receiver",
    async () => {
      await say(app, second, "receive here");
      await cli("send", "after receiver move");
      await until(
        async () => (await notices(second)) === 1 && (await notified()),
        "notice in new session",
      );
      assert.equal(await notices(first), 2);
      await say(app, second, "receive here");
      await cli("send", "repeat bind must not create duplicate workers");
      await until(
        async () => (await notices(second)) === 2 && (await notified()),
        "one notice after repeated bind",
      );
      await pause();
      assert.equal(await notices(second), 2);
    },
  );

  await t.test(
    "restart after accepted submit but before bus acknowledgment does not submit twice",
    async () => {
      writeFileSync(blockAck, "block");
      await cli("send", "restart delivery");
      await until(
        async () => (await notices(second)) === 3,
        "accepted notice before ack failure",
      );
      assert.equal((await cli("status")).unnotified, 1);
      await app.close();
      unlinkSync(blockAck);
      app = await openApp(model(), data);
      await until(notified, "pending delivery recovered after restart");
      await pause();
      assert.equal(
        await notices(second),
        3,
        "request ID deduplicated across restart",
      );
      await cli("send", "worker survives restart");
      await until(
        async () => (await notices(second)) === 4 && (await notified()),
        "post-restart notice",
      );
    },
  );

  await t.test(
    "spend limits defer delivery without losing pending messages",
    async () => {
      await app.spend.setSessionBudget(owner(app), second, 1);
      await recordCost(app, second, 1);
      await cli("send", "wait for budget");
      await pause();
      assert.equal(await notices(second), 4);
      assert.equal((await cli("status")).unnotified, 1);
      await app.spend.setSessionBudget(owner(app), second, null);
      await until(
        async () => (await notices(second)) === 5 && (await notified()),
        "delivery after budget release",
      );
    },
  );

  await t.test(
    "guests cannot inspect or capture the machine-wide inbox",
    async () => {
      const guest = app.config.addUser("Guest", "guest");
      const user = app.config.userById(guest.user.id)!;
      const { submissionId } = await app.commands.submit(first, user, {
        text: "receive here",
        requestId: crypto.randomUUID(),
      });
      await (await app.harness.submission(submissionId, context))!.wait(
        context,
      );
      assert.match(
        (await modelTexts(app, first)).at(-1)!,
        /Only the Pocket owner/,
      );
      await cli("send", "owner receiver unchanged");
      await until(
        async () => (await notices(second)) === 6 && (await notified()),
        "owner kept receiver",
      );
      assert.equal(await notices(first), 2);
    },
  );

  await t.test(
    "stop clears the binding; selecting again processes messages without a worker leak",
    async () => {
      await say(app, second, "stop bus");
      await cli("send", "after stop");
      await pause();
      assert.equal(await notices(second), 6);
      await say(app, first, "receive here");
      await until(
        async () => (await notices(first)) === 3 && (await notified()),
        "new worker after stop",
      );
      await pause();
      assert.equal(await notices(second), 6);
      assert.ok(!existsSync(blockAck));
    },
  );

  await t.test(
    "disabling during an in-flight CLI check does not send after the toggle",
    async () => {
      const before = await notices(first);
      writeFileSync(blockClaim, "block");
      await until(() => existsSync(claimStarted), "a check to be in flight");
      await app.setExtensionEnabled(owner(app), "pi-agent-msgs.ts", false);
      await cli("send", "arrived after disable during a slow check");
      unlinkSync(blockClaim);
      await pause();
      assert.equal(await notices(first), before);
      assert.equal((await cli("status")).unnotified, 1);
      await app.setExtensionEnabled(owner(app), "pi-agent-msgs.ts", true);
      await until(
        async () => (await notices(first)) === before + 1 && (await notified()),
        "in-flight claim recovered on enable",
      );
    },
  );

  await t.test(
    "disabled stays disabled across restart; enabling resumes the saved receiver",
    async () => {
      const before = await notices(first);
      await app.setExtensionEnabled(owner(app), "pi-agent-msgs.ts", false);
      await pause();
      await cli("send", "backlog across a disabled restart");
      await app.close();
      app = await openApp(model(), data);
      const count = requests;
      await pause();
      assert.equal(requests, count);
      assert.equal(await notices(first), before);
      assert.equal((await cli("status")).unnotified, 1);
      await app.setExtensionEnabled(owner(app), "pi-agent-msgs.ts", true);
      await until(
        async () => (await notices(first)) === before + 1 && (await notified()),
        "saved worker after disabled restart",
      );
    },
  );
});
