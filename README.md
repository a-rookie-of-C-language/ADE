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
        │  Agent 进程管理 (stdio pipes)│
        │    ├ codex                 │
        │    ├ claude                │
        │    └ pi                    │
        │  事件存储 (JSONL, 追加式)    │
        └────────────────────────────┘
```

## Status — M0 skeleton (verified)

- [x] Monorepo: `shared` (types/events) · `server` · `web`
- [x] REST: file tree / read / write, agents, task dispatch / abort / replay
- [x] WebSocket: init snapshot + realtime task output + file-change broadcast
- [x] Web UI: file tree · Monaco editor (bundled locally, no CDN) · task chat
- [x] Responsive: desktop 3-column, tablet/phone bottom-tab navigation
- [x] Event sourcing: every task → `workspace/.ade/tasks/<id>/events.jsonl`
- [x] File watcher: edits from any device / agent show up everywhere
- [x] Real-agent E2E: dispatched a task to `codex exec` through the HTTP API,
      streamed output, exit 0 (`claude` integration verified up to its API
      gateway; `pi` is config-only until you adjust its command)
- [x] Smoke test: `npm run smoke`

## Quickstart

```bash
npm install
npm run dev        # server on :8787 (tsx watch) + web on :5173 (vite)
```

Open http://localhost:5173 — dispatch a task to `Demo` to see the full loop,
then select `Codex` or `Claude Code` (CLIs must be in the server's PATH).

Single-port production mode (serves the built web UI from the server):

```bash
npm run build
npm start          # http://localhost:8787
```

## Access from phone / tablet

ADE is web-first; any device on the same network works.

```bash
# 1. generate a token
node -e "console.log(crypto.randomUUID())"

# 2. start with LAN exposure + auth
$env:ADE_HOST="0.0.0.0"; $env:ADE_TOKEN="<your-token>"; npm start
# (bash: ADE_HOST=0.0.0.0 ADE_TOKEN=<token> npm start)

# 3. on the phone open
#    http://<your-lan-ip>:8787/?token=<your-token>
```

The token is stored in `localStorage` after the first load. For access over the
internet, put ADE behind Tailscale or a Cloudflare Tunnel — do **not** expose it
directly; the API can write files and spawn processes.

## Agents

Agents are declared in [`ade.config.json`](ade.config.json). A task simply
spawns the configured argv inside the workspace:

```jsonc
{
  "id": "codex",
  "label": "Codex",
  "command": ["codex", "exec", "--", "{{prompt}}"],   // {{prompt}} / {{workspace}} are substituted
  "cwd": ".",                                          // relative to workspace root
  "stdin": "closed"                                    // default; EOF right after spawn
}
```

Notes learned the hard way (and handled):

- `codex exec` / `claude -p` wait for **stdin EOF** before starting — ADE closes
  stdin right after spawn (`stdin: "open"` keeps it for future interactive agents).
- Placeholders use `{{prompt}}` (not `{prompt}`) so they never collide with JS
  template literals such as `${prompt}`.
- Agent output (stdout/stderr) streams to every connected device and is
  persisted to the task's event log.

## HTTP API

| Method | Path | Description |
| --- | --- | --- |
| GET | `/api/agents` | registered agents |
| GET | `/api/files/tree` | workspace file tree |
| GET | `/api/files/content?p=` | read a text file (≤2 MB) |
| PUT | `/api/files/content` | write `{ path, content }` |
| GET | `/api/tasks` | task list (newest first) |
| POST | `/api/tasks` | `{ agentId, prompt, cwd? }` → dispatch |
| POST | `/api/tasks/:id/abort` | kill a running task |
| GET | `/api/tasks/:id/events` | full event replay (JSONL) |
| WS | `/ws` | init snapshot + `task` / `file` events |

Auth (when `ADE_TOKEN` is set): `Authorization: Bearer <token>` header, or
`?token=` query param.

## Project layout

```
packages/
  shared/   # AgentDefinition, TaskEvent, WS protocol types (single source of truth)
  server/   # Fastify + WS + file service + chokidar watcher + TaskManager (cross-spawn)
  web/      # React + Vite + Monaco; responsive PWA-ready UI
workspace/  # THE workspace — single copy, lives with the server
  .ade/     # event store (one JSONL per task) — gitignored runtime data
```

## Roadmap

- **M1** — interactive agents via node-pty (TUI, xterm.js), approval forwarding
  to all devices + push notifications
- **M2** — git worktree isolation for parallel agents, diff review & merge UI
- **M3** — agent chaining (output → input handoffs), richer task history
- **M4** — LSP, snapshots/checkpoints, desktop shell (Tauri), offline PWA

## Known limitations (M0)

- Text files only in the editor (binary rejected, ≤2 MB per file)
- stdio pipes, not PTY — interactive TUI agents (e.g. `claude` REPL) need M1
- `claude -p` verified up to its model gateway; `pi` needs its real command
- Single user, broadcast WS (fine for personal use; multi-user comes later)