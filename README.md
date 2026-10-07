# omp-tray-ext

A native Linux status-bar tray for [Oh My Pi (omp)](https://omp.sh)
that reflects agent state — idle, working, or errored. The tray icon appears
when omp starts and is removed when omp exits — even on a hard kill.

It implements the freedesktop **StatusNotifierItem (SNI)** spec over the DBus
session bus, so any SNA-compatible panel renders a real tray icon with zero GUI
toolkit dependencies:

- KDE Plasma
- GNOME Shell + AppIndicator extension
- waybar (tray module)
- Swaync / swaybar
- Any host speaking `org.kde.StatusNotifierItem`

No Electron. No GTK. No Qt. The icon bytes are drawn pixel-by-pixel in-process
and pushed as `IconPixmap` ARGB data over DBus.

## States

| Agent state | Tray icon | SNI `Status` | Fires on |
|-------------|-----------|--------------|----------|
| idle | `>_` prompt glyph | `Active` | `session_start` / terminal `agent_end` / `session_before_switch` / `session_switch` / `session_shutdown` |
| working | spinning ring (rotated circle, chunk missing; monochrome) | `Active` | `agent_start`, and inside the run window only: assistant `message_start` / `tool_execution_start` / `tool_result` (success) |
| error | `X` crossed strokes | `NeedsAttention` | `tool_result` with `isError` — any time, even outside a run (auto-clears after 5 s, reverting to the pre-error state) |

Mapping is **turn-windowed**: a run window opens at `agent_start` and closes at
a terminal `agent_end` (`willContinue` falsy — a continuation, including an
`awaitingAsyncWork` wait, keeps the window open, so there is no false idle
between steps of one visible run). Working-mapped events are ignored outside
the window: omp emits unpaired events while idle — prompt-cache warm replays
(provider requests with no run around them) and standalone tool dispatches —
and mapping those used to strand the spinner with no `agent_end` to settle it
back. For the same reason `before_provider_request` is deliberately unmapped
and must not be re-added: cache warming fires it on an idle timer (up to 30
minutes) with no run around it.

**The guarantee this buys: the tray returns to idle when the agent finishes.**
Idle-time provider traffic (prompt-cache warming) and background tool results
cannot strand the spinner. Background failures still surface: a `tool_result`
with `isError` flashes the error glyph even while idle, then self-reverts to
the pre-error state.

The spinner animates at ~8 fps while the agent is working — each frame is a
ring with a ~90° arc gap, rotated 45° per frame.

## Usage

The extension registers a `/tray` slash command inside omp:

```
/tray                show daemon running state (default)
/tray stop | off     stop the daemon (tray icon disappears)
/tray restart        stop + re-spawn the daemon (state re-seeded; failure is
                     reported honestly instead of adopting a dying daemon)
/tray working        force the tray to the working spinner
/tray error          force the tray to the error glyph
/tray debug          show plugin/daemon state for troubleshooting
```

Subcommands autocomplete as you type them. `/tray debug` prints one fact per
line:

```
daemon running : true
daemon pid    : 4242
plugin state  : idle
daemon script : /home/you/.omp/agent/extensions/omp-tray-ext/daemon.ts
model         : anthropic/claude-sonnet-4
agent idle    : true
cwd           : /home/you/project
```

## Architecture

A **detached daemon** owns the tray; the omp extension spawns it at load and
shuts it down at process exit, forwarding state over DBus IPC. One daemon
serves every omp on the session bus (single shared icon, last writer wins),
and teardown stops only the daemon that instance spawned. The icon dies WITH
its app, whatever the death mode: the daemon knows its owner's pid (passed at
spawn) and exits when the owner process disappears — covering SIGKILL and
terminal close, where no exit hook can ever run in omp. Clean exits get the
instant path instead: `process.on("exit")` with a PID + `/proc` cmdline
identity check so a recycled PID is never signaled. What teardown is *not*:
`session_shutdown` never stops the daemon (it also fires when subagent
child sessions are disposed) — it only closes the run window and sends idle.
`/tray stop` remains the explicit stop. A daemon already running at startup
is adopted only when it is owner-bound; an owner-less leftover (e.g. from an
older version) is stopped and replaced. A daemon dying
mid-turn is respawned (and its state reseeded) on the next state event. The
icon survives panel and DE restarts: the daemon watches the
StatusNotifierWatcher and re-registers whenever one appears, so the tray also
shows up when the daemon starts before the panel does.

```
omp process (transient)          tray daemon (tied to omp lifetime)
┌─────────────────┐              ┌──────────────────────┐
│ index.ts        │  SetState(s)  │ daemon.ts            │
│  spawn daemon   │──── DBus ────▶│  owns SNI on bus     │
│  forward events │              │  spinner timer       │
│  /tray command  │              │  IconPixmap (ARGB)   │
└─────────────────┘              └──────────┬───────────┘
                                            ▼
                                 KDE / GNOME / waybar panel
```

- `index.ts` — extension entry; owns `session_start` (`ensureDaemon()` then
  `controller.force("idle")`) and `session_switch` (re-ensure only), spawns
  the daemon detached, forwards turn events, respawns + reseeds on a failed
  send (the reseed runs even when the respawn fails — the daemon may appear
  moments later, and the forced reseed retries the lost final idle),
  registers the `/tray` command, and kills the spawned daemon at process exit
  (clean exits only — every other death mode is the daemon's own watchdog's
  job).
- `daemon.ts` — owns the SNI item + `org.omptray.Daemon` control interface
  (exclusive name slot — a competing daemon exits cleanly, no name stealing);
  re-registers with a (re)appearing StatusNotifierWatcher; renders the
  spinner and responds to `SetState`/`Stop`; shuts itself down when its
  owning app dies.
- `ipc.ts` — shared DBus client: `daemonAlive`, `daemonProcessPid`,
  `sendState`, `stopDaemon`.
- `controller.ts` — maps omp events to `idle`/`working`/`error`, turn-windowed
  (see States); `attach()` maps run and session-lifecycle events (when a
  mid-turn switch swallows `agent_end`, `session_before_switch`/
  `session_switch`/`session_shutdown` are the run window's only idle close) —
  `session_start` is owned by `index.ts`.
- `icons.ts` — monochrome glyphs: `>` chevron + `_`, `X` (crossed strokes), 8 spinner frames.

## Install

You need a Linux desktop with a DBus session bus (standard on any Linux
desktop) and [`bun`](https://bun.sh) installed.

**Option A — clone into the user extensions directory (recommended):**

```bash
git clone https://github.com/Croissander/omp-tray-ext.git ~/.omp/agent/extensions/omp-tray-ext
cd ~/.omp/agent/extensions/omp-tray-ext && bun install
```

Restart `omp`. omp auto-discovers the extension via the `omp.extensions` field
in `package.json` and loads `index.ts` at startup. The daemon spawns at load
time and the tray appears in your panel.

**Option B — clone anywhere and point the settings `extensions` array at it:**

```bash
git clone https://github.com/Croissander/omp-tray-ext.git
cd omp-tray-ext && bun install
```

```yaml
# ~/.omp/agent/config.yml
extensions:
  - /path/to/omp-tray-ext
```

**Option C — load once via CLI flag:**

```bash
omp --extension ./omp-tray-ext
```

**Option D — install via the `omp` CLI:**

```bash
omp install github:Croissander/omp-tray-ext#master
```

`#master` or a `#vX.Y.Z` tag from the
[tags page](https://github.com/Croissander/omp-tray-ext/tags) — always WITH a
ref: a bare spec pins whatever HEAD `bun` first resolved and omp then never
detects updates. Use the `github:owner/repo#ref` shorthand (not
`git@github.com:...git#ref`): bun 1.3.x does not parse a `#ref` in scp-style
URLs. **Updating:** `omp install --force github:Croissander/omp-tray-ext#master`
(or a newer `#vX.Y.Z`), then restart omp — the extension is imported at
startup, and a running daemon keeps its loaded code until it is respawned.

**Updating:** `git pull` in the cloned directory. No rebuild needed — omp
imports the TypeScript directly via Bun.

## Development

```bash
bun install          # one-time; dbus-next only
bunx tsc --noEmit    # typecheck (strict)
bun test             # full suite (5 files / 57 tests)
bun test index.test.ts
bun test controller.test.ts
bun test icons.test.ts
bun test daemon.test.ts
bun test ipc.test.ts
```

The daemon and ipc suites are hermetic: they run against a private throwaway
`dbus-daemon` session (with a fake StatusNotifierWatcher) or duck-typed fake
buses — never the real session bus. Tests that need `dbus-daemon` self-skip
when the binary is not installed.

Contributing guidance lives in [AGENTS.md](AGENTS.md): architecture,
invariants, code conventions, testing patterns, and the release/version
policy (bump + tag + push — tags are what `omp install` keys on).

## Requirements

- Linux desktop with a DBus session bus and an SNA host running in your panel.
- `dbus-next` (installed by `bun install`; pure JS, no native build).
- `bun` (the extension and daemon import TS directly; omp loads via Bun).

## Limitations

- **One tray icon per session bus (by design).** Concurrent omp instances
  share a single icon and their states interleave on it (last writer wins).
  Exactly one daemon serves the bus — the name slot is exclusive (no name
  stealing): a competing daemon start exits cleanly and the running daemon
  keeps the icon. Per-instance icons are the upgrade path if interleaving
  becomes a problem.
