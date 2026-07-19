const assert = require('assert');
const vm = require('vm');
const {
  CHROME_FOR_TESTING_VERSION,
  DEFAULT_IDLE_TIMEOUT_MS,
  captureManifest,
  captureOffscreenScript,
  captureServiceWorker,
  normalizeBrowserCandidates,
  requiresNoSandbox,
  runtimeIdentityArgs,
  setBrowserRuntimeIdle
} = require('../src/browserRuntime');

const manifest = captureManifest();
const candidates = normalizeBrowserCandidates();

assert(/^\d+\.\d+\.\d+\.\d+$/.test(CHROME_FOR_TESTING_VERSION));
assert.strictEqual(DEFAULT_IDLE_TIMEOUT_MS, 5 * 60 * 1000);
assert.strictEqual(typeof setBrowserRuntimeIdle, 'function');
assert.strictEqual(manifest.manifest_version, 3);
assert(manifest.permissions.includes('offscreen'));
assert(manifest.permissions.includes('debugger'));
assert(manifest.permissions.includes('tabs'));
assert(!manifest.permissions.includes('tabCapture'));
assert(!manifest.permissions.includes('desktopCapture'));
assert(!manifest.permissions.includes('activeTab'));
assert(!manifest.host_permissions);
assert(Array.isArray(candidates.paths));
assert(Array.isArray(candidates.commands));
assert(candidates.paths.length > 0 || candidates.commands.length > 0);
const identityArgs = runtimeIdentityArgs();
assert(!identityArgs.some((arg) => arg.startsWith('--user-agent=')));
assert(!identityArgs.includes('--enable-automation'));
assert(!identityArgs.includes('--disable-blink-features=AutomationControlled'));
assert(!identityArgs.includes('--auto-select-desktop-capture-source=Entire screen'));
assert(!identityArgs.includes('--enable-usermedia-screen-capturing'));
assert(!identityArgs.includes('--allow-http-screen-capture'));
assert.strictEqual(typeof requiresNoSandbox(), 'boolean');
new vm.Script(captureServiceWorker('ws://127.0.0.1:17333/runtime'), { filename: 'capture-service-worker.js' });
new vm.Script(captureOffscreenScript(), { filename: 'capture-offscreen.js' });

console.log('browserRuntime.test OK');
