# BMCP

BMCP gives local agent CLIs a visible browser inside VS Code.

It is not a new agent. It is a small VS Code extension that exposes a local HTTP control port so tools running in the VS Code terminal can open a visible browser panel, inspect structured page state, type, click, and read the result.

## What Works In This First Release

- Open a visible `BMCP Browser` panel in VS Code.
- Start a local-only HTTP bridge at `http://127.0.0.1:17333`.
- Run a complete local demo page flow through HTTP:
  - open browser;
  - read a structured element snapshot;
  - type username and password;
  - click sign in;
  - read the final page state.
- Open external sites in a real local browser session and mirror the live page inside the `BMCP Browser` panel.
- Let the user watch and interact with the same browser surface while the local agent CLI uses structured element snapshots and actions.

The first release proves the product loop with a visible browser surface and structured controls. BMCP is a scaffold for local agent CLIs; it does not replace the agent itself.

## Install

Install BMCP from the Visual Studio Marketplace, then run:

1. Open Command Palette.
2. Run `BMCP: Run Demo`.
3. Watch the visible browser panel complete the sign-in flow.

## Local Agent CLI Control

When VS Code has activated the extension, a local agent CLI can call:

```bash
curl http://127.0.0.1:17333/health
curl -X POST http://127.0.0.1:17333/open \
  -H 'content-type: application/json' \
  -d '{"url":"bmcp:demo"}'
curl -X POST http://127.0.0.1:17333/snapshot -d '{}'
curl -X POST http://127.0.0.1:17333/demo -d '{}'
```

The response includes structured element references such as `e1`, `e2`, and `e3`, so an agent can act through explicit page controls rather than screenshot guessing.

## Commands

- `BMCP: Open Browser`
- `BMCP: Run Demo`

## Safety Boundary

BMCP is designed for user-authorized browser work in a visible local VS Code surface. It is not a CAPTCHA bypass, anti-fraud bypass, scraping evasion, or security-control circumvention tool.

## Development

```bash
npm install
npm run verify
```

Package a VSIX:

```bash
npm run package
```

Publish when `VSCE_PAT` is available:

```bash
npm run publish:marketplace
```
