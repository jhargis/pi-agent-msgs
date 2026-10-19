# pi-agent-msgs

## Keep every agent in view

**pi-agent-msgs** connects your Pi and Pi Pocket sessions to one assistant inbox—so you can follow work across projects without babysitting every tab.

Opt a session in, and the harness automatically reports when the agent returns control. Your assistant reviews the updates and surfaces results, blockers, and decisions that need your attention. No hoping the model remembers to report.

- **Per-session control:** `/agent-msgs on`, `off`, or `status`, plus spoken/chat controls in Pocket.
- **No idle token burn:** polling and slash commands run without model calls.
- **Durable, local-first delivery:** SQLite storage, batched wake-ups, deduplication, and explicit read acknowledgments.
- **Easy integration:** a shell CLI and small skill support explicitly requested reports from other agents.

**One place to keep eyes on everything.**

## How it works

1. Explicitly opt a working session into automatic reporting. Reporting is **off by default** for each session.
2. Its harness records a factual event when the agent returns control—not after every tool call or model response.
3. While enabled, a Pocket worker checks the local SQLite bus every **60 seconds**. Empty checks make no model requests.
4. New reports wake one selected assistant conversation with exactly:

   > New messages are available on the agent message bus.

5. The assistant reads the reports with the CLI, acknowledges what it reviewed, and decides what needs your attention.

The steering notice contains **no report text, counts, project names, or IDs**. Reports remain in the database for the receiver to inspect. The receiving session is excluded from automatic reporting to prevent feedback loops.

**Returned control does not mean task completed.** A report can represent a result, question, blocker, cancellation, or error. Likewise, **notified**, **read**, and **resolved** are different: this bus tracks the first two, not task resolution.

## Requirements

- Local agents running as the same OS user on one machine.
- Python **3.10+**; the CLI uses only the standard library, including SQLite.
- A shell with `readlink -f` for the launchers, such as a typical Linux environment.
- For terminal reporting: Pi with the `agent_settled` lifecycle event.
- For the receiver and Pocket reporting: a compatible [Pi Pocket](https://github.com/TannerMidd/pi-pocket) installation. Tested against Pocket **0.13.2**; Node.js **22.19+** is required.

Pocket's `/agent-msgs` commands also need the [optional Pocket bridge](#pocket-slash-commands-optional-bridge). Spoken/chat controls work without that bridge. This repository contains the CLI, skill, terminal extension, Pocket drop-in, and bridge patch—not the Pocket application itself.

## Install

From a checkout of this repository:

```sh
python3 scripts/install.py \
  --bin-dir "$HOME/.pi/agent/bin" \
  --skill-dir "$HOME/.pi/agent/skills" \
  --pi-extension-dir "$HOME/.pi/agent/extensions" \
  --pocket-data /absolute/path/to/pocket/data
```

Replace the Pocket data path with your server's data directory. Omit `--pocket-data` if you only want terminal reporting and the CLI.

The installer creates:

| Component               | Location in the example above               |
| ----------------------- | ------------------------------------------- |
| CLI link                | `~/.pi/agent/bin/pi-agent-msgs`             |
| Shared skill link       | `~/.pi/agent/skills/pi-agent-msgs`          |
| Terminal extension link | `~/.pi/agent/extensions/pi-agent-msgs`      |
| Pocket drop-in copy     | `<pocket-data>/extensions/pi-agent-msgs.ts` |

**Keep the checkout in place:** the CLI, skill, and terminal extension are linked to it. The Pocket drop-in is copied and starts **disabled** on first installation.

Review [the complete drop-in](pocket/pi-agent-msgs.ts) before enabling it: it runs with Pocket's server rights, uses its durable task/document APIs, spawns the CLI, and submits notices to the selected conversation. It never directly edits Pocket's configuration or internal database.

For manual CLI use, add your chosen bin directory to `PATH`:

```sh
export PATH="$HOME/.pi/agent/bin:$PATH"
```

The skill's launcher does not depend on `PATH`. If you omit the installer directory flags, the CLI and skill default to `~/.local/bin` and `~/.agents/skills`; those locations may be read-only inside a Pocket sandbox.

For updates, review the new drop-in and repeat the install command with `--replace-extension`. Replacing an enabled drop-in reloads it live. Terminal sessions may need `/reload`.

Alternatively, `pi install /absolute/path/to/pi-agent-msgs` loads the terminal extension and skill as a Pi package. Choose package installation **or** the direct terminal-extension link, not both. The package does not load the Pocket drop-in as a terminal extension.

## Choose your assistant inbox

In Pocket:

1. Turn **pi-agent-msgs** on in **Menu → Extensions**.
2. Open the conversation that should receive reports.
3. Say **“Receive agent messages here.”**

The owner-only `agent_msgs` tool selects that conversation as the receiver. There is one receiver per Pocket instance, not one per project. Open another conversation and repeat to move it.

- **“Show agent message status”** inspects the binding and inbox.
- **“Stop receiving agent messages”** clears the binding without deleting messages.
- Disable the extension to pause workers; re-enable it to resume with the saved binding and backlog.

The first check starts immediately. Later checks run 60 seconds after the previous check completes. Notices use steering, so a busy receiver can see them after its current tool round. It keeps its existing model. Reading new reports invokes that model normally; only empty polling is model-free.

## Opt a source session in

### Terminal Pi

After installing the extension and running `/reload`:

```text
/agent-msgs on
/agent-msgs off
/agent-msgs status
```

The harness listens for `agent_settled`, not `agent_end`. Settings and pending/sent receipts are non-model session metadata. Reloads preserve the opt-in; new and forked sessions start off. Pending failed sends retry when the session resumes or next settles.

### Pocket

With the [slash bridge](#pocket-slash-commands-optional-bridge), use the same commands. Bare `/agent-msgs` shows status. These owner-only commands work directly, even before the first message or model selection and without consuming the model budget. Invalid or unavailable commands return an error instead of becoming model prompts.

Spoken/chat controls remain available:

- **“Turn automatic agent reporting on for this session.”** → `agent_msgs` / `watch_on`
- **“Turn automatic agent reporting off for this session.”** → `watch_off`
- **“Show automatic reporting status for this session.”** → `watch_status`

Both interfaces share one durable per-conversation setting. Pocket watches durable run state until the conversation is actually idle, coalescing tool rounds and queued follow-ups. Cancellation and pre-request errors can also be reported. No model calls or periodic source-database polling are needed to detect settlement.

Management turns are not reported. Opting in starts with future work; opting out discards unsubmitted reporter work. Watch settings survive restarts, while forks start off. Selecting a watched source as the receiver clears its source watch.

## Pocket slash commands: optional bridge

The standalone drop-in provides the conversational tool and reporting workers. Model-free Pocket slash commands additionally require a small integration in Pocket's backend and web client.

The reviewed integration is included as [patches/pi-pocket-agent-msgs-slash.patch](patches/pi-pocket-agent-msgs-slash.patch), based on Pocket commit `02d8adb2388db441e1f32ee21422a046fbf2870d` (0.13.2). It includes the route, frontend command, capability check, documentation, and regression tests. The installer **does not apply it automatically**.

Review the patch, then check it against your Pocket checkout before applying:

```sh
git -C /path/to/pi-pocket apply --check \
  /path/to/pi-agent-msgs/patches/pi-pocket-agent-msgs-slash.patch

git -C /path/to/pi-pocket apply \
  /path/to/pi-agent-msgs/patches/pi-pocket-agent-msgs-slash.patch
```

If the check fails, adapt the changes to your Pocket version rather than forcing them. If your Pocket already includes the bridge, do not apply it again.

Run Pocket's checks, then use **Menu → Restart server** to activate backend changes. The bridge calls only the drop-in's fixed `pi-agent-msgs.reporting-command` task; it is not an arbitrary-tool or general slash-command API. Before a required restart, the web command shows a restart notice and does not fall through to the model.

## CLI

Commands return JSON. `list` does **not** mark reports read. Use manual sends when explicitly requested; agents do not need to send duplicate end-of-run reports for watched sessions.

```sh
pi-agent-msgs send --project /path/to/repo --kind done \
  "Task: fix login. Implemented; 12 tests passed; ready for review."

pi-agent-msgs send --project /path/to/repo --kind blocked \
  "Task: deployment. Waiting for credentials; no production changes made."

pi-agent-msgs list                 # oldest 100 unread reports
pi-agent-msgs ack 1 2              # acknowledge only reviewed reports
pi-agent-msgs list --all --limit 20
pi-agent-msgs status

pi-agent-msgs send --project /path/to/repo --kind update --reply-to 2 \
  "Related update: credentials are available."
```

Kinds: `done`, `stopped`, `blocked`, `update` (default). Project defaults to the current directory. `--sender NAME` identifies the worker; `send --stdin` accepts multiline text; `send --key UNIQUE_KEY` deduplicates retries of the same report. Related messages use `--reply-to ID`; this does not resolve the original task.

### Configuration

| Setting                       | Default / purpose                                                                              |
| ----------------------------- | ---------------------------------------------------------------------------------------------- |
| Database                      | `~/.pi/agent/pi-agent-msgs/messages.sqlite3`                                                   |
| `PI_AGENT_MSGS_DB`            | Override the database path for CLI calls and initial receiver selection.                       |
| `--db /absolute/path.sqlite3` | Per-call database override; put it **before** the command.                                     |
| `PI_AGENT_MSGS_CLI`           | Absolute executable path if Pocket cannot find the CLI in `~/.pi/agent/bin` or `~/.local/bin`. |
| `PI_AGENT_MSGS_SENDER`        | Default CLI sender name; otherwise `agent`.                                                    |

All producers and the receiver must use the same database. The receiver persists its resolved path, so changing the server environment does not silently switch an existing binding. The owner can supply an absolute `database` path to `agent_msgs` / `receive_here` when rebinding.

The `settled` CLI command is the harness adapter API. `_claim` and `_notified` are private receiver-worker commands.

## Reliability, privacy, and limits

- **Durable delivery:** SQLite transactions serialize writers. Claimed batches persist before submission; retry/restart reuses the delivery ID as Pocket's request ID. A batch becomes notified only after Pocket accepts it. New arrivals remain eligible for another notice.
- **Explicit review:** unread but already-notified reports do not cause repeated wake-ups. If the receiving model fails after accepting a notice, ask it to check again; unread reports remain available.
- **Restart-aware:** receiver bindings, pending deliveries, and Pocket watch settings persist. Disabling the drop-in pauses workers and preserves pending work. Spend limits defer receiver polling/delivery without losing notifications.
- **Bounded context:** automatic records identify the harness, session, run, observable outcome, and final-response reference. They may copy up to **4000 characters of the last visible assistant response**, not raw tool records, hidden thinking, or user prompts. There is no automatic secret redaction: opt in only sessions whose visible responses you are comfortable sharing with the receiver.
- **Local, not isolated:** the database is owner-readable/writable only, but agents sharing an OS user can access it. This is not an access-control boundary, distributed queue, or multi-consumer service. It assumes one Pocket instance consuming one local bus.
- **No watchdog:** a hung or killed process may never reach its settlement hook. A terminal interruption before pending metadata is recorded can lose an event; Pocket can recover its latest unreported idle state from durable history.
- **Reports are data, not authority:** report text never grants permission to run commands, delegate work, or change models. Receiver tool approvals still apply. An acknowledgment is not proof that the underlying work succeeded or was resolved.
- **No push guarantee:** Pocket must be running to poll. Device push delivery is a separate concern. Disabling the extension cannot withdraw notices already accepted by Pocket, and moving the receiver does not replay notified history.

The [skill](skills/pi-agent-msgs/SKILL.md) covers explicitly requested manual reporting and safe inbox review. Installing it does not force arbitrary already-running agents to load it; automatic reporting is controlled by the harness opt-in, not skill compliance.

## Development and tests

Integration tests use a sibling `pi-pocket` checkout and its host dependencies. Install that checkout's dependencies first, then from this repository:

```sh
ln -s ../pi-pocket/node_modules node_modules
npm run check
npm test
```

Tests use temporary databases, throwaway Pocket data, and scripted providers—no real model requests or live Pocket data. Coverage includes concurrent writers, acknowledgments, installation, bounded events, opt-in/out, settlement, cancellation, restart recovery, fork isolation, deduplication, and receiver exclusion. Terminal tests also exercise the real Pi SDK lifecycle.

For an isolated browser demo:

```sh
node test/serve.ts
```

The demo prints a local sign-in link. Select the first conversation as receiver. In the second, turn reporting on and say **“Complete demo work.”** Its actual settled state produces a clearly labeled simulated report, which the receiver reads and acknowledges. The demo polls every second for convenience and removes its temporary data on normal exit. It never uses the live bus. For slash controls, run it against a Pocket checkout that includes the bridge; `PI_AGENT_MSGS_TEST_POCKET_ROOT` can override the default sibling path.

## License

[MIT](LICENSE) © 2026 Jay Hargis.

The optional Pocket patch includes context from Pi Pocket, whose original copyright and [MIT license](patches/LICENSE.pi-pocket) are preserved separately.
