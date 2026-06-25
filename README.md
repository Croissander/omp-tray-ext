# omp-tray-ext

A native Linux status-bar tray for [Oh My Pi (omp)](https://omp.sh)
that reflects agent state — idle, working, or errored. The tray icon appears
when omp starts and is removed when omp exits.

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
| idle | `>_` prompt glyph | `Passive` | `session_start` / `agent_end` / `turn_end` |
| working | spinning ring (rotated circle, chunk missing; monochrome) | `Active` | `agent_start` / `before_provider_request` / `tool_execution_start` |
| error | `!!` double exclamation | `NeedsAttention` | `tool_result` with `isError` (auto-clears after 5 s) |

The spinner animates at ~8 fps while the agent is working — each frame is a
ring with a ~90° arc gap, rotated 45° per frame.

## Architecture

A **detached daemon** owns the tray; the omp extension spawns it at load
and stops it on quit, forwarding state over DBus IPC. The tray mirrors the
omp process lifetime.

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

- `index.ts` — extension entry; spawns the daemon detached, forwards events,
  registers the `/tray` command.
- `daemon.ts` — owns the SNI item + `org.omptray.Daemon` control interface;
  renders the spinner and responds to `SetState`/`Stop`.
- `ipc.ts` — shared DBus client: `daemonAlive`, `sendState`, `stopDaemon`.
- `controller.ts` — maps omp lifecycle events to `idle`/`working`/`error`.
- `icons.ts` — monochrome glyphs: `>` chevron + `_`, `!!`, 8 spinner frames.

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

**Updating:** `git pull` in the cloned directory. No rebuild needed — omp
imports the TypeScript directly via Bun.

## Requirements

- Linux desktop with a DBus session bus and an SNA host running in your panel.
- `dbus-next` (installed by `bun install`; pure JS, no native build).
- `bun` (the extension and daemon import TS directly; omp loads via Bun).
