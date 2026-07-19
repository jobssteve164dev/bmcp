const fs = require('fs');
const http = require('http');
const https = require('https');
const os = require('os');
const path = require('path');
const { execFile, spawn } = require('child_process');
const extract = require('extract-zip');
const WebSocket = require('ws');

const CHROME_FOR_TESTING_VERSION = '149.0.7827.54';
const DEFAULT_RUNTIME_PORT = 17433;
const DEFAULT_IDLE_TIMEOUT_MS = 5 * 60 * 1000;

let runtimeProcess;
let runtime;
let runtimeIdle = false;
let idleTimer;

async function ensureBrowserRuntime(options) {
  refreshIdleTimer();
  const storagePath = options.storagePath;
  fs.mkdirSync(storagePath, { recursive: true });

  if (runtime && runtime.process && !runtime.process.killed) {
    if (options.url && options.url !== runtime.url) {
      await runtime.cdp.navigate(options.url);
      runtime.url = options.url;
    }
    return runtime;
  }

  const browserPath = await resolveBrowserPath(options);
  const extensionPath = ensureCaptureExtension(storagePath, options.signalingUrl);
  const remoteDebuggingPort = await findAvailablePort(DEFAULT_RUNTIME_PORT);
  const userDataDir = path.join(storagePath, 'profile');
  fs.mkdirSync(userDataDir, { recursive: true });

  const runtimeArgs = [
    `--remote-debugging-port=${remoteDebuggingPort}`,
    `--user-data-dir=${userDataDir}`,
    `--load-extension=${extensionPath}`,
    ...runtimeIdentityArgs(),
    options.url
  ];
  if (requiresNoSandbox()) {
    runtimeArgs.splice(runtimeArgs.length - 1, 0, '--no-sandbox');
  }

  runtimeProcess = spawn(browserPath, runtimeArgs, {
    detached: false,
    stdio: ['ignore', 'ignore', 'pipe']
  });
  let startupError = '';
  runtimeProcess.stderr.on('data', (chunk) => {
    startupError = `${startupError}${chunk}`.slice(-4000);
  });

  runtimeProcess.on('exit', () => {
    runtime = undefined;
  });

  const cdp = await CdpClient.connect(remoteDebuggingPort).catch((error) => {
    throw new Error(`${error.message}${startupError ? ` ${startupError.trim()}` : ''}`);
  });
  runtime = {
    browserPath,
    cdp,
    extensionPath,
    process: runtimeProcess,
    remoteDebuggingPort,
    source: options.browserPath ? 'configured' : browserPath.includes(storagePath) ? 'downloaded' : 'system',
    url: options.url
  };
  return runtime;
}

function runtimeIdentityArgs() {
  return [
    '--no-first-run',
    '--no-default-browser-check',
    '--disable-background-timer-throttling',
    '--disable-renderer-backgrounding',
    '--disable-features=CalculateNativeWinOcclusion',
    '--auto-accept-this-tab-capture',
    '--window-size=1280,720'
  ];
}

function requiresNoSandbox() {
  if (process.platform !== 'linux') return false;
  if (typeof process.getuid === 'function' && process.getuid() === 0) return true;
  return fs.existsSync('/.dockerenv') || fs.existsSync('/run/.containerenv');
}

function closeBrowserRuntime() {
  clearTimeout(idleTimer);
  idleTimer = undefined;
  if (runtime?.cdp) {
    runtime.cdp.close();
  }
  runtime = undefined;
  if (runtimeProcess && !runtimeProcess.killed) {
    runtimeProcess.kill();
  }
  runtimeProcess = undefined;
}

function setBrowserRuntimeIdle(idle, timeoutMs = DEFAULT_IDLE_TIMEOUT_MS) {
  runtimeIdle = Boolean(idle);
  clearTimeout(idleTimer);
  idleTimer = undefined;
  if (runtimeIdle && runtimeProcess) {
    idleTimer = setTimeout(closeBrowserRuntime, timeoutMs);
  }
}

function refreshIdleTimer(timeoutMs = DEFAULT_IDLE_TIMEOUT_MS) {
  if (!runtimeIdle) return;
  clearTimeout(idleTimer);
  idleTimer = setTimeout(closeBrowserRuntime, timeoutMs);
}

async function resolveBrowserPath(options) {
  if (options.browserPath && fs.existsSync(options.browserPath)) {
    return options.browserPath;
  }

  const systemBrowser = await findSystemBrowser();
  if (systemBrowser) {
    return systemBrowser;
  }

  return ensureChromeForTesting(options.storagePath);
}

async function findSystemBrowser() {
  const candidates = browserCandidates();
  for (const candidate of candidates.paths) {
    if (fs.existsSync(candidate)) return candidate;
  }
  for (const command of candidates.commands) {
    const resolved = await resolveCommand(command);
    if (resolved) return resolved;
  }
  return '';
}

function browserCandidates() {
  if (process.platform === 'darwin') {
    return {
      paths: [
        '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
        '/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge',
        '/Applications/Chromium.app/Contents/MacOS/Chromium'
      ],
      commands: ['google-chrome', 'microsoft-edge', 'chromium']
    };
  }
  if (process.platform === 'win32') {
    const roots = [
      process.env.PROGRAMFILES,
      process.env['PROGRAMFILES(X86)'],
      process.env.LOCALAPPDATA
    ].filter(Boolean);
    return {
      paths: roots.flatMap((root) => [
        path.join(root, 'Google', 'Chrome', 'Application', 'chrome.exe'),
        path.join(root, 'Microsoft', 'Edge', 'Application', 'msedge.exe')
      ]),
      commands: ['chrome', 'msedge']
    };
  }
  return {
    paths: [
      '/usr/bin/google-chrome',
      '/usr/bin/google-chrome-stable',
      '/usr/bin/microsoft-edge',
      '/usr/bin/microsoft-edge-stable',
      '/usr/bin/chromium',
      '/usr/bin/chromium-browser'
    ],
    commands: ['google-chrome', 'google-chrome-stable', 'microsoft-edge', 'chromium', 'chromium-browser']
  };
}

function resolveCommand(command) {
  return new Promise((resolve) => {
    const resolver = process.platform === 'win32' ? 'where' : 'which';
    execFile(resolver, [command], (error, stdout) => {
      if (error) return resolve('');
      const first = String(stdout || '').split(/\r?\n/).find(Boolean);
      resolve(first || '');
    });
  });
}

async function ensureChromeForTesting(storagePath) {
  const platform = chromeForTestingPlatform();
  const installDir = path.join(storagePath, 'chrome-for-testing', CHROME_FOR_TESTING_VERSION, platform);
  const executable = chromeForTestingExecutable(installDir, platform);
  if (fs.existsSync(executable)) return executable;

  fs.mkdirSync(installDir, { recursive: true });
  const archivePath = path.join(installDir, `chrome-${platform}.zip`);
  const url = `https://storage.googleapis.com/chrome-for-testing-public/${CHROME_FOR_TESTING_VERSION}/${platform}/chrome-${platform}.zip`;
  await downloadFile(url, archivePath);
  await extract(archivePath, { dir: installDir });
  if (!fs.existsSync(executable)) {
    throw new Error(`SoloBrowser downloaded Chrome for Testing but could not find ${executable}`);
  }
  return executable;
}

function chromeForTestingPlatform() {
  if (process.platform === 'darwin') {
    return process.arch === 'arm64' ? 'mac-arm64' : 'mac-x64';
  }
  if (process.platform === 'win32') {
    return process.arch === 'ia32' ? 'win32' : 'win64';
  }
  return 'linux64';
}

function chromeForTestingExecutable(installDir, platform) {
  if (platform.startsWith('mac-')) {
    return path.join(installDir, `chrome-${platform}`, 'Google Chrome for Testing.app', 'Contents', 'MacOS', 'Google Chrome for Testing');
  }
  if (platform.startsWith('win')) {
    return path.join(installDir, `chrome-${platform}`, 'chrome.exe');
  }
  return path.join(installDir, `chrome-${platform}`, 'chrome');
}

function downloadFile(fileUrl, destination) {
  return new Promise((resolve, reject) => {
    const client = fileUrl.startsWith('https:') ? https : http;
    const request = client.get(fileUrl, (response) => {
      if (response.statusCode >= 300 && response.statusCode < 400 && response.headers.location) {
        return downloadFile(response.headers.location, destination).then(resolve, reject);
      }
      if (response.statusCode !== 200) {
        reject(new Error(`SoloBrowser could not download browser runtime: HTTP ${response.statusCode}`));
        return;
      }
      const file = fs.createWriteStream(destination);
      response.pipe(file);
      file.on('finish', () => file.close(resolve));
      file.on('error', reject);
    });
    request.on('error', reject);
  });
}

function ensureCaptureExtension(storagePath, signalingUrl) {
  const extensionPath = path.join(storagePath, 'capture-extension');
  fs.mkdirSync(extensionPath, { recursive: true });
  writeFileIfChanged(path.join(extensionPath, 'manifest.json'), JSON.stringify(captureManifest(), null, 2));
  writeFileIfChanged(path.join(extensionPath, 'service_worker.js'), captureServiceWorker(signalingUrl));
  writeFileIfChanged(path.join(extensionPath, 'offscreen.html'), captureOffscreenHtml());
  writeFileIfChanged(path.join(extensionPath, 'offscreen.js'), captureOffscreenScript());
  return extensionPath;
}

function captureManifest() {
  return {
    manifest_version: 3,
    name: 'SoloBrowser Capture Runtime',
    version: '1.0.0',
    permissions: ['offscreen', 'debugger', 'tabs'],
    background: {
      service_worker: 'service_worker.js'
    },
    action: {
      default_title: 'SoloBrowser Capture'
    }
  };
}

function captureServiceWorker(signalingUrl) {
  return `
const SIGNALING_URL = ${JSON.stringify(signalingUrl)};
let socket;
let controlledTabId;
let debuggerAttached = false;
let inputQueue = Promise.resolve();
let latestPointerMove;
let pointerMoveScheduled = false;

connect();

chrome.action.onClicked.addListener(() => {
  send({ type: 'runtime-ready' });
});

chrome.runtime.onMessage.addListener((message) => {
  if (message?.type === 'webrtcAnswer' || message?.type === 'webrtcCandidate' || message?.type === 'capture-error' || message?.type === 'capture-ready') {
    send(message);
  }
  if (message?.type === 'native-input' && message.input) {
    enqueueInput(message.input);
  }
  if (message?.type === 'native-resize') {
    enqueueCommand('Emulation.setDeviceMetricsOverride', {
      width: clamp(message.width, 320, 3000),
      height: clamp(message.height, 240, 2200),
      deviceScaleFactor: 1,
      mobile: false
    });
  }
});

function connect() {
  socket = new WebSocket(SIGNALING_URL);
  socket.addEventListener('open', () => send({ type: 'runtime-ready' }));
  socket.addEventListener('close', () => setTimeout(connect, 800));
  socket.addEventListener('message', async (event) => {
    const message = JSON.parse(event.data);
    try {
      if (message.type === 'webrtcOffer') await startCapture(message);
      if (message.type === 'webrtcCandidate') chrome.runtime.sendMessage(message);
    } catch (error) {
      send({ type: 'capture-error', error: error.message });
    }
  });
}

function send(message) {
  if (socket?.readyState === WebSocket.OPEN) {
    socket.send(JSON.stringify(message));
  }
}

async function startCapture(message) {
  const tabs = await chrome.tabs.query({ active: true, lastFocusedWindow: true });
  const nextTabId = tabs[0]?.id;
  if (!nextTabId) throw new Error('SoloBrowser could not identify the active browser tab.');
  if (debuggerAttached && controlledTabId !== nextTabId) {
    await chrome.debugger.detach({ tabId: controlledTabId }).catch(() => {});
    debuggerAttached = false;
  }
  controlledTabId = nextTabId;
  await ensureOffscreen();
  chrome.runtime.sendMessage({
    type: 'startCapture',
    offer: message.offer,
    source: 'display'
  });
}

function enqueueInput(input) {
  if (input.type === 'input_mouse' && input.eventType === 'mouseMoved') {
    latestPointerMove = input;
    if (!pointerMoveScheduled) {
      pointerMoveScheduled = true;
      setTimeout(() => {
        pointerMoveScheduled = false;
        const next = latestPointerMove;
        latestPointerMove = undefined;
        if (next) enqueueInputCommand(next);
      }, 16);
    }
    return;
  }
  enqueueInputCommand(input);
}

function enqueueInputCommand(input) {
  if (input.type === 'input_mouse') {
    enqueueCommand('Input.dispatchMouseEvent', {
      type: input.eventType || 'mouseMoved',
      x: Number(input.x) || 0,
      y: Number(input.y) || 0,
      button: input.button === 'none' ? 'none' : input.button || 'left',
      clickCount: Number(input.clickCount) || 0,
      deltaX: Number(input.deltaX) || 0,
      deltaY: Number(input.deltaY) || 0
    });
    return;
  }
  if (input.type === 'input_keyboard') {
    const params = {
      type: input.eventType === 'keyUp' ? 'keyUp' : 'keyDown',
      key: input.key || '',
      code: input.code || ''
    };
    if (params.type === 'keyDown' && input.key?.length === 1) {
      params.text = input.text || input.key;
      params.unmodifiedText = input.unmodifiedText || input.key;
    }
    enqueueCommand('Input.dispatchKeyEvent', params);
  }
}

function enqueueCommand(method, params) {
  inputQueue = inputQueue.then(async () => {
    await ensureDebugger();
    return chrome.debugger.sendCommand({ tabId: controlledTabId }, method, params);
  }).catch((error) => send({ type: 'capture-error', error: error.message }));
}

async function ensureDebugger() {
  if (debuggerAttached) return;
  await chrome.debugger.attach({ tabId: controlledTabId }, '1.3');
  debuggerAttached = true;
}

function clamp(value, min, max) {
  const number = Math.round(Number(value));
  return Math.max(min, Math.min(max, Number.isFinite(number) ? number : min));
}

async function ensureOffscreen() {
  if (await chrome.offscreen.hasDocument()) return;
  await chrome.offscreen.createDocument({
    url: 'offscreen.html',
    reasons: ['DISPLAY_MEDIA', 'USER_MEDIA'],
    justification: 'Stream the active SoloBrowser tab into the VS Code browser view.'
  });
}
`;
}

function captureOffscreenHtml() {
  return '<!doctype html><meta charset="utf-8"><script src="offscreen.js"></script>';
}

function captureOffscreenScript() {
  return `
let peer;
let controlChannel;
let pointerChannel;

chrome.runtime.onMessage.addListener((message) => {
  if (message?.type === 'startCapture') startCapture(message).catch((error) => {
    chrome.runtime.sendMessage({ type: 'capture-error', error: error.message });
  });
  if (message?.type === 'webrtcCandidate' && peer && message.candidate) {
    peer.addIceCandidate(message.candidate).catch(() => {});
  }
});

async function startCapture(message) {
  if (peer) {
    peer.close();
    peer = undefined;
  }

  const stream = message.source === 'display'
    ? await navigator.mediaDevices.getDisplayMedia({ audio: false, video: { frameRate: 60 } })
    : await navigator.mediaDevices.getUserMedia({
      audio: false,
      video: {
        mandatory: {
          chromeMediaSource: 'tab',
          chromeMediaSourceId: message.streamId,
          maxFrameRate: 60
        }
      }
    });

  const audio = new Audio();
  audio.srcObject = stream;
  audio.play().catch(() => {});

  peer = new RTCPeerConnection({ iceServers: [] });
  peer.ondatachannel = (event) => {
    const channel = event.channel;
    if (channel.label === 'solobrowser-control') controlChannel = channel;
    if (channel.label === 'solobrowser-pointer') pointerChannel = channel;
    channel.onmessage = (messageEvent) => {
      try {
        const message = JSON.parse(messageEvent.data);
        if (message.type === 'nativeInput') {
          chrome.runtime.sendMessage({ type: 'native-input', input: message.input });
        }
        if (message.type === 'nativeResize') {
          chrome.runtime.sendMessage({ type: 'native-resize', width: message.width, height: message.height });
        }
      } catch (_) {}
    };
  };
  peer.onicecandidate = (event) => {
    if (event.candidate) {
      chrome.runtime.sendMessage({ type: 'webrtcCandidate', candidate: event.candidate });
    }
  };
  for (const track of stream.getTracks()) {
    peer.addTrack(track, stream);
  }
  await peer.setRemoteDescription(message.offer);
  const answer = await peer.createAnswer();
  await peer.setLocalDescription(answer);
  chrome.runtime.sendMessage({ type: 'webrtcAnswer', answer });
  chrome.runtime.sendMessage({ type: 'capture-ready' });
}
`;
}

function writeFileIfChanged(file, contents) {
  if (fs.existsSync(file) && fs.readFileSync(file, 'utf8') === contents) return;
  fs.writeFileSync(file, contents);
}

async function findAvailablePort(start) {
  for (let port = start; port < start + 50; port++) {
    if (await canListen(port)) return port;
  }
  throw new Error('SoloBrowser could not find an available browser debugging port.');
}

function canListen(port) {
  return new Promise((resolve) => {
    const tester = http.createServer();
    tester.listen(port, '127.0.0.1', () => {
      tester.close(() => resolve(true));
    });
    tester.on('error', () => resolve(false));
  });
}

class CdpClient {
  constructor(port, pageSocket, pageId) {
    this.port = port;
    this.pageSocket = pageSocket;
    this.pageId = pageId;
    this.nextId = 1;
    this.pending = new Map();
    this.lastSnapshot = undefined;
    pageSocket.on('message', (data) => this.handleMessage(data));
  }

  static async connect(port) {
    await waitForCdp(port);
    const page = await firstPage(port);
    const ws = new WebSocket(page.webSocketDebuggerUrl);
    await new Promise((resolve, reject) => {
      ws.once('open', resolve);
      ws.once('error', reject);
    });
    const client = new CdpClient(port, ws, page.id);
    await client.send('Page.enable');
    await client.send('Runtime.enable');
    await client.send('Accessibility.enable');
    return client;
  }

  handleMessage(data) {
    let message;
    try {
      message = JSON.parse(String(data));
    } catch (_) {
      return;
    }
    if (!message.id) return;
    const pending = this.pending.get(message.id);
    if (!pending) return;
    this.pending.delete(message.id);
    if (message.error) {
      pending.reject(new Error(message.error.message || 'CDP command failed.'));
    } else {
      pending.resolve(message.result || {});
    }
  }

  send(method, params = {}) {
    return new Promise((resolve, reject) => {
      const id = this.nextId++;
      this.pending.set(id, { resolve, reject });
      this.pageSocket.send(JSON.stringify({ id, method, params }));
      setTimeout(() => {
        if (!this.pending.has(id)) return;
        this.pending.delete(id);
        reject(new Error(`Timed out waiting for CDP command: ${method}`));
      }, 10000);
    });
  }

  async navigate(targetUrl) {
    this.lastSnapshot = undefined;
    await this.send('Page.navigate', { url: targetUrl });
  }

  async command(command) {
    if (command === 'reload') return this.send('Page.reload', { ignoreCache: false });
    if (command === 'back') return this.send('Runtime.evaluate', { expression: 'history.back()' });
    if (command === 'forward') return this.send('Runtime.evaluate', { expression: 'history.forward()' });
    throw new Error(`Unsupported browser command: ${command}`);
  }

  async dispatchInput(input) {
    if (input.type === 'input_mouse') {
      const typeMap = {
        mousePressed: 'mousePressed',
        mouseReleased: 'mouseReleased',
        mouseMoved: 'mouseMoved',
        mouseWheel: 'mouseWheel'
      };
      return this.send('Input.dispatchMouseEvent', {
        type: typeMap[input.eventType] || 'mouseMoved',
        x: Number(input.x) || 0,
        y: Number(input.y) || 0,
        button: input.button === 'none' ? 'none' : input.button || 'left',
        clickCount: Number(input.clickCount) || 0,
        deltaX: Number(input.deltaX) || 0,
        deltaY: Number(input.deltaY) || 0
      });
    }
    if (input.type === 'input_keyboard' && input.eventType === 'keyDown') {
      if (input.key && input.key.length === 1) {
        return this.send('Input.dispatchKeyEvent', {
          type: 'keyDown',
          text: input.key,
          unmodifiedText: input.key,
          key: input.key
        });
      }
      return this.send('Input.dispatchKeyEvent', {
        type: 'keyDown',
        key: input.key || '',
        code: input.code || ''
      });
    }
    if (input.type === 'input_keyboard' && input.eventType === 'keyUp') {
      return this.send('Input.dispatchKeyEvent', {
        type: 'keyUp',
        key: input.key || '',
        code: input.code || ''
      });
    }
  }

  async setViewport(width, height) {
    const viewport = {
      width: clampInteger(width, 320, 3000),
      height: clampInteger(height, 240, 2200),
      deviceScaleFactor: 1,
      mobile: false
    };
    await this.send('Emulation.setDeviceMetricsOverride', viewport);
    return viewport;
  }

  async startPageWebRtc(offer) {
    const result = await this.send('Runtime.evaluate', {
      awaitPromise: true,
      returnByValue: true,
      expression: `(${pageWebRtcSource()})(${JSON.stringify(offer)})`
    });
    const value = result.result?.value;
    if (!value?.ok) {
      throw new Error(value?.error || 'SoloBrowser could not start current-tab WebRTC capture.');
    }
    return value;
  }

  async addPageWebRtcCandidate(candidate) {
    await this.send('Runtime.evaluate', {
      awaitPromise: true,
      expression: `window.__bmcpAddCandidate && window.__bmcpAddCandidate(${JSON.stringify(candidate)})`
    });
  }

  async snapshot() {
    const result = await this.send('Runtime.evaluate', {
      awaitPromise: true,
      returnByValue: true,
      expression: `(${collectPageSnapshotSource()})()`
    });
    const snapshot = result.result?.value || { title: '', url: '', text: '', elements: [] };
    snapshot.raw = snapshot.text;
    this.lastSnapshot = snapshot;
    return snapshot;
  }

  async click(ref) {
    const element = await this.findElement(ref);
    if (element.bounds?.width && element.bounds?.height) {
      const x = Math.round(element.bounds.x + element.bounds.width / 2);
      const y = Math.round(element.bounds.y + element.bounds.height / 2);
      await this.send('Input.dispatchMouseEvent', { type: 'mouseMoved', x, y, button: 'none' });
      await this.send('Input.dispatchMouseEvent', { type: 'mousePressed', x, y, button: 'left', clickCount: 1 });
      await this.send('Input.dispatchMouseEvent', { type: 'mouseReleased', x, y, button: 'left', clickCount: 1 });
      return { clicked: ref, selector: element.selector };
    }
    await this.send('Runtime.evaluate', {
      awaitPromise: true,
      expression: `(${elementActionSource()})(${JSON.stringify(element.selector)}, 'click')`
    });
    return { clicked: ref, selector: element.selector };
  }

  async type(ref, text) {
    const element = await this.findElement(ref);
    await this.send('Runtime.evaluate', {
      awaitPromise: true,
      expression: `(${elementActionSource()})(${JSON.stringify(element.selector)}, 'focus')`
    });
    await this.send('Input.insertText', { text: String(text || '') });
    await this.send('Runtime.evaluate', {
      awaitPromise: true,
      expression: `(${elementActionSource()})(${JSON.stringify(element.selector)}, 'change')`
    });
    return { typed: ref, selector: element.selector, text: String(text || '') };
  }

  async findElement(ref) {
    if (!ref) throw new Error('Missing element ref.');
    const normalized = String(ref).replace(/^@/, '');
    if (!this.lastSnapshot?.elements?.length) {
      await this.snapshot();
    }
    const element = this.lastSnapshot.elements.find((item) => item.ref === normalized);
    if (!element) {
      await this.snapshot();
      const refreshed = this.lastSnapshot.elements.find((item) => item.ref === normalized);
      if (refreshed) return refreshed;
      throw new Error(`Could not find element ref: ${ref}`);
    }
    return element;
  }

  close() {
    if (this.pageSocket.readyState === WebSocket.OPEN) {
      this.pageSocket.close();
    }
  }
}

function clampInteger(value, min, max) {
  const number = Math.round(Number(value));
  if (!Number.isFinite(number)) return min;
  return Math.max(min, Math.min(max, number));
}

function collectPageSnapshotSource() {
  return function collectBmcpPageSnapshot() {
    const selectors = [
      'a[href]',
      'button',
      'input',
      'textarea',
      'select',
      '[role="button"]',
      '[role="link"]',
      '[contenteditable="true"]',
      '[tabindex]:not([tabindex="-1"])'
    ];
    const elements = Array.from(document.querySelectorAll(selectors.join(',')))
      .filter((element) => !element.disabled && isVisible(element))
      .slice(0, 120)
      .map((element, index) => describeElement(element, index + 1));

    return {
      title: document.title || '',
      url: String(location.href),
      text: getVisibleText(document.body || document.documentElement),
      elements
    };

    function describeElement(element, index) {
      const tag = element.tagName.toLowerCase();
      const role = element.getAttribute('role') || inferRole(element);
      const label = getLabel(element);
      const rect = element.getBoundingClientRect();
      const value = 'value' in element ? element.value : undefined;
      return {
        ref: `e${index}`,
        tag,
        role,
        label,
        value,
        selector: getSelector(element),
        bounds: {
          x: Math.round(rect.x),
          y: Math.round(rect.y),
          width: Math.round(rect.width),
          height: Math.round(rect.height)
        },
        raw: `${role} ${label}`.trim()
      };
    }

    function isVisible(element) {
      const style = getComputedStyle(element);
      if (style.display === 'none' || style.visibility === 'hidden' || style.opacity === '0') return false;
      const rect = element.getBoundingClientRect();
      return rect.width > 0 && rect.height > 0;
    }

    function getVisibleText(element) {
      const text = element?.innerText || element?.textContent || '';
      return text.replace(/\s+/g, ' ').trim();
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
        const text = labelledBy
          .split(/\s+/)
          .map((id) => document.getElementById(id)?.textContent || '')
          .join(' ')
          .replace(/\s+/g, ' ')
          .trim();
        if (text) return text;
      }
      if (element.id) {
        const label = document.querySelector(`label[for="${cssEscape(element.id)}"]`);
        if (label?.textContent) return label.textContent.replace(/\s+/g, ' ').trim();
      }
      const text = element.innerText || element.textContent || element.getAttribute('placeholder') || element.getAttribute('title') || '';
      return text.replace(/\s+/g, ' ').trim();
    }

    function getSelector(element) {
      if (element.id) return `#${cssEscape(element.id)}`;
      const dataTest = element.getAttribute('data-testid') || element.getAttribute('data-test');
      if (dataTest) return `[data-testid="${cssEscape(dataTest)}"]`;
      const name = element.getAttribute('name');
      if (name) return `${element.tagName.toLowerCase()}[name="${cssEscape(name)}"]`;
      const parts = [];
      let current = element;
      while (current && current.nodeType === Node.ELEMENT_NODE && current !== document.documentElement) {
        const tag = current.tagName.toLowerCase();
        const siblings = Array.from(current.parentElement?.children || []).filter((sibling) => sibling.tagName === current.tagName);
        const nth = siblings.length > 1 ? `:nth-of-type(${siblings.indexOf(current) + 1})` : '';
        parts.unshift(`${tag}${nth}`);
        current = current.parentElement;
      }
      return parts.join(' > ');
    }

    function cssEscape(value) {
      if (window.CSS?.escape) return CSS.escape(String(value));
      return String(value).replace(/["\\#.:,[\]>+~*^$|= ]/g, '\\$&');
    }
  }.toString();
}

function elementActionSource() {
  return function bmcpElementAction(selector, action) {
    const element = document.querySelector(selector);
    if (!element) throw new Error(`Element not found: ${selector}`);
    if (action === 'click') {
      element.click();
      return true;
    }
    if (action === 'focus') {
      element.focus();
      if ('value' in element) {
        element.value = '';
        element.dispatchEvent(new InputEvent('input', { bubbles: true, inputType: 'deleteContentBackward' }));
      }
      return true;
    }
    if (action === 'change') {
      element.dispatchEvent(new Event('input', { bubbles: true }));
      element.dispatchEvent(new Event('change', { bubbles: true }));
      return true;
    }
    throw new Error(`Unsupported element action: ${action}`);
  }.toString();
}

function pageWebRtcSource() {
  return async function startBmcpPageWebRtc(offer) {
    try {
      if (window.__bmcpPeer) {
        window.__bmcpPeer.close();
      }
      const stream = await navigator.mediaDevices.getDisplayMedia({
        audio: false,
        video: { frameRate: 60 },
        preferCurrentTab: true,
        selfBrowserSurface: 'include',
        surfaceSwitching: 'exclude'
      });
      const peer = new RTCPeerConnection({ iceServers: [] });
      window.__bmcpPeer = peer;
      window.__bmcpAddCandidate = async (candidate) => {
        if (candidate) await peer.addIceCandidate(candidate);
      };
      for (const track of stream.getTracks()) {
        peer.addTrack(track, stream);
      }
      await peer.setRemoteDescription(offer);
      const answer = await peer.createAnswer();
      await peer.setLocalDescription(answer);
      await new Promise((resolve) => {
        if (peer.iceGatheringState === 'complete') {
          resolve();
          return;
        }
        const timer = setTimeout(resolve, 800);
        peer.addEventListener('icegatheringstatechange', () => {
          if (peer.iceGatheringState === 'complete') {
            clearTimeout(timer);
            resolve();
          }
        });
      });
      return { ok: true, answer: peer.localDescription };
    } catch (error) {
      return { ok: false, error: `${error.name || 'Error'}: ${error.message || error}` };
    }
  }.toString();
}

async function waitForCdp(port) {
  const started = Date.now();
  while (Date.now() - started < 20000) {
    try {
      await jsonGet(`http://127.0.0.1:${port}/json/version`);
      return;
    } catch (_) {
      await new Promise((resolve) => setTimeout(resolve, 250));
    }
  }
  throw new Error('SoloBrowser browser runtime did not expose CDP in time.');
}

async function firstPage(port) {
  const pages = await jsonGet(`http://127.0.0.1:${port}/json/list`);
  const page = pages.find((item) => item.type === 'page' && item.webSocketDebuggerUrl);
  if (!page) throw new Error('SoloBrowser browser runtime has no controllable page.');
  return page;
}

function jsonGet(targetUrl) {
  return new Promise((resolve, reject) => {
    http.get(targetUrl, (response) => {
      let body = '';
      response.on('data', (chunk) => { body += chunk; });
      response.on('end', () => {
        try {
          resolve(JSON.parse(body));
        } catch (error) {
          reject(error);
        }
      });
    }).on('error', reject);
  });
}

module.exports = {
  CHROME_FOR_TESTING_VERSION,
  DEFAULT_IDLE_TIMEOUT_MS,
  captureManifest,
  captureOffscreenScript,
  captureServiceWorker,
  closeBrowserRuntime,
  ensureBrowserRuntime,
  ensureCaptureExtension,
  findSystemBrowser,
  normalizeBrowserCandidates: browserCandidates,
  requiresNoSandbox,
  runtimeIdentityArgs,
  setBrowserRuntimeIdle
};
