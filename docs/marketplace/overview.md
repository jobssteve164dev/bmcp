# SoloBrowser

SoloBrowser gives local AI agents a real, visible browser inside VS Code, while you keep the page and every action in view.

Use it when an agent in the VS Code terminal needs to browse, inspect, fill, or verify a website. SoloBrowser opens a persistent local Chrome, Edge, or Chromium session, shows it inside VS Code, and gives the agent structured controls instead of asking it to guess from screenshots.

## Highlights

- Real, visible browser session inside VS Code.
- Local HTTP bridge for existing agent CLIs.
- Structured element snapshots with stable references.
- Persistent browser profile for cookies, preferences, and signed-in sessions.
- Stable system browser preferred over a downloaded testing browser.
- Browser-native navigation and input through Chrome DevTools Protocol.
- Working first-run demo with open, snapshot, type, click, and read-result.
- Local-first workflow with no hosted browser service.

## First Run

Run `SoloBrowser: Open Browser` from the Command Palette and enter a URL. To try the local walkthrough first, run `SoloBrowser: Run Demo`.

SoloBrowser opens the browser panel, fills the demo sign-in form, clicks Sign in, and reports the visible result through the local bridge.

## Current Scope

External pages run in a managed, headed browser—not an iframe or a headless page. SoloBrowser keeps one local profile, uses the browser's own network stack and identity, and mirrors the visible tab into VS Code. It does not rewrite the User-Agent or inject a synthetic browser fingerprint.

## Safety Boundary

SoloBrowser is for user-authorized browser actions in the user's visible local workspace. A real browser identity improves compatibility, but no extension can guarantee that every site will accept an automated session. SoloBrowser does not bypass CAPTCHA, anti-fraud checks, access controls, or site policy.
