import {
  cleanUp,
  context,
  lastText,
  modelTexts,
  newSession,
  openApp,
  owner,
  root,
  say,
  scriptedModel,
  until,
} from "../../pi-pocket/test/helpers.ts";
import {
  fauxAssistantMessage,
  fauxText,
  fauxToolCall,
} from "@earendil-works/pi-ai/providers/faux";
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { copyFileSync, mkdirSync, unlinkSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { after, before, test } from "node:test";
import { promisify } from "node:util";
import type { ConversationId } from "@earendil-works/pi-durable";
import { ReportingDoc } from "../pocket/pi-agent-msgs.ts";

const exec = promisify(execFile);
const CLI = resolve(import.meta.dirname, "../bin/pi-agent-msgs");
const data = join(root, "report-data");
const database = join(root, "bus.sqlite3");
const wrapper = join(root, "cli");
const failAfter = join(root, "fail-after");
let modelCalls = 0;
const route = () =>
  scriptedModel((input) => {
    modelCalls++;
    const last = lastText(input as never);
    const text = last.text.replace(/^\[from: [^\]]+\] /, "");
    const actions: Record<string, string> = {
      "watch on": "watch_on",
      "watch off": "watch_off",
      "watch status": "watch_status",
      "receive here": "receive_here",
    };
    if (last.role === "user" && actions[text])
      return fauxAssistantMessage(
        [fauxToolCall("agent_msgs", { action: actions[text] })],
        { stopReason: "toolUse" },
      );
    if (last.role === "user" && text === "slow work")
      return fauxAssistantMessage(
        [fauxToolCall("bash", { command: "sleep 0.35; echo CHECK_PASSED" })],
        { stopReason: "toolUse" },
      );
    return fauxAssistantMessage([
      fauxText(
        last.role === "toolResult" && text.includes("CHECK_PASSED")
          ? "Checks passed; I need your decision before proceeding."
          : `reply: ${text}`,
      ),
    ]);
  });
let app: Awaited<ReturnType<typeof openApp>>;
let source: ConversationId;
let receiver: ConversationId;
let unwatched: ConversationId;
const pause = () => new Promise((done) => setTimeout(done, 250));
const reports = async () =>
  JSON.parse(
    (await exec(CLI, ["--db", database, "list", "--all"])).stdout,
  ).messages.filter((message: any) => message.sender === "pocket-harness");
const count = async () => (await reports()).length;

before(async () => {
  mkdirSync(join(data, "extensions"), { recursive: true });
  copyFileSync(
    resolve(import.meta.dirname, "../pocket/pi-agent-msgs.ts"),
    join(data, "extensions/pi-agent-msgs.ts"),
  );
  writeFileSync(
    wrapper,
    `#!/bin/sh\ncase "$*" in *" settled "*) if [ -f '${failAfter}' ]; then '${CLI}' "$@"; echo 'simulated crash after bus acceptance' >&2; exit 1; fi;; esac\nexec '${CLI}' "$@"\n`,
    { mode: 0o700 },
  );
  process.env.PI_AGENT_MSGS_CLI = wrapper;
  process.env.PI_AGENT_MSGS_DB = database;
  process.env.PI_AGENT_MSGS_POLL_MS = "80";
  app = await openApp(route(), data);
  await app.setExtensionEnabled(owner(app), "pi-agent-msgs.ts", true);
  source = await newSession(app);
  receiver = await newSession(app);
  unwatched = await newSession(app);
  await say(app, receiver, "receive here");
});
after(async () => {
  await app?.close();
  delete process.env.PI_AGENT_MSGS_CLI;
  delete process.env.PI_AGENT_MSGS_DB;
  delete process.env.PI_AGENT_MSGS_POLL_MS;
  cleanUp();
});

test("Pocket observes actual idle state for explicitly watched sessions only", async (t) => {
  await t.test(
    "the slash task controls a brand-new model-less session and retires an idle watcher on off",
    async () => {
      const { id } = await app.commands.createSession(owner(app), {
        cwd: root,
      });
      await (await app.harness.conversation(id, context))!.configure(
        { model: null },
        context,
      );
      const loaded = await app.loader.reload("pi-agent-msgs.ts");
      const command = loaded
        .flatMap((extension) => extension.tasks ?? [])
        .find(
          (task) => task.definition.name === "pi-agent-msgs.reporting-command",
        )!;
      const control = async (action: string) => {
        const taskId = await app.harness.commit(
          (tx) =>
            tx.createTask(
              command as never,
              { action, by: owner(app).id },
              {
                conversationId: id,
                ownership: { kind: "conversation" },
                background: true,
              },
            ),
          context,
        );
        const result = await app.harness.waitForTask(taskId, context);
        assert.equal(result.state.outcome.status, "completed");
        return result.state.outcome.status === "completed"
          ? (result.state.outcome.result as { reporting: boolean })
          : undefined;
      };
      const before = modelCalls;
      assert.equal((await control("status"))?.reporting, false);
      assert.equal((await control("on"))?.reporting, true);
      const watcher = (await app.harness.snapshot(ReportingDoc, id, context))!
        .config!.task;
      await pause();
      assert.equal((await control("on"))?.reporting, true);
      assert.equal(
        (await app.harness.snapshot(ReportingDoc, id, context))!.config!.task,
        watcher,
      );
      assert.equal((await control("status"))?.reporting, true);
      assert.equal((await control("off"))?.reporting, false);
      const stopped = await app.harness.waitForTask(watcher, context);
      assert.equal(stopped.state.outcome.status, "completed");
      assert.equal(modelCalls, before);
      assert.deepEqual(await modelTexts(app, id), []);
      assert.equal(app.isBusy(id), false);
      assert.equal(await count(), 0);
    },
  );
  await t.test(
    "off by default, including the receiver; enabling/status turns are not reported",
    async () => {
      await say(app, source, "ordinary work");
      await say(app, unwatched, "ordinary work");
      await pause();
      assert.equal(await count(), 0);
      await say(app, source, "watch on");
      await say(app, source, "watch status");
      await pause();
      assert.equal(await count(), 0);
      assert.match((await modelTexts(app, source)).at(-1)!, /reporting.*true/);
    },
  );
  await t.test(
    "a tool round is not settled; one final event has context without asserting task completion",
    async () => {
      const target = (await app.harness.conversation(source, context))!;
      const work = await target.submit(
        { type: "input", content: "slow work", requestId: "slow-1" },
        context,
      );
      await until(() => app.isBusy(source), "busy source");
      await new Promise((done) => setTimeout(done, 100));
      assert.equal(await count(), 0);
      await work.wait(context);
      await until(async () => (await count()) === 1, "settled source report");
      const [message] = await reports();
      const body = JSON.parse(message.body);
      assert.equal(message.kind, "stopped");
      assert.equal(body.event, "agent_returned_control");
      assert.equal(body.session, String(source));
      assert.match(body.response_excerpt, /need your decision/);
      assert.match(body.response_ref, new RegExp(`/s/${source}`));
      assert.equal(body.outcome, "settled");
      await pause();
      assert.equal(await count(), 1);
    },
  );
  await t.test(
    "queued follow-ups settle as one burst, not one report per answer",
    async () => {
      const target = (await app.harness.conversation(source, context))!;
      const first = await target.submit(
        { type: "input", content: "slow work", requestId: "queued-1" },
        context,
      );
      const second = await target.submit(
        {
          type: "input",
          content: "follow-up final response",
          whenBusy: "followUp",
          requestId: "queued-2",
        },
        context,
      );
      await Promise.all([first.wait(context), second.wait(context)]);
      await until(async () => (await count()) === 2, "one queued-burst report");
      await pause();
      assert.equal(await count(), 2);
      assert.match(
        JSON.parse((await reports()).at(-1).body).response_excerpt,
        /follow-up final response/,
      );
    },
  );
  await t.test(
    "stop/cancel is reported without the reporter being aborted with the run",
    async () => {
      const target = (await app.harness.conversation(source, context))!;
      await target.submit(
        { type: "input", content: "slow work", requestId: "abort-1" },
        context,
      );
      await until(() => app.isBusy(source), "source to abort");
      await new Promise((done) => setTimeout(done, 50));
      await target.abort(context);
      await until(async () => (await count()) === 3, "aborted control return");
      assert.equal((await reports()).at(-1).kind, "stopped");
      assert.equal(
        JSON.parse((await reports()).at(-1).body).outcome,
        "aborted",
      );
    },
  );
  await t.test(
    "failure before a provider request is still observed",
    async () => {
      const target = (await app.harness.conversation(source, context))!;
      await target.configure(
        { model: { provider: "nonexistent", modelId: "missing" } },
        context,
      );
      const failed = await target.submit(
        { type: "input", content: "cannot run", requestId: "bad-model" },
        context,
      );
      await failed.wait(context);
      await until(async () => (await count()) === 4, "failed run event");
      assert.equal(JSON.parse((await reports()).at(-1).body).outcome, "error");
      await target.configure(
        { model: { provider: "faux", modelId: "faux-1" } },
        context,
      );
    },
  );
  await t.test(
    "opt-out suppresses runs; opt-in starts fresh rather than replaying old work",
    async () => {
      await say(app, source, "watch off");
      await say(app, source, "unwatched result");
      await pause();
      assert.equal(await count(), 4);
      await say(app, source, "watch on");
      await pause();
      assert.equal(await count(), 4);
      await say(app, source, "new watched result");
      await until(async () => (await count()) === 5, "new opted-in report");
    },
  );
  await t.test(
    "watch state and reporting survive restart without replay",
    async () => {
      await pause();
      await app.close();
      app = await openApp(route(), data);
      await pause();
      assert.equal(await count(), 5);
      await say(app, source, "after restart");
      await until(async () => (await count()) === 6, "resumed report");
    },
  );
  await t.test(
    "bus acceptance before a failed receipt/restart is deduplicated",
    async () => {
      writeFileSync(failAfter, "fail");
      await say(app, source, "pending source report");
      await until(async () => (await count()) === 7, "accepted source event");
      await app.close();
      unlinkSync(failAfter);
      app = await openApp(route(), data);
      await pause();
      assert.equal(await count(), 7);
      await say(app, source, "next source report");
      await until(async () => (await count()) === 8, "next source event");
    },
  );
  await t.test(
    "the receiver cannot be watched; moving the receiver clears its previous source watch",
    async () => {
      const beforeWatch = (await modelTexts(app, receiver)).length;
      await say(app, receiver, "watch on");
      // A bus notice can arrive after the management reply; inspect this turn, not just the tail.
      assert.match(
        (await modelTexts(app, receiver)).slice(beforeWatch).join("\n"),
        /excluded from automatic reporting/,
      );
      await say(app, source, "receive here");
      await say(app, source, "receiver reviewing messages");
      await pause();
      assert.equal(await count(), 8);
      const beforeStatus = (await modelTexts(app, source)).length;
      await say(app, source, "watch status");
      assert.match(
        (await modelTexts(app, source)).slice(beforeStatus).join("\n"),
        /reporting.*false/,
      );
      await pause();
      assert.equal(await count(), 8);
    },
  );
});
