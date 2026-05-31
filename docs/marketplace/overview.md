# BMCP Marketplace Overview

BMCP gives local agent CLIs a visible browser inside VS Code.

Use it when an agent running in the VS Code terminal needs to operate a page and the user wants to see every step. BMCP opens a browser panel, exposes a localhost control bridge, and returns structured element snapshots so the agent can click and type against explicit controls.

## Highlights

- Visible browser panel inside VS Code.
- Local HTTP bridge for existing agent CLIs.
- Structured element snapshots with stable references.
- Working first-run demo with open, snapshot, type, click, and read-result.
- Local-first workflow with no hosted browser service.

## First Run

Run `BMCP: Run Demo` from the Command Palette.

BMCP opens the browser panel, fills the demo sign-in form, clicks Sign in, and reports the visible inventory state through the local bridge.

## Current Scope

This first release proves the VS Code-visible browser loop and local agent bridge. External pages can be displayed when they allow embedding. Full arbitrary-site control will require the next browser-control layer and is not claimed by this release.

## Safety Boundary

BMCP is for user-authorized browser actions in the user's visible local workspace. It is not positioned as CAPTCHA bypass, anti-fraud bypass, scraping evasion, or security-control circumvention tooling.
