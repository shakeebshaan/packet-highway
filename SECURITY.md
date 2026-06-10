# Security Policy

## What this tool does (and doesn't)

Packet Highway captures **packet metadata only** — protocol, ports, addresses,
sizes, and the owning process. It never inspects, stores, or transmits payload
contents. Everything runs locally:

- The web server binds to `127.0.0.1` only (never `0.0.0.0`).
- No telemetry, no analytics, no outbound connections of any kind.
- The hosted demo on GitHub Pages is **fully synthetic** — it generates fake
  traffic in the browser and captures nothing.

## Elevation

Live capture uses Windows `pktmon`, which requires Administrator. `start.bat`
self-elevates for that one process. If you'd rather not elevate, use
`start-demo.bat` — it runs unprivileged with synthetic traffic.

Things worth knowing when reviewing the code:

- `PacketHighway.cs` is the entire backend — capture, parsing, process
  attribution, HTTP/SSE server. ~900 lines, no dependencies, auditable in one
  sitting.
- The frontend (`web/`) vendors Three.js locally and loads nothing from a CDN.

## Reporting a vulnerability

Please use **GitHub private vulnerability reporting** (Security tab →
"Report a vulnerability") rather than a public issue. You should get a
response within a week.

In scope: anything that makes the server reachable from off-machine, payload
data leaking into logs or the UI, privilege-escalation issues around the
elevated capture process, XSS via attacker-controlled packet fields (hostnames,
process names, etc.).

## Supported versions

Only the latest release on `main` is supported.
