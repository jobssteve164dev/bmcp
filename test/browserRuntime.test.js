const assert = require('assert');
const vm = require('vm');
const {
  CHROME_FOR_TESTING_VERSION,
  DEFAULT_IDLE_TIMEOUT_MS,
  captureManifest,
  captureOffscreenScript,
  captureServiceWorker,
  CdpClient,
  createSingleFlight,
  createRuntimeNavigator,
  deriveRuntimeMetadataFromCommandLine,
  isReusableRuntimeMetadata,
  needsVirtualDisplay,
  normalizeBrowserCandidates,
  pageWebRtcCloseSource,
  pageWebRtcSource,
  profileLockCanBeQuarantined,
  profileLockIsStale,
  requiresNoSandbox,
  runtimeClientBlocksTermination,
  runtimeIdentityArgs,
  runtimeLeaseCanBeReclaimed,
  runtimeProcessCanBeTerminated,
  sameBrowserRuntimeInstance,
  stoppingRuntimeHasExited,
  setBrowserRuntimeIdle,
  waitForPageCaptureReady
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
const offscreenScript = captureOffscreenScript();
new vm.Script(offscreenScript, { filename: 'capture-offscreen.js' });
assert(offscreenScript.includes('const peers = new Map()'));
assert(offscreenScript.includes('message.clientId'));
assert(offscreenScript.includes('message.connectionId'));

assert.strictEqual(needsVirtualDisplay('linux', {}), true);
assert.strictEqual(needsVirtualDisplay('linux', { DISPLAY: ':1' }), false);
assert.strictEqual(needsVirtualDisplay('linux', { WAYLAND_DISPLAY: 'wayland-0' }), false);
assert.strictEqual(needsVirtualDisplay('darwin', {}), false);

assert.strictEqual(profileLockIsStale({ pidAlive: false, socketAlive: false }), true);
assert.strictEqual(profileLockIsStale({ pidAlive: true, socketAlive: false }), false);
assert.strictEqual(profileLockIsStale({ pidAlive: false, socketAlive: true }), false);
assert.strictEqual(profileLockCanBeQuarantined({
  currentHost: 'local',
  lockHost: 'local',
  pidAlive: false,
  socketAlive: false
}), true);
assert.strictEqual(profileLockCanBeQuarantined({
  currentHost: 'local',
  lockHost: 'remote',
  pidAlive: false,
  socketAlive: false
}), false);

assert.strictEqual(runtimeClientBlocksTermination({
  host: 'local',
  pid: 123,
  processStartIdentity: 'start-1',
  runtimeId: 'runtime-1'
}, 'runtime-1', {
  currentHost: 'local',
  pidAlive: true,
  processStartIdentity: 'start-1'
}), true);
assert.strictEqual(runtimeClientBlocksTermination({
  host: 'local',
  pid: 123,
  processStartIdentity: 'start-1',
  runtimeId: 'runtime-1'
}, 'runtime-2', {
  currentHost: 'local',
  pidAlive: true,
  processStartIdentity: 'start-1'
}), false);
assert.strictEqual(runtimeClientBlocksTermination({
  host: 'remote',
  pid: 123,
  processStartIdentity: 'remote-start',
  runtimeId: 'runtime-1'
}, 'runtime-1', {
  currentHost: 'local',
  pidAlive: false,
  processStartIdentity: ''
}), true);
assert.strictEqual(runtimeClientBlocksTermination({
  host: 'local',
  pid: 123,
  processStartIdentity: 'old-start',
  runtimeId: 'runtime-1'
}, 'runtime-1', {
  currentHost: 'local',
  pidAlive: true,
  processStartIdentity: 'new-start'
}), false);

assert.strictEqual(runtimeLeaseCanBeReclaimed({
  host: 'local', pid: 123, processStartIdentity: 'old-start'
}, { currentHost: 'local', pidAlive: true, processStartIdentity: 'new-start' }), true);
assert.strictEqual(runtimeLeaseCanBeReclaimed({
  host: 'remote', pid: 123, processStartIdentity: 'remote-start'
}, { currentHost: 'local', pidAlive: false, processStartIdentity: '' }), false);
assert.strictEqual(runtimeLeaseCanBeReclaimed({ pid: 123 }, {
  currentHost: 'local', pidAlive: false, processStartIdentity: ''
}), false);

assert.strictEqual(isReusableRuntimeMetadata({
  browserPid: 123,
  browserStartIdentity: 'browser-start',
  host: 'local',
  remoteDebuggingPort: 17433,
  runtimeId: 'runtime-1',
  userDataDir: '/profile'
}, '/profile', {
  currentHost: 'local',
  pidAlive: true,
  processStartIdentity: 'browser-start'
}), true);
assert.strictEqual(isReusableRuntimeMetadata({
  browserPid: 123,
  browserStartIdentity: 'browser-start',
  host: 'local',
  remoteDebuggingPort: 17433,
  runtimeId: 'runtime-1',
  userDataDir: '/other-profile'
}, '/profile', {
  currentHost: 'local',
  pidAlive: true,
  processStartIdentity: 'browser-start'
}), false);
assert.strictEqual(isReusableRuntimeMetadata({
  browserPid: 123,
  browserStartIdentity: 'browser-start',
  host: 'remote',
  remoteDebuggingPort: 17433,
  runtimeId: 'runtime-1',
  userDataDir: '/profile'
}, '/profile', {
  currentHost: 'local',
  pidAlive: true,
  processStartIdentity: 'browser-start'
}), false);
assert.strictEqual(isReusableRuntimeMetadata({
  browserPid: 123,
  browserStartIdentity: 'old-start',
  host: 'local',
  remoteDebuggingPort: 17433,
  runtimeId: 'runtime-1',
  userDataDir: '/profile'
}, '/profile', {
  currentHost: 'local',
  pidAlive: true,
  processStartIdentity: 'new-start'
}), false);

const processMetadata = {
  browserPid: 123,
  browserStartIdentity: 'browser-start',
  display: ':123',
  host: 'local',
  remoteDebuggingPort: 17433,
  userDataDir: '/profile',
  xvfbPid: 456,
  xvfbStartIdentity: 'xvfb-start'
};
assert.strictEqual(runtimeProcessCanBeTerminated(processMetadata, 'browser', {
  currentHost: 'local',
  pidAlive: true,
  processStartIdentity: 'browser-start',
  commandLine: ['/usr/bin/chromium', '--remote-debugging-port=17433', '--user-data-dir=/profile']
}), true);
assert.strictEqual(runtimeProcessCanBeTerminated(processMetadata, 'browser', {
  currentHost: 'local',
  pidAlive: true,
  processStartIdentity: 'reused-pid',
  commandLine: ['/usr/bin/unrelated']
}), false);
assert.strictEqual(runtimeProcessCanBeTerminated(processMetadata, 'xvfb', {
  currentHost: 'local',
  pidAlive: true,
  processStartIdentity: 'xvfb-start',
  commandLine: ['/usr/bin/Xvfb', ':123', '-screen', '0', '1280x900x24']
}), true);
assert.strictEqual(runtimeProcessCanBeTerminated(processMetadata, 'xvfb', {
  currentHost: 'remote',
  pidAlive: true,
  processStartIdentity: 'xvfb-start',
  commandLine: ['/usr/bin/Xvfb', ':123']
}), false);

const discoveredGeneration = {
  browserPid: 123,
  browserStartIdentity: 'browser-start',
  host: 'local',
  remoteDebuggingPort: 17433,
  runtimeId: 'discovered-runtime',
  userDataDir: '/profile'
};
assert.strictEqual(sameBrowserRuntimeInstance(discoveredGeneration, {
  ...discoveredGeneration,
  runtimeId: 'owner-runtime'
}), true);
assert.strictEqual(sameBrowserRuntimeInstance(discoveredGeneration, {
  ...discoveredGeneration,
  browserStartIdentity: 'different-start',
  runtimeId: 'owner-runtime'
}), false);
assert.strictEqual(stoppingRuntimeHasExited({
  browserPid: 123,
  browserStartIdentity: 'old-start',
  host: 'local',
  stopping: true
}, {
  currentHost: 'local',
  pidAlive: false,
  processStartIdentity: ''
}), true);
assert.strictEqual(stoppingRuntimeHasExited({
  browserPid: 123,
  browserStartIdentity: 'old-start',
  host: 'local',
  stopping: true
}, {
  currentHost: 'local',
  pidAlive: true,
  processStartIdentity: 'reused-start'
}), true);
assert.strictEqual(stoppingRuntimeHasExited({
  browserPid: 123,
  browserStartIdentity: 'remote-start',
  host: 'remote',
  stopping: true
}, {
  currentHost: 'local',
  pidAlive: false,
  processStartIdentity: ''
}), false);

assert.deepStrictEqual(deriveRuntimeMetadataFromCommandLine(321, [
  '/usr/bin/chromium',
  '--remote-debugging-port=17433',
  '--user-data-dir=/profile'
], '/profile'), {
  browserPid: 321,
  remoteDebuggingPort: 17433,
  userDataDir: '/profile'
});
assert.strictEqual(deriveRuntimeMetadataFromCommandLine(321, [
  '/usr/bin/chromium',
  '--remote-debugging-port=17433',
  '--user-data-dir=/other-profile'
], '/profile'), undefined);

class FakePeerConnection {
  constructor() {
    this.iceGatheringState = 'complete';
    FakePeerConnection.instances.push(this);
  }

  close() {
    this.closed = true;
  }

  addTrack() {}

  async addIceCandidate(candidate) {
    if (!this.candidates) this.candidates = [];
    this.candidates.push(candidate);
  }

  async setRemoteDescription(description) {
    this.remoteDescription = description;
  }

  async createAnswer() {
    return { type: 'answer', sdp: 'answer-sdp' };
  }

  async setLocalDescription() {
    const description = {};
    Object.defineProperty(description, 'type', { value: 'answer', enumerable: false });
    Object.defineProperty(description, 'sdp', { value: 'answer-sdp', enumerable: false });
    description.toJSON = () => ({ type: 'answer', sdp: 'answer-sdp' });
    this.localDescription = description;
  }

  addEventListener() {}
}
FakePeerConnection.instances = [];

(async () => {
  const navigationSocket = {
    on(_event, listener) { this.listener = listener; },
    readyState: 1,
    send() {}
  };
  const navigationClient = new CdpClient(17433, navigationSocket, 'page-1');
  navigationClient.lastSnapshot = { elements: [{ ref: 'e1' }] };
  navigationClient.handleMessage(JSON.stringify({
    method: 'Page.frameNavigated',
    params: { frame: { id: 'main', url: 'https://redirected.example/' } }
  }));
  assert.strictEqual(navigationClient.lastSnapshot, undefined);
  let sameDocumentUrl = '';
  navigationClient.setNavigationListener((frame) => { sameDocumentUrl = frame.url; });
  navigationClient.lastSnapshot = { elements: [{ ref: 'e1' }] };
  navigationClient.handleMessage(JSON.stringify({
    method: 'Page.navigatedWithinDocument',
    params: { frameId: 'main', url: 'https://redirected.example/settings' }
  }));
  assert.strictEqual(navigationClient.lastSnapshot, undefined);
  assert.strictEqual(sameDocumentUrl, 'https://redirected.example/settings');

  const sameDocumentNavigation = navigationClient.waitForMainFrameNavigation(
    async () => ({ ok: true })
  );
  navigationClient.handleMessage(JSON.stringify({
    method: 'Page.navigatedWithinDocument',
    params: { frameId: 'main', url: 'https://redirected.example/settings#profile' }
  }));
  assert.deepStrictEqual(await sameDocumentNavigation, { ok: true });
  assert.strictEqual(navigationClient.eventWaiters.size, 0);

  let viewportAttempts = 0;
  navigationClient.send = async () => {
    viewportAttempts++;
    if (viewportAttempts === 1) throw new Error('Execution context was destroyed.');
    return { result: { value: { deviceWidth: 1280, deviceHeight: 720, url: 'https://final.example/' } } };
  };
  assert.deepStrictEqual(await navigationClient.getViewport(), {
    deviceWidth: 1280,
    deviceHeight: 720,
    url: 'https://final.example/'
  });
  assert.strictEqual(viewportAttempts, 2);

  let readinessChecks = 0;
  await waitForPageCaptureReady(async () => ({
    result: { value: ++readinessChecks >= 2 }
  }), 100, 0);
  assert.strictEqual(readinessChecks, 2);

  const singleFlight = createSingleFlight();
  let startupCalls = 0;
  let finishStartup;
  const firstStartup = singleFlight(() => {
    startupCalls++;
    return new Promise((resolve) => { finishStartup = resolve; });
  });
  const secondStartup = singleFlight(() => {
    startupCalls++;
    return Promise.resolve('unexpected');
  });
  assert.strictEqual(firstStartup, secondStartup);
  assert.strictEqual(startupCalls, 0);
  await Promise.resolve();
  assert.strictEqual(startupCalls, 1);
  finishStartup('shared-runtime');
  assert.strictEqual(await secondStartup, 'shared-runtime');

  const navigateRuntime = createRuntimeNavigator();
  const navigationCalls = [];
  let finishFirstNavigation;
  const navigatedRuntime = {
    cdp: {
      isOpen: () => true,
      async navigate(targetUrl) {
        navigationCalls.push(targetUrl);
        if (targetUrl === 'https://a.example/') {
          await new Promise((resolve) => { finishFirstNavigation = resolve; });
        }
      }
    },
    url: 'https://b.example/'
  };
  const navigateToA = navigateRuntime(navigatedRuntime, 'https://a.example/');
  await new Promise((resolve) => setImmediate(resolve));
  const keepLatestB = navigateRuntime(navigatedRuntime, 'https://b.example/');
  finishFirstNavigation();
  await Promise.all([navigateToA, keepLatestB]);
  assert.deepStrictEqual(navigationCalls, ['https://a.example/', 'https://b.example/']);
  assert.strictEqual(navigatedRuntime.url, 'https://b.example/');

  const recoverFailedNavigation = createRuntimeNavigator();
  const failedNavigationCalls = [];
  let rejectFirstNavigation;
  const uncertainRuntime = {
    cdp: {
      isOpen: () => true,
      async navigate(targetUrl) {
        failedNavigationCalls.push(targetUrl);
        if (targetUrl === 'https://a.example/') {
          await new Promise((_, reject) => { rejectFirstNavigation = reject; });
        }
      }
    },
    url: 'https://b.example/'
  };
  const failedA = recoverFailedNavigation(uncertainRuntime, 'https://a.example/');
  await new Promise((resolve) => setImmediate(resolve));
  const reassertB = recoverFailedNavigation(uncertainRuntime, 'https://b.example/');
  rejectFirstNavigation(new Error('navigation context changed'));
  await Promise.allSettled([failedA, reassertB]);
  assert.deepStrictEqual(failedNavigationCalls, ['https://a.example/', 'https://b.example/']);

  const freshNavigationCalls = [];
  const freshRuntime = {
    cdp: {
      isOpen: () => true,
      async navigate(targetUrl) {
        freshNavigationCalls.push(targetUrl);
      }
    },
    url: 'https://requested.example/'
  };
  await createRuntimeNavigator()(freshRuntime, 'https://requested.example/');
  assert.deepStrictEqual(freshNavigationCalls, ['https://requested.example/']);
  assert.strictEqual(freshRuntime.url, 'https://requested.example/');

  const offscreenMessages = [];
  const offscreenContext = vm.createContext({
    Audio: class Audio {
      play() { return Promise.resolve(); }
    },
    RTCPeerConnection: FakePeerConnection,
    chrome: {
      runtime: {
        onMessage: { addListener() {} },
        sendMessage(message) { offscreenMessages.push(message); }
      }
    },
    navigator: {
      mediaDevices: {
        async getDisplayMedia() {
          return { getTracks: () => [{ kind: 'video', readyState: 'live' }] };
        }
      }
    }
  });
  new vm.Script(offscreenScript, { filename: 'capture-offscreen-runtime.js' }).runInContext(offscreenContext);
  const offscreenPeerStart = FakePeerConnection.instances.length;
  await offscreenContext.startCapture({ clientId: 'client-a', connectionId: 'a-1', offer: { type: 'offer' }, source: 'display' });
  await offscreenContext.startCapture({ clientId: 'client-b', connectionId: 'b-1', offer: { type: 'offer' }, source: 'display' });
  await offscreenContext.startCapture({ clientId: 'client-a', connectionId: 'a-2', offer: { type: 'offer' }, source: 'display' });
  const [firstClientAPeer, clientBPeer] = FakePeerConnection.instances.slice(offscreenPeerStart);
  assert.strictEqual(firstClientAPeer.closed, true);
  assert.strictEqual(clientBPeer.closed, undefined);
  assert.deepStrictEqual(
    offscreenMessages.filter((message) => message.type === 'webrtcAnswer').map((message) => message.connectionId),
    ['a-1', 'b-1', 'a-2']
  );

  const pagePeerStart = FakePeerConnection.instances.length;
  const startPageWebRtc = vm.runInNewContext(`(${pageWebRtcSource()})`, {
    RTCPeerConnection: FakePeerConnection,
    clearTimeout,
    navigator: {
      mediaDevices: {
        async getDisplayMedia() {
          return { getTracks: () => [{ kind: 'video' }] };
        }
      }
    },
    setTimeout,
    window: {}
  });
  const result = await startPageWebRtc({ type: 'offer', sdp: 'offer-sdp' }, 'surface-1');
  assert.deepStrictEqual(
    JSON.parse(JSON.stringify(result.answer)),
    { type: 'answer', sdp: 'answer-sdp' }
  );
  await startPageWebRtc({ type: 'offer', sdp: 'offer-sdp-2' }, 'surface-2');
  assert.strictEqual(FakePeerConnection.instances[pagePeerStart].closed, undefined);
  await startPageWebRtc({ type: 'offer', sdp: 'offer-sdp-3' }, 'surface-1');
  assert.strictEqual(FakePeerConnection.instances[pagePeerStart].closed, true);

  let releaseDisplayStream;
  const queuedWindow = {};
  const queuedStartPageWebRtc = vm.runInNewContext(`(${pageWebRtcSource()})`, {
    RTCPeerConnection: FakePeerConnection,
    clearTimeout,
    navigator: {
      mediaDevices: {
        getDisplayMedia() {
          return new Promise((resolve) => { releaseDisplayStream = resolve; });
        }
      }
    },
    setTimeout,
    window: queuedWindow
  });
  const queuedStart = queuedStartPageWebRtc({ type: 'offer', sdp: 'queued-offer' }, 'queued-surface');
  await Promise.resolve();
  assert.strictEqual(typeof queuedWindow.__bmcpAddCandidate, 'function');
  await queuedWindow.__bmcpAddCandidate('queued-surface', { candidate: 'early-candidate' });
  releaseDisplayStream({ getTracks: () => [{ kind: 'video' }] });
  await queuedStart;
  const queuedPeer = FakePeerConnection.instances.at(-1);
  assert.deepStrictEqual(queuedPeer.candidates, [{ candidate: 'early-candidate' }]);

  let sharedDisplayCalls = 0;
  let releaseSharedDisplay;
  let displayTrackStopped = false;
  const displayTrack = {
    kind: 'video',
    readyState: 'live',
    stop() { displayTrackStopped = true; this.readyState = 'ended'; }
  };
  const sharedWindow = {};
  const sharedStartPageWebRtc = vm.runInNewContext(`(${pageWebRtcSource()})`, {
    RTCPeerConnection: FakePeerConnection,
    clearTimeout,
    navigator: {
      mediaDevices: {
        getDisplayMedia() {
          sharedDisplayCalls++;
          return new Promise((resolve) => { releaseSharedDisplay = resolve; });
        }
      }
    },
    setTimeout,
    window: sharedWindow
  });
  const firstSurfaceStart = sharedStartPageWebRtc({ type: 'offer', sdp: 'surface-a' }, 'surface-a', 'surface-a:1');
  const secondSurfaceStart = sharedStartPageWebRtc({ type: 'offer', sdp: 'surface-b' }, 'surface-b', 'surface-b:1');
  await Promise.resolve();
  assert.strictEqual(sharedDisplayCalls, 1);
  releaseSharedDisplay({ getTracks: () => [displayTrack] });
  await Promise.all([firstSurfaceStart, secondSurfaceStart]);
  const closePageWebRtc = vm.runInNewContext(`(${pageWebRtcCloseSource()})`, { window: sharedWindow });
  closePageWebRtc('surface-a');
  assert.strictEqual(displayTrackStopped, false);
  closePageWebRtc('surface-b');
  assert.strictEqual(displayTrackStopped, true);

  let failedTrackStopped = false;
  class FailingPeerConnection extends FakePeerConnection {
    async setRemoteDescription() {
      throw new Error('invalid offer');
    }
  }
  const failedWindow = {};
  const failedStartPageWebRtc = vm.runInNewContext(`(${pageWebRtcSource()})`, {
    RTCPeerConnection: FailingPeerConnection,
    clearTimeout,
    navigator: {
      mediaDevices: {
        async getDisplayMedia() {
          return {
            getTracks: () => [{
              readyState: 'live',
              stop() { failedTrackStopped = true; }
            }]
          };
        }
      }
    },
    setTimeout,
    window: failedWindow
  });
  const failedResult = await failedStartPageWebRtc({ type: 'offer' }, 'failed-surface', 'failed-surface:1');
  assert.strictEqual(failedResult.ok, false);
  assert.strictEqual(failedWindow.__bmcpPeers.size, 0);
  assert.strictEqual(failedTrackStopped, true);
  console.log('browserRuntime.test OK');
})().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
