const http = require('http');
const { execFile } = require('child_process');
const vscode = require('vscode');
const WebSocket = require('ws');

const DEFAULT_PORT = 17333;
const NATIVE_SESSION = 'bmcp-native';
const pending = new Map();

let panel;
let server;
let nativeSocket;
let currentState = {
  mode: 'demo',
  url: 'bmcp:demo'
};

function activate(context) {
  context.subscriptions.push(
    vscode.commands.registerCommand('bmcp.openBrowser', async () => {
      const url = await vscode.window.showInputBox({
        title: 'Open in BMCP',
        prompt: 'Enter a URL, or leave empty for the local demo page',
        value: 'bmcp:demo'
      });
      await openBrowser(url || 'bmcp:demo');
    }),
    vscode.commands.registerCommand('bmcp.runDemo', async () => {
      await runDemo();
    })
  );

  startServer(context);
}

function deactivate() {
  if (server) {
    server.close();
    server = undefined;
  }
  closeNativeStream();
}

function startServer(context) {
  const port = Number(process.env.BMCP_PORT) || vscode.workspace.getConfiguration('bmcp').get('port', DEFAULT_PORT);

  server = http.createServer(async (req, res) => {
    try {
      if (req.method === 'GET' && req.url === '/health') {
        return sendJson(res, 200, {
          ok: true,
          name: 'BMCP',
          port,
          panelVisible: Boolean(panel),
          current: currentState
        });
      }

      if (req.method !== 'POST') {
        return sendJson(res, 405, { ok: false, error: 'Use POST for browser actions.' });
      }

      const body = await readJson(req);
      if (req.url === '/open') {
        const result = await openBrowser(body.url || 'bmcp:demo');
        return sendJson(res, 200, { ok: true, result });
      }
      if (req.url === '/snapshot') {
        return sendJson(res, 200, { ok: true, snapshot: await browserAction('snapshot') });
      }
      if (req.url === '/click') {
        return sendJson(res, 200, { ok: true, result: await browserAction('click', { ref: body.ref }) });
      }
      if (req.url === '/type') {
        return sendJson(res, 200, {
          ok: true,
          result: await browserAction('type', { ref: body.ref, text: body.text || '' })
        });
      }
      if (req.url === '/read') {
        return sendJson(res, 200, { ok: true, result: await browserAction('read') });
      }
      if (req.url === '/demo') {
        return sendJson(res, 200, { ok: true, result: await runDemo() });
      }

      return sendJson(res, 404, { ok: false, error: `Unknown endpoint: ${req.url}` });
    } catch (error) {
      return sendJson(res, 500, { ok: false, error: error.message });
    }
  });

  server.listen(port, '127.0.0.1', () => {
    console.log(`BMCP listening on http://127.0.0.1:${port}`);
  });

  server.on('error', (error) => {
    vscode.window.showErrorMessage(`BMCP could not start local port ${port}: ${error.message}`);
  });

  context.subscriptions.push({ dispose: () => server?.close() });
}

async function openBrowser(url) {
  currentState = normalizeTarget(url);
  if (currentState.mode === 'native') {
    await runAgentBrowser(['open', currentState.url], 30000);
    currentState.streamUrl = await ensureNativeStream();
  }
  ensurePanel();
  panel.reveal(vscode.ViewColumn.Beside);
  panel.webview.html = getHtml(currentState);
  if (currentState.mode === 'native') {
    startNativeStreamRelay(currentState.streamUrl);
  }
  return currentState;
}

function ensurePanel() {
  if (panel) return panel;

  panel = vscode.window.createWebviewPanel('bmcpBrowser', 'BMCP Browser', vscode.ViewColumn.Beside, {
    enableScripts: true,
    retainContextWhenHidden: true
  });

  panel.webview.onDidReceiveMessage((message) => {
    if (message?.type === 'nativeInput') {
      sendNativeInput(message.input);
      return;
    }
    if (!message || !message.id) return;
    const entry = pending.get(message.id);
    if (!entry) return;
    pending.delete(message.id);
    if (message.ok) {
      entry.resolve(message.result);
    } else {
      entry.reject(new Error(message.error || 'BMCP webview action failed.'));
    }
  });

  panel.onDidDispose(() => {
    panel = undefined;
    closeNativeStream();
    for (const entry of pending.values()) {
      entry.reject(new Error('BMCP browser panel was closed.'));
    }
    pending.clear();
  });

  return panel;
}

function startNativeStreamRelay(streamUrl) {
  closeNativeStream();
  if (!streamUrl || !panel) return;

  nativeSocket = new WebSocket(streamUrl);
  nativeSocket.on('open', () => {
    panel?.webview.postMessage({ type: 'nativeStatus', text: '已连接', connected: true });
  });
  nativeSocket.on('message', (data) => {
    let message;
    try {
      message = JSON.parse(String(data));
    } catch (_) {
      return;
    }
    if (message.type === 'frame' && message.data) {
      panel?.webview.postMessage({
        type: 'nativeFrame',
        data: message.data,
        metadata: message.metadata || {}
      });
    }
  });
  nativeSocket.on('close', () => {
    panel?.webview.postMessage({ type: 'nativeStatus', text: '已断开', connected: false });
  });
  nativeSocket.on('error', (error) => {
    panel?.webview.postMessage({ type: 'nativeStatus', text: error.message || '连接异常', connected: false });
  });
}

function sendNativeInput(input) {
  if (!nativeSocket || nativeSocket.readyState !== WebSocket.OPEN || !input) return;
  nativeSocket.send(JSON.stringify(input));
}

function closeNativeStream() {
  if (!nativeSocket) return;
  nativeSocket.close();
  nativeSocket = undefined;
}

function requestWebview(action, payload = {}) {
  ensurePanel();
  if (!panel.webview.html) {
    panel.webview.html = getHtml(currentState);
  }

  return new Promise((resolve, reject) => {
    const id = `${Date.now()}-${Math.random().toString(16).slice(2)}`;
    pending.set(id, { resolve, reject });
    panel.webview.postMessage({ id, action, payload });

    setTimeout(() => {
      if (!pending.has(id)) return;
      pending.delete(id);
      reject(new Error(`Timed out waiting for BMCP action: ${action}`));
    }, 5000);
  });
}

async function browserAction(action, payload = {}) {
  if (currentState.mode !== 'native') {
    return requestWebview(action, payload);
  }

  if (action === 'snapshot') {
    const raw = await runAgentBrowser(['snapshot', '-i'], 30000);
    return parseAgentBrowserSnapshot(raw);
  }
  if (action === 'read') {
    const raw = await runAgentBrowser(['snapshot', '-i'], 30000);
    return { text: raw };
  }
  if (action === 'click') {
    const ref = normalizeAgentBrowserRef(payload.ref);
    const raw = await runAgentBrowser(['click', ref], 30000);
    return { clicked: ref, raw };
  }
  if (action === 'type') {
    const ref = normalizeAgentBrowserRef(payload.ref);
    const raw = await runAgentBrowser(['fill', ref, payload.text || ''], 30000);
    return { typed: ref, text: payload.text || '', raw };
  }

  throw new Error(`Unsupported native browser action: ${action}`);
}

function runAgentBrowser(args, timeout = 15000) {
  return new Promise((resolve, reject) => {
    execFile('agent-browser', ['--session-name', NATIVE_SESSION, ...args], { timeout }, (error, stdout, stderr) => {
      if (error) {
        const detail = [stderr, stdout].filter(Boolean).join('\n').trim();
        reject(new Error(detail || error.message));
        return;
      }
      resolve(stdout.trim());
    });
  });
}

async function ensureNativeStream() {
  let output = '';
  try {
    output = await runAgentBrowser(['stream', 'status'], 10000);
  } catch (_) {
    output = await runAgentBrowser(['stream', 'enable'], 10000);
  }

  let streamUrl = extractStreamUrl(output);
  if (!streamUrl) {
    output = await runAgentBrowser(['stream', 'enable'], 10000);
    streamUrl = extractStreamUrl(output);
  }
  if (!streamUrl) {
    output = await runAgentBrowser(['stream', 'status'], 10000);
    streamUrl = extractStreamUrl(output);
  }
  if (!streamUrl) {
    throw new Error(`BMCP could not find the native browser stream URL. Output: ${output}`);
  }
  return streamUrl;
}

function extractStreamUrl(output) {
  const match = String(output || '').match(/ws:\/\/(?:127\.0\.0\.1|localhost):\d+/);
  return match ? match[0] : '';
}

function normalizeAgentBrowserRef(ref) {
  if (!ref) throw new Error('Missing element ref.');
  const value = String(ref);
  return value.startsWith('@') ? value : `@${value.replace(/^e/, 'e')}`;
}

function parseAgentBrowserSnapshot(raw) {
  const elements = raw
    .split('\n')
    .map((line) => line.trim())
    .filter((line) => line.includes('[ref=e'))
    .map((line) => {
      const refMatch = line.match(/ref=(e\d+)/);
      const roleMatch = line.match(/^-+\s*([a-zA-Z]+)\s+/);
      const labelMatch = line.match(/"([^"]+)"/);
      return {
        ref: refMatch ? refMatch[1] : '',
        role: roleMatch ? roleMatch[1] : '',
        label: labelMatch ? labelMatch[1] : '',
        raw: line
      };
    })
    .filter((item) => item.ref);

  return {
    title: '',
    url: currentState.url,
    text: raw,
    raw,
    elements
  };
}

async function runDemo() {
  await openBrowser('bmcp:demo');
  let snapshot = await requestWebview('snapshot');
  const username = findRef(snapshot, 'Username');
  const password = findRef(snapshot, 'Password');
  const login = findRef(snapshot, 'Sign in');

  await requestWebview('type', { ref: username, text: 'standard_user' });
  await requestWebview('type', { ref: password, text: 'secret_sauce' });
  await requestWebview('click', { ref: login });

  snapshot = await requestWebview('snapshot');
  return {
    completed: snapshot.text.includes('Inventory'),
    visibleText: snapshot.text,
    snapshot
  };
}

function findRef(snapshot, label) {
  const match = snapshot.elements.find((element) => element.label === label);
  if (!match) {
    throw new Error(`Could not find element labeled "${label}".`);
  }
  return match.ref;
}

function normalizeTarget(url) {
  if (!url || url === 'bmcp:demo') {
    return { mode: 'demo', url: 'bmcp:demo' };
  }
  return { mode: 'native', url };
}

function getHtml(state) {
  if (state.mode === 'native') {
    return getNativeHtml(state);
  }
  return getDemoHtml();
}

function getNativeHtml(state) {
  const safeUrl = escapeHtml(state.url);
  return `<!doctype html>
<html>
<head>
  <meta charset="UTF-8">
  <meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'unsafe-inline'; script-src 'unsafe-inline'; img-src data:;">
  <style>
    * { box-sizing: border-box; }
    html, body { height: 100%; margin: 0; font-family: -apple-system, BlinkMacSystemFont, Segoe UI, sans-serif; background: #111318; color: #f6f7fb; }
    body { overflow: hidden; }
    .shell { height: 100vh; display: grid; grid-template-rows: 40px 1fr; }
    header { display: grid; grid-template-columns: 1fr auto; align-items: center; gap: 12px; padding: 0 12px; background: #191d24; border-bottom: 1px solid #2a303a; }
    .address { min-width: 0; height: 26px; display: flex; align-items: center; padding: 0 9px; border: 1px solid #343b47; border-radius: 6px; background: #101318; color: #d7deea; font-size: 12px; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
    .status { display: inline-flex; align-items: center; gap: 6px; color: #aab4c4; font-size: 12px; }
    .dot { width: 7px; height: 7px; border-radius: 99px; background: #f5c451; }
    .status.connected .dot { background: #33d17a; }
    .viewport { min-height: 0; display: grid; place-items: center; background: #050608; outline: none; }
    img { max-width: 100%; max-height: 100%; width: 100%; height: 100%; object-fit: contain; user-select: none; -webkit-user-drag: none; cursor: default; }
    .empty { position: absolute; inset: 40px 0 0; display: grid; place-items: center; color: #aab4c4; font-size: 13px; pointer-events: none; }
    .empty.hidden { display: none; }
  </style>
</head>
<body>
  <div class="shell">
    <header>
      <div class="address" title="${safeUrl}">${safeUrl}</div>
      <div id="status" class="status"><span class="dot"></span><span id="status-text">连接中</span></div>
    </header>
    <main id="viewport" class="viewport" tabindex="0" aria-label="Browser viewport">
      <img id="frame" alt="" />
      <div id="empty" class="empty">正在打开网页</div>
    </main>
  </div>
  <script>
    const vscode = acquireVsCodeApi();
    const frame = document.getElementById('frame');
    const viewport = document.getElementById('viewport');
    const status = document.getElementById('status');
    const statusText = document.getElementById('status-text');
    const empty = document.getElementById('empty');
    let metadata = { deviceWidth: 1280, deviceHeight: 720 };
    let lastMove = 0;

    function setStatus(text, connected) {
      statusText.textContent = text;
      status.classList.toggle('connected', Boolean(connected));
    }

    function send(message) {
      vscode.postMessage({ type: 'nativeInput', input: message });
    }

    window.addEventListener('message', (event) => {
      const message = event.data || {};
      if (message.type === 'nativeStatus') {
        setStatus(message.text || '连接中', message.connected);
      }
      if (message.type === 'nativeFrame' && message.data) {
        metadata = message.metadata || metadata;
        frame.src = 'data:image/jpeg;base64,' + message.data;
        empty.classList.add('hidden');
      }
    });

    function toBrowserPoint(event) {
      const rect = frame.getBoundingClientRect();
      const naturalWidth = metadata.deviceWidth || frame.naturalWidth || rect.width;
      const naturalHeight = metadata.deviceHeight || frame.naturalHeight || rect.height;
      return {
        x: Math.max(0, Math.round((event.clientX - rect.left) * naturalWidth / rect.width)),
        y: Math.max(0, Math.round((event.clientY - rect.top) * naturalHeight / rect.height))
      };
    }

    function mouseButton(event) {
      if (event.button === 1) return 'middle';
      if (event.button === 2) return 'right';
      return 'left';
    }

    viewport.addEventListener('pointerdown', (event) => {
      viewport.focus();
      event.preventDefault();
      const point = toBrowserPoint(event);
      send({ type: 'input_mouse', eventType: 'mousePressed', x: point.x, y: point.y, button: mouseButton(event), clickCount: event.detail || 1 });
    });
    viewport.addEventListener('pointerup', (event) => {
      event.preventDefault();
      const point = toBrowserPoint(event);
      send({ type: 'input_mouse', eventType: 'mouseReleased', x: point.x, y: point.y, button: mouseButton(event), clickCount: event.detail || 1 });
    });
    viewport.addEventListener('pointermove', (event) => {
      const now = Date.now();
      if (now - lastMove < 40) return;
      lastMove = now;
      const point = toBrowserPoint(event);
      send({ type: 'input_mouse', eventType: 'mouseMoved', x: point.x, y: point.y, button: 'none', clickCount: 0 });
    });
    viewport.addEventListener('wheel', (event) => {
      event.preventDefault();
      const point = toBrowserPoint(event);
      send({ type: 'input_mouse', eventType: 'mouseWheel', x: point.x, y: point.y, button: 'none', clickCount: 0, deltaX: event.deltaX, deltaY: event.deltaY });
    }, { passive: false });
    viewport.addEventListener('keydown', (event) => {
      event.preventDefault();
      const payload = { type: 'input_keyboard', eventType: 'keyDown', key: event.key, code: event.code };
      if (event.key && event.key.length === 1) {
        payload.text = event.key;
        payload.unmodifiedText = event.key;
      }
      send(payload);
    });
    viewport.addEventListener('keyup', (event) => {
      event.preventDefault();
      send({ type: 'input_keyboard', eventType: 'keyUp', key: event.key, code: event.code });
    });
    setStatus('连接中', false);
  </script>
</body>
</html>`;
}

function getDemoHtml() {
  return `<!doctype html>
<html>
<head>
  <meta charset="UTF-8">
  <meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'unsafe-inline'; script-src 'unsafe-inline'; img-src data:;">
  <style>
    :root { color-scheme: light; }
    * { box-sizing: border-box; }
    body { margin: 0; font-family: -apple-system, BlinkMacSystemFont, Segoe UI, sans-serif; background: #f5f7fb; color: #18202f; }
    .shell { min-height: 100vh; display: grid; grid-template-rows: 54px 1fr; }
    header { display: flex; align-items: center; justify-content: space-between; padding: 0 18px; background: #172033; color: white; }
    header strong { font-size: 16px; }
    header span { color: #b9c4d8; font-size: 13px; }
    main { display: grid; place-items: center; padding: 28px; }
    .login, .inventory { width: min(460px, 100%); background: white; border: 1px solid #d9deea; border-radius: 8px; padding: 24px; box-shadow: 0 10px 30px rgba(23, 32, 51, 0.08); }
    h1 { margin: 0 0 18px; font-size: 24px; }
    label { display: grid; gap: 7px; margin: 12px 0; font-weight: 600; }
    input { height: 40px; border: 1px solid #c9d1df; border-radius: 6px; padding: 0 10px; font: inherit; }
    button { height: 40px; border: 0; border-radius: 6px; padding: 0 14px; background: #2457d6; color: white; font-weight: 700; cursor: pointer; }
    .grid { display: grid; gap: 10px; margin-top: 14px; }
    .item { display: flex; justify-content: space-between; gap: 12px; padding: 12px; border: 1px solid #dce2ee; border-radius: 6px; }
    .hidden { display: none; }
  </style>
</head>
<body>
  <div class="shell">
    <header><strong>BMCP Browser</strong><span>Local demo page</span></header>
    <main>
      <section id="login" class="login">
        <h1>Sign in</h1>
        <label for="username">Username</label>
        <input id="username" name="username" autocomplete="username" />
        <label for="password">Password</label>
        <input id="password" name="password" type="password" autocomplete="current-password" />
        <button id="login-button">Sign in</button>
      </section>
      <section id="inventory" class="inventory hidden">
        <h1>Inventory</h1>
        <div class="grid">
          <div class="item"><strong>Trail Backpack</strong><span>$29</span></div>
          <div class="item"><strong>Everyday Jacket</strong><span>$49</span></div>
          <div class="item"><strong>Desk Light</strong><span>$18</span></div>
        </div>
      </section>
    </main>
  </div>
  <script>${pageModelRuntime()}</script>
  <script>${webviewRuntime()}</script>
  <script>
    document.getElementById('login-button').addEventListener('click', () => {
      document.getElementById('login').classList.add('hidden');
      document.getElementById('inventory').classList.remove('hidden');
      document.title = 'Inventory';
    });
    document.title = 'Sign in';
  </script>
</body>
</html>`;
}

function pageModelRuntime() {
  return `
${collectSnapshotSource()}
`;
}

function collectSnapshotSource() {
  return `
function collectSnapshot(root = document) {
  const selectors = ['a[href]', 'button', 'input', 'textarea', 'select', '[role="button"]', '[tabindex]:not([tabindex="-1"])'];
  const elements = Array.from(root.querySelectorAll(selectors.join(','))).filter((element) => !element.disabled && isVisible(element));
  return { title: root.title || '', url: root.location ? String(root.location.href) : '', text: getVisibleText(root.body || root), elements: elements.map((element, index) => describeElement(element, index + 1)) };
}
function describeElement(element, index) {
  const tag = element.tagName.toLowerCase();
  const role = element.getAttribute('role') || inferRole(element);
  const label = getLabel(element);
  const value = 'value' in element ? element.value : undefined;
  const rect = element.getBoundingClientRect ? element.getBoundingClientRect() : null;
  return { ref: 'e' + index, tag, role, label, value, selector: getSelector(element), bounds: rect ? { x: Math.round(rect.x), y: Math.round(rect.y), width: Math.round(rect.width), height: Math.round(rect.height) } : null };
}
function isVisible(element) {
  const style = element.ownerDocument.defaultView.getComputedStyle(element);
  if (style.display === 'none' || style.visibility === 'hidden' || style.opacity === '0') return false;
  const rect = element.getBoundingClientRect();
  return rect.width > 0 && rect.height > 0;
}
function getVisibleText(element) {
  const text = element.innerText || element.textContent || '';
  return text.replace(/\\s+/g, ' ').trim();
}
function inferRole(element) {
  const tag = element.tagName.toLowerCase();
  const type = (element.getAttribute('type') || '').toLowerCase();
  if (tag === 'button') return 'button';
  if (tag === 'a') return 'link';
  if (tag === 'select') return 'combobox';
  if (tag === 'textarea') return 'textbox';
  if (tag === 'input' && ['button', 'submit', 'reset'].includes(type)) return 'button';
  if (tag === 'input') return 'textbox';
  return tag;
}
function getLabel(element) {
  const aria = element.getAttribute('aria-label');
  if (aria) return aria.trim();
  const labelledBy = element.getAttribute('aria-labelledby');
  if (labelledBy) {
    const text = labelledBy.split(/\\s+/).map((id) => element.ownerDocument.getElementById(id)?.textContent || '').join(' ').replace(/\\s+/g, ' ').trim();
    if (text) return text;
  }
  if (element.id) {
    const label = element.ownerDocument.querySelector('label[for="' + cssEscape(element.id) + '"]');
    if (label?.textContent) return label.textContent.replace(/\\s+/g, ' ').trim();
  }
  const text = element.innerText || element.textContent || element.getAttribute('placeholder') || '';
  return text.replace(/\\s+/g, ' ').trim();
}
function getSelector(element) {
  if (element.id) return '#' + cssEscape(element.id);
  const dataTest = element.getAttribute('data-testid') || element.getAttribute('data-test');
  if (dataTest) return '[data-testid="' + cssEscape(dataTest) + '"]';
  const name = element.getAttribute('name');
  if (name) return element.tagName.toLowerCase() + '[name="' + cssEscape(name) + '"]';
  return element.tagName.toLowerCase();
}
function cssEscape(value) {
  return String(value).replace(/["\\\\#.:,[\\]>+~*^$|= ]/g, '\\\\$&');
}`;
}

function webviewRuntime() {
  return `
const vscode = acquireVsCodeApi();
window.addEventListener('message', async (event) => {
  const { id, action, payload } = event.data || {};
  if (!id) return;
  try {
    const result = await handleBmcpAction(action, payload || {});
    vscode.postMessage({ id, ok: true, result });
  } catch (error) {
    vscode.postMessage({ id, ok: false, error: error.message });
  }
});

async function handleBmcpAction(action, payload) {
  if (action === 'snapshot') return collectSnapshot(document);
  if (action === 'read') return { text: collectSnapshot(document).text };
  if (action === 'click') {
    const element = findByRef(payload.ref);
    element.click();
    return { clicked: payload.ref, label: getLabel(element) };
  }
  if (action === 'type') {
    const element = findByRef(payload.ref);
    element.focus();
    element.value = payload.text;
    element.dispatchEvent(new InputEvent('input', { bubbles: true, inputType: 'insertText', data: payload.text }));
    element.dispatchEvent(new Event('change', { bubbles: true }));
    return { typed: payload.ref, label: getLabel(element), text: payload.text };
  }
  throw new Error('Unsupported action: ' + action);
}

function findByRef(ref) {
  const snapshot = collectSnapshot(document);
  const item = snapshot.elements.find((element) => element.ref === ref);
  if (!item) throw new Error('Unknown element ref: ' + ref);
  const element = document.querySelector(item.selector);
  if (!element) throw new Error('Element is no longer available: ' + ref);
  return element;
}`;
}

function readJson(req) {
  return new Promise((resolve, reject) => {
    let data = '';
    req.on('data', (chunk) => {
      data += chunk;
    });
    req.on('end', () => {
      if (!data) return resolve({});
      try {
        resolve(JSON.parse(data));
      } catch (error) {
        reject(new Error(`Invalid JSON body: ${error.message}`));
      }
    });
    req.on('error', reject);
  });
}

function sendJson(res, status, body) {
  res.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'access-control-allow-origin': 'http://127.0.0.1',
    'cache-control': 'no-store'
  });
  res.end(JSON.stringify(body));
}

function escapeHtml(value) {
  return String(value)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

module.exports = {
  activate,
  deactivate
};
