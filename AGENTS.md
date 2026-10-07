# Repository Guidelines

## Project Overview

omp-tray-ext is a native Linux status-bar tray for [Oh My Pi (omp)](https://omp.sh)
that reflects agent state — `idle`, `working`, `error` — and takes quick
actions on the agent (right-click dbusmenu: interrupt, quick prompts, stop).
A detached daemon implements the freedesktop **StatusNotifierItem (SNI)** spec
over the DBus session bus and pushes pixel-drawn ARGB `IconPixmap` bytes; no
Electron/GTK/Qt. Two processes: the omp extension (transient) and the tray
daemon (one shared per session bus). This file is the ground-truth brief for
any agent working here.

## Architecture & Data Flow

```
omp process (transient)          tray daemon (one per session bus)
┌─────────────────┐              ┌──────────────────────┐
│ index.ts        │ SetState(s)  │ daemon.ts            │
│  spawn daemon   │─────────────▶│  owns SNI on bus     │
│  forward events │ SetDetail(s) │  spinner timer       │
│  /tray command  │              │  IconPixmap (ARGB)   │
│  menu actions   │◀─────────────│  dbusmenu /MenuBar   │
└─────────────────┘ SessionAction└──────────┬───────────┘
                                            ▼
                                 KDE / GNOME / waybar panel
```

- `index.ts` — extension entry (`export default function ompTray(pi)`); daemon
  lifetime (detached `Bun.spawn`, single-flight `ensureDaemon`, `recover()` on
  failed sends with an unconditional reseed), owner of the `session_start` /
  `session_switch` re-ensure handlers (`session_shutdown` is mapped in
  `controller.ts` only — index.ts never binds it), `/tray` command,
  exit-registered PID-checked kill (`killOwnDaemon` — the instant path on
  clean exits), owner-verified adoption (`isOwnerless` — an owner-less daemon
  is replaced, never adopted), the owner pid handed to the daemon's
  watchdog (argv[2] at spawn), and the process-single-flight tray-menu action
  listener (`ensureActionListener` + module-level `actionRoute`, last
  factory's session wins).
- `controller.ts` — `TrayController`: maps omp events to `DaemonState`
  (`"idle" | "working" | "error"`) under a turn window (`inRun`), closes the
  window on terminal `agent_end` and on session transitions, serializes
  sends on a promise chain (error-flash timing lives here too), captures the
  run's ctx at `agent_start` for `interrupt()` (tray "Interrupt agent" —
  cleared when an idle transition's job runs), and forwards the current tool
  name (`tool_execution_start.toolName`) as run detail.
- `ipc.ts` — shared DBus contract (bus name `org.omptray.Daemon`, path/iface
  `/org/omptray/Daemon`) + deadline-bounded client `daemonAlive(timeoutMs?)`,
  `sendState(state, detail?)` (resolves `false` on failure; the detail RPC
  rides the same connection and is best-effort), `stopDaemon(timeoutMs?)`
  (true iff `Stop()` completed). Each call opens its own session-bus
  connection under ONE absolute budget (connect + RPCs, default 3 s), plus
  `daemonProcessPid(timeoutMs?)` (the daemon's owning pid, null when the name
  is unowned — the adoption owner check). Also `watchSessionActions(onAction,
  timeoutMs?, probeMs?)` — the extension's persistent SessionAction
  subscription (name-addressed match survives daemon respawns; reconnect on
  bus error + `probeMs` liveness probe against silent socket death) — and
  `deadline()` (shared with `daemon.ts`) plus the `__setSessionBusForTests`
  `@internal` bus-factory seam.
- `daemon.ts` — detached process owning the SNI item (its signals are the
  cross-host update contract — see flow below), the right-click
  `com.canonical.dbusmenu` at `/MenuBar` (static item tree; GNOME requires a
  live `Menu` path to show the icon at all), and the `org.omptray.Daemon`
  control interface (`SetState`, `SetDetail`, `Stop`, `SessionAction`
  signal); spinner timer (8 frames @120 ms), `paint()`/`render()` SNI
  updates, watcher (re-)registration, bus self-probe, and the owner-liveness
  watchdog (exits when the owning app dies, whatever the death mode, and when
  the owning app's terminal is gone while the app lingers — see the
  owner-lifetime invariant).
- `icons.ts` — pure 22×22 pixel glyphs (no font/image library): `>_` prompt,
  `X` error, 8 spinner frames; RGBA→ARGB converter.

Exact flow: event mapping is TURN-WINDOWED — `agent_start` opens the run
window, and working-mapped events (assistant `message_start`,
`tool_execution_start`, `tool_result` success) apply ONLY inside it; while
idle they are IGNORED (omp emits unpaired idle-time events: prompt-cache warm
replays fire provider requests on an idle timer for up to 30 min; non-loop
tool dispatches emit `tool_result` with no run around them — a "working" from
either has no `agent_end` to settle it back). `before_provider_request` is NO
LONGER MAPPED and must NEVER be re-added. `tool_result` with `isError` →
`error` flash even while idle (self-reverting). `agent_end` → `idle` only when
`willContinue` is falsy (continuations, incl. `awaitingAsyncWork`, are not
user-visible terminals — the window stays open); no `turn_end` handler —
deliberate, it fires mid-loop. `session_before_switch` / `session_switch` /
`session_shutdown` close the window + `idle` (a mid-turn switch swallows
`agent_end`; subagent child disposals emit `session_shutdown`). `index.ts`
handles `session_start` (`ensureDaemon()` then `controller.force("idle")`)
and `session_switch` (re-`ensureDaemon()` only — switching sessions is not an
idle signal); teardown is the exit-registered `killOwnDaemon()` on clean
exits (PID-targeted with a `/proc/<pid>/cmdline` identity check — never
another omp's daemon), the daemon's owner watchdog for every other death
mode (see Key invariants), plus the explicit `/tray stop` —
`session_shutdown` never stops the daemon. Sends
call `SetState`; the daemon validates the state
literal (trust boundary), then publishes SNI properties (`IconPixmap`,
`ToolTip`, `Status`, `AttentionIconPixmap`) and emits `NewIcon`,
`NewAttentionIcon`, `NewStatus` (WITH the `(s)` status string), `NewTitle`,
`NewToolTip`. Signals are the cross-host update contract — Plasma/waybar
ignore `PropertiesChanged` — and `NewToolTip` fires only when the tooltip
TEXT changes (spinner ticks must not churn it; the tick path pushes the same
composed text, detail included). `SetDetail` (extension→daemon) carries the
current tool name — the daemon trims+clamps to 80 chars (trust boundary) and
shows it in the menu header (`omp — Working · Edit`) and the working tooltip;
`setState("idle")` clears it.

Menu flow: the right-click menu is a **static** dbusmenu tree — ids never
change (root 0 → header 1, sep 2, interrupt 3, Prompts 4→[5,6,7], sep 8,
Debug 9→[10..13], Stop 14), so the layout revision never moves and
`LayoutUpdated` is declared but never emitted. Live values ride
`ItemsPropertiesUpdated`: the header label + Interrupt `enabled` on every
`setState`/`setDetail`, the watcher row after the first successful watcher
registration (all other Debug rows are boot-immutable: version from
package.json, started HH:MM, owner pid — deliberately never "uptime", which
a cached client would show stale). A click arrives as `Event(id, "clicked",
data, timestamp)`; the daemon validates (only known action ids × "clicked"
do anything — trust boundary) and either acts daemon-side (`Stop` →
deferred shutdown) or emits `SessionAction(action, arg)` on the control
interface (`("abort","")` / `("prompt", verbatim prompt text)`). Only the
daemon's exclusive name can be the signal's sender, so spoofing requires
owning the slot. `ItemIsMenu` is `true` (the menu is real). The Event/
GetProperty arg types are canonical per the KDE/libdbusmenu interface
(`Event` is `(i,s,v,u)`; `GetProperty` `(i,s)`) — the stub-era `(u,…)` types
mismatched every conformant client's marshalling and would have rejected
clicks on signature.

| Agent state | Icon | SNI `Status` | Trigger |
|---|---|---|---|
| idle | `>_` | `Active` | `session_start` (via `force`) / terminal `agent_end` (`willContinue` falsy) / session switch/shutdown |
| working | spinning ring (8 frames, ~8 fps) | `Active` | in-run turn events (see above) |
| error | `X` | `NeedsAttention` | `tool_result` with `isError`; auto-clears `errorMs` (5 s) after the error **send**, back to the **pre-error** state |

### Key invariants (do not break)

- **Event mapping is TURN-WINDOWED (`inRun` opens at `agent_start`).**
  Working-mapped events (assistant `message_start`, `tool_execution_start`,
  `tool_result` success) apply ONLY inside the window; while idle they are
  ignored — omp emits unpaired idle-time events (prompt-cache warm replays
  fire provider requests on an idle timer for up to 30 min; non-loop tool
  dispatches emit `tool_result` with no run around them), and a "working" from
  them has no `agent_end` to settle it back (the stuck-working bug this gate
  exists to prevent). `before_provider_request` is UNMAPPED and must NEVER be
  re-added: it is the only mapped event reachable from unbracketed provider
  calls, and in-run it is redundant (`agent_start` / `message_start` /
  `tool_execution_start` already cover every run). `tool_result` `isError`
  flashes ERROR even while idle (self-reverting). `agent_end` is terminal only
  when `willContinue` is falsy — continuations (incl. `awaitingAsyncWork`)
  keep the window open (such settles are not user-visible terminals).
  `session_before_switch` / `session_switch` / `session_shutdown` close the
  window + idle: a mid-turn switch swallows `agent_end` (listeners disconnect
  before the abort), so these are the window's only idle close, and
  `session_shutdown` also fires for subagent child disposals — resetting a
  working stranded by a child run.
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
  Process teardown is `process.on("exit", killOwnDaemon)` on clean exits plus
  the explicit `/tray stop` — NEVER a `session_shutdown` handler (the event
  fires for subagent child disposals too, sharing the module-level
  `daemonPid`, so a child's dispose would kill the shared daemon mid-parent-
  turn). `killOwnDaemon()` signals only a daemon this process spawned: it
  verifies identity via `/proc/<pid>/cmdline` before SIGTERM (PID-reuse
  guard). The daemon's SIGTERM handler removes the SNI item cleanly.
  `process.kill`/`bus.disconnect` on a dead target throws ESRCH — swallowed in
  `try/catch`. Signal deaths never reach that exit hook (see the owner-lifetime
  invariant).
- **The icon dies WITH its app (owner-bound daemon lifetime).** The daemon's
  argv[2] is its owner's pid (fallback: its parent at boot) and it shuts down
  when `process.ppid` stops matching — checked at boot (the owner may die
  before the daemon even starts) and on a 1 s poll. This is the ONLY
  mechanism covering signal death: `process.on("exit")` never runs when the
  owner dies by signal (SIGHUP terminal close, SIGINT, SIGTERM, SIGKILL —
  verified empirically, 2026-10-06), so exit-hook-only teardown leaked the
  daemon and its icon on every hard close (the stale-icon bug). The same poll
  also watches the owner's CONTROLLING TERMINAL: an owner can outlive its
  terminal (omp's disconnect teardown hangs instead of exiting — upstream
  #5835/#6788 class), ppid never changes, and only the released ctty
  (`/proc/<owner>/stat` `tty_nr` → 0, read once at boot and re-checked each
  poll) marks the app as gone for the user. A boot `tty_nr` of 0 (piped
  stdin, setsid) is non-interactive and arms NOTHING — the tty check kills
  only when a tty the owner HAD has gone. `-1` (unreadable stat) never reads
  as terminal death. Adoption
  enforces the same invariant client-side: `ensureDaemon` ADOPTS only an
  owner-bound daemon (`isOwnerless` — `/proc/<pid>/stat` ppid 1 or gone) and
  REPLACES an owner-less one (`stopDaemon` + `waitGone` + spawn) — which also
  flushes pre-watchdog orphans. Never re-add an "adopt when `daemonAlive()`"
  gate.
- **`ensureDaemon` is single-flight; there is deliberately NO generation
  guard (the v1.3.0 `globalThis` generation guard is removed — never
  re-add).** Overlapping callers (load-time ensure, `session_start` /
  `session_switch` handlers, `recover()`, `/tray restart`) share one spawn
  attempt — `daemonPid` is last-write-wins, and a stomped PID would name a
  dead slot-loser while the surviving daemon skips the exit hook: it still
  dies with its owner via the watchdog (its icon may outlive a clean exit by
  one 1 s poll). omp re-binds extension factories in-process per subagent
  session WITHOUT re-evaluating the module, so a generation counter silences
  the parent's handlers and drops queued sends the moment any subagent has run
  — dropping the final "idle" strands the icon at "working". Double-load
  duplicates without the guard are benign: same events → identical sends, and
  the daemon's `SetState` is idempotent.
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
  `Error("dbus call timeout")`; `daemonAlive`/`daemonProcessPid`/`sendState`/`stopDaemon` run on
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
  from a chain job deadlocks the chain against itself). The reseed is
  UNCONDITIONAL — even when the respawn failed: a failed ensure is not final
  (the daemon may appear moments later), and the forced reseed retries the
  lost final "idle" that the dedupe would otherwise swallow.
- **The right-click menu is a static dbusmenu tree; actions flow daemon →
  extension over `SessionAction`.** Item ids never change and the layout
  revision never moves — dynamic values (header label, Interrupt `enabled`,
  watcher row) ride `ItemsPropertiesUpdated`, and `LayoutUpdated` is declared
  but never emitted (a property change must not trigger client layout
  refetches). `Event` args are a trust boundary (known action ids ×
  `"clicked"` only). The extension keeps EXACTLY ONE `watchSessionActions`
  subscription per process (`ensureActionListener` module-level flag):
  omp re-binds factories per subagent session, and a second live subscription
  would deliver every click twice — double prompts. The module-level
  `actionRoute` is last-write-wins like `daemonPid` (the newest factory's
  session handles actions). `interrupt()` calls `ctx.abort()` on the ctx
  captured at `agent_start` — the ONLY abort handle omp gives extensions (no
  `pi.abort()`) — cleared in the idle transition's job BEFORE its `await`
  (clearing after would stomp a newer run's ctx captured mid-send), and
  deliberately NOT chained (aborting must not wait behind tray sends).
  Quick prompts go out via `pi.sendUserMessage` (idle → starts a turn;
  streaming → queues as steer). The action listener self-heals like the
  daemon's own bus link: reconnect on bus `error` plus a `probeMs` liveness
  probe — pending calls never settle on a clean socket close, and
  `NameHasOwner === false` is a HEALTHY probe answer (an absent daemon is
  valid; the name-addressed match revives with it). It is fire-and-forget
  from the omp flow and warns on handler errors.
- **Known ceilings:** (a) icon removal after a hard-killed owner lags up to
  one watchdog poll (1 s) plus the bus's name sweep; (b) an owner-less daemon
  that got reparented under a subreaper (not pid 1) reads as owned at
  adoption — `ponytail:`-marked in `isOwnerless`, upgrade path a daemon-side
  owner-pid handshake; (c) an adopted daemon outlives a closing ADOPTER while
  its owner omp lives (shared slot, by design) — the next failed send
  re-heals via `recover()`; (d) a terminal dying during the daemon's ~2 s
  spawn window reads as non-interactive (boot `tty_nr` 0) and disarms the
  tty check (ppid still covers the exit) — `ponytail:`-marked in
  `daemon.ts`, upgrade path the extension passing its own `isTTY` in
  argv[3]; (e) omp itself may still linger headless after a disconnect
  (upstream #5835/#6788 class) — the tty watchdog only takes the ICON down
  then; killing the zombie process is omp's to fix; (f) menu quick-actions
  always target the NEWEST session/route (shared-slot semantics): the daemon
  cannot know whether any extension subscribes (no gating — heartbeat/
  handshake is the upgrade path), `interrupt` aborts the newest run's ctx
  (a child session's rebinding wins until the parent re-binds), and a
  lingering child handler after the parent resumes sends to a disposed
  session (caught + warned, `pi.sendUserMessage` throws); (g) the menu cannot
  approve permission prompts or focus/raise the terminal window (Wayland
  clients cannot raise peers) — both are the research-backed next features,
  gated on omp permission plumbing / a WM helper.

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
bun test                          # full suite (5 files, 65 tests)
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
| `index.ts` | Extension entry (`ompTray` factory), daemon lifetime (single-flight `ensureDaemon`, unconditional-reseed `recover()`, exit-hook PID-checked kill, owner-verified adoption `isOwnerless`), `/tray`, process-single-flight menu-action listener (`actionRoute` → interrupt/sendUserMessage) |
| `daemon.ts` | Detached SNI daemon: `Daemon`, `DaemonControl` (+`SetDetail`/`SessionAction`), `stateView`, right-click dbusmenu at `/MenuBar` (static tree, `OmpTrayMenu`), `import.meta.main` entry + owner watchdog |
| `controller.ts` | `TrayController` — turn-windowed event→state mapping + serialized chain (flash timing), run-ctx capture for `interrupt()`, tool-name detail |
| `ipc.ts` | DBus contract constants + deadline-bounded client (`daemonAlive`/`daemonProcessPid`/`sendState`(+detail)/`stopDaemon`, `watchSessionActions`, `deadline()`, `__setSessionBusForTests`) |
| `icons.ts` | Glyph drawing + ARGB conversion; `import.meta.main` visual demo |
| `index.test.ts` | Spawn-runner resolution + extension pins (single-flight spawn, reseed-after-failed-ensure, no-suppression, shutdown-no-kill, restart failure, owner-verified adoption + `isOwnerless` parse, menu-action single-flight route; bun:test) |
| `controller.test.ts` | Chain-ordering/state-machine + turn-window mapping + flash-timing + interrupt/detail pins (bun:test) |
| `icons.test.ts` | Pixel/ARGB correctness suite (bun:test) |
| `daemon.test.ts` | `stateView` render-mapping + hermetic lifecycle pins (slot, watcher-restart, SNI conformance, initial-state, SIGTERM-during-startup, owner-lifetime (predecease, stale-icon, setsid-owner, tty-loss), menu layout/live-properties/click-routing; bun:test) |
| `ipc.test.ts` | `deadline` unit pins + fake-bus RPC pins (never-settle, success, disconnect-always, owner-pid probe, detail RPC, action-listener reconnect/probe; bun:test) |
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
  `*.test.ts` beside sources. Full suite `bun test` (65 tests / 5 files);
  each file's header comment states its single-file command.
- `index.test.ts` pins the spawn runner and extension lifetime:
  `resolveDaemonRunner` prefers `bun` from PATH and returns `null` for a
  non-bun host binary (fork-bomb pin); overlapping `ensureDaemon()` calls
  share one spawn (single-flight pin); a lost final idle is retried even
  after a failed respawn (reseed-after-failed-ensure pin); no activation is
  suppressed — both send (no-suppression pin); `session_shutdown` settles the
  icon and never kills the daemon (shutdown-no-kill pin); `/tray restart`
  failure spawns and adopts nothing (restart-failure pin); an owner-less
  daemon is stopped and replaced, never adopted (stale-icon self-heal pin);
  `isOwnerless` parses `stat` ppid (comm with parens/spaces) and treats a
  vanished pid as owner-less (parse pin); menu actions route to the newest
  activation with exactly ONE SessionAction subscription across every
  rebinding in the file (single-flight route pin — must stay the LAST test,
  the listener is a process-wide singleton started by the first `ompTray()`).
- `controller.test.ts` pins the ordering + timing invariants: FIFO chain under
  send reordering, error flash can't overtake a later idle, `force` bypasses
  the dedupe, `reseed` replays state after a daemon respawn AND reads it at
  job execution (not call time), flash dedupe, revert to the **pre-error**
  state after `errorMs`, `errorMs` measured from the error **send** (not the
  call), and a flash/transition/flash burst reverts to the pre-flash state.
  Its turn-window mapping pins: cache-warm idle replays can't reopen working
  (no `before_provider_request`), non-loop idle `tool_result` (success
  ignored, error still flashes), `willContinue` `agent_end` keeps the window
  open, and session switch/shutdown close a window that never got its
  `agent_end`. Its quick-action pins: `tool_execution_start` carries the tool
  name as detail (sent even on a state dedupe; idle clears it), and
  `interrupt()` aborts the ctx captured at `agent_start`, no-ops before any
  run, and is inert after the run settles.
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
  registration, SIGTERM during the startup connect window exiting promptly
  (silent Unix-socket listener that accepts but never completes the D-Bus
  handshake), the owner-lifetime pins (owner-predecease: a daemon whose
  owner died before it booted exits without registering; stale-icon: a
  SIGKILLed owner takes the daemon and its names down — the icon dies with
  its app; setsid-owner: a non-interactive owner (no ctty) boots, registers
  and STAYS up, then still dies at a SIGKILLed owner — the tty check must not
  arm on boot tty 0; tty-loss: an owner under `script`(1) that survives its
  pty master being SIGKILLed (HUP-ignored) still loses the daemon and its
  names when the ctty releases — the icon dies with the terminal, not just
  the pid), and the menu pins (static tree via real `GetLayout` round-trips —
  ids, disabled header, submenu depth/property filtering, `GetGroupProperties`,
  `AboutToShow` false; live header label + tooltip with `SetDetail` and
  `ItemsPropertiesUpdated`; click routing over `SessionAction` — prompt text
  verbatim from the layout, abort, junk inert, Stop exits the daemon). Plus a
  `ownerTtyNr` parse pin (comm with parens/spaces; a
  truncated or unreadable stat reads as -1 "unknown", never as terminal
  death). Self-skips when the `dbus-daemon` (or, for tty-loss, `script`)
  binary is missing.
- `ipc.test.ts` pins `deadline()` (value passthrough, timeout error, prompt
  original rejection, timer disarmed on settle) and the client calls against a
  fake `MessageBus` (via `__setSessionBusForTests`): never-settling RPCs
  settle `false` fast (the dbus-next never-settle defect), a healthy daemon
  resolves `true` on the default 3 s budget, and every call disconnects the
  bus exactly once on success and failure paths. `daemonProcessPid` gets its
  own owner-pid probe pins: the owner's pid on success, null fast when the
  name is unowned or the call hangs. `sendState` detail pins: the detail RPC
  rides the same connection, a detail failure never fails the send, no detail
  → only `SetState`. `watchSessionActions` pins: one persistent connection
  delivering `SessionAction` payloads, reconnect after a bus error, and a
  failed liveness probe (silent socket death) drops and re-subscribes — no
  churn beyond the one recovery.
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
