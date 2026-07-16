# SoloBrowser Product Brief

## 1. Product Boundary

SoloBrowser is a real, visible VS Code browser for local agent CLIs.

It does not try to become a new agent CLI. The first product boundary is to let existing local agent CLIs, such as Claude Code, Codex, Cursor Agent, Gemini CLI, and other MCP-capable or HTTP-capable tools, open and operate a visible browser inside VS Code.

The core promise is simple: when an agent needs to use a website, the user sees the real browser and every action while staying inside the same editor workflow.

## 2. Current Market Signals

Similar projects already exist, and BMCP should learn from them instead of pretending the category is empty.

- BrowserMCP combines an MCP server with a Chrome extension so AI applications can automate a user's local browser. Worth learning: local execution, existing logged-in browser profile, privacy-by-default positioning, and real browser profile instead of a newly spawned automation profile. Source: https://github.com/BrowserMCP/mcp
- AlienMcp connects MCP clients to real Chrome tabs. Worth learning: tab-group scoping, explicit user control over which tabs are shared with the agent, localhost-only communication, and CDP-backed click/type/hover rather than fragile JavaScript-only events. Source: https://www.alien-mcp.com/
- Integrated Browser MCP is a VS Code extension that exposes VS Code's integrated browser through HTTP and MCP. Worth learning: VS Code-native browser surface, lazy browser launch, local HTTP API, MCP bridge, workspace-to-window routing, and browser status diagnostics. Source: https://marketplace.visualstudio.com/items?itemName=thimo.integrated-browser-mcp
- Microsoft Playwright MCP popularized structured accessibility snapshots for agents. Worth learning: give the agent a precise page operation model instead of relying on screenshots or vision-only interpretation. Source: https://github.com/microsoft/playwright-mcp
- ManulMcpServer exposes deterministic browser automation in VS Code and emphasizes replayable scripts and element scanning. Worth learning: explainable actions, readable execution steps, persistent browser sessions, and inspect/retry after a failed action. Source: https://marketplace.visualstudio.com/items?itemName=manul-engine.manul-mcp-server

BMCP's initial differentiation should be narrower than a full browser automation suite: it should be the VS Code-local, visible-browser scaffold that big local agent CLIs can plug into without asking users to adopt a new agent.

## 3. Target Users

Primary users are developers and operators who already work in VS Code and already use local agent CLIs.

They want the agent to handle website tasks while they keep visual control:

- testing a local web app in VS Code;
- logging into a SaaS product with the user's existing session;
- filling forms and checking results;
- navigating admin pages, docs, dashboards, or issue trackers;
- extracting visible state from a page after an operation.

They do not want another chat product, another autonomous agent, or a hidden remote browser. They want their current agent CLI to gain a trustworthy browser hand.

## 4. Core Browser Actions In VS Code

The first useful workflow should support these actions from an agent CLI running in the VS Code workspace:

- open a visible browser view inside VS Code;
- navigate to a URL;
- show the current page to the user while the agent acts;
- return a structured page snapshot with stable element references;
- click a referenced element;
- type into a referenced input;
- wait for page state to change;
- read visible text and key page state;
- report the final result back to the agent CLI.

Screenshots are allowed as evidence for the human, but they are not the agent's primary operation model. The agent should operate through browser-native page structure: accessibility tree, DOM metadata, CDP target state, element bounds, roles, labels, and stable element references.

## 5. Visible Browser Requirement

BMCP must have a clear browser interface that users can see in VS Code.

This is not a traditional headless browser MCP and not a screenshot-only skill. The user should be able to watch the page open, see clicks and typing happen, interrupt if needed, and understand which website is currently under agent control.

The first version can be minimal, but it must make the browser visible as part of the product experience, not as a debugging afterthought.

## 6. Website Interaction Trust Boundary

BMCP should use the user's local, visible browser surface and browser-native interaction channels so websites receive normal browser-originated actions rather than synthetic page-script shortcuts.

The target experience is:

- no headless-only browser as the default path;
- no screenshot-only coordinate clicking as the main path;
- no remote browser farm;
- no separate fake agent browser identity;
- browser events should come from the real browser control path where possible;
- the user remains responsible for sites, sessions, and actions they authorize.

BMCP should not be positioned as a CAPTCHA bypass, anti-fraud bypass, scraping evasion, or security-control circumvention tool. The product requirement is to avoid unnecessary automation fingerprints caused by bad architecture, not to help users defeat a website's protective controls.

## 7. First Demo Scenario

The first demo should use a deliberately safe website that proves the product loop without needing real credentials.

Recommended first scenario:

1. The user opens VS Code in the BMCP workspace.
2. The user starts their existing local agent CLI in the VS Code terminal.
3. The agent asks BMCP to open a visible browser in VS Code.
4. BMCP navigates to `https://www.saucedemo.com/`.
5. The agent receives a structured page snapshot, not just a screenshot.
6. The agent fills username `standard_user` and password `secret_sauce`.
7. The agent clicks Login.
8. The visible browser shows the inventory page.
9. The agent reads the page state and reports that the product list is visible.

SauceDemo is useful because it is a known browser automation demo site with stable form fields and no real user data. If a local-only demo is preferred later, the same scenario can be moved to a checked-in static fixture page.

## 8. Non-Goals

BMCP should not do these in the first product slice:

- build a new general-purpose agent CLI;
- replace Claude Code, Codex, Cursor Agent, Gemini CLI, Copilot, or other local agents;
- become a broad hosted browser automation platform;
- run hidden remote browser sessions;
- offer scraping-at-scale, proxy rotation, fingerprint spoofing, CAPTCHA solving, or anti-bot bypass tooling;
- rely on screenshots as the primary way the agent understands page controls;
- require the user to learn a new browser automation DSL before the first demo works;
- optimize for CI headless testing before the visible VS Code workflow is proven.

## 9. Success Standards

The first product slice is successful when all of the following are true:

- A local agent CLI can trigger a visible browser inside VS Code.
- The user can see the website while the agent operates it.
- The browser action loop supports navigate, snapshot, click, type, wait, and read-result.
- The agent receives structured element-level information sufficient to choose accurate actions without vision-only guessing.
- The demo scenario completes from VS Code terminal to visible browser to final agent result.
- The product does not require users to adopt a new agent CLI.
- The design keeps control local to the user's machine and workspace.
- The browser trust boundary is explicit: real visible browser path, no headless default, no evasion product positioning.

## 10. Minimum Acceptance Commands

For this brief itself:

```bash
test -f docs/product-brief.md
sed -n '1,240p' docs/product-brief.md
rg -n "Target Users|Core Browser Actions|Visible Browser|First Demo Scenario|Non-Goals|Success Standards|local agent CLI|VS Code|structured page snapshot|element references|not try to become a new agent CLI|CAPTCHA bypass|anti-bot bypass" docs/product-brief.md
```

For the first implementation slice later:

```bash
node --check src/cli.js
node src/cli.js browser open https://www.saucedemo.com/
node src/cli.js browser snapshot
node src/cli.js browser demo saucedemo
```

If the implementation has not created `src/cli.js` yet, only the brief validation command is required for this roadmap step.
