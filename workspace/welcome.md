# Welcome to your ADE workspace

This folder is the **single source of truth**. Files here live on the machine
running the ADE server; your PC / phone / tablet are just screens onto it.

## Try it

1. Open this file in the editor — edits are saved back to the server (Ctrl/Cmd+S).
2. Switch to the **Agent** panel and dispatch a task to `Demo`.
3. Watch output stream in realtime; refresh on another device and you'll see
   the same task history (event-sourced under `workspace/.ade/tasks/`).

## Real agents

`codex`, `claude` and `pi` are wired in `ade.config.json` at the repo root.
As long as the CLI is installed in the server's PATH, dispatching a task
simply runs it inside this workspace.