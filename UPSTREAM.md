# Upstream and migration

- Project: [narumiruna/pi-extensions, packages/pi-caffeinate](https://github.com/narumiruna/pi-extensions/tree/a0e0079303415a1eb0eb58f68538a593c58182e5/packages/pi-caffeinate).
- Examined repository commit: `a0e0079303415a1eb0eb58f68538a593c58182e5`.
- License: MIT, Copyright (c) 2026 narumiruna. Full attribution/license: [NOTICE](NOTICE).
- Read real upstream `src/index.ts`, `caffeinate.ts`, `inhibitors.ts`, `inhibitor-process.ts` and `settings.ts` via pinned GitHub raw/API sources before implementation.

This independent DSH implementation ports the “keep awake during agent activity” behavior. DSH `agent/status` and `agent/disposed` replace Pi lifecycle hooks. A set of real agents and a serialized operation queue own one actual subprocess per plugin instance. Schemastery supplies config; the `caffeinate` ToolRuntime tool supplies structured status and revision-checked enable/disable controls.

Linux uses systemd-inhibit with a stdin-bound foreground Node holder; macOS uses native caffeinate with `-w` parent binding. Explicit stop, idle/disposal and plugin unload terminate the Unix process group, escalate when needed and await reaping. A trusted argv override supports diagnostic foreground processes without shell parsing. Process failures become visible status errors. Real DSH agent-loop tests use foreground processes, not mocked child_process functions or forged lifecycle events.

This release omits upstream Pi TUI menus/statusline, settings persistence, environment-variable compatibility, Linux D-Bus ScreenSaver fallback, Windows/WSL PowerShell support, and custom shell-string parsing. Linux display mode is a logind request and may not affect a compositor. It controls the host running DSH, never a remote world/sandbox. Tests prove local lifecycle behavior; macOS device sleep/display behavior has not been verified. See README for failure and platform limitations.
