const assert = require('assert');
const Module = require('module');
const path = require('path');
const { JSDOM, VirtualConsole } = require('jsdom');

const originalLoad = Module._load;
Module._load = function load(request, parent, isMain) {
  if (request === 'vscode') {
    return {
      workspace: {
        getConfiguration() {
          return { get(_key, fallback) { return fallback; } };
        }
      },
      window: {}
    };
  }
  return originalLoad.call(this, request, parent, isMain);
};

const { __test } = require('../src/extension');

assert.strictEqual(typeof __test.resolveFallbackProfilePath, 'function');
assert.strictEqual(
  __test.resolveFallbackProfilePath('/persistent/storage'),
  path.join('/persistent/storage', 'fallback-profile')
);

const provider = new __test.BmcpWebviewViewProvider({ scheme: 'test', path: '/extension' });
const html = provider._getHtmlForWebview();

assert.strictEqual(typeof __test.agentBrowserArgs, 'function');
assert.deepStrictEqual(__test.agentBrowserArgs(['open', 'https://x.com'], {
  fallbackProfilePath: '/persistent/fallback',
  runtimePort: 17433
}), [
  '--session', 'bmcp-native', '--cdp', '17433', 'open', 'https://x.com'
]);
assert.deepStrictEqual(__test.agentBrowserArgs(['open', 'https://x.com'], {
  fallbackProfilePath: '/persistent/fallback',
  runtimePort: 0
}), [
  '--session', 'bmcp-native', '--profile', '/persistent/fallback', 'open', 'https://x.com'
]);
assert.strictEqual(typeof __test.createAgentBrowserArgs, 'function');
assert.deepStrictEqual(
  __test.fallbackBootstrapArgs('https://x.com', { runtimePort: 17433 }),
  ['get', 'url']
);
assert.deepStrictEqual(
  __test.fallbackBootstrapArgs('https://x.com', { runtimePort: 0 }),
  ['open', 'https://x.com']
);
const mutableConnection = { fallbackProfilePath: '/persistent/fallback', runtimePort: 17433 };
const frozenAgentBrowserArgs = __test.createAgentBrowserArgs(mutableConnection);
mutableConnection.runtimePort = 0;
assert.deepStrictEqual(frozenAgentBrowserArgs(['stream', 'status']), [
  '--session', 'bmcp-native', '--cdp', '17433', 'stream', 'status'
]);
assert.strictEqual(typeof __test.refreshedRuntimePort, 'function');
assert.strictEqual(__test.refreshedRuntimePort({ remoteDebuggingPort: 17434 }, 4, 4, 17433), 17434);
assert.strictEqual(__test.refreshedRuntimePort({ remoteDebuggingPort: 17434 }, 3, 4, 0), 0);

assert.strictEqual(__test.normalizeUrlInput('youtube.com'), 'https://youtube.com');
assert.strictEqual(__test.normalizeTarget('youtube.com').url, 'https://youtube.com');
assert(html.includes("vscode.postMessage({ type: 'openNative'"));
assert(html.includes("vscode.postMessage({ type: 'nativeInput'"));
assert(html.includes("vscode.postMessage({ type: 'webrtcOffer'"));
assert(html.includes('<video id="stream" autoplay playsinline muted></video>'));
assert(html.includes('stream.play().catch(() => {});'));
assert(html.includes('media-src blob:'));
assert(html.includes('object-fit: contain'));
assert(!html.includes('object-fit: fill'));
assert(!html.includes('<iframe'));
assert(!html.includes('/proxy?url='));
assert(!html.includes('http://localhost:'));

assert.strictEqual(__test.isBrowserSurfaceVisible(undefined, undefined), false);
assert.strictEqual(__test.isBrowserSurfaceVisible({ visible: false }, { visible: false }), false);
assert.strictEqual(__test.isBrowserSurfaceVisible({ visible: true }, { visible: false }), true);
assert.strictEqual(__test.isBrowserSurfaceVisible({ visible: false }, { visible: true }), true);
assert.deepStrictEqual(__test.normalizeViewportSize(320, 240, 'fallback'), { width: 320, height: 240 });

const registry = __test.createWebviewConnectionRegistry();
const registryWebview = {};
registry.markReady(registryWebview, 'client-1', 'document-new');
assert.strictEqual(registry.beginOffer(registryWebview, {
  clientId: 'client-1', documentId: 'document-old', connectionId: 'connection-old'
}), undefined);
const firstConnection = registry.beginOffer(registryWebview, {
  clientId: 'client-1', documentId: 'document-new', connectionId: 'connection-1'
});
const secondConnection = registry.beginOffer(registryWebview, {
  clientId: 'client-1', documentId: 'document-new', connectionId: 'connection-2'
});
assert.strictEqual(registry.isCurrent(firstConnection), false);
assert.strictEqual(registry.isCurrent(secondConnection), true);
registry.markReady(registryWebview, 'client-1', 'document-next');
assert.strictEqual(registry.isCurrent(secondConnection), false);
assert.strictEqual(registry.queueCandidate(registryWebview, {
  clientId: 'client-1', documentId: 'document-next', connectionId: 'connection-3', candidate: { candidate: 'early' }
}), true);
const thirdConnection = registry.beginOffer(registryWebview, {
  clientId: 'client-1', documentId: 'document-next', connectionId: 'connection-3'
});
assert.deepStrictEqual(registry.takeCandidates(thirdConnection), [{ candidate: 'early' }]);
assert.strictEqual(Boolean(registry.queueCandidate(registryWebview, {
  clientId: 'client-1', documentId: 'document-next', connectionId: 'connection-4', candidate: { candidate: 'next-early' }
})), true);
const fourthConnection = registry.beginOffer(registryWebview, {
  clientId: 'client-1', documentId: 'document-next', connectionId: 'connection-4'
});
assert.deepStrictEqual(registry.takeCandidates(fourthConnection), [{ candidate: 'next-early' }]);
assert.strictEqual(registry.matchActive(registryWebview, {
  clientId: 'client-1', documentId: 'document-next', connectionId: 'connection-4'
}), fourthConnection);
assert.strictEqual(registry.matchActive(registryWebview, {
  clientId: 'client-1', documentId: 'document-next', connectionId: 'connection-stale'
}), undefined);
registry.invalidateActive();
assert.strictEqual(registry.isCurrent(fourthConnection), false);

function runWebview(generatedHtml, setupWindow) {
  const messages = [];
  const virtualConsole = new VirtualConsole();
  virtualConsole.on('jsdomError', (error) => {
    throw error;
  });
  const dom = new JSDOM(generatedHtml, {
    beforeParse(window) {
      window.acquireVsCodeApi = () => ({ postMessage: (message) => messages.push(message) });
      window.ResizeObserver = class ResizeObserver {
        observe() {}
      };
      setupWindow?.(window);
    },
    runScripts: 'dangerously',
    virtualConsole
  });
  return { dom, messages };
}

const { dom: sidebarDom, messages: sidebarMessages } = runWebview(html);
assert(sidebarMessages.some((message) => message.type === 'nativeReady' && message.documentId));
assert(!sidebarMessages.some((message) => message.type === 'openNative'));
assert(!html.includes('createDataChannel'));
sidebarDom.window.dispatchEvent(new sidebarDom.window.MessageEvent('message', {
  data: { type: 'nativeUrl', url: 'https://redirected.example/sidebar' }
}));
assert.strictEqual(
  sidebarDom.window.document.getElementById('url-input').value,
  'https://redirected.example/sidebar'
);
const sidebarUrlInput = sidebarDom.window.document.getElementById('url-input');
sidebarUrlInput.focus();
sidebarUrlInput.value = 'https://typed.example/';
sidebarDom.window.dispatchEvent(new sidebarDom.window.MessageEvent('message', {
  data: { type: 'nativeUrl', url: 'https://redirected.example/while-focused' }
}));
assert.strictEqual(sidebarUrlInput.value, 'https://typed.example/');
sidebarUrlInput.blur();
assert.strictEqual(sidebarUrlInput.value, 'https://redirected.example/while-focused');
sidebarDom.window.dispatchEvent(new sidebarDom.window.MessageEvent('message', {
  data: { type: 'nativeViewport', metadata: { deviceWidth: 1280, deviceHeight: 720, url: 'https://viewport.example/sidebar' } }
}));
assert.strictEqual(sidebarUrlInput.value, 'https://viewport.example/sidebar');

const panelHtml = __test.getNativeHtml({
  mode: 'native',
  url: 'https://example.test',
  transport: 'webrtc',
  viewport: { deviceWidth: 1280, deviceHeight: 720 }
}, 'panel-1');
const { dom: panelDom, messages: panelMessages } = runWebview(panelHtml);
assert(panelMessages.some((message) => message.type === 'nativeReady' && message.clientId === 'panel-1' && message.documentId));
assert(!panelHtml.includes('createDataChannel'));
assert(panelHtml.includes('object-fit: contain'));
assert(!panelHtml.includes('object-fit: fill'));
assert(panelHtml.includes('stream.play().catch(() => {});'));
panelDom.window.dispatchEvent(new panelDom.window.MessageEvent('message', {
  data: { type: 'nativeUrl', url: 'https://redirected.example/panel' }
}));
assert.strictEqual(
  panelDom.window.document.getElementById('address').textContent,
  'https://redirected.example/panel'
);
panelDom.window.dispatchEvent(new panelDom.window.MessageEvent('message', {
  data: { type: 'nativeViewport', metadata: { deviceWidth: 1280, deviceHeight: 720, url: 'https://viewport.example/panel' } }
}));
assert.strictEqual(
  panelDom.window.document.getElementById('address').textContent,
  'https://viewport.example/panel'
);

const panelVideo = panelDom.window.document.getElementById('stream');
const panelViewport = panelDom.window.document.getElementById('viewport');
Object.defineProperty(panelVideo, 'videoWidth', { value: 1280 });
Object.defineProperty(panelVideo, 'videoHeight', { value: 462 });
panelViewport.getBoundingClientRect = () => ({ left: 0, top: 0, width: 300, height: 300 });
const displayScale = 300 / 1280;
const displayOffsetY = (300 - 462 * displayScale) / 2;
panelViewport.dispatchEvent(new panelDom.window.MouseEvent('pointerdown', {
  bubbles: true,
  button: 0,
  clientX: 640 * displayScale,
  clientY: displayOffsetY + (525 * 462 / 720) * displayScale
}));
const pointerMessage = panelMessages.findLast((message) => message.type === 'nativeInput');
assert.strictEqual(pointerMessage.input.x, 640);
assert.strictEqual(pointerMessage.input.y, 525);

Object.defineProperty(panelDom.window.document.getElementById('frame'), 'naturalWidth', { value: 800 });
Object.defineProperty(panelDom.window.document.getElementById('frame'), 'naturalHeight', { value: 400 });
panelDom.window.dispatchEvent(new panelDom.window.MessageEvent('message', {
  data: { type: 'webrtcFailed' }
}));
panelDom.window.dispatchEvent(new panelDom.window.MessageEvent('message', {
  data: {
    type: 'nativeFrame',
    data: 'jpeg',
    metadata: { deviceWidth: 800, deviceHeight: 600 }
  }
}));
panelViewport.dispatchEvent(new panelDom.window.MouseEvent('pointerdown', {
  bubbles: true,
  button: 0,
  clientX: 150,
  clientY: 150
}));
const fallbackPointerMessage = panelMessages.findLast((message) => message.type === 'nativeInput');
assert.strictEqual(fallbackPointerMessage.input.x, 400);
assert.strictEqual(fallbackPointerMessage.input.y, 300);

class FakeWebviewPeerConnection {
  constructor() {
    FakeWebviewPeerConnection.instances.push(this);
  }

  addTransceiver() {}

  close() {
    this.closed = true;
  }

  async createOffer() {
    return { type: 'offer', sdp: 'offer-sdp' };
  }

  async setLocalDescription(description) {
    this.localDescription = {
      ...description,
      toJSON: () => ({ type: description.type, sdp: description.sdp })
    };
  }
}
FakeWebviewPeerConnection.instances = [];

(async () => {
  const { dom: restartDom, messages: restartMessages } = runWebview(panelHtml, (window) => {
    window.RTCPeerConnection = FakeWebviewPeerConnection;
  });
  const restartMessage = new restartDom.window.MessageEvent('message', {
    data: { type: 'startWebRtc', clientId: 'panel-1' }
  });
  restartDom.window.dispatchEvent(restartMessage);
  restartDom.window.dispatchEvent(restartMessage);
  await Promise.resolve();
  await Promise.resolve();
  await Promise.resolve();
  await new Promise((resolve) => setImmediate(resolve));
  const offers = restartMessages.filter((message) => message.type === 'webrtcOffer');
  assert.strictEqual(FakeWebviewPeerConnection.instances[0].closed, true);
  assert.strictEqual(offers.length, 1);
  assert(offers[0].connectionId.startsWith('panel-1:'));
  assert.strictEqual(offers[0].documentId, restartMessages.find((message) => message.type === 'nativeReady').documentId);
  assert.strictEqual(typeof offers[0].offer.sdp, 'string');

  const connectionTimers = [];
  const { dom: timeoutDom, messages: timeoutMessages } = runWebview(panelHtml, (window) => {
    window.RTCPeerConnection = FakeWebviewPeerConnection;
    const nativeSetTimeout = window.setTimeout.bind(window);
    window.setTimeout = (callback, delay, ...args) => {
      if (delay === 3000) {
        connectionTimers.push(() => callback(...args));
        return connectionTimers.length;
      }
      return nativeSetTimeout(callback, delay, ...args);
    };
  });
  timeoutDom.window.dispatchEvent(new timeoutDom.window.MessageEvent('message', {
    data: { type: 'startWebRtc', clientId: 'panel-1' }
  }));
  await Promise.resolve();
  await Promise.resolve();
  await new Promise((resolve) => setImmediate(resolve));
  assert.strictEqual(connectionTimers.length, 1);
  connectionTimers[0]();
  const timeoutMessage = timeoutMessages.find((message) => message.type === 'webrtcTimeout');
  assert(timeoutMessage);
  assert.strictEqual(timeoutMessage.clientId, 'panel-1');
  assert(timeoutMessage.connectionId.startsWith('panel-1:'));

  const frameCallbacks = [];
  const clearedTimers = [];
  const reconnectTimers = [];
  const { dom: reconnectDom } = runWebview(panelHtml, (window) => {
    window.RTCPeerConnection = FakeWebviewPeerConnection;
    const nativeSetTimeout = window.setTimeout.bind(window);
    const nativeClearTimeout = window.clearTimeout.bind(window);
    window.setTimeout = (callback, delay, ...args) => {
      if (delay === 3000) {
        const id = 100 + reconnectTimers.length;
        reconnectTimers.push({ callback: () => callback(...args), id });
        return id;
      }
      return nativeSetTimeout(callback, delay, ...args);
    };
    window.clearTimeout = (id) => {
      if (id >= 100) clearedTimers.push(id);
      else nativeClearTimeout(id);
    };
  });
  const reconnectVideo = reconnectDom.window.document.getElementById('stream');
  reconnectVideo.requestVideoFrameCallback = (callback) => frameCallbacks.push(callback);
  const reconnectMessage = new reconnectDom.window.MessageEvent('message', {
    data: { type: 'startWebRtc', clientId: 'panel-1' }
  });
  reconnectDom.window.dispatchEvent(reconnectMessage);
  await Promise.resolve();
  await Promise.resolve();
  await new Promise((resolve) => setImmediate(resolve));
  const firstReconnectPeer = FakeWebviewPeerConnection.instances.at(-1);
  firstReconnectPeer.ontrack({ streams: [{}] });
  reconnectDom.window.dispatchEvent(reconnectMessage);
  await Promise.resolve();
  await Promise.resolve();
  await new Promise((resolve) => setImmediate(resolve));
  assert.strictEqual(reconnectTimers.length, 2);
  frameCallbacks[0]();
  assert(!clearedTimers.includes(reconnectTimers[1].id));

  const sidebarConnectionTimers = [];
  const { dom: sidebarTimeoutDom, messages: sidebarTimeoutMessages } = runWebview(html, (window) => {
    window.RTCPeerConnection = FakeWebviewPeerConnection;
    const nativeSetTimeout = window.setTimeout.bind(window);
    window.setTimeout = (callback, delay, ...args) => {
      if (delay === 3000) {
        sidebarConnectionTimers.push(() => callback(...args));
        return sidebarConnectionTimers.length;
      }
      return nativeSetTimeout(callback, delay, ...args);
    };
  });
  const sidebarReady = sidebarTimeoutMessages.find((message) => message.type === 'nativeReady');
  sidebarTimeoutDom.window.dispatchEvent(new sidebarTimeoutDom.window.MessageEvent('message', {
    data: { type: 'startWebRtc', clientId: sidebarReady.clientId }
  }));
  await Promise.resolve();
  await Promise.resolve();
  await new Promise((resolve) => setImmediate(resolve));
  assert.strictEqual(sidebarConnectionTimers.length, 1);
  sidebarConnectionTimers[0]();
  const sidebarTimeout = sidebarTimeoutMessages.find((message) => message.type === 'webrtcTimeout');
  assert(sidebarTimeout);
  assert.strictEqual(sidebarTimeout.clientId, sidebarReady.clientId);
  assert.strictEqual(sidebarTimeout.documentId, sidebarReady.documentId);
  console.log('sidebarView.test OK');
})().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
