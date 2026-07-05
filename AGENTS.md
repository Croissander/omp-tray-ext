# AGENTS.md — omp-tray-ext

A native Linux status-bar tray for [Oh My Pi (omp)](https://omp.sh) that reflects
agent state — idle, working, errored. Implements the freedesktop
**StatusNotifierItem (SNI)** spec over the DBus session bus. No Electron/GTK/Qt;
the icon bytes are drawn pixel-by-pixel and pushed as `IconPixmap` ARGB.

This file is the ground-truth brief for any agent (or human) working in this repo.
Read it before touching code.

## Architecture

```
omp process (transient)          tray daemon (tied to omp lifetime)
┌─────────────────┐              ┌──────────────────────┐
│ index.ts        │  SetState(s) │ daemon.ts            │
│  spawn daemon   │──── DBus ───▶│  owns SNI on bus     │
│  forward events │              │  spinner timer       │
│  /tray command  │              │  IconPixmap (ARGB)   │
└─────────────────┘              └──────────┬───────────┘
                                  ▼
                       KDE / GNOME / waybar panel
```

- `index.ts` — extension entry; spawns the daemon detached, forwards omp
  lifecycle events to it, registers the `/tray` slash command.
- `daemon.ts` — owns the SNI item + `org.omptray.Daemon` control interface;
  renders the spinner and reacts to `SetState`/`Stop`. Lifetime mirrors the omp
  process.
- `ipc.ts` — shared DBus client: `daemonAlive`, `sendState`, `stopDaemon`.
  Each call opens its own session-bus connection, so there is **no** cross-
  connection FIFO — the controller serializes state changes itself (see below).
- `controller.ts` — maps omp lifecycle events to `idle`/`working`/`error`
  states and forwards them. Exposes `.state` for the `/tray debug` command.
- `icons.ts` — monochrome glyphs: `>` chevron + `_`, `!!`, 8 spinner frames.

### State mapping

| Agent state | Tray icon | SNI `Status` | Fires on |
|-------------|-----------|--------------|----------|
| idle | `>_` prompt glyph | `Passive`→`Active` | `session_start` / `agent_end` |
| working | spinning ring (~8 fps) | `Active` | `agent_start` / `before_provider_request` / `tool_execution_start` |
| error | `!!` double exclamation | `NeedsAttention` | `tool_result` with `isError` (auto-clears after 5 s) |

### Key invariants (do not break)

- **State transitions are serialized through `TrayController.chain`.** Each
  `sendState` opens its own DBus connection with no cross-connection ordering,
  so two concurrent transitions can reorder — a stale "working" landing after a
  later "idle" leaves the tray spinning forever. The promise-chain forces call B
  to wait for call A's `sendState` to resolve before starting. The chain also
  `.catch()`es so a failing send can't wedge every later state.
- **The daemon is tied to the omp process lifetime.** Spawned at load,
  stopped on `session_shutdown`. A last-resort `process.on("exit")` SIGTERM covers
  signal-based exit paths (SIGHUP/SIGTERM) that skip `session.dispose()`. The
  daemon's own SIGTERM handler removes the SNI item cleanly. `process.kill` on an
  already-dead PID throws ESRCH — swallowed.
- **Error is transient.** `flashError()` shows `!!` for 5 s, then reverts. It is
  routed through the same chain so an un-awaited error send can't overtake a
  later idle/working.
- **Tray IPC never blocks the agent loop.** `sendState` is a no-op if the daemon
  isn't running. Every `await` of it is fire-and-forget at the omp level.

## omp extension authoring — what applies here

Authoritative docs: <https://omp.sh/docs/extension-authoring> and
<https://github.com/can1357/oh-my-pi/blob/main/docs/extensions.md>. Summary of
the rules that govern this extension specifically:

- **Factory signature.** `export default function ompTray(pi: ExtensionAPI)`.
  Register handlers/tools/commands during load; runtime actions
  (`sendMessage`, `setActiveTools`, …) throw `ExtensionRuntimeNotInitializedError`
  if called synchronously during module evaluation. We only register + spawn the
  daemon on load — fine.
- **Command names must not clash with built-ins.** omp reserves
  `BUILTIN_SLASH_COMMAND_RESERVED_NAMES` (built from the builtin registry). The
  extension runner **silently skips** a registered command whose name is in that
  set, logging a diagnostic. That is why `debug` lives as `/tray debug`, not as a
  separate `/debug` (omp ships a builtin `/debug`).
- **Command argument autocompletion** is provided via
  `getArgumentCompletions(argumentPrefix)`. Convention (mirroring the builtins):
  return `AutocompleteItem[] | null`. Filter by prefix; `null` when no match or
  after a space (past the subcommand). Each item is
  `{ value: "<sub> ", label, description? }` — note the trailing space in `value`.
  Must be side-effect-free (it runs synchronously on each keystroke).
- **No DBus/GUI deps beyond `dbus-next`.** Pure JS, no native build. The daemon
  is spawned with `bun run` (TS imported directly — omp loads extensions via Bun).
- **Logs.** omp writes structured logs to `~/.omp/logs/omp.$(date +%F).log`. The
  daemon logs to its own stderr (currently `stdio: "ignore"` on the spawn —
  flip to a file if debugging spawn failures). Extension logs via `pi.logger`.
- **Disable temporarily** without removing the file:
  ```yaml
  # ~/.omp/agent/config.yml
  disabledExtensions:
    - omp-tray-ext
  ```
  The derived name is the filename stem / directory name — here `omp-tray-ext`
  per `package.json#name`.

## Slash command surface (`/tray`)

```
/tray                status   — show daemon running state (default)
/tray stop  | off    stop     — stop the daemon
/tray restart        restart  — stop + re-spawn
/tray working        working  — force the tray to working
/tray error          error    — force the tray to error
/tray debug          debug    — show plugin/daemon state for troubleshooting
```

All subcommands are prefix-filtered by `getArgumentCompletions` (typed in the
editor → dropdown). `/tray debug` reports: daemon running/ready/PID, plugin-side
`TrayController.state`, daemon script path, active model, agent idle, cwd.

## Development practices

### Environment

- Runtime: `bun` (the extension and daemon import TS directly; omp loads via
  Bun). Required by users at runtime too.
- Target: a Linux desktop with a DBus session bus and an SNA host (KDE Plasma,
  GNOME + Appindicator, waybar tray module, swaync/swaybar, …).
- TypeScript is a `peerDependency`; `@types/bun` is the only dev type source.
  `@oh-my-pi/pi-coding-agent` is **not** installed locally — it's an ambient
  host-provided type. To resolve types during editing, it must be available on
  the host (it ships with omp at `~/.omp/plugins/node_modules/...` and in the
  bun cache). Do not add it to `dependencies`; do not import it at runtime.

### Local dev loop

```bash
bun install                       # one-time; dbus-next only
bunx tsc --noEmit                 # typecheck
bun test controller.test.ts       # self-checks for the state chain
```

To test live against omp:

```bash
# Option A — installed as a user extension
ln -s "$PWD" ~/.omp/agent/extensions/omp-tray-ext   # or git clone there
# Restart omp; the daemon spawns at load and the tray appears in the panel.

# Option B — load once via CLI flag
omp --extension ./.
```

Iterating on `daemon.ts` / `index.ts` requires reloading omp — the extension is
imported at startup, not hot-reloaded. `daemonReady` is re-checked on
`session_start`, so `/compact` or a session switch will re-ensure the daemon.

### Code conventions

- **Ponytail by default.** Lazy = efficient, not careless. The ladder:
  does it need to exist? → stdlib → native platform feature → already-installed
  dep → one line → minimum code that works. Mark deliberate simplifications with
  `// ponytail: <shortcut>; upgrade path <X>`.
- **No unrequested abstractions.** No interface with one implementation, no
  factory for one product, no config for a value that never changes. Deletion
  over addition; boring over clever.
- **Never simplify away** input validation at trust boundaries, error handling
  that prevents data loss, security.
- **Each non-trivial logic unit leaves one runnable check behind** — an
  `assert`-based `demo()`/`__main__` self-check or one small `test_*.py` (here:
  `controller.test.ts`). Trivial one-liners need no test.
- **DBus IPC patterns:** every connection is opened with a connect timeout and
  disconnected in a `finally`. `process.kill`/`bus.disconnect` on an already-dead
  target throws — always wrap in `try {} catch {}`.
- **Use `Promise.withResolvers()`** instead of `new Promise((resolve) => ...)`.
- **Don't extract one-expression functions.** Inline unless the name creates a
  durable contract (test seam, DI boundary, public API, type guard).

### Editing discipline

- Prefer the `edit` tool for surgical changes; `write` only for new files or
  full overwrites.
- Re-read a file before editing if a tool failed or the file changed since.
- Grep/glob to locate targets; read sections, not whole files. Don't open files
  hoping.
- Run `lsp references` before modifying exported symbols — missed callsites are
  bugs.
- Run `bunx tsc --noEmit` and the affected `bun test` after every non-trivial
  change. Tests assert behavior, not current state.

## Release / version policy  ⚠️

**After every bigger change, bump the version in `package.json` and push to
GitHub.** "Bigger" = any user-visible behavior change, new command, new state,
DBus contract change, or anything touching `daemon.ts`/`ipc.ts`/`controller.ts`
invariants. Pure refactor of identical behavior with no observable change does
not require a bump.

Conventions:

- `package.json#version` is the single source of truth (no git tags today).
- Semver-leaning: `1.0.1 → 1.0.2` for fixes/patches, → `1.1.0` for new
  commands/states, → `2.0.0` for a DBus contract break.

Workflow:

```bash
# 1. Make the change; verify.
bunx tsc --noEmit && bun test controller.test.ts

# 2. Bump version in package.json (edit version: "x.y.z").

# 3. Commit + push.
git add -A
git commit -m "<scope>: <what changed> (vX.Y.Z)"
git push origin master
```

Remote: `git@github.com:Croissander/omp-tray-ext.git`, branch `master`.

## Further reading

- omp extension authoring — <https://omp.sh/docs/extension-authoring>
- omp extension runtime internals —
  <https://github.com/can1357/oh-my-pi/blob/main/docs/extensions.md>
- SNI spec — <https://www.freedesktop.org/wiki/Specifications/StatusNotifierItem/>
- dbus-next — <https://github.com/dbusjs/node-dbus-next>
