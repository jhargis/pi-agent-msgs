// Exercise the real terminal Pi lifecycle with an isolated scripted provider, not just mocked hook calls.
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { test } from "node:test";
import { promisify } from "node:util";
import {
  fauxAssistantMessage,
  fauxProvider,
  fauxText,
  fauxToolCall,
} from "@earendil-works/pi-ai/providers/faux";
import { Type } from "@earendil-works/pi-ai";
import extension from "../pi/index.ts";

const exec = promisify(execFile);

test("real Pi SDK: opt-in command, tool round and final settlement", async () => {
  const root = mkdtempSync(join(tmpdir(), "pi-msgs-sdk-test-"));
  const agentDir = join(root, "agent");
  mkdirSync(agentDir);
  const database = join(root, "bus.sqlite3");
  const CLI = resolve(import.meta.dirname, "../bin/pi-agent-msgs");
  const saved = {
    cli: process.env.PI_AGENT_MSGS_CLI,
    db: process.env.PI_AGENT_MSGS_DB,
    agent: process.env.PI_CODING_AGENT_DIR,
  };
  process.env.PI_AGENT_MSGS_CLI = CLI;
  process.env.PI_AGENT_MSGS_DB = database;
  process.env.PI_CODING_AGENT_DIR = agentDir;
  let session: any;
  const rows = async () =>
    JSON.parse((await exec(CLI, ["--db", database, "list", "--all"])).stdout)
      .messages;
  try {
    const {
      createAgentSession,
      DefaultResourceLoader,
      ModelRuntime,
      SessionManager,
      SettingsManager,
    } = await import(
      process.env.PI_AGENT_MSGS_TEST_SDK ?? "@earendil-works/pi-coding-agent"
    );
    const runtime = await ModelRuntime.create({
      authPath: join(agentDir, "auth.json"),
      modelsPath: null,
      modelsStorePath: join(agentDir, "models-store.json"),
      allowModelNetwork: false,
      refreshOnCreate: false,
    });
    const faux = fauxProvider({
      tokensPerSecond: 2000,
      models: [{ id: "scripted" }],
    });
    faux.setResponses([
      fauxAssistantMessage([fauxText("An unwatched answer.")]),
      fauxAssistantMessage([fauxToolCall("probe", {})], {
        stopReason: "toolUse",
      }),
      fauxAssistantMessage([
        fauxText("Checks passed; waiting for the user's decision."),
      ]),
      fauxAssistantMessage([fauxText("Another unwatched answer.")]),
    ]);
    runtime.registerNativeProvider(faux.provider);
    const settings = SettingsManager.inMemory({
      compaction: { enabled: false },
      retry: { enabled: false },
      enableInstallTelemetry: false,
    });
    const resources = new DefaultResourceLoader({
      cwd: root,
      agentDir,
      settingsManager: settings,
      noSkills: true,
      noPromptTemplates: true,
      noThemes: true,
      noContextFiles: true,
      disabledBuiltinExtensions: ["mcp"],
      extensionFactories: [extension],
    });
    await resources.reload();
    const errors: string[] = [];
    ({ session } = await createAgentSession({
      cwd: root,
      agentDir,
      modelRuntime: runtime,
      model: runtime.getModel("faux", "scripted")!,
      thinkingLevel: "off",
      resourceLoader: resources,
      settingsManager: settings,
      sessionManager: SessionManager.create(root, join(root, "sessions")),
      tools: ["probe"],
      customTools: [
        {
          name: "probe",
          label: "Probe",
          description: "A scripted local check.",
          parameters: Type.Object({}),
          execute: async () => {
            assert.equal(
              (await rows()).length,
              0,
              "a tool round must not report settlement",
            );
            return {
              content: [{ type: "text", text: "check passed" }],
              details: {},
            };
          },
        },
      ],
    }));
    await session.bindExtensions({
      mode: "json",
      onError: (error: any) =>
        errors.push(String(error.error ?? error.message ?? error)),
    });
    await session.prompt("Unwatched work");
    assert.equal((await rows()).length, 0);
    await session.prompt("/agent-msgs on");
    await session.prompt("/agent-msgs status");
    assert.equal(
      (await rows()).length,
      0,
      "management commands do not report old results",
    );
    await session.prompt("Do watched work");
    const messages = await rows();
    assert.equal(messages.length, 1);
    const body = JSON.parse(messages[0].body);
    assert.equal(body.source, "pi");
    assert.equal(body.event, "agent_returned_control");
    assert.match(body.response_excerpt, /waiting for the user's decision/);
    await session.prompt("/agent-msgs off");
    await session.prompt("Unwatched again");
    assert.equal((await rows()).length, 1);
    assert.deepEqual(errors, []);
  } finally {
    session?.dispose();
    for (const [key, value] of [
      ["PI_AGENT_MSGS_CLI", saved.cli],
      ["PI_AGENT_MSGS_DB", saved.db],
      ["PI_CODING_AGENT_DIR", saved.agent],
    ]) {
      if (value === undefined) delete process.env[key!];
      else process.env[key!] = value;
    }
    rmSync(root, { recursive: true, force: true });
  }
});
