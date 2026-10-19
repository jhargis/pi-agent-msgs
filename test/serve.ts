// Isolated browser demonstration: never points at the real Pocket data or a real provider.
import {
  fauxAssistantMessage,
  fauxText,
  fauxToolCall,
} from "@earendil-works/pi-ai/providers/faux";
import { copyFileSync, mkdirSync } from "node:fs";
import { createServer } from "node:http";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";

const pocketRoot =
  process.env.PI_AGENT_MSGS_TEST_POCKET_ROOT ??
  resolve(import.meta.dirname, "../../pi-pocket");
const {
  cleanUp,
  lastText,
  newSession,
  openApp,
  owner,
  root,
  say,
  scriptedModel,
} = await import(pathToFileURL(join(pocketRoot, "test/helpers.ts")).href);
const { createHandler } = await import(
  pathToFileURL(join(pocketRoot, "src/server/http.ts")).href
);

const CLI = resolve(import.meta.dirname, "../bin/pi-agent-msgs");
const database = join(root, "messages.sqlite3");
const data = join(root, "data");
mkdirSync(join(data, "extensions"), { recursive: true });
copyFileSync(
  resolve(import.meta.dirname, "../pocket/pi-agent-msgs.ts"),
  join(data, "extensions/pi-agent-msgs.ts"),
);
process.env.PI_AGENT_MSGS_CLI = CLI;
process.env.PI_AGENT_MSGS_DB = database;
process.env.PI_AGENT_MSGS_POLL_MS = "1000";
let summary = "";
const app = await openApp(
  scriptedModel((input) => {
    const last = lastText(input as never);
    const text = last.text.replace(/^\[from: [^\]]+\] /, "");
    const tool = (name: string, args: Record<string, unknown>) =>
      fauxAssistantMessage([fauxToolCall(name, args)], {
        stopReason: "toolUse",
      });

    if (last.role === "user" && /receive agent messages here/i.test(text)) {
      return tool("agent_msgs", { action: "receive_here" });
    }
    if (last.role === "user" && /show agent message status/i.test(text)) {
      return tool("agent_msgs", { action: "status" });
    }
    if (
      last.role === "user" &&
      /turn automatic reporting on for this session/i.test(text)
    ) {
      return tool("agent_msgs", { action: "watch_on" });
    }
    if (last.role === "user" && /turn automatic reporting off/i.test(text)) {
      return tool("agent_msgs", { action: "watch_off" });
    }
    if (last.role === "user" && text === "Complete demo work") {
      return fauxAssistantMessage([
        fauxText(
          "Demo work returned control; simulated checks passed. No real task work was performed; ready for your review.",
        ),
      ]);
    }
    if (text === "New messages are available on the agent message bus.") {
      return tool("bash", { command: `'${CLI}' --db '${database}' list` });
    }
    if (last.role === "toolResult") {
      try {
        const value = JSON.parse(last.text);
        if (Array.isArray(value.messages) && value.messages.length > 0) {
          summary = value.messages
            .map((message: { kind: string; body: string }) => {
              try {
                const report = JSON.parse(message.body);
                if (report.event === "agent_returned_control")
                  return `Session ${report.session} returned control (${report.outcome}). ${report.response_excerpt}`;
              } catch {
                /* Manual report text. */
              }
              return `${message.kind}: ${message.body}`;
            })
            .join("\n");
          const ids = value.messages
            .map((message: { id: number }) => message.id)
            .join(" ");
          return tool("bash", {
            command: `'${CLI}' --db '${database}' ack ${ids}`,
          });
        }
        if (Array.isArray(value.acknowledged)) {
          return fauxAssistantMessage([
            fauxText(`Reviewed and acknowledged:\n${summary}`),
          ]);
        }
      } catch {
        /* Normal tool errors render below. */
      }
      return fauxAssistantMessage([fauxText(last.text)]);
    }
    return fauxAssistantMessage([
      fauxText(
        `Demo ready. Open either conversation and say “Receive agent messages here” to select it.`,
      ),
    ]);
  }),
  data,
);
await app.setExtensionEnabled(owner(app), "pi-agent-msgs.ts", true);
const first = await newSession(app);
await say(app, first, "Personal assistant demo");
const second = await newSession(app);
await say(app, second, "Project work demo");
const host = "127.0.0.2";
const port = 8898;
const handler = createHandler({
  app,
  listen: { host, port },
  restart: () => {},
});
const server = createServer(
  (request, response) => void handler(request, response),
);
await new Promise<void>((done) => server.listen(port, host, done));
console.log(
  `Owner: http://${host}:${port}/login?token=${encodeURIComponent(app.config.ownerToken)}`,
);
console.log(`Receiver: http://${host}:${port}/s/${first}`);
console.log(`Source: http://${host}:${port}/s/${second}`);
console.log(
  `Sample: '${CLI}' --db '${database}' send --project demo --kind done 'Login fix complete; all 12 tests passed; ready for review.'`,
);
console.log(
  `PID: ${process.pid}; data: ${root}. SIGTERM stops the demo and removes its data.`,
);
const stop = async () => {
  server.closeAllConnections();
  server.close();
  await app.close();
  cleanUp();
  process.exit(0);
};
process.on("SIGTERM", () => void stop());
process.on("SIGINT", () => void stop());
