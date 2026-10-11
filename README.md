# ADE — Agent Development Environment

> One workspace, every device, every agent.

ADE is **not** a chat app. It is a development environment that lives on a server
(or your own PC): the workspace (files, processes, tasks) has a single copy, and
your desktop / phone / tablet are just screens onto it. Agents — **Codex**,
**Claude Code**, **Pi**, anything with a CLI — run as managed processes inside
that workspace, and every task is captured as an append-only event stream.

```
   PC 浏览器 / 桌面壳        手机 PWA            Pad
   编辑器 + chat + 任务       chat + 任务 + 审批    分屏工作台
        └─────────────┬──────────────┘
                      │ HTTPS + WebSocket
        ┌─────────────▼──────────────┐
        │  ADE Server                │
        │  auth · REST API · WS 广播  │
        ├────────────────────────────┤
        │  文件服务 + watcher          │
        │  Monaco 编辑后端             │
        │  Agent 进程管理 (pipes + PTY)│
        │    ├ codex                 │
        │    ├ claude                │
        │    └ pi                    │
        │  事件存储 (JSONL, 追加式)    │
        └────────────────────────────┘
```

## Status — M0 skeleton + interactive terminal

- [x] Monorepo: `shared` (types/events) · `server` · `web`
- [x] REST: file tree / read / write, agents, task dispatch / abort / replay
- [x] WebSocket: init snapshot + realtime task output + file-change broadcast
- [x] Web UI: file tree · Monaco editor (bundled locally, no CDN) · task chat
- [x] Download the full append-only task event log (JSONL) from any device;
      the live UI keeps only the most recent 2000 events (`npm run smoke:task-log`)
- [x] Quick open: find files by name or path from any pane on desktop, tablet,
      or phone; `Ctrl/Cmd+P` also opens it (`npm run smoke:quick-open`)
- [x] Responsive: desktop 3-column, tablet/phone bottom-tab navigation
- [x] Task working directory: choose a workspace folder on desktop, tablet, or
      phone; handoffs and chains keep the selected scope. Server-pinned agents
      show a fixed-directory hint without revealing their configuration;
      invalid, missing, and linked directories are rejected before dispatch
      (`npm run smoke:agents`, `npm run smoke:browser-agents`)
- [x] Event sourcing: every task → `workspace/.ade/tasks/<id>/events.jsonl`
- [x] File watcher: edits from any device / agent show up everywhere
- [x] Live file presence: editor status shows other connected viewers of the
      current file; disconnects clear counts (`npm run smoke:presence`)
- [x] File deep links: opening a file updates `?file=`, refresh restores the
      selected file, and the editor can copy a link for another device
- [x] Real-agent E2E: dispatched a task to `codex exec` through the HTTP API,
      streamed output, exit 0 (`claude` integration verified up to its API
      gateway; Pi's print-mode adapter is verified with a mock CLI, not a live Pi install)
- [x] Smoke test: `npm run smoke`
- [x] Persistent PTY sessions: xterm terminal, remote input / resize / abort,
      reconnect replay on desktop, tablet, and phone
- [x] Terminal smoke test: `npm run smoke:terminal`
- [x] Revision-checked file saves: stale edits are blocked and local drafts are
      retained for comparison or explicit conflict resolution (`npm run smoke:files`)
- [x] Unsaved browser drafts survive refresh in the same tab; restored drafts are
      checked against disk revisions before editing or saving (`npm run smoke:drafts`)
- [x] Workspace file management: create files and folders, rename and delete files
      with revision checks and no replacement of existing destinations
      (`npm run smoke:management`)
- [x] Cross-device file moves remap open editor tabs without losing drafts;
      folder creation and empty-folder deletion notify every device
      (`npm run smoke:web-files`)
- [x] Agent handoff: hand the recent output of a finished task to another agent
      with a new request; lineage and the effective prompt are persisted (`npm run smoke:handoff`)
- [x] Searchable task history: filter by agent/status, follow handoff links in
      either direction, and reopen a task on another device with its copied URL
- [x] Sequential agent chains: up to four non-interactive steps with persisted
      prompts, output handoff, failure/abort stop, and real-process smoke test (`npm run smoke:chain`)
- [x] Pi one-shot adapter: `pi --print` reads the effective prompt from stdin,
      including chain handoffs (`npm run smoke:pi` with a mock CLI)
- [x] Server-side executable checks: missing CLIs appear unavailable on all devices;
      dispatch rejects them before creating a task (`npm run smoke:agents`;
      `npm run smoke:browser-agents` after build)
- [x] Git Changes: staged and working-tree changes, including renames
      and untracked text files, with inline diff review on desktop and phone
      (`npm run smoke:git`)
- [x] Review-bound whole-file Stage / Unstage for text changes, with revision
      checks to reject changes made after the diff was opened (`npm run smoke:git`,
      `npm run smoke:browser-git` after build)
- [x] Optional Web Push task-result and chain-approval notifications (VAPID + Service Worker,
      explicit per-device opt-in; `npm run smoke:push`)
- [x] Single ADE server per workspace on the same host; a second startup exits
      before task recovery, even on another port (`npm run smoke:lock`)
- [x] Optional, persistent approvals between chain steps: review the next
      agent/prompt on any device; approve or reject with audited events
      (`npm run smoke:chain`; mobile: `ADE_TEST_APPROVAL=1 npm run smoke:browser-task-notices`)
- [x] Explicit recovery of a completed chain step whose next step was never
      recorded after a server restart; failed, rejected, or already-started chains cannot be resumed
      (`npm run smoke:chain-recovery` and `npm run smoke:browser-chain-recovery` after build)
- [ ] Agent-native tool permission prompts as structured ADE approvals (CLI
      prompts can still be handled manually in the shared terminal)

Task logs contain prompts and raw agent output, which may include secrets. Treat
downloaded JSONL files as sensitive workspace data.

File operations reject symlinks and junctions encountered in a workspace path.
Folder deletion only works when the folder is empty. Recursive directory moves/deletes
are not exposed yet. Revision checks serialize
ADE requests, but do not lock out unrelated local processes changing the same
paths concurrently; on Windows, Node does not provide `O_NOFOLLOW`.

## Quickstart

```bash
npm install
npm run dev        # server on :8787 (tsx watch) + web on :5173 (vite)
```

Open http://localhost:5173 — dispatch a task to `Demo` to see the full loop,
then select `Codex` or `Claude Code` (CLIs must be in the server's PATH).
Select `Terminal Demo` to try a shared interactive terminal; type `exit` to finish.

Single-port production mode (serves the built web UI from the server):

```bash
npm run build
npm start          # http://localhost:8787
```

Run only one ADE server per workspace. Startup acquires a lock in
`workspace/.ade/server.lock`; another new-version server pointing at the same
workspace exits before recovering tasks, regardless of its port. Normal shutdown
releases the lock, and a lock left after a crash expires after about 10 seconds.
Do not manually remove a live server's lock. Servers started with older ADE
builds do not honor this lock; stop those instances separately before using the
same workspace from a new server.

## Access from phone / tablet

ADE is web-first; any device on the same network works.

```bash
# 1. generate a token
node -e "console.log(crypto.randomUUID())"

# 2. start with LAN exposure + auth
$env:ADE_HOST="0.0.0.0"; $env:ADE_TOKEN="<your-token>"; npm start
# (bash: ADE_HOST=0.0.0.0 ADE_TOKEN=<token> npm start)

# 3. on the phone open
#    http://<your-lan-ip>:8787/#token=<your-token>
```

The token is stored in `localStorage` and removed from the address bar after
the first load. The `#token=` fragment is not sent in HTTP requests; older
`?token=` links are still accepted by the web UI. Non-loopback `ADE_HOST`
requires `ADE_TOKEN`. Only same-origin browser connections and the local Vite
development origin are accepted by default. If a reverse proxy rewrites the
Host header, set `ADE_ALLOWED_ORIGINS` to its exact HTTPS origin (comma-separated
for more than one). For access over the internet, put ADE behind a private
network or an HTTPS reverse proxy; do **not** expose it directly. The API can
write files and spawn processes. Plain HTTP on a LAN does not encrypt tokens
or workspace data; use HTTPS for networks you do not fully trust.

## Task notifications

ADE generates a VAPID keypair on first server startup and stores it in
`workspace/.ade/push-vapid.json`. Back up this file if you intend to keep device
subscriptions across workspace migrations. You can instead supply an existing
stable keypair using the environment; generate one with:

```bash
node -e "console.log(require('web-push').generateVAPIDKeys())"
```

Set `ADE_VAPID_PUBLIC_KEY`, `ADE_VAPID_PRIVATE_KEY`, and `ADE_VAPID_SUBJECT`
(e.g. `mailto:you@example.com`) together on the server to override the generated
pair. Keep private keys secret; rotating a key requires devices to re-subscribe.
Open ADE over HTTPS, or use localhost for local testing, and
click the bell in the header to enable notifications on each device. The same
button disables them. On iOS/iPadOS, add the site to the Home Screen first,
then enable notifications from that installed app. Browsers or networks that
do not support push still show the in-page unread count while connected.

Push subscriptions are saved in `workspace/.ade/push-subscriptions.json`; they
include secret endpoint/key material and must not be shared. Delivery goes
through the device vendor's push service. Notification content includes only
the agent name, task ID and completion/failure or approval-needed status, not
prompts or output. A chain waiting for approval sends one approval notification
instead of a separate task-complete notification.
Only known browser push gateways are accepted as subscription endpoints. If
your browser uses another gateway, its subscription will be rejected instead
of letting an authenticated client direct server-side requests to arbitrary hosts.
Delivery is best-effort: a completed task stays in the task history even if a
push gateway is offline or notifications are blocked.
Do not start ADE with `NODE_TLS_REJECT_UNAUTHORIZED=0`: it disables certificate
validation for outbound HTTPS requests, including push delivery.

## Agents

Agents are declared in [`ade.config.json`](ade.config.json). A task simply
spawns the configured argv inside the workspace:

```jsonc
{
  "id": "codex",
  "label": "Codex",
  "command": ["codex", "exec", "--", "{{prompt}}"],   // {{prompt}} / {{workspace}} are substituted
  "cwd": ".",                                          // relative to workspace root
  "stdin": "closed"                                    // default; also supports "prompt" and "open"
}
```

Notes learned the hard way (and handled):

- `codex exec` / `claude -p` wait for **stdin EOF** before starting — ADE closes
  stdin right after spawn (`stdin: "open"` keeps it for future interactive agents).
  The Pi adapter uses `"stdin": "prompt"`: ADE writes the effective prompt and
  closes stdin so Pi print mode treats it as text, not a CLI flag or `@file` argument.
  Install and authenticate Pi on the ADE server before selecting it; the local
  smoke test uses a mock CLI and does not validate live Pi credentials or models.
- ADE marks an agent unavailable if its executable cannot be found in the server's
  PATH (or the agent's PATH override); Windows terminal agents require a native
  `.exe`. This check refreshes when devices connect or request `/api/agents`.
  It does not verify authentication, API access, or whether a CLI can finish a task.
- REST and WebSocket expose only the Agent's id, label, optional description,
  mode, enabled flag and availability. CLI argv, working directory, stdin mode
  and environment variables remain on the server. Treat descriptions as public.
- Placeholders use `{{prompt}}` (not `{prompt}`) so they never collide with JS
  template literals such as `${prompt}`.
- Agent output (stdout/stderr) streams to every connected device and is
  persisted to the task's event log.
- A finished task with output can be handed to a new agent from the task view.
  ADE includes up to the most recent 12,000 characters of its output as
  untrusted context, strips terminal control sequences, and records the exact
  prompt in a `task.handoff` event. Check the source output for secrets before
  passing it to another agent.
- Search the Tasks list by prompt, agent or task ID; use the agent/status filters
  to narrow it down. Task detail links to its source and follow-up tasks. Copy
  link preserves the selected task in the URL; the receiving device must be
  able to reach the same ADE host and authenticate separately when enabled.
- Completed and failed tasks you have not viewed are marked in the task list;
  phones also show a count on the Agent tab. Reconnect checks tasks that ended
  while the page was disconnected. The in-page indicator resets on reload;
  optional Web Push sends background task-result and approval notifications when enabled.
  Run
  `npm run smoke:task-notices` for state reconciliation checks, or
  `npm run smoke:browser-task-notices` against a running server with the demo
  agent for the mobile browser check.
- Switch the composer to **Chain** to add up to three follow-up agents. Each
  step receives the previous step's output as untrusted context. The server
  runs the sequence even if the browser disconnects; a failed or aborted step
  stops it. Only non-interactive agents are accepted in automatic chains.
  Check **Review before this step** to pause a successful chain until someone
  with ADE access approves the next agent and request, or rejects the remaining
  steps. A pending approval survives server restart. Approval does not approve
  the agent CLI's own tool permissions or inspect its planned file changes.
  If the server restarts after a step completed but before the next step was
  recorded, open that task and choose **Continue next step**. This action is
  audited and only available when no child task exists; running and failed
  tasks are never retried automatically.
- File reads include a SHA-256 `revision`; saves require `expectedRevision`
  (use `null` to create a new file). A stale revision returns HTTP 409, and
  omitting it returns 428. The editor preserves the draft on conflicts and
  offers comparison, disk reload, or explicit overwrite. ADE serializes its
  own writes per file; an external process writing at precisely the same time
  is not covered by that lock.
- Unsaved drafts are stored locally in the current browser profile, scoped to
  workspace and tab. They do not sync to other devices and may contain secrets;
  clear browser site data to remove them. If browser storage is full or blocked,
  ADE shows a warning and asks before leaving with unprotected edits. Run
  `npm run smoke:browser-drafts` against a running server for the optional
  browser end-to-end test (Node.js 22+, `ADE_BROWSER` may point to a Chromium executable).
  This also checks the other-viewers indicator in a phone viewport. Presence is
  temporary per connection: it does not sync drafts, identify devices, or lock edits.
- File links point at the server's current saved contents. They contain the
  workspace-relative path, not the access token or a local unsaved draft;
  recipients still need access to the same ADE server.
- Set `"mode": "pty"` for interactive commands. PTY output and remote keystrokes
  are shared across devices; the last connected terminal to resize sets the
  process dimensions. The UI replays the most recent 2,000 events per task.
- On Windows, `node-pty` requires a native `.exe`; npm `.cmd`/`.ps1` shims are
  not directly executable in PTY mode. `Codex Terminal` works when a native
  `codex.exe` is installed; configure an explicit native executable for other
  interactive CLIs. The one-shot `Claude Code` adapter still uses pipes.
- Git Changes is available when the configured workspace root is itself a Git
  repository and Git is installed on the server. Preview and whole-file Stage /
  Unstage are limited to UTF-8 text up to 2 MB per side; a change since review
  requires reopening the diff. Commits, partial staging, and merges remain in
  the terminal. ADE internal `.ade` files do not appear in Changes.

## HTTP API

| Method | Path | Description |
| --- | --- | --- |
| GET | `/api/agents` | public agent metadata with `available` and optional `unavailableReason` (no argv or env) |
| GET | `/api/files/tree` | workspace file tree |
| GET | `/api/files/content?p=` | read text and revision (≤2 MB) |
| PUT | `/api/files/content` | write `{ path, content, expectedRevision }` → new revision; 409 on conflict |
| GET | `/api/git/changes` | staged and working-tree status (or `available: false`) |
| GET | `/api/git/diff?p=&side=staged\|working` | read-only two-sided text diff |
| POST | `/api/git/index` | `{ path, action: "stage"\|"unstage", expectedRevision }` for reviewed text files; stale revisions return 409 |
| GET | `/api/tasks` | task list (newest first) |
| GET | `/api/push/config` | public VAPID key or null when push is disabled |
| POST / DELETE | `/api/push/subscriptions` | subscribe or unsubscribe this device (authenticated) |
| POST | `/api/tasks` | `{ agentId, prompt, cwd?, sourceTaskId?, nextSteps? }` → dispatch, handoff, or chain (up to three `{agentId,prompt}` follow-ups) |
| POST | `/api/tasks/:id/abort` | kill a running task |
| POST | `/api/tasks/:id/resume` | manually continue a restart-gap chain when no next task exists (409 otherwise) |
| GET | `/api/tasks/:id/events` | most recent 2,000 events (JSON response) |
| GET | `/api/tasks/:id/log` | download complete append-only JSONL event log |
| WS | `/ws` | init snapshot + `task` / `file` events; `presence.set` / `presence` for ephemeral file viewers |

Auth (when `ADE_TOKEN` is set): `Authorization: Bearer <token>` for REST;
the browser WebSocket handshake uses `?token=` because it cannot set an
Authorization header. Avoid logging WebSocket request URLs at reverse proxies.

## Project layout

```
packages/
  shared/   # AgentDefinition, TaskEvent, WS protocol types (single source of truth)
  server/   # Fastify + WS + file service + watcher + TaskManager (cross-spawn/node-pty)
  web/      # React + Vite + Monaco + xterm; responsive web UI
workspace/  # THE workspace — single copy, lives with the server
  .ade/     # event store (one JSONL per task) — gitignored runtime data
```

## Roadmap

- **M1 (in progress)** — interactive PTY, xterm, opt-in task-result/approval Web Push,
  and approvals between chain steps implemented; native CLI approval forwarding remains
- **M2 (started)** — diff review and whole-file staging implemented; git
  worktree isolation for parallel agents, partial staging, and merge UI remain
- **M3 (started)** — explicit handoffs, searchable linked history and bounded
  sequential agent chains implemented; branching flows and resumable workflows remain
- **M4** — LSP, snapshots/checkpoints, desktop shell (Tauri), offline PWA

## Known limitations

- Text files only in the editor (binary rejected, ≤2 MB per file)
- PTY support depends on a native CLI executable on Windows; `claude` REPL is
  not preconfigured for PTY on Windows
- No native CLI tool-approval cards yet; use the terminal to answer those prompts
  while connected. Push requires HTTPS (or localhost), browser support and opt-in
- `claude -p` verified up to its model gateway; Pi print mode has not been tested
  against a local authenticated Pi installation
- Single user, broadcast WS (fine for personal use; multi-user comes later)
