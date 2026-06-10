# Contributing

Thanks for your interest! This project is deliberately small: one C# file, one
JS file, zero dependencies beyond what ships with Windows. Please keep it that
way — PRs that add package managers, frameworks, or build systems will be
declined unless they solve a problem the current setup can't.

## Dev setup

No installs needed on Windows 10/11:

```bat
build.bat        rem compiles PacketHighway.cs with the .NET Framework csc
start-demo.bat   rem runs with synthetic traffic, no admin needed
```

Open `http://localhost:8339/` and you should see traffic within a second or
two. For the wallpaper path, `start.bat` (elevates for pktmon).

The pure-frontend demo also runs with no backend at all: serve `web/` with any
static file server and open it with `?static=1`.

## Layout

| Path | What |
| --- | --- |
| `PacketHighway.cs` | Backend: pktmon capture, parsing, protocol classification, process attribution, HTTP + SSE server |
| `web/app.js` | Three.js scene, HUD, packet→vehicle spawning, static demo generator |
| `web/index.html` | Markup + styles |
| `wallpaper.ps1` | Pins the Edge window into the desktop's WorkerW layer |
| `*.bat` | Entry points |

## Guidelines

- Test both paths before submitting: `start-demo.bat` (server) and
  `web/index.html?static=1` (static).
- Keep the frontend ES5-compatible (it currently runs without a transpiler).
- The wallpaper must stay non-interactive and below the icon layer; anything
  touching `wallpaper.ps1` should be tested on a multi-monitor, mixed-DPI
  setup if possible — that's where the bodies are buried.
- Vehicle/protocol mapping changes should update both the README legend and
  the in-app legend.

## Reporting bugs

Open an issue with your Windows version, monitor layout (count + DPI scaling),
and whether demo mode reproduces it. Security issues: see
[SECURITY.md](SECURITY.md) — please don't open public issues for those.
