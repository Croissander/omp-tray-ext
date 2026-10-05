# Repository Guidelines

## Project Overview

omp-tray-ext is a native Linux status-bar tray for [Oh My Pi (omp)](https://omp.sh)
that reflects agent state — `idle`, `working`, `error`. A detached daemon
implements the freedesktop **StatusNotifierItem (SNI)** spec over the DBus
session bus and pushes pixel-drawn ARGB `IconPixmap` bytes; no Electron/GTK/Qt.
Two processes: the omp extension (transient) and the tray daemon (one shared
per session bus). This file is the ground-truth brief for any agent working here.

## Architecture & Data Flow

```
omp process (transient)          tray daemon (one per session bus)
┌─────────────────┐              ┌──────────────────────┐
│ index.ts        │  SetState(s) │ daemon.ts            │
│  spawn daemon   │──── DBus ───▶│  owns SNI on bus     │
│  forward events │              │  spinner timer       │
│  /tray command  │              │  IconPixmap (ARGB)   │
└─────────────────┘              └──────────┬───────────┘
                                            ▼
                                 KDE / GNOME / waybar panel
```

- `index.ts` — extension entry (`export default function ompTray(pi)`); daemon
  lifetime (detached `Bun.spawn`, single-flight `ensureDaemon`, `recover()` on
  failed sends), owner of `session_start` / `session_switch` /
  `session_shutdown`, `/tray` command, exit-registered PID-checked kill
  (`killOwnDaemon`).
- `controller.ts` — `TrayController`: maps omp turn events to `DaemonState`
  (`"idle" | "working" | "error"`) and serializes sends on a promise chain
  (error-flash timing lives here too).
- `ipc.ts` — shared DBus contract (bus name `org.omptray.Daemon`, path/iface
  `/org/omptray/Daemon`) + deadline-bounded client `daemonAlive(timeoutMs?)`,
  `sendState` (resolves `false` on failure), `stopDaemon(timeoutMs?)` (true
  iff `Stop()` completed). Each call opens its own session-bus connection
  under ONE absolute budget (connect + RPCs, default 3 s). Also exports
  `deadline()` (shared with `daemon.ts`) and the `__setSessionBusForTests`
  `@internal` bus-factory seam.
- `daemon.ts` — detached process owning the SNI item (its signals are the
  cross-host update contract — see flow below), the minimal
  `com.canonical.dbusmenu` at `/MenuBar` (empty layout; GNOME needs a live
  `Menu` path to show the icon at all), and the `org.omptray.Daemon` control
  interface (`SetState`, `Stop`); spinner timer (8 frames @120 ms),
  `paint()`/`render()` SNI updates, watcher (re-)registration, bus self-probe.
- `icons.ts` — pure 22×22 pixel glyphs (no font/image library): `>_` prompt,
  `X` error, 8 spinner frames; RGBA→ARGB converter.

Exact flow: turn events (`agent_start`, `before_provider_request`,
`tool_execution_start`, assistant `message_start`) → `working`; `tool_result`
with `isError` → `error` flash (else `working`); `agent_end` → `idle` (no
`turn_end` handler — deliberate; it fires mid-loop). `index.ts` handles
`session_start` (`ensureDaemon()` then `controller.force("idle")`),
`session_switch` (re-`ensureDaemon()` only — switching sessions is not an
idle signal), and `session_shutdown` (`killOwnDaemon()` — PID-targeted, never
another omp's daemon). Sends call `SetState`; the daemon validates the state
literal (trust boundary), then publishes SNI properties (`IconPixmap`,
`ToolTip`, `Status`, `AttentionIconPixmap`) and emits `NewIcon`,
`NewAttentionIcon`, `NewStatus` (WITH the `(s)` status string), `NewTitle`,
`NewToolTip`. Signals are the cross-host update contract — Plasma/waybar
ignore `PropertiesChanged` — and `NewToolTip` fires only when the tooltip
TEXT changes (spinner ticks must not churn it).

| Agent state | Icon | SNI `Status` | Trigger |
|---|---|---|---|
| idle | `>_` | `Active` | `session_start` (via `force`) / `agent_end` |
| working | spinning ring (8 frames, ~8 fps) | `Active` | turn events (see above) |
| error | `X` | `NeedsAttention` | `tool_result` with `isError`; auto-clears `errorMs` (5 s) after the error **send**, back to the **pre-error** state |

### Key invariants (do not break)

- **State transitions serialize through `TrayController.chain`.** Each
  `sendState` opens its own DBus connection with no cross-connection FIFO, so
  concurrent transitions can reorder — a stale "working" landing after a later
  "idle" leaves the tray spinning forever. The chain forces call B to wait for
  call A's `sendState` to resolve; it `.catch()`es so a failing send can't
  wedge every later state.
- **One daemon per session bus (exclusive slot; control gate claimed FIRST).**
  The control name `org.omptray.Daemon` is claimed FIRST with `DO_NOT_QUEUE`
  (exclusive, no replacement): a later daemon's claim gets `EXISTS` and exits
  BEFORE claiming the SNI alias or registering with the watcher, so N
  concurrent starts (e.g. omp loads the extension twice) yield one watcher
  registration and one surviving tray icon. THEN the SNI alias
  `org.kde.StatusNotifierItem.omptray`, also `DO_NOT_QUEUE` —
  `REPLACE_EXISTING`/`ALLOW_REPLACEMENT` let a second daemon steal the alias
  from the live winner (two icons, 2026-10-05). A name can't be replaced out
  from under a live owner, so a new daemon claims the slot only after the
  previous one exits; deliberate takeover is `/tray restart` (stop + respawn,
  fails honestly — never adopts a daemon still alive at the wait deadline).
  Process teardown (`session_shutdown` + `process.on("exit")`) signals only a
  daemon this process spawned: `killOwnDaemon()` verifies identity via
  `/proc/<pid>/cmdline` before SIGTERM (PID-reuse guard). The daemon's
  SIGTERM handler removes the SNI item cleanly. `process.kill`/
  `bus.disconnect` on a dead target throws ESRCH — swallowed in `try/catch`.
- **`ensureDaemon` is single-flight; the generation guard covers double-load
  AND reload.** Overlapping callers (load-time ensure, `session_start` /
  `session_switch` handlers, `recover()`, `/tray restart`) share one spawn
  attempt — `daemonPid` is last-write-wins, and a stomped PID would name a
  dead slot-loser while the surviving daemon is never killed at exit
  (orphaned icon). The `Symbol.for("omp-tray-ext.gen")` counter on
  `globalThis` collapses double-loaded copies (two path spellings → two
  module scopes in one process) to one live handler set — the newest
  activation wins — and makes module reloads (fresh `?mtime` import) replace
  the previous activation cleanly: every event handler, the `/tray` handler
  and the send wrapper start with a `stale()` check and no-op silently. NEVER
  guard `process.on("exit", killOwnDaemon)` — a stale activation must still
  reap its own spawn (the kill is PID-targeted with a `/proc` identity
  check).
- **Watcher (re-)registration is subscribe-before-act and fires on every
  owner appearance.** The daemon (re-)registers with
  `org.kde.StatusNotifierWatcher` on EVERY appearance of the watcher name —
  watcher item lists are in-memory and empty after a panel/DE restart, no host
  solicits re-registration, and this also covers daemon-before-panel boot.
  The `NameOwnerChanged` AddMatch is queued before the `NameHasOwner` flush
  roundtrip, so an appearance lands either in the snapshot or in the handler
  (never neither), and appearances seen while bootstrapping coalesce into the
  single initial register. Registration is idempotent and deadline-bounded
  (3 s): bursts coalesce to at most one extra attempt and failure is
  warn-only — the next owner appearance retries.
- **Startup publishes state BEFORE watcher registration.** The full initial
  render runs before `RegisterStatusNotifierItem`: a fast host snapshots
  `GetAll` at registration time and must already see `Status "Active"` + icon
  + tooltip (a bare `setState("idle")` is a dedupe no-op on the already-idle
  state). The 300 ms re-render after registration is kept for the
  `GetAll`↔signal-subscribe race: panels subscribe to signals asynchronously
  and can miss the first `NewIcon`/`NewStatus`.
- **Every DBus RPC is deadline-bounded.** dbus-next pending calls NEVER settle
  on connection loss (there is no close event) — an unbounded call hangs
  forever. `deadline()` (`ipc.ts`, shared with `daemon.ts`) rejects
  `Error("dbus call timeout")`; `daemonAlive`/`sendState`/`stopDaemon` run on
  ONE absolute `timeoutMs` budget (default 3 s) covering connect + every RPC
  and disconnect in `finally`; daemon-side calls (`requestName`, watcher
  registration, self-probe) use the same wrapper (3 s).
- **Shutdown always exits.** `Daemon.shutdown()` is re-entrant-safe and calls
  `process.exit` in EVERY state — including a null bus: a SIGTERM during the
  up-to-10 s connect window used to return silently, and the orphaned daemon
  went on to claim the slot and register an icon. A bus `error` event logs +
  exits at ANY phase (pre-start errors were ignored and `start()` then wedged
  on a never-settling `requestName`).
- **Silent bus death self-heals.** A clean socket close emits no event and an
  idle daemon (spinner stopped) never writes, so it would linger forever: a
  30 s self-probe (`NameHasOwner` of its own name, 3 s deadline) exits on
  rejection or `false`. The extension heals the other direction:
  `session_start` AND `session_switch` re-ensure the daemon, and a mid-session
  daemon death self-heals via `recover()` (respawn + `reseed`) on the next
  failed send.
- **Error is transient; the flash is send-anchored and state reads happen at
  job execution.** `flashError()` shows `X` for `errorMs` (default 5 s) from
  the moment the error is SENT — the timer arms in `finally`, even when the
  send failed, so `current` can't wedge on `"error"` with no timer to clear
  it — then reverts to the pre-error state, not hardcoded `idle`. A second
  flash while one is showing just re-arms (extends) the live timer instead of
  re-sending `"error"`. The revert target is read when the revert job runs,
  not when the timer is armed; likewise `reseed()` and the revert read
  `current`/`revertTo` INSIDE the chain job — a call-time capture with a
  chain backlog replays a stale state and the fresh daemon gets stuck on it.
  The flash routes through the same chain so an un-awaited error send can't
  overtake a later idle/working.
- **Tray IPC never blocks the agent loop.** `sendState` resolves `false` when
  the daemon is unreachable; the `send` seam then fires `recover()` (respawn +
  `reseed()`) — single-flight, its flag cleared BEFORE the reseed (so a failed
  reseed's nested `recover()` can start a new attempt) and NEVER awaited from
  inside `TrayController.chain` (reseed enqueues on the chain; awaiting it
  from a chain job deadlocks the chain against itself).

### Slash-command surface (`/tray`)

```
/tray                status   — show daemon running state (default)
/tray stop  | off    stop     — stop the daemon (explicit user command: targets the shared slot)
/tray restart        restart  — stop + re-spawn, reseeds current state; fails honestly (no adopt)
/tray working        working  — force working
/tray error          error    — force error
/tray debug          debug    — plugin/daemon state for troubleshooting (daemon state is live-probed, never mirrored)
```

## Key Directories

Flat root — no `src/`; all source, tests, and config live beside each other:

- `*.ts` at root — five modules + five test files (see Important Files).
- `node_modules/` — `bun install` output (gitignored).
- `.zcode/` — local session/plan artifacts (gitignored).
- Committed at root: `README.md`, `AGENTS.md`, `LICENSE`, `package.json`,
  `tsconfig.json`, `bun.lock` (deliberately committed — see below).

## Development Commands

```bash
bun install                       # one-time; dbus-next only
bunx tsc --noEmit                 # typecheck (strict) — after every change
bun test                          # full suite (5 files)
bun test controller.test.ts       # single file (each header states its command)
bun ./icons.ts                    # render glyphs, print pixel counts (visual check)
```

Live test against omp (the extension is imported at startup — no hot reload;
restart omp to re-iterate):

```bash
ln -s "$PWD" ~/.omp/agent/extensions/omp-tray-ext   # Option A: user extension
omp --extension ./.                                  # Option B: one-shot load
# ⚠️ Use only ONE load channel: a ~/.omp/agent/extensions symlink PLUS an `omp install` copy loads the extension twice in one omp session (duplicate event handlers, redundant daemon spawn per open).
```

`session_start` AND `session_switch` re-ensure the daemon, so `/compact` or a
session switch revives a stopped daemon (a switch never forces state —
switching sessions is not an idle signal); a mid-session daemon death
self-heals via `recover()` on the next failed send. Troubleshooting: `/tray debug` inside omp; omp
logs to `~/.omp/logs/omp.$(date +%F).log`; the daemon logs to its own stderr
(the spawn is `stdio: "ignore"` — flip to a file to debug spawn failures).
Disable without uninstalling:

```yaml
# ~/.omp/agent/config.yml
disabledExtensions:
  - omp-tray-ext        # derived from package.json#name
```

### Commits & release/version policy ⚠️

After every bigger change: bump `package.json#version`, commit, tag `vX.Y.Z` on
the **same commit**, push. "Bigger" = user-visible behavior change, new
command/state, DBus contract change, or anything touching the `daemon.ts` /
`ipc.ts` / `controller.ts` invariants. Behavior-identical refactors and
docs-only commits need no bump.

- Commit style: `<type>[(scope)]: <what> (vX.Y.Z)`; version suffix only on
  behavior commits (e.g. `fix: route reseed through the chain (v1.1.1)`,
  `docs(readme): ...`).
- Semver-leaning: → patch for fixes, → minor for new commands/states, → major
  for a DBus contract break.
- Tags are REQUIRED for `omp install` to detect updates: a bare spec pins the
  first-resolved HEAD SHA into `bun.lock` and is then treated as satisfied.
- bun 1.3.x does NOT parse `#ref` in scp-style git URLs
  (`git@github.com:...git#tag` fails) — always use `github:owner/repo#ref`.

```bash
bunx tsc --noEmit && bun test     # gates first — never commit red
git add -A && git commit -m "<scope>: <what changed> (vX.Y.Z)"
git tag vX.Y.Z && git push origin master --tags
```

Stale-lockfile recovery when `omp install --force` still resolves an old SHA:

```bash
rm -rf ~/.omp/plugins/node_modules/omp-tray-ext
# drop the "omp-tray-ext" line from ~/.omp/plugins/package.json and bun.lock
omp install github:Croissander/omp-tray-ext#vX.Y.Z
```

## Code Conventions & Common Patterns

- **Ponytail by default** (lazy = efficient): does it need to exist? → stdlib →
  platform feature → installed dep → one line → minimum code that works. Mark
  deliberate shortcuts with `// ponytail: <shortcut>; upgrade path <X>`.
- **No unrequested abstractions**: no one-implementation interfaces, no
  factories for one product, no config for a value that never changes. Deletion
  over addition; boring over clever.
- **Don't extract one-expression functions** — inline unless the name is a
  durable contract (test seam, DI boundary, public API, type guard).
- **`Promise.withResolvers()`**, never `new Promise((resolve) => ...)`.
- **DBus discipline**: EVERY RPC is deadline-bounded (dbus-next pending calls
  never settle on connection loss) — connect and calls share one absolute
  budget via `deadline()`; disconnect in `finally`, wrap
  `process.kill`/`bus.disconnect` in `try/catch`. DBus method args are a trust
  boundary — validate literals (see `DaemonControl.SetState`).
- **DI seams**: `TrayController`'s `send` and `errorMs` constructor params and
  `ipc.ts`'s `__setSessionBusForTests` bus factory are `@internal` injectables
  for tests; tests drive privates via `c["transition"](...)`. Follow this
  shape for new testable logic.
- **Never simplify away** trust-boundary validation, error handling that
  prevents data loss, security, accessibility basics.
- Comments explain *why* (races, invariants), not what. JSDoc exported
  symbols. Editing: surgical `edit` over rewrites; grep/glob to locate, read
  ranges; `lsp references` before changing an exported symbol.

### omp extension-authoring rules (apply here)

Authoritative: <https://omp.sh/docs/extension-authoring>,
<https://github.com/can1357/oh-my-pi/blob/main/docs/extensions.md>.

- Factory: `export default function ompTray(pi: ExtensionAPI)`. Register
  handlers/tools/commands at load only — runtime actions (`sendMessage`,
  `setActiveTools`, …) throw `ExtensionRuntimeNotInitializedError` if called
  during module evaluation.
- Command names must not clash with `BUILTIN_SLASH_COMMAND_RESERVED_NAMES` —
  the runner **silently skips** conflicts (why `/tray debug`, not `/debug`).
- `getArgumentCompletions(argumentPrefix)` contract: `AutocompleteItem[] |
  null`, prefix-filtered, `null` after a space or on no match; each item's
  `value` carries a **trailing space** (`"<sub> "`); side-effect-free (runs on
  every keystroke).

## Important Files

| Path | Role |
|---|---|
| `index.ts` | Extension entry (`ompTray` factory), daemon lifetime (single-flight `ensureDaemon`, generation guard), `/tray` |
| `daemon.ts` | Detached SNI daemon: `Daemon`, `DaemonControl`, `stateView`, `/MenuBar` dbusmenu, `import.meta.main` entry |
| `controller.ts` | `TrayController` — event→state mapping + serialized chain (flash timing) |
| `ipc.ts` | DBus contract constants + deadline-bounded client (`daemonAlive`/`sendState`/`stopDaemon`, `deadline()`, `__setSessionBusForTests`) |
| `icons.ts` | Glyph drawing + ARGB conversion; `import.meta.main` visual demo |
| `index.test.ts` | Spawn-runner resolution + extension pins (single-flight spawn, generation guard, restart failure; bun:test) |
| `controller.test.ts` | Chain-ordering/state-machine + flash-timing pins (bun:test) |
| `icons.test.ts` | Pixel/ARGB correctness suite (bun:test) |
| `daemon.test.ts` | `stateView` render-mapping + hermetic lifecycle pins (slot, watcher-restart, SNI conformance, initial-state, SIGTERM-during-startup; bun:test) |
| `ipc.test.ts` | `deadline` unit pins + fake-bus RPC pins (never-settle, success, disconnect-always; bun:test) |
| `.github/workflows/ci.yml` | CI: `bun install --frozen-lockfile` + gates on push/PR |
| `package.json` | `omp.extensions` load hook; `name` doubles as `disabledExtensions` key; `version` couples to git tag |
| `tsconfig.json` | Strict flags — see Runtime/Tooling Preferences |
| `bun.lock` | Committed lockfile; pinned SHAs affect `omp install` update detection |

## Runtime/Tooling Preferences

- **Bun is required** (for users too): the extension and daemon are TypeScript
  run directly — no build step, no emitted JS (`noEmit`,
  `allowImportingTsExtensions`). The daemon is spawned as `bun daemon.ts`
  (`resolveDaemonRunner`: `Bun.which("bun")`, falling back to `process.execPath`
  only when its basename is `bun`). NEVER spawn `process.execPath` blindly: omp
  is a Bun-compiled binary, so it is omp itself — `omp run daemon.ts` starts
  another omp session that auto-loads this extension and spawns again without
  bound (process storm that froze the machine, 2026-10-05).
- **Package manager**: bun (`bun.lock` committed). Node is not supported.
- **Dependencies**: `dbus-next` is the only runtime dep (pure JS — no native
  builds, keep it that way). `@oh-my-pi/pi-coding-agent` is a devDependency
  for **types only** — every import is `import type`, erased at runtime
  (omp binaries are compiled ELF with no `.d.ts`). Never move it to
  `dependencies`, never import it at runtime. `typescript` is a peerDependency.
- **tsconfig consequences**: `noUncheckedIndexedAccess` → typed-array indexing
  needs `?? 0` guards; `verbatimModuleSyntax` → type-only imports must use
  `import type`; plus `strict`, `noImplicitOverride`,
  `noFallthroughCasesInSwitch`.
- **No formatter or linter is configured** — match surrounding style; don't
  add tooling unrequested.

## Testing & QA

- Framework: **bun:test** (`import { test, expect } from "bun:test"`), flat
  `*.test.ts` beside sources. Full suite `bun test`; each file's header
  comment states its single-file command.
- `index.test.ts` pins the spawn runner and extension lifetime:
  `resolveDaemonRunner` prefers `bun` from PATH and returns `null` for a
  non-bun host binary (fork-bomb pin); overlapping `ensureDaemon()` calls
  share one spawn (single-flight pin); a stale activation is silent while the
  newest sends (generation pin); `/tray restart` failure spawns and adopts
  nothing (restart-failure pin).
- `controller.test.ts` pins the ordering + timing invariants: FIFO chain under
  send reordering, error flash can't overtake a later idle, `force` bypasses
  the dedupe, `reseed` replays state after a daemon respawn AND reads it at
  job execution (not call time), flash dedupe, revert to the **pre-error**
  state after `errorMs`, `errorMs` measured from the error **send** (not the
  call), and a flash/transition/flash burst reverts to the pre-flash state.
- `icons.test.ts` pins pixel correctness: `[a,r,g,b]` byte order, visible
  glyphs/frames, pairwise-distinct spinner frames, 8-frame wraparound, shared
  pre-rendered glyph instances.
- `daemon.test.ts` pins the render mapping (`stateView`): exact
  status/tooltip/attention literals per state and shared pre-rendered glyph
  instances (`===` identity); importing `daemon.ts` is side-effect-free. Its
  lifecycle pins run real `daemon.ts` children on a PRIVATE throwaway
  `dbus-daemon` session bus with a fake StatusNotifierWatcher: single-instance
  slot (one registration + one survivor), watcher-restart re-registration, SNI
  conformance (`Category`/`Menu`/`ItemIsMenu`, `NewStatus` `(s)` payload,
  `NewToolTip` only on tooltip-text change), initial state published before
  registration, and SIGTERM during the startup connect window exiting promptly
  (silent Unix-socket listener that accepts but never completes the D-Bus
  handshake). Self-skips when the `dbus-daemon` binary is missing.
- `ipc.test.ts` pins `deadline()` (value passthrough, timeout error, prompt
  original rejection, timer disarmed on settle) and the client calls against a
  fake `MessageBus` (via `__setSessionBusForTests`): never-settling RPCs
  settle `false` fast (the dbus-next never-settle defect), a healthy daemon
  resolves `true` on the default 3 s budget, and every call disconnects the
  bus exactly once on success and failure paths.
- Rule: **tests never touch the real session bus.** The documented deviation
  from "tests never touch DBus" remains `daemon.test.ts`'s private-bus
  harness: it speaks DBus, but only over a PRIVATE throwaway `dbus-daemon`
  session bus with a fake StatusNotifierWatcher (hermetic — never the real
  session bus). Patterns to reuse: `stubApi()` double (inject `send` — no I/O
  at all), duck-typed fake `MessageBus` through `__setSessionBusForTests`
  (restored in `afterEach`), `drain()`
  macrotask yield that settles the chain regardless of
  microtask hop count, `void c["transition"](...)` to fire internals the way
  omp does (un-awaited handlers), real-timer waits through the `errorMs` seam
  (`new TrayController(api, send, 10)`).
- Standard: every non-trivial logic unit leaves **one runnable check** behind
  (assert-based self-check or one small test file); trivial one-liners need
  none. Tests assert behavior, not implementation — no wiring/echo/tautology
  tests; existing wording/implementation tests get deleted, never re-pinned.
- Gates before every commit: `bunx tsc --noEmit && bun test`. Never commit a
  red tree; run the suite once across the union of changed files.

Further reading: SNI spec —
<https://www.freedesktop.org/wiki/Specifications/StatusNotifierItem/>;
dbus-next — <https://github.com/dbusjs/node-dbus-next>.
