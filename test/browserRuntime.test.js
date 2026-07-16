const assert = require('assert');
const {
  CHROME_FOR_TESTING_VERSION,
  captureManifest,
  normalizeBrowserCandidates,
  requiresNoSandbox,
  runtimeIdentityArgs
} = require('../src/browserRuntime');

const manifest = captureManifest();
const candidates = normalizeBrowserCandidates();

assert(/^\d+\.\d+\.\d+\.\d+$/.test(CHROME_FOR_TESTING_VERSION));
assert.strictEqual(manifest.manifest_version, 3);
assert(manifest.permissions.includes('offscreen'));
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

console.log('browserRuntime.test OK');
