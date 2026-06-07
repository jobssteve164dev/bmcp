const assert = require('assert');
const Module = require('module');

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

const provider = new __test.BmcpWebviewViewProvider({ scheme: 'test', path: '/extension' });
const html = provider._getHtmlForWebview();

assert.strictEqual(__test.normalizeUrlInput('youtube.com'), 'https://youtube.com');
assert.strictEqual(__test.normalizeTarget('youtube.com').url, 'https://youtube.com');
assert(html.includes("vscode.postMessage({ type: 'openNative'"));
assert(html.includes("vscode.postMessage({ type: 'nativeInput'"));
assert(html.includes("vscode.postMessage({ type: 'webrtcOffer'"));
assert(html.includes('<video id="stream" autoplay playsinline muted></video>'));
assert(html.includes('media-src blob:'));
assert(!html.includes('<iframe'));
assert(!html.includes('/proxy?url='));
assert(!html.includes('http://localhost:'));

console.log('sidebarView.test OK');
