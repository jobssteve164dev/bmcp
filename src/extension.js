const http = require('http');
const https = require('https');
const url = require('url');
const { execFile } = require('child_process');
const vscode = require('vscode');
const WebSocket = require('ws');

const DEFAULT_PORT = 17333;
const NATIVE_SESSION = 'bmcp-native';
const pending = new Map();
let lastTargetHost = '';
let actualPort = DEFAULT_PORT;

let panel;
let server;
let nativeSocket;
let nativeResizeTimer;
let nativeViewport = { width: 1280, height: 720 };
let nativeInputQueue = Promise.resolve();
let currentState = {
  mode: 'demo',
  url: 'bmcp:demo'
};

function activate(context) {
  context.subscriptions.push(
    vscode.commands.registerCommand('bmcp.openBrowser', async () => {
      const urlInput = await vscode.window.showInputBox({
        title: 'Open in BMCP',
        prompt: 'Enter a URL, or leave empty for the local demo page',
        value: 'bmcp:demo'
      });
      await openBrowser(urlInput || 'bmcp:demo');
    }),
    vscode.commands.registerCommand('bmcp.runDemo', async () => {
      await runDemo();
    })
  );

  // 注册侧边栏 Webview View Provider
  const provider = new BmcpWebviewViewProvider(context.extensionUri);
  context.subscriptions.push(
    vscode.window.registerWebviewViewProvider(BmcpWebviewViewProvider.viewType, provider)
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
  const preferredPort = Number(process.env.BMCP_PORT) || vscode.workspace.getConfiguration('bmcp').get('port', DEFAULT_PORT);

  server = http.createServer(async (req, res) => {
    try {
      const reqUrl = url.parse(req.url, true);
      const pathname = reqUrl.pathname;

      if (pathname === '/health' && req.method === 'GET') {
        return sendJson(res, 200, {
          ok: true,
          name: 'BMCP',
          port: actualPort,
          panelVisible: Boolean(panel),
          current: currentState
        });
      }

      const localPostRoutes = ['/open', '/snapshot', '/click', '/type', '/read', '/demo'];
      if (localPostRoutes.includes(pathname)) {
        if (req.method !== 'POST') {
          return sendJson(res, 405, { ok: false, error: 'Use POST for local browser actions.' });
        }

        const body = await readJson(req);
        if (pathname === '/open') {
          const result = await openBrowser(body.url || 'bmcp:demo');
          return sendJson(res, 200, { ok: true, result });
        }
        if (pathname === '/snapshot') {
          return sendJson(res, 200, { ok: true, snapshot: await browserAction('snapshot') });
        }
        if (pathname === '/click') {
          return sendJson(res, 200, { ok: true, result: await browserAction('click', { ref: body.ref }) });
        }
        if (pathname === '/type') {
          return sendJson(res, 200, {
            ok: true,
            result: await browserAction('type', { ref: body.ref, text: body.text || '' })
          });
        }
        if (pathname === '/read') {
          return sendJson(res, 200, { ok: true, result: await browserAction('read') });
        }
        if (pathname === '/demo') {
          return sendJson(res, 200, { ok: true, result: await runDemo() });
        }
      }

      // 非本地 API 均走全流量代理，传入实际启动的 actualPort
      return handleProxyRequest(req, res, actualPort);
    } catch (error) {
      return sendJson(res, 500, { ok: false, error: error.message });
    }
  });

  let currentPort = preferredPort;
  function tryListen() {
    server.listen(currentPort, '127.0.0.1', () => {
      actualPort = currentPort;
      console.log(`BMCP listening on http://127.0.0.1:${actualPort}`);
    });
  }

  server.on('error', (error) => {
    if (error.code === 'EADDRINUSE') {
      console.log(`Port ${currentPort} in use, trying ${currentPort + 1}...`);
      currentPort++;
      tryListen();
    } else {
      vscode.window.showErrorMessage(`BMCP could not start local port ${currentPort}: ${error.message}`);
    }
  });

  tryListen();

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
    if (message?.type === 'nativeResize') {
      scheduleNativeViewport(message.width, message.height);
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
  if (!input) return;
  if (nativeSocket && nativeSocket.readyState === WebSocket.OPEN) {
    nativeSocket.send(JSON.stringify(input));
    return;
  }
  nativeInputQueue = nativeInputQueue.then(() => runNativeInput(input)).catch((error) => {
    panel?.webview.postMessage({ type: 'nativeStatus', text: error.message || '输入失败', connected: false });
  });
}

async function runNativeInput(input) {
  if (input.type === 'input_mouse') {
    const x = String(clampInteger(input.x, 0, 3000));
    const y = String(clampInteger(input.y, 0, 2200));
    const button = ['left', 'right', 'middle'].includes(input.button) ? input.button : 'left';
    if (input.eventType === 'mouseMoved') return;
    if (input.eventType === 'mousePressed') {
      await runAgentBrowser(['mouse', 'move', x, y], 5000);
      await runAgentBrowser(['mouse', 'down', button], 5000);
      return;
    }
    if (input.eventType === 'mouseReleased') {
      await runAgentBrowser(['mouse', 'move', x, y], 5000);
      await runAgentBrowser(['mouse', 'up', button], 5000);
      return;
    }
    if (input.eventType === 'mouseWheel') {
      await runAgentBrowser(['mouse', 'move', x, y], 5000);
      await runAgentBrowser(['mouse', 'wheel', String(Math.round(Number(input.deltaY) || 0)), String(Math.round(Number(input.deltaX) || 0))], 5000);
    }
    return;
  }

  if (input.type === 'input_keyboard') {
    if (input.eventType !== 'keyDown') return;
    if (input.key && input.key.length === 1) {
      await runAgentBrowser(['keyboard', 'type', input.key], 5000);
      return;
    }
    if (input.key) {
      await runAgentBrowser(['press', normalizeKey(input.key)], 5000);
    }
  }
}

function normalizeKey(key) {
  const aliases = {
    ' ': 'Space',
    ArrowLeft: 'ArrowLeft',
    ArrowRight: 'ArrowRight',
    ArrowUp: 'ArrowUp',
    ArrowDown: 'ArrowDown',
    Backspace: 'Backspace',
    Delete: 'Delete',
    Enter: 'Enter',
    Escape: 'Escape',
    Tab: 'Tab'
  };
  return aliases[key] || key;
}

function scheduleNativeViewport(width, height) {
  const next = {
    width: clampInteger(width, 320, 3000),
    height: clampInteger(height, 240, 2200)
  };
  if (!next.width || !next.height) return;
  if (next.width === nativeViewport.width && next.height === nativeViewport.height) return;
  nativeViewport = next;

  clearTimeout(nativeResizeTimer);
  nativeResizeTimer = setTimeout(async () => {
    try {
      await runAgentBrowser(['set', 'viewport', String(nativeViewport.width), String(nativeViewport.height)], 10000);
    } catch (error) {
      panel?.webview.postMessage({ type: 'nativeStatus', text: error.message || '尺寸同步失败', connected: false });
    }
  }, 180);
}

function clampInteger(value, min, max) {
  const number = Math.round(Number(value));
  if (!Number.isFinite(number)) return 0;
  return Math.max(min, Math.min(max, number));
}

function closeNativeStream() {
  clearTimeout(nativeResizeTimer);
  nativeResizeTimer = undefined;
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
    .viewport { position: relative; min-height: 0; background: #050608; outline: none; overflow: hidden; }
    img { position: absolute; inset: 0; width: 100%; height: 100%; object-fit: fill; user-select: none; -webkit-user-drag: none; cursor: default; }
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
    let resizeTimer;

    function setStatus(text, connected) {
      statusText.textContent = text;
      status.classList.toggle('connected', Boolean(connected));
    }

    function send(message) {
      vscode.postMessage({ type: 'nativeInput', input: message });
    }

    function sendViewportSize() {
      const rect = viewport.getBoundingClientRect();
      const width = Math.max(320, Math.round(rect.width));
      const height = Math.max(240, Math.round(rect.height));
      vscode.postMessage({ type: 'nativeResize', width, height });
    }

    function scheduleViewportSize() {
      clearTimeout(resizeTimer);
      resizeTimer = setTimeout(sendViewportSize, 80);
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
      const rect = viewport.getBoundingClientRect();
      const naturalWidth = metadata.deviceWidth || rect.width;
      const naturalHeight = metadata.deviceHeight || rect.height;
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
    new ResizeObserver(scheduleViewportSize).observe(viewport);
    window.addEventListener('resize', scheduleViewportSize);
    scheduleViewportSize();
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

function handleProxyRequest(req, res, port) {
  const reqUrl = url.parse(req.url, true);
  let targetUrlStr = '';

  if (reqUrl.pathname === '/proxy') {
    targetUrlStr = reqUrl.query.url;
  }

  // 尝试补全相对路径
  if (!targetUrlStr) {
    const referer = req.headers['referer'];
    if (referer) {
      const refUrl = url.parse(referer, true);
      if (refUrl.pathname === '/proxy' && refUrl.query.url) {
        const refTarget = url.parse(refUrl.query.url);
        targetUrlStr = refTarget.protocol + '//' + refTarget.host + req.url;
      } else if (lastTargetHost) {
        targetUrlStr = lastTargetHost + req.url;
      }
    } else if (lastTargetHost) {
      targetUrlStr = lastTargetHost + req.url;
    }
  }

  if (!targetUrlStr) {
    res.writeHead(400, { 'content-type': 'text/plain; charset=utf-8' });
    res.end('Missing target URL parameters.');
    return;
  }

  if (!/^https?:\/\//i.test(targetUrlStr)) {
    targetUrlStr = 'https://' + targetUrlStr;
  }

  const parsedTarget = url.parse(targetUrlStr);
  lastTargetHost = parsedTarget.protocol + '//' + parsedTarget.host;

  const headers = { ...req.headers };
  headers['host'] = parsedTarget.host;
  delete headers['origin'];
  delete headers['accept-encoding']; // 强制不使用压缩，便于修改网页内容并注入脚本

  const client = parsedTarget.protocol === 'https:' ? https : http;

  const proxyReq = client.request({
    protocol: parsedTarget.protocol,
    host: parsedTarget.hostname,
    port: parsedTarget.port,
    method: req.method,
    path: parsedTarget.path,
    headers: headers,
    rejectUnauthorized: false
  }, (proxyRes) => {
    let status = proxyRes.statusCode;
    const responseHeaders = { ...proxyRes.headers };

    // 处理重定向，使用相对于当前的相对路径，确保在 code-server / 端口隧道下保持路由
    if (status === 301 || status === 302 || status === 307 || status === 308) {
      let location = responseHeaders['location'];
      if (location) {
        if (!/^https?:\/\//i.test(location)) {
          location = url.resolve(targetUrlStr, location);
        }
        responseHeaders['location'] = './proxy?url=' + encodeURIComponent(location);
      }
    }

    // 剔除安全限制
    delete responseHeaders['x-frame-options'];
    delete responseHeaders['content-security-policy'];
    delete responseHeaders['content-security-policy-report-only'];

    // 允许跨域
    responseHeaders['access-control-allow-origin'] = '*';
    responseHeaders['access-control-allow-methods'] = '*';
    responseHeaders['access-control-allow-headers'] = '*';

    const contentType = responseHeaders['content-type'] || '';
    if (contentType.includes('text/html')) {
      let bodyChunks = [];
      proxyRes.on('data', (chunk) => {
        bodyChunks.push(chunk);
      });
      proxyRes.on('end', () => {
        let bodyBuffer = Buffer.concat(bodyChunks);
        let html = bodyBuffer.toString('utf8');

        // 1. 自动补全相对路径为绝对公网路径，消除静态资源加载跨域与 404
        const targetOrigin = parsedTarget.protocol + '//' + parsedTarget.host;
        html = html.replace(/(src|href|action)=["']\/(?!\/)/g, (match) => match.slice(0, -1) + targetOrigin + '/');

        // 2. 注入脚本劫持 API 与跳转，利用 window.location 动态自适应解析宿主代理地址，解决 code-server 多端口跨域
        const injectScript = `<script>
          (function() {
            const baseUrl = window.location.protocol + '//' + window.location.host + window.location.pathname.replace(/\\/proxy$/, '/');
            
            const originalFetch = window.fetch;
            window.fetch = function(input, init) {
              let url = typeof input === 'string' ? input : (input instanceof Request ? input.url : '');
              if (url && !url.startsWith('http://127.0.0.1') && !url.startsWith('http://localhost') && !url.startsWith(baseUrl)) {
                const proxiedUrl = baseUrl + 'proxy?url=' + encodeURIComponent(url);
                if (input instanceof Request) {
                  input = new Request(proxiedUrl, input);
                } else {
                  input = proxiedUrl;
                }
              }
              return originalFetch.call(this, input, init);
            };

            const originalOpen = XMLHttpRequest.prototype.open;
            XMLHttpRequest.prototype.open = function(method, url, ...args) {
              if (url && typeof url === 'string' && !url.startsWith('http://127.0.0.1') && !url.startsWith('http://localhost') && !url.startsWith(baseUrl)) {
                url = baseUrl + 'proxy?url=' + encodeURIComponent(url);
              }
              return originalOpen.call(this, method, url, ...args);
            };

            document.addEventListener('click', function(e) {
              const anchor = e.target.closest('a');
              if (anchor && anchor.href) {
                const href = anchor.href;
                if (href.startsWith('http') && !href.startsWith('http://127.0.0.1') && !href.startsWith('http://localhost') && !href.startsWith(baseUrl)) {
                  e.preventDefault();
                  window.location.href = baseUrl + 'proxy?url=' + encodeURIComponent(href);
                }
              }
            }, true);
          })();
        </script>`;

        if (html.includes('<head>')) {
          html = html.replace('<head>', '<head>' + injectScript);
        } else if (html.includes('<html>')) {
          html = html.replace('<html>', '<html>' + injectScript);
        } else {
          html = injectScript + html;
        }

        const modifiedBuffer = Buffer.from(html, 'utf8');
        responseHeaders['content-length'] = modifiedBuffer.length;

        res.writeHead(status, responseHeaders);
        res.end(modifiedBuffer);
      });
    } else {
      res.writeHead(status, responseHeaders);
      proxyRes.pipe(res);
    }
  });

  proxyReq.on('error', (err) => {
    res.writeHead(500, { 'content-type': 'text/plain; charset=utf-8' });
    res.end('Proxy Error: ' + err.message);
  });

  req.pipe(proxyReq);
}

class BmcpWebviewViewProvider {
  static viewType = 'bmcp.browserView';

  constructor(extensionUri) {
    this._extensionUri = extensionUri;
  }

  async resolveWebviewView(webviewView, context, _token) {
    this._view = webviewView;

    webviewView.webview.options = {
      enableScripts: true,
      localResourceRoots: [this._extensionUri]
    };

    const localUri = vscode.Uri.parse(`http://127.0.0.1:${actualPort}`);
    let externalUrlStr = `http://127.0.0.1:${actualPort}/`;
    try {
      const externalUri = await vscode.env.asExternalUri(localUri);
      externalUrlStr = externalUri.toString();
    } catch (err) {
      console.error('Failed to resolve external URI, falling back to localhost:', err);
    }

    if (!externalUrlStr.endsWith('/')) {
      externalUrlStr += '/';
    }

    webviewView.webview.html = this._getHtmlForWebview(externalUrlStr);
  }

  _getHtmlForWebview(externalUrlStr) {
    const defaultUrl = `${externalUrlStr}proxy?url=${encodeURIComponent('https://www.youtube.com')}`;
    
    return `<!DOCTYPE html>
<html lang="zh-CN">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <style>
    :root {
      --primary-color: #2563eb;
      --bg-dark: #0f172a;
      --bg-card: rgba(30, 41, 59, 0.7);
      --border-color: rgba(255, 255, 255, 0.08);
      --text-main: #f1f5f9;
      --text-muted: #94a3b8;
    }

    * {
      box-sizing: border-box;
      margin: 0;
      padding: 0;
    }

    body {
      font-family: 'Inter', -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif;
      background: var(--bg-dark);
      color: var(--text-main);
      height: 100vh;
      display: flex;
      flex-direction: column;
      overflow: hidden;
    }

    .nav-bar {
      display: flex;
      align-items: center;
      gap: 6px;
      padding: 6px 8px;
      background: var(--bg-card);
      backdrop-filter: blur(8px);
      -webkit-backdrop-filter: blur(8px);
      border-bottom: 1px solid var(--border-color);
      z-index: 10;
    }

    .nav-btn {
      background: transparent;
      border: none;
      color: var(--text-muted);
      width: 24px;
      height: 24px;
      border-radius: 4px;
      display: flex;
      align-items: center;
      justify-content: center;
      cursor: pointer;
      transition: all 0.2s;
    }

    .nav-btn:hover {
      background: rgba(255, 255, 255, 0.08);
      color: var(--text-main);
    }

    .nav-btn svg {
      width: 14px;
      height: 14px;
      fill: currentColor;
    }

    .address-bar {
      flex: 1;
      position: relative;
      display: flex;
      align-items: center;
    }

    .address-input {
      width: 100%;
      height: 24px;
      background: rgba(15, 23, 42, 0.6);
      border: 1px solid var(--border-color);
      border-radius: 4px;
      padding: 0 24px 0 8px;
      font-size: 11px;
      color: var(--text-main);
      outline: none;
      transition: all 0.2s;
    }

    .address-input:focus {
      border-color: var(--primary-color);
      background: rgba(15, 23, 42, 0.9);
    }

    .go-btn {
      position: absolute;
      right: 4px;
      background: transparent;
      border: none;
      color: var(--text-muted);
      cursor: pointer;
      display: flex;
      align-items: center;
      justify-content: center;
      padding: 2px;
      border-radius: 3px;
    }

    .go-btn:hover {
      color: var(--primary-color);
    }

    .go-btn svg {
      width: 10px;
      height: 10px;
      fill: currentColor;
    }

    .web-container {
      flex: 1;
      width: 100%;
      position: relative;
      background: #000;
    }

    iframe {
      width: 100%;
      height: 100%;
      border: none;
      background: #fff;
    }

    .loading-bar {
      position: absolute;
      top: 0;
      left: 0;
      height: 2px;
      background: var(--primary-color);
      width: 0;
      transition: width 0.3s;
      z-index: 100;
    }
  </style>
</head>
<body>
  <div class="nav-bar">
    <button class="nav-btn" id="btn-back" title="后退">
      <svg viewBox="0 0 24 24"><path d="M15.41 7.41L14 6l-6 6 6 6 1.41-1.41L10.83 12z"/></svg>
    </button>
    <button class="nav-btn" id="btn-forward" title="前进">
      <svg viewBox="0 0 24 24"><path d="M10 6L8.59 7.41 13.17 12l-4.58 4.59L10 18l6-6z"/></svg>
    </button>
    <button class="nav-btn" id="btn-refresh" title="刷新">
      <svg viewBox="0 0 24 24"><path d="M17.65 6.35C16.2 4.9 14.21 4 12 4c-4.42 0-7.99 3.58-7.99 8s3.57 8 7.99 8c3.73 0 6.84-2.55 7.73-6h-2.08c-.82 2.33-3.04 4-5.65 4-3.31 0-6-2.69-6-6s2.69-6 6-6c1.66 0 3.14.69 4.22 1.78L13 11h7V4l-2.35 2.35z"/></svg>
    </button>
    <button class="nav-btn" id="btn-home" title="YouTube">
      <svg viewBox="0 0 24 24"><path d="M10 20v-6h4v6h5v-8h3L12 3 2 12h3v8z"/></svg>
    </button>
    
    <div class="address-bar">
      <input type="text" class="address-input" id="url-input" placeholder="输入网址并回车..." value="https://www.youtube.com">
      <button class="go-btn" id="btn-go" title="前往">
        <svg viewBox="0 0 24 24"><path d="M12 4l-1.41 1.41L16.17 11H4v2h12.17l-5.58 5.59L12 20l8-8z"/></svg>
      </button>
    </div>
  </div>

  <div class="web-container">
    <div class="loading-bar" id="loading-bar"></div>
    <iframe id="web-frame" src="\${defaultUrl}" allow="accelerometer; autoplay; clipboard-write; encrypted-media; gyroscope; picture-in-picture; web-share" allowfullscreen></iframe>
  </div>

  <script>
    const iframe = document.getElementById('web-frame');
    const urlInput = document.getElementById('url-input');
    const btnGo = document.getElementById('btn-go');
    const btnBack = document.getElementById('btn-back');
    const btnForward = document.getElementById('btn-forward');
    const btnRefresh = document.getElementById('btn-refresh');
    const btnHome = document.getElementById('btn-home');
    const loadingBar = document.getElementById('loading-bar');

    const baseUrl = '${externalUrlStr}';

    function getProxyUrl(targetUrl) {
      if (!/^https?:\/\//i.test(targetUrl)) {
        targetUrl = 'https://' + targetUrl;
      }
      return baseUrl + 'proxy?url=' + encodeURIComponent(targetUrl);
    }

    function navigateTo(targetUrl) {
      showLoading();
      const proxyUrl = getProxyUrl(targetUrl);
      iframe.src = proxyUrl;
    }

    function showLoading() {
      loadingBar.style.width = '40%';
    }

    function hideLoading() {
      loadingBar.style.width = '100%';
      setTimeout(() => {
        loadingBar.style.width = '0';
      }, 200);
    }

    btnGo.addEventListener('click', () => navigateTo(urlInput.value));
    urlInput.addEventListener('keydown', (e) => {
      if (e.key === 'Enter') navigateTo(urlInput.value);
    });
    btnBack.addEventListener('click', () => {
      try { iframe.contentWindow.history.back(); } catch(e) {}
    });
    btnForward.addEventListener('click', () => {
      try { iframe.contentWindow.history.forward(); } catch(e) {}
    });
    btnRefresh.addEventListener('click', () => {
      showLoading();
      iframe.contentWindow.location.reload();
    });
    btnHome.addEventListener('click', () => {
      urlInput.value = 'https://www.youtube.com';
      navigateTo('https://www.youtube.com');
    });

    iframe.addEventListener('load', () => {
      hideLoading();
      try {
        const currentLoc = iframe.contentWindow.location.href;
        const urlParams = new URLSearchParams(new URL(currentLoc).search);
        const realUrl = urlParams.get('url');
        if (realUrl) {
          urlInput.value = realUrl;
        }
      } catch (e) {}
    });
  </script>
</body>
</html>`;
  }
}

module.exports = {
  activate,
  deactivate
};
