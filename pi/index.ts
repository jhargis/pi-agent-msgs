/** Automatic, opt-in returned-control reporting for terminal Pi. No model-callable reporting decision. */
import type {
  ExtensionAPI,
  ExtensionContext,
} from "@earendil-works/pi-coding-agent";
import { execFile } from "node:child_process";
import { realpathSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";

const exec = promisify(execFile);
const WATCH = "pi-agent-msgs.watch";
const PENDING = "pi-agent-msgs.pending";
const SENT = "pi-agent-msgs.sent";
type Setting = {
  session: string;
  enabled: boolean;
  database?: string;
  skipThrough?: string;
};
type Report = {
  session: string;
  run: string;
  database: string;
  project: string;
  reference: string;
  text: string;
  outcome: "settled" | "aborted" | "error";
};

export default function agentMessages(pi: ExtensionAPI) {
  const command =
    process.env.PI_AGENT_MSGS_CLI ??
    join(
      dirname(realpathSync(fileURLToPath(import.meta.url))),
      "../bin/pi-agent-msgs",
    );
  let currentSession: string | undefined;
  let line = Promise.resolve();

  const cli = async (args: string[], input = "") => {
    const pending = exec(command, args, {
      timeout: 15_000,
      maxBuffer: 1024 * 1024,
    });
    pending.child.stdin?.end(input);
    return JSON.parse((await pending).stdout);
  };
  const setting = (ctx: ExtensionContext): Setting => {
    const session = ctx.sessionManager.getSessionId();
    for (const entry of [...ctx.sessionManager.getBranch()].reverse()) {
      if (entry.type === "custom" && entry.customType === WATCH) {
        const value = entry.data as Setting | undefined;
        if (value?.session === session) return value;
      }
    }
    return { session, enabled: false };
  };
  const outbox = (ctx: ExtensionContext) => {
    const session = ctx.sessionManager.getSessionId();
    const pending = new Map<string, Report>();
    const sent = new Set<string>();
    for (const entry of ctx.sessionManager.getBranch()) {
      if (entry.type !== "custom") continue;
      if (entry.customType === PENDING) {
        const value = entry.data as Report;
        if (value?.session === session) pending.set(value.run, value);
      } else if (entry.customType === SENT) {
        const value = entry.data as { session: string; run: string };
        if (value?.session === session) sent.add(value.run);
      }
    }
    return { pending, sent };
  };
  const inform = (ctx: ExtensionContext, text: string, error = false) => {
    if (ctx.hasUI) ctx.ui.notify(text, error ? "error" : "info");
    else if (error) console.error(text);
  };
  const status = (ctx: ExtensionContext) => {
    if (ctx.hasUI)
      ctx.ui.setStatus(
        "pi-agent-msgs",
        setting(ctx).enabled ? "agent reports: on" : undefined,
      );
  };
  const flush = (ctx: ExtensionContext) => {
    const session = ctx.sessionManager.getSessionId();
    const work = line.then(async () => {
      if (currentSession !== session || !setting(ctx).enabled) return;
      const { pending, sent } = outbox(ctx);
      for (const report of pending.values()) {
        if (sent.has(report.run)) continue;
        if (currentSession !== session || !setting(ctx).enabled) return;
        try {
          await cli(
            [
              "--db",
              report.database,
              "settled",
              "--source",
              "pi",
              "--session",
              session,
              "--run",
              report.run,
              "--project",
              report.project,
              "--response-ref",
              report.reference,
              "--outcome",
              report.outcome,
              "--stdin",
            ],
            report.text,
          );
          // Session replacement invalidates the old context. Never append a receipt into a different session.
          if (currentSession !== session) return;
          pi.appendEntry(SENT, { session, run: report.run });
        } catch (error) {
          inform(
            ctx,
            `Agent message reporting failed; the pending report remains in this session for retry: ${error instanceof Error ? error.message : String(error)}`,
            true,
          );
          return;
        }
      }
    });
    line = work.catch(() => {});
    return work;
  };
  const restore = async (ctx: ExtensionContext) => {
    currentSession = ctx.sessionManager.getSessionId();
    status(ctx);
    await flush(ctx);
  };

  pi.on("session_start", async (_event, ctx) => restore(ctx));
  pi.on("session_tree", async (_event, ctx) => restore(ctx));
  pi.registerCommand("agent-msgs", {
    description:
      "Automatic reporting for this session: on, off, status. Reports returned control, not task completion. Default off.",
    handler: async (args, ctx) => {
      currentSession = ctx.sessionManager.getSessionId();
      const action = args.trim() || "status";
      if (!["on", "off", "status"].includes(action)) {
        inform(ctx, "Usage: /agent-msgs on|off|status", true);
        return;
      }
      if (action === "on") {
        try {
          const { database } = await cli(["status"]);
          const skipThrough = ctx.sessionManager
            .getBranch()
            .findLast((entry) => entry.type === "message")?.id;
          pi.appendEntry(WATCH, {
            session: currentSession,
            enabled: true,
            database,
            skipThrough,
          });
        } catch (error) {
          inform(
            ctx,
            `Could not enable agent reports: ${error instanceof Error ? error.message : String(error)}`,
            true,
          );
          return;
        }
      } else if (action === "off") {
        pi.appendEntry(WATCH, { session: currentSession, enabled: false });
      }
      status(ctx);
      const state = setting(ctx);
      const { pending, sent } = outbox(ctx);
      inform(
        ctx,
        `Automatic returned-control reports: ${state.enabled ? "on" : "off"}; ${[...pending.keys()].filter((key) => !sent.has(key)).length} pending.`,
      );
      if (state.enabled) await flush(ctx);
    },
  });
  pi.on("agent_settled", async (event, ctx) => {
    const state = setting(ctx);
    if (!state.enabled || !state.database) return;
    const branch = ctx.sessionManager.getBranch();
    const lastUser = branch.findLastIndex(
      (entry) => entry.type === "message" && entry.message.role === "user",
    );
    const lastAssistant = branch.findLastIndex(
      (entry) => entry.type === "message" && entry.message.role === "assistant",
    );
    const lastMessage = branch.findLast((entry) => entry.type === "message");
    if (!lastMessage) return;
    const run = lastMessage.id;
    if (run === state.skipThrough) {
      await flush(ctx);
      return;
    }
    const { pending, sent } = outbox(ctx);
    if (!pending.has(run) && !sent.has(run)) {
      const entry = branch[lastAssistant];
      const answer =
        lastAssistant >= lastUser &&
        entry?.type === "message" &&
        entry.message.role === "assistant"
          ? entry.message
          : undefined;
      const text =
        answer?.content
          .filter((part) => part.type === "text")
          .map((part) => part.text)
          .join("\n") ?? "";
      const file = ctx.sessionManager.getSessionFile();
      pi.appendEntry(PENDING, {
        session: state.session,
        run,
        database: state.database,
        project: ctx.cwd,
        reference: file
          ? `${file}#${answer ? entry.id : lastMessage.id}`
          : `pi session ${state.session}, entry ${run}`,
        text: text.slice(0, 4001),
        outcome: event.aborted
          ? "aborted"
          : answer?.stopReason === "error"
            ? "error"
            : "settled",
      } satisfies Report);
    }
    await flush(ctx);
  });
}
