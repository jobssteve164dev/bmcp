# Control SoloBrowser from an agent

Open SoloBrowser in the IDE. Its browser stays visible while the agent reads and operates the selected page. Page controls use the same browser session regardless of whether the image arrives over WebRTC or the fallback stream.

## Connect an MCP client

Run **SoloBrowser: Copy MCP Configuration** in the command palette and paste the result into your client's MCP settings. Node.js must be available on the IDE host. For remote IDEs, run this MCP process on that host as well.

For a source checkout, the server can also be started with `node scripts/mcp.js`. It uses newline-delimited JSON-RPC over stdio, negotiating MCP 2025-11-25 or an older supported version. See the [MCP lifecycle specification](https://modelcontextprotocol.io/specification/2025-11-25/basic/lifecycle).

`SOLOBROWSER_REGISTRY` optionally points to the extension's `globalStorage/instances` directory. `SOLOBROWSER_WORKSPACE` selects a workspace; otherwise the MCP process uses its working directory. The copied configuration sets both automatically.

The copied command uses a stable launcher in extension storage. Activating a newer plugin updates that launcher, so the client's configured path does not depend on the extension version.

The client discovers live windows and checks their instance identity. It chooses a matching workspace and, when necessary, the only visible window. If several windows match, use `browser_instances` followed by `browser_select_instance`. The selection stays fixed until explicitly changed; a disconnected instance produces an error instead of silently switching windows.

## Tools and HTTP routes

| MCP tool | HTTP route | Arguments |
| --- | --- | --- |
| `browser_instances` | Local registry discovery | None |
| `browser_select_instance` | MCP client selection | `instanceId` |
| `browser_open` | `POST /open` | `url` |
| `browser_snapshot` | `POST /snapshot` | None |
| `browser_read` | `POST /read` | None |
| `browser_click` | `POST /click` | `ref` or `selector` |
| `browser_type` | `POST /type` or `/fill` | `ref` or `selector`, `text` |
| `browser_press` | `POST /press` | `key`, optionally `ref` or `selector` |
| `browser_scroll` | `POST /scroll` | `deltaX`, `deltaY`, optionally `ref` or `selector` |
| `browser_wait` | `POST /wait` | `selector` + optional `state`, `url`, `text`, `readyState`, `timeoutMs` |
| `browser_screenshot` | `POST /screenshot` | Optional `fullPage` |
| `browser_tabs` | `POST /tabs` | Optional `action: list`; or `action: select`, `tabId` |
| `browser_navigate` | `POST /navigate` | `action: back`, `forward`, or `reload` |
| `browser_upload` | `POST /upload` | File-input `ref` or `selector`, `files` |

`GET /health` returns the live instance ID, workspace paths, version, visibility and current page. `GET /capabilities` returns tool schemas. The default HTTP port is 17333; an occupied port causes automatic selection of another port. Use discovery instead of assuming the default port. MCP automatically sends `x-solobrowser-instance` on HTTP actions to reject stale port reuse.

HTTP bodies and responses are JSON. Success has `ok: true` and `result` (`snapshot` for `/snapshot`); failures have `ok: false` and `error`. MCP operation failures return `isError: true`; screenshots return an MCP image block. `/demo` remains available for the built-in demo.

## Operation semantics

- `type` and `fill` replace the entire field, including clearing it when `text` is empty. They do not echo entered text back in the response.
- `read` returns title, URL and body text. `snapshot` additionally returns visible elements and references. Password values are omitted.
- References belong to the most recent snapshot of a document. After navigation, take a new snapshot. Replacing a DOM element invalidates its old reference rather than retargeting another element.
- `wait` checks all supplied conditions. Its default timeout is 15 seconds and can be explicitly increased. Selector states are `visible`, `hidden`, `attached` and `detached`; URL and text matching use substrings. Pair navigation-triggering actions with a subsequent URL or element wait.
- `tabs` selects an existing browser tab and updates the editor's displayed page. It does not open a second browser profile.
- Upload paths refer to files on the IDE host, not the viewer's laptop. Upload selects files; submitting the website's form remains a separate action.
- HTTP control calls are serialized within an instance. Human interaction can still change the page; the agent should take a fresh snapshot when the page changes.

The server binds to loopback. Website-origin requests to control routes are rejected. This is a local-agent interface; do not publish its port as an unauthenticated public endpoint.

## Verification

`npm run verify` checks syntax, unit/contract tests, MCP stdio initialization and packaging. `npm run test:browser` runs real Chromium controls against a local fixture. Set `BROWSER_PATH` if Chromium is not installed at `/usr/bin/chromium`. The fixture does not submit anything to external websites.

For an opt-in full acceptance run, set `SOLOBROWSER_IDE_CDP` to the CDP port of a dedicated IDE test window , `SOLOBROWSER_BROWSER_CDP` to the plugin browser CDP port, and `SOLOBROWSER_WORKSPACE` to its workspace, then run `node test/ide-live.test.js`. It exercises the real MCP → HTTP → plugin chain with a local fixture, including a forced capture failure and visible fallback frames. It restores the X login page and closes the tab it created.
