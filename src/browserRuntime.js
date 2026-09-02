const fs = require('fs');
const http = require('http');
const https = require('https');
const os = require('os');
const path = require('path');
const { randomUUID } = require('crypto');
const { execFile, execFileSync, spawn } = require('child_process');
const extract = require('extract-zip');
const WebSocket = require('ws');

const CHROME_FOR_TESTING_VERSION = '149.0.7827.54';
const DEFAULT_RUNTIME_PORT = 17433;
const DEFAULT_IDLE_TIMEOUT_MS = 5 * 60 * 1000;
const RUNTIME_METADATA_FILE = 'runtime.json';
const RUNTIME_STARTUP_LEASE_FILE = 'runtime-startup.json';
const RUNTIME_CLIENTS_DIR = 'runtime-clients';
const RUNTIME_MEMBERSHIP_LEASE_FILE = 'runtime-membership.json';
const RUNTIME_HOST = os.hostname();
const RUNTIME_PROCESS_START_IDENTITY = readProcessStartIdentity(process.pid);
const RUNTIME_CLIENT_ID = `${RUNTIME_HOST.replace(/[^a-zA-Z0-9._-]/g, '_')}-${process.pid}-${randomUUID()}`;

let runtimeProcess;
let runtime;
let runtimeIdle = false;
let idleTimer;
let virtualDisplayProcess;
let virtualDisplayValue = '';
let virtualDisplayStartIdentity = '';
let runtimeStartupPromise;
let runtimeClosePromise;
let runtimeCloseForce = false;
let runtimeCloseRetryTimer;
let runtimeActivityEpoch = 0;
const runRuntimeStartup = createSingleFlight();
const navigateRuntime = createRuntimeNavigator();

async function ensureBrowserRuntime(options) {
  runtimeActivityEpoch++;
  refreshIdleTimer();
  if (runtime?.cdp?.isOpen()) {
    await navigateRuntime(runtime, options.url);
    return runtime;
  }

  const startupPromise = runRuntimeStartup(() => startOrAttachBrowserRuntime(options));
  runtimeStartupPromise = startupPromise;
  let activeRuntime;
  try {
    activeRuntime = await startupPromise;
  } finally {
    if (runtimeStartupPromise === startupPromise) runtimeStartupPromise = undefined;
  }
  await navigateRuntime(activeRuntime, options.url);
  return activeRuntime;
}

function createSingleFlight() {
  let active;
  return (operation) => {
    if (!active) {
      active = Promise.resolve().then(operation).finally(() => {
        active = undefined;
      });
    }
    return active;
  };
}

function createRuntimeNavigator() {
  let queue = Promise.resolve();
  let latestQueuedTarget = '';
  const initializedRuntimes = new WeakSet();
  return (activeRuntime, targetUrl) => {
    const reassertTarget = Boolean(
      targetUrl && latestQueuedTarget && latestQueuedTarget !== targetUrl
    );
    if (targetUrl) latestQueuedTarget = targetUrl;
    const operation = queue.catch(() => {}).then(async () => {
      if (!targetUrl || !activeRuntime?.cdp?.isOpen()) return activeRuntime;
      if (
        reassertTarget
        || targetUrl !== activeRuntime.url
        || !initializedRuntimes.has(activeRuntime)
      ) {
        await activeRuntime.cdp.navigate(targetUrl);
        activeRuntime.url = targetUrl;
        initializedRuntimes.add(activeRuntime);
      }
      return activeRuntime;
    });
    queue = operation;
    return operation;
  };
}

async function startOrAttachBrowserRuntime(options) {
  const storagePath = options.storagePath;
  fs.mkdirSync(storagePath, { recursive: true });

  if (runtime?.cdp?.isOpen()) {
    return runtime;
  }

  const browserPath = await resolveBrowserPath(options);
  const extensionPath = '';
  const userDataDir = path.join(storagePath, 'profile');
  fs.mkdirSync(userDataDir, { recursive: true });

  const attached = await tryAttachExistingRuntime({
    browserPath,
    extensionPath,
    storagePath,
    url: options.url,
    userDataDir
  });
  if (attached) return attached;

  const startupLeasePath = acquireRuntimeStartupLease(storagePath);
  if (!startupLeasePath) {
    const shared = await waitForSharedRuntime({
      browserPath,
      extensionPath,
      storagePath,
      url: options.url,
      userDataDir
    });
    if (shared) return shared;
    throw new Error('SoloBrowser timed out waiting for the shared browser runtime to start.');
  }

  try {
    await waitForStoppingRuntimeExit(storagePath);
    quarantineStaleProfileLocks(userDataDir);
    const remoteDebuggingPort = await findAvailablePort(DEFAULT_RUNTIME_PORT);
    const display = await ensureVirtualDisplay();

    const runtimeArgs = [
      `--remote-debugging-port=${remoteDebuggingPort}`,
      `--user-data-dir=${userDataDir}`,
      ...runtimeIdentityArgs(),
      'about:blank'
    ];
    if (requiresNoSandbox()) {
      runtimeArgs.splice(runtimeArgs.length - 1, 0, '--no-sandbox');
    }

    runtimeProcess = spawn(browserPath, runtimeArgs, {
      detached: false,
      env: display.env,
      stdio: ['ignore', 'ignore', 'pipe']
    });
    let startupError = '';
    runtimeProcess.stderr.on('data', (chunk) => {
      startupError = `${startupError}${chunk}`.slice(-4000);
    });

    const launchedRuntimeProcess = runtimeProcess;
    runtimeProcess.on('exit', () => {
      if (runtime?.process === launchedRuntimeProcess) runtime.processExited = true;
    });

    const cdp = await CdpClient.connect(remoteDebuggingPort).catch((error) => {
      if (runtimeProcess && !runtimeProcess.killed) runtimeProcess.kill();
      closeVirtualDisplay();
      throw new Error(`${error.message}${startupError ? ` ${startupError.trim()}` : ''}`);
    });
    const metadataPath = path.join(storagePath, RUNTIME_METADATA_FILE);
    const metadata = {
      browserPath,
      browserPid: runtimeProcess.pid,
      browserStartIdentity: readProcessStartIdentity(runtimeProcess.pid),
      display: display.value,
      host: RUNTIME_HOST,
      ownerPid: process.pid,
      remoteDebuggingPort,
      runtimeId: randomUUID(),
      startedAt: new Date().toISOString(),
      userDataDir,
      xvfbPid: display.processPid || 0,
      xvfbStartIdentity: readProcessStartIdentity(display.processPid)
    };
    const membershipLeasePath = await acquireRuntimeMembershipLease(storagePath);
    if (!membershipLeasePath) {
      cdp.close();
      if (runtimeProcess && !runtimeProcess.killed) runtimeProcess.kill();
      closeVirtualDisplay();
      throw new Error('SoloBrowser could not register the browser runtime owner.');
    }
    try {
      const existingMetadata = readJson(metadataPath);
      if (sameBrowserRuntimeInstance(existingMetadata, metadata)) {
        metadata.runtimeId = existingMetadata.runtimeId;
      }
      atomicWriteJson(metadataPath, metadata);
      registerRuntimeClient(storagePath, metadata.runtimeId);
    } finally {
      releaseRuntimeMembershipLease(membershipLeasePath, storagePath);
    }
    runtime = {
      browserPath,
      cdp,
      extensionPath,
      metadataPath,
      owned: true,
      process: runtimeProcess,
      remoteDebuggingPort,
      runtimeId: metadata.runtimeId,
      source: options.browserPath ? 'configured' : browserPath.includes(storagePath) ? 'downloaded' : 'system',
      storagePath,
      url: 'about:blank'
    };
    return runtime;
  } finally {
    releaseRuntimeStartupLease(startupLeasePath, storagePath);
  }
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

function needsVirtualDisplay(platform = process.platform, env = process.env) {
  return platform === 'linux' && !env.DISPLAY && !env.WAYLAND_DISPLAY;
}

async function ensureVirtualDisplay() {
  if (!needsVirtualDisplay()) {
    return { env: process.env, processPid: 0, value: process.env.DISPLAY || process.env.WAYLAND_DISPLAY || '' };
  }
  if (
    virtualDisplayProcess
    && !virtualDisplayProcess.killed
    && virtualDisplayProcess.exitCode === null
    && virtualDisplayValue
  ) {
    return {
      env: { ...process.env, DISPLAY: virtualDisplayValue },
      processPid: virtualDisplayProcess.pid,
      value: virtualDisplayValue
    };
  }

  const xvfbPath = ['/usr/bin/Xvfb', '/usr/local/bin/Xvfb'].find((candidate) => fs.existsSync(candidate))
    || await resolveCommand('Xvfb');
  if (!xvfbPath) {
    throw new Error('SoloBrowser needs an X display in this remote workspace, but Xvfb is not installed.');
  }

  for (let number = 100; number < 150; number++) {
    const socketPath = `/tmp/.X11-unix/X${number}`;
    const lockPath = `/tmp/.X${number}-lock`;
    if (pathExists(socketPath) || pathExists(lockPath)) continue;

    const displayValue = `:${number}`;
    const child = spawn(xvfbPath, [displayValue, '-screen', '0', '1280x900x24', '-ac', '-nolisten', 'tcp'], {
      detached: false,
      stdio: ['ignore', 'ignore', 'pipe']
    });
    let startupError = '';
    child.stderr.on('data', (chunk) => {
      startupError = `${startupError}${chunk}`.slice(-2000);
    });
    if (await waitForPath(socketPath, child, 5000)) {
      virtualDisplayProcess = child;
      virtualDisplayValue = displayValue;
      virtualDisplayStartIdentity = readProcessStartIdentity(child.pid);
      return { env: { ...process.env, DISPLAY: displayValue }, processPid: child.pid, value: displayValue };
    }
    if (!child.killed) child.kill();
    if (startupError && number === 149) {
      throw new Error(`SoloBrowser could not start Xvfb: ${startupError.trim()}`);
    }
  }
  throw new Error('SoloBrowser could not find a free virtual display.');
}

function waitForPath(targetPath, child, timeoutMs) {
  return new Promise((resolve) => {
    const started = Date.now();
    const check = () => {
      if (pathExists(targetPath)) return resolve(true);
      if (child.exitCode !== null || Date.now() - started >= timeoutMs) return resolve(false);
      setTimeout(check, 50);
    };
    check();
  });
}

function closeVirtualDisplay() {
  if (
    virtualDisplayProcess
    && !virtualDisplayProcess.killed
    && processIsAlive(virtualDisplayProcess.pid)
    && virtualDisplayStartIdentity
    && readProcessStartIdentity(virtualDisplayProcess.pid) === virtualDisplayStartIdentity
  ) {
    const commandLine = readProcessCommandLine(virtualDisplayProcess.pid);
    if (
      path.basename(String(commandLine[0] || '')).toLowerCase() === 'xvfb'
      && commandLine.includes(virtualDisplayValue)
    ) {
      virtualDisplayProcess.kill();
    }
  }
  virtualDisplayProcess = undefined;
  virtualDisplayValue = '';
  virtualDisplayStartIdentity = '';
}

function closeBrowserRuntime(options = {}) {
  const force = Boolean(options.force);
  if (runtimeClosePromise) {
    if (force && !runtimeCloseForce) {
      return runtimeClosePromise.then(() => closeBrowserRuntime({ force: true }));
    }
    return runtimeClosePromise;
  }
  const closeEpoch = runtimeActivityEpoch;
  runtimeCloseForce = force;
  runtimeClosePromise = closeBrowserRuntimeOnce(closeEpoch, force).finally(() => {
    runtimeClosePromise = undefined;
    runtimeCloseForce = false;
  });
  return runtimeClosePromise;
}

async function closeBrowserRuntimeOnce(closeEpoch, force) {
  clearTimeout(idleTimer);
  idleTimer = undefined;
  const pendingStartup = runtimeStartupPromise;
  if (pendingStartup) await pendingStartup.catch(() => {});
  if (!force && closeEpoch !== runtimeActivityEpoch) return false;
  const closingRuntime = runtime;
  if (!closingRuntime) return true;
  const membershipLeasePath = await acquireRuntimeMembershipLease(closingRuntime.storagePath);
  if (!membershipLeasePath) {
    scheduleRuntimeCloseRetry(force);
    return false;
  }
  if (!force && closeEpoch !== runtimeActivityEpoch) {
    releaseRuntimeMembershipLease(membershipLeasePath, closingRuntime.storagePath);
    return false;
  }
  if (runtime !== closingRuntime) {
    releaseRuntimeMembershipLease(membershipLeasePath, closingRuntime.storagePath);
    return false;
  }
  try {
    closingRuntime.cdp?.close();
    releaseRuntimeClient(closingRuntime.storagePath);
    const remainingClients = listLiveRuntimeClients(closingRuntime.storagePath, closingRuntime.runtimeId);
    if (remainingClients.length === 0) {
      terminateSharedRuntime(closingRuntime);
      closeVirtualDisplay();
    }
  } finally {
    releaseRuntimeMembershipLease(membershipLeasePath, closingRuntime.storagePath);
  }
  runtime = undefined;
  runtimeProcess = undefined;
  return true;
}

function scheduleRuntimeCloseRetry(force) {
  clearTimeout(runtimeCloseRetryTimer);
  runtimeCloseRetryTimer = setTimeout(() => {
    runtimeCloseRetryTimer = undefined;
    closeBrowserRuntime({ force }).catch(() => {});
  }, 100);
}

async function closeBrowserSurface(clientId) {
  if (!clientId || !runtime?.cdp?.isOpen()) return;
  await runtime.cdp.closePageWebRtc(String(clientId));
}

function terminateSharedRuntime(closingRuntime) {
  const metadata = readJson(closingRuntime.metadataPath);
  if (!metadata?.runtimeId || metadata.runtimeId !== closingRuntime.runtimeId) return;
  atomicWriteJson(closingRuntime.metadataPath, {
    ...metadata,
    stopping: true,
    stoppingAt: new Date().toISOString()
  });
  for (const kind of ['browser', 'xvfb']) {
    if (!runtimeProcessCanBeTerminated(metadata, kind)) continue;
    const pid = Number(kind === 'browser' ? metadata.browserPid : metadata.xvfbPid);
    try { process.kill(pid, 'SIGTERM'); } catch {}
  }
}

async function waitForStoppingRuntimeExit(storagePath, timeoutMs = 15000) {
  const metadata = readJson(path.join(storagePath, RUNTIME_METADATA_FILE));
  if (!metadata?.stopping) return;
  const started = Date.now();
  while (Date.now() - started < timeoutMs) {
    if (stoppingRuntimeHasExited(metadata)) return;
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  throw new Error('SoloBrowser is still closing the previous browser session. Please retry shortly.');
}

function stoppingRuntimeHasExited(metadata, checks = {}) {
  const currentHost = checks.currentHost ?? RUNTIME_HOST;
  if (!metadata?.host || metadata.host !== currentHost) return false;
  const pidAlive = checks.pidAlive ?? processIsAlive(metadata.browserPid);
  if (!pidAlive) return true;
  const observedStart = String(
    checks.processStartIdentity ?? readProcessStartIdentity(metadata.browserPid)
  );
  return Boolean(
    metadata.browserStartIdentity
    && observedStart
    && metadata.browserStartIdentity !== observedStart
  );
}

function runtimeProcessCanBeTerminated(metadata, kind, checks = {}) {
  if (!metadata || !['browser', 'xvfb'].includes(kind)) return false;
  const currentHost = checks.currentHost ?? RUNTIME_HOST;
  if (!metadata.host || metadata.host !== currentHost) return false;
  const pid = Number(kind === 'browser' ? metadata.browserPid : metadata.xvfbPid);
  const expectedStart = String(kind === 'browser'
    ? metadata.browserStartIdentity || ''
    : metadata.xvfbStartIdentity || '');
  const pidAlive = checks.pidAlive ?? processIsAlive(pid);
  const processStartIdentity = String(
    checks.processStartIdentity ?? readProcessStartIdentity(pid)
  );
  if (!pidAlive || !expectedStart || processStartIdentity !== expectedStart) return false;
  const commandLine = checks.commandLine ?? readProcessCommandLine(pid);
  if (!Array.isArray(commandLine) || commandLine.length === 0) return false;
  const commandText = commandLine.join(' ');
  if (kind === 'browser') {
    return commandText.includes(`--remote-debugging-port=${Number(metadata.remoteDebuggingPort)}`)
      && commandText.includes(`--user-data-dir=${metadata.userDataDir}`);
  }
  return path.basename(firstCommandExecutable(commandLine)).toLowerCase() === 'xvfb'
    && Boolean(metadata.display)
    && commandText.includes(String(metadata.display));
}

function sameBrowserRuntimeInstance(first, second) {
  return Boolean(
    first?.runtimeId
    && first.host
    && first.host === second?.host
    && Number(first.browserPid) === Number(second?.browserPid)
    && first.browserStartIdentity
    && first.browserStartIdentity === second?.browserStartIdentity
    && Number(first.remoteDebuggingPort) === Number(second?.remoteDebuggingPort)
    && first.userDataDir === second?.userDataDir
  );
}

function setBrowserRuntimeIdle(idle, timeoutMs = DEFAULT_IDLE_TIMEOUT_MS) {
  runtimeIdle = Boolean(idle);
  clearTimeout(idleTimer);
  idleTimer = undefined;
  if (!runtimeIdle) {
    clearTimeout(runtimeCloseRetryTimer);
    runtimeCloseRetryTimer = undefined;
  }
  if (runtimeIdle && runtime) {
    idleTimer = setTimeout(() => closeBrowserRuntime().catch(() => {}), timeoutMs);
  }
}

function profileLockIsStale({ pidAlive, socketAlive }) {
  return !pidAlive && !socketAlive;
}

function profileLockCanBeQuarantined({ currentHost, lockHost, pidAlive, socketAlive }) {
  return Boolean(
    lockHost
    && lockHost === currentHost
    && profileLockIsStale({ pidAlive, socketAlive })
  );
}

function quarantineStaleProfileLocks(userDataDir) {
  const lockPath = path.join(userDataDir, 'SingletonLock');
  if (!pathExists(lockPath)) return [];

  let lockTarget = '';
  let socketTarget = '';
  try { lockTarget = fs.readlinkSync(lockPath); } catch {}
  try { socketTarget = fs.readlinkSync(path.join(userDataDir, 'SingletonSocket')); } catch {}
  const match = lockTarget.match(/^(.*)-(\d+)$/);
  const lockHost = match?.[1] || '';
  const lockPid = Number(match?.[2] || 0);
  const pidAlive = lockHost === os.hostname() && processIsAlive(lockPid);
  const socketAlive = Boolean(socketTarget && pathExists(socketTarget));
  if (!profileLockCanBeQuarantined({
    currentHost: os.hostname(),
    lockHost,
    pidAlive,
    socketAlive
  })) return [];

  const quarantineDir = path.join(
    path.dirname(userDataDir),
    'lock-quarantine',
    `${new Date().toISOString().replace(/[:.]/g, '-')}-${process.pid}-${randomUUID()}`
  );
  fs.mkdirSync(quarantineDir, { recursive: true });
  const moved = [];
  for (const name of ['SingletonLock', 'SingletonCookie', 'SingletonSocket']) {
    const source = path.join(userDataDir, name);
    if (!pathExists(source)) continue;
    fs.renameSync(source, path.join(quarantineDir, name));
    moved.push(name);
  }
  return moved;
}

function isReusableRuntimeMetadata(metadata, userDataDir, checks = {}) {
  const pidAlive = checks.pidAlive ?? processIsAlive(metadata?.browserPid);
  const currentHost = checks.currentHost ?? RUNTIME_HOST;
  const processStartIdentity = String(
    checks.processStartIdentity ?? readProcessStartIdentity(metadata?.browserPid)
  );
  return Boolean(
    metadata
    && !metadata.stopping
    && metadata.host === currentHost
    && typeof metadata.runtimeId === 'string'
    && metadata.runtimeId
    && Number.isInteger(Number(metadata.browserPid))
    && Number(metadata.browserPid) > 0
    && typeof metadata.browserStartIdentity === 'string'
    && metadata.browserStartIdentity
    && metadata.browserStartIdentity === processStartIdentity
    && Number.isInteger(Number(metadata.remoteDebuggingPort))
    && Number(metadata.remoteDebuggingPort) > 0
    && metadata.userDataDir === userDataDir
    && pidAlive
  );
}

function deriveRuntimeMetadataFromCommandLine(browserPid, args, userDataDir) {
  const pid = Number(browserPid);
  if (!Number.isInteger(pid) || pid <= 0 || !Array.isArray(args)) return undefined;

  const portPrefix = '--remote-debugging-port=';
  const profilePrefix = '--user-data-dir=';
  const portArgument = args.find((argument) => argument.startsWith(portPrefix));
  const profileArgument = args.find((argument) => argument.startsWith(profilePrefix));
  const remoteDebuggingPort = Number(portArgument?.slice(portPrefix.length));
  const profilePath = profileArgument?.slice(profilePrefix.length);
  if (
    !Number.isInteger(remoteDebuggingPort)
    || remoteDebuggingPort <= 0
    || !profilePath
    || path.resolve(profilePath) !== path.resolve(userDataDir)
  ) {
    return undefined;
  }

  return {
    browserPid: pid,
    remoteDebuggingPort,
    userDataDir
  };
}

function discoverRuntimeFromProfileLock(userDataDir) {
  try {
    const lockTarget = fs.readlinkSync(path.join(userDataDir, 'SingletonLock'));
    const match = lockTarget.match(/^(.*)-(\d+)$/);
    const lockHost = match?.[1] || '';
    const browserPid = Number(match?.[2] || 0);
    if (lockHost !== os.hostname() || !processIsAlive(browserPid)) return undefined;

    const args = fs.readFileSync(`/proc/${browserPid}/cmdline`)
      .toString('utf8')
      .split('\0')
      .filter(Boolean);
    const discovered = deriveRuntimeMetadataFromCommandLine(browserPid, args, userDataDir);
    if (!discovered) return undefined;
    const display = discoverBrowserDisplay(browserPid);
    return {
      ...discovered,
      browserPath: args[0],
      browserStartIdentity: readProcessStartIdentity(browserPid),
      display,
      host: RUNTIME_HOST,
      ownerPid: 0,
      runtimeId: randomUUID(),
      startedAt: new Date().toISOString(),
      xvfbPid: 0,
      xvfbStartIdentity: ''
    };
  } catch (_) {
    return undefined;
  }
}

async function tryAttachExistingRuntime(options) {
  const metadataPath = path.join(options.storagePath, RUNTIME_METADATA_FILE);
  let metadata = readJson(metadataPath);
  if (metadata?.stopping) return undefined;
  if (!isReusableRuntimeMetadata(metadata, options.userDataDir)) {
    if (!profileLockDiscoveryAllowed(options.storagePath)) return undefined;
    metadata = discoverRuntimeFromProfileLock(options.userDataDir);
  }
  if (!isReusableRuntimeMetadata(metadata, options.userDataDir)) return undefined;
  const membershipLeasePath = await acquireRuntimeMembershipLease(options.storagePath);
  if (!membershipLeasePath) return undefined;
  try {
    metadata = readJson(metadataPath);
    if (metadata?.stopping) return undefined;
    if (!isReusableRuntimeMetadata(metadata, options.userDataDir)) {
      if (!profileLockDiscoveryAllowed(options.storagePath)) return undefined;
      metadata = discoverRuntimeFromProfileLock(options.userDataDir);
    }
    if (!isReusableRuntimeMetadata(metadata, options.userDataDir)) return undefined;
    atomicWriteJson(metadataPath, metadata);
    registerRuntimeClient(options.storagePath, metadata.runtimeId);
  } finally {
    releaseRuntimeMembershipLease(membershipLeasePath, options.storagePath);
  }
  try {
    const cdp = await CdpClient.connect(Number(metadata.remoteDebuggingPort));
    runtime = {
      browserPath: metadata.browserPath || options.browserPath,
      cdp,
      extensionPath: options.extensionPath,
      metadataPath,
      owned: false,
      process: undefined,
      remoteDebuggingPort: Number(metadata.remoteDebuggingPort),
      runtimeId: metadata.runtimeId,
      source: 'shared',
      storagePath: options.storagePath,
      url: ''
    };
    return runtime;
  } catch (connectError) {
    const releaseLeasePath = await acquireRuntimeMembershipLease(options.storagePath);
    if (!releaseLeasePath) {
      throw new Error(`SoloBrowser could not unregister a failed shared runtime connection: ${connectError.message}`);
    }
    try {
      releaseRuntimeClient(options.storagePath);
      const remainingClients = listLiveRuntimeClients(options.storagePath, metadata.runtimeId);
      if (remainingClients.length === 0) {
        terminateSharedRuntime({
          metadataPath,
          runtimeId: metadata.runtimeId,
          storagePath: options.storagePath
        });
      }
    } finally {
      releaseRuntimeMembershipLease(releaseLeasePath, options.storagePath);
    }
    return undefined;
  }
}

function profileLockDiscoveryAllowed(storagePath) {
  const leasePath = path.join(storagePath, RUNTIME_STARTUP_LEASE_FILE);
  if (!pathExists(leasePath)) return true;
  return runtimeLeaseCanBeReclaimed(readJson(leasePath));
}

function discoverBrowserDisplay(browserPid) {
  if (process.platform !== 'linux') return '';
  try {
    const environment = fs.readFileSync(`/proc/${Number(browserPid)}/environ`, 'utf8')
      .split('\0')
      .find((entry) => entry.startsWith('DISPLAY='));
    return environment?.slice('DISPLAY='.length) || '';
  } catch (_) {
    return '';
  }
}

async function waitForSharedRuntime(options, timeoutMs = 35000) {
  const started = Date.now();
  while (Date.now() - started < timeoutMs) {
    const attached = await tryAttachExistingRuntime(options);
    if (attached) return attached;
    await new Promise((resolve) => setTimeout(resolve, 250));
  }
  return undefined;
}

function acquireRuntimeStartupLease(storagePath) {
  const leasePath = path.join(storagePath, RUNTIME_STARTUP_LEASE_FILE);
  try {
    const descriptor = fs.openSync(leasePath, 'wx');
    fs.writeFileSync(descriptor, JSON.stringify(runtimeLeaseRecord()));
    fs.closeSync(descriptor);
    return leasePath;
  } catch (error) {
    if (error.code !== 'EEXIST') throw error;
  }

  const lease = readJson(leasePath);
  if (!runtimeLeaseCanBeReclaimed(lease)) return '';
  quarantineFile(leasePath, storagePath, 'runtime-startup');
  return acquireRuntimeStartupLease(storagePath);
}

function releaseRuntimeStartupLease(leasePath, storagePath) {
  if (!leasePath) return;
  const lease = readJson(leasePath);
  if (lease?.ownerId !== RUNTIME_CLIENT_ID) return;
  quarantineFile(leasePath, storagePath, 'runtime-startup-complete');
}

function tryAcquireRuntimeMembershipLease(storagePath) {
  if (!storagePath) return '';
  const leasePath = path.join(storagePath, RUNTIME_MEMBERSHIP_LEASE_FILE);
  try {
    const descriptor = fs.openSync(leasePath, 'wx');
    fs.writeFileSync(descriptor, JSON.stringify(runtimeLeaseRecord()));
    fs.closeSync(descriptor);
    return leasePath;
  } catch (error) {
    if (error.code !== 'EEXIST') throw error;
  }

  const lease = readJson(leasePath);
  if (!runtimeLeaseCanBeReclaimed(lease)) return '';
  quarantineFile(leasePath, storagePath, 'runtime-membership-stale');
  return tryAcquireRuntimeMembershipLease(storagePath);
}

function runtimeLeaseRecord() {
  return {
    host: RUNTIME_HOST,
    ownerId: RUNTIME_CLIENT_ID,
    pid: process.pid,
    processStartIdentity: RUNTIME_PROCESS_START_IDENTITY,
    startedAt: new Date().toISOString()
  };
}

function runtimeLeaseCanBeReclaimed(lease, checks = {}) {
  const currentHost = checks.currentHost ?? RUNTIME_HOST;
  if (!lease?.host || lease.host !== currentHost) return false;
  const pidAlive = checks.pidAlive ?? processIsAlive(lease.pid);
  if (!pidAlive) return true;
  const observedStart = String(
    checks.processStartIdentity ?? readProcessStartIdentity(lease.pid)
  );
  if (!lease.processStartIdentity || !observedStart) return false;
  return String(lease.processStartIdentity) !== observedStart;
}

async function acquireRuntimeMembershipLease(storagePath, timeoutMs = 5000) {
  const started = Date.now();
  while (Date.now() - started < timeoutMs) {
    const leasePath = tryAcquireRuntimeMembershipLease(storagePath);
    if (leasePath) return leasePath;
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  return '';
}

function releaseRuntimeMembershipLease(leasePath, storagePath) {
  if (!leasePath || !storagePath) return;
  const lease = readJson(leasePath);
  if (lease?.ownerId !== RUNTIME_CLIENT_ID) return;
  quarantineFile(leasePath, storagePath, 'runtime-membership-complete');
}

function runtimeClientMarker(storagePath) {
  return path.join(storagePath, RUNTIME_CLIENTS_DIR, `${RUNTIME_CLIENT_ID}.json`);
}

function registerRuntimeClient(storagePath, runtimeId) {
  const clientsPath = path.join(storagePath, RUNTIME_CLIENTS_DIR);
  fs.mkdirSync(clientsPath, { recursive: true });
  atomicWriteJson(runtimeClientMarker(storagePath), {
    clientId: RUNTIME_CLIENT_ID,
    host: RUNTIME_HOST,
    pid: process.pid,
    processStartIdentity: RUNTIME_PROCESS_START_IDENTITY,
    registeredAt: new Date().toISOString(),
    runtimeId
  });
}

function releaseRuntimeClient(storagePath) {
  if (!storagePath) return;
  quarantineFile(runtimeClientMarker(storagePath), storagePath, `runtime-client-${process.pid}`);
}

function runtimeClientBlocksTermination(record, runtimeId, checks = {}) {
  if (!record || !runtimeId || record.runtimeId !== runtimeId) return false;
  const currentHost = checks.currentHost ?? RUNTIME_HOST;
  if (!record.host || record.host !== currentHost) return true;
  const pidAlive = checks.pidAlive ?? processIsAlive(record.pid);
  if (!pidAlive) return false;
  const observedStart = String(
    checks.processStartIdentity ?? readProcessStartIdentity(record.pid)
  );
  if (!record.processStartIdentity || !observedStart) return true;
  return String(record.processStartIdentity) === observedStart;
}

function listLiveRuntimeClients(storagePath, runtimeId) {
  if (!storagePath) return [];
  try {
    return fs.readdirSync(path.join(storagePath, RUNTIME_CLIENTS_DIR))
      .filter((name) => name.endsWith('.json'))
      .map((name) => readJson(path.join(storagePath, RUNTIME_CLIENTS_DIR, name)))
      .filter((record) => runtimeClientBlocksTermination(record, runtimeId));
  } catch (_) {
    return [];
  }
}

function readProcessStartIdentity(pid) {
  const number = Number(pid);
  if (!Number.isInteger(number) || number <= 0) return '';
  try {
    if (process.platform === 'linux') {
      const stat = fs.readFileSync(`/proc/${number}/stat`, 'utf8');
      const fields = stat.slice(stat.lastIndexOf(')') + 2).trim().split(/\s+/);
      return String(fields[19] || '');
    }
    if (process.platform === 'darwin') {
      return execFileSync('/bin/ps', ['-p', String(number), '-o', 'lstart='], {
        encoding: 'utf8',
        stdio: ['ignore', 'pipe', 'ignore']
      }).trim();
    }
    if (process.platform === 'win32') {
      return execFileSync('powershell.exe', [
        '-NoProfile',
        '-NonInteractive',
        '-Command',
        `(Get-Process -Id ${number}).StartTime.ToUniversalTime().Ticks`
      ], {
        encoding: 'utf8',
        stdio: ['ignore', 'pipe', 'ignore']
      }).trim();
    }
    return '';
  } catch (_) {
    return '';
  }
}

function readProcessCommandLine(pid) {
  const number = Number(pid);
  if (!Number.isInteger(number) || number <= 0) return [];
  try {
    if (process.platform === 'linux') {
      return fs.readFileSync(`/proc/${number}/cmdline`, 'utf8').split('\0').filter(Boolean);
    }
    if (process.platform === 'darwin') {
      const command = execFileSync('/bin/ps', ['-p', String(number), '-o', 'command='], {
        encoding: 'utf8',
        stdio: ['ignore', 'pipe', 'ignore']
      }).trim();
      return command ? [command] : [];
    }
    if (process.platform === 'win32') {
      const command = execFileSync('powershell.exe', [
        '-NoProfile',
        '-NonInteractive',
        '-Command',
        `(Get-CimInstance Win32_Process -Filter "ProcessId = ${number}").CommandLine`
      ], {
        encoding: 'utf8',
        stdio: ['ignore', 'pipe', 'ignore']
      }).trim();
      return command ? [command] : [];
    }
    return [];
  } catch (_) {
    return [];
  }
}

function firstCommandExecutable(commandLine) {
  if (!Array.isArray(commandLine) || !commandLine.length) return '';
  if (commandLine.length > 1) return String(commandLine[0] || '');
  const command = String(commandLine[0] || '').trim();
  if (!command.startsWith('"')) return command.split(/\s+/)[0] || '';
  return command.slice(1, command.indexOf('"', 1) > 0 ? command.indexOf('"', 1) : undefined);
}

function processIsAlive(pid) {
  const number = Number(pid);
  if (!Number.isInteger(number) || number <= 0) return false;
  try {
    process.kill(number, 0);
    return true;
  } catch (_) {
    return false;
  }
}

function pathExists(targetPath) {
  try {
    fs.lstatSync(targetPath);
    return true;
  } catch (_) {
    return false;
  }
}

function readJson(file) {
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch (_) {
    return undefined;
  }
}

function atomicWriteJson(file, value) {
  const temporary = `${file}.${process.pid}.${Date.now()}.${randomUUID()}.tmp`;
  fs.writeFileSync(temporary, JSON.stringify(value, null, 2), 'utf8');
  fs.renameSync(temporary, file);
}

function quarantineFile(file, storagePath, prefix) {
  if (!pathExists(file)) return;
  const quarantineDir = path.join(storagePath, 'lock-quarantine');
  fs.mkdirSync(quarantineDir, { recursive: true });
  try {
    fs.renameSync(file, path.join(
      quarantineDir,
      `${prefix}-${Date.now()}-${process.pid}-${randomUUID()}.json`
    ));
  } catch (error) {
    if (error.code !== 'ENOENT') throw error;
  }
}

function refreshIdleTimer(timeoutMs = DEFAULT_IDLE_TIMEOUT_MS) {
  clearTimeout(runtimeCloseRetryTimer);
  runtimeCloseRetryTimer = undefined;
  if (!runtimeIdle) return;
  clearTimeout(idleTimer);
  idleTimer = setTimeout(() => closeBrowserRuntime().catch(() => {}), timeoutMs);
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
      if (message.type === 'stopCapture') chrome.runtime.sendMessage(message);
    } catch (error) {
      send({
        type: 'capture-error',
        clientId: message.clientId,
        connectionId: message.connectionId,
        error: error.message
      });
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
    clientId: message.clientId,
    connectionId: message.connectionId,
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
const peers = new Map();
const peerKeysByClient = new Map();
let displayStream;
let displayStreamPromise;

chrome.runtime.onMessage.addListener((message) => {
  if (message?.type === 'startCapture') startCapture(message).catch((error) => {
    chrome.runtime.sendMessage({
      type: 'capture-error',
      clientId: message.clientId,
      connectionId: message.connectionId,
      error: error.message
    });
  });
  if (message?.type === 'webrtcCandidate' && message.candidate) {
    const peer = peers.get(String(message.connectionId || message.clientId || 'default'));
    if (peer) peer.addIceCandidate(message.candidate).catch(() => {});
  }
  if (message?.type === 'stopCapture') stopCapture(message.clientId);
});

function stopCapture(clientId) {
  const key = peerKeysByClient.get(String(clientId || 'default'));
  const peer = key && peers.get(key);
  if (peer) peer.close();
  if (key) peers.delete(key);
  peerKeysByClient.delete(String(clientId || 'default'));
}

async function startCapture(message) {
  const clientId = String(message.clientId || 'default');
  const connectionId = String(message.connectionId || clientId);
  const previousKey = peerKeysByClient.get(clientId);
  const previousPeer = previousKey && peers.get(previousKey);
  if (previousPeer) {
    previousPeer.close();
    peers.delete(previousKey);
  }
  peerKeysByClient.set(clientId, connectionId);

  const stream = message.source === 'display'
    ? await ensureDisplayStream()
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
  if (peerKeysByClient.get(clientId) !== connectionId) return;

  const audio = new Audio();
  audio.srcObject = stream;
  audio.play().catch(() => {});

  const peer = new RTCPeerConnection({ iceServers: [] });
  peers.set(connectionId, peer);
  peer.onicecandidate = (event) => {
    if (event.candidate) {
      chrome.runtime.sendMessage({
        type: 'webrtcCandidate',
        clientId,
        connectionId,
        candidate: typeof event.candidate.toJSON === 'function' ? event.candidate.toJSON() : event.candidate
      });
    }
  };
  for (const track of stream.getTracks()) {
    peer.addTrack(track, stream);
  }
  await peer.setRemoteDescription(message.offer);
  const answer = await peer.createAnswer();
  await peer.setLocalDescription(answer);
  if (peerKeysByClient.get(clientId) !== connectionId) {
    peer.close();
    peers.delete(connectionId);
    return;
  }
  const localDescription = peer.localDescription;
  chrome.runtime.sendMessage({
    type: 'webrtcAnswer',
    clientId,
    connectionId,
    answer: typeof localDescription?.toJSON === 'function'
      ? localDescription.toJSON()
      : { type: localDescription?.type, sdp: localDescription?.sdp }
  });
  chrome.runtime.sendMessage({ type: 'capture-ready', clientId, connectionId });
}

async function ensureDisplayStream() {
  const streamIsLive = displayStream?.getTracks?.().some((track) => track.readyState === 'live');
  if (streamIsLive) return displayStream;
  if (!displayStreamPromise) {
    displayStreamPromise = navigator.mediaDevices
      .getDisplayMedia({ audio: false, video: { frameRate: 60 } })
      .then((stream) => {
        displayStream = stream;
        return stream;
      })
      .finally(() => {
        displayStreamPromise = undefined;
      });
  }
  return displayStreamPromise;
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

async function waitForPageCaptureReady(send, timeoutMs = 5000, intervalMs = 50) {
  const started = Date.now();
  let lastError;
  while (Date.now() - started < timeoutMs) {
    try {
      const result = await send('Runtime.evaluate', {
        returnByValue: true,
        expression: 'Boolean(navigator.mediaDevices?.getDisplayMedia)'
      });
      if (result.result?.value === true) return;
    } catch (error) {
      lastError = error;
    }
    await new Promise((resolve) => setTimeout(resolve, intervalMs));
  }
  throw new Error(lastError
    ? `SoloBrowser page capture did not become ready: ${lastError.message}`
    : 'SoloBrowser page capture did not become ready before timeout.');
}

class CdpClient {
  constructor(port, pageSocket, pageId) {
    this.port = port;
    this.pageSocket = pageSocket;
    this.pageId = pageId;
    this.nextId = 1;
    this.pending = new Map();
    this.eventWaiters = new Map();
    this.lastSnapshot = undefined;
    this.mainFrameId = '';
    this.mainFrameNavigationListener = undefined;
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
    await client.send('Emulation.clearDeviceMetricsOverride');
    const frameTree = await client.send('Page.getFrameTree');
    client.mainFrameId = frameTree.frameTree?.frame?.id || '';
    return client;
  }

  handleMessage(data) {
    let message;
    try {
      message = JSON.parse(String(data));
    } catch (_) {
      return;
    }
    if (message.method) {
      const waiters = this.eventWaiters.get(message.method) || [];
      const remaining = [];
      for (const waiter of waiters) {
        if (!waiter.predicate || waiter.predicate(message.params || {})) {
          clearTimeout(waiter.timer);
          waiter.resolve(message.params || {});
        } else {
          remaining.push(waiter);
        }
      }
      if (remaining.length) this.eventWaiters.set(message.method, remaining);
      else this.eventWaiters.delete(message.method);
      if (message.method === 'Page.frameNavigated' && !message.params?.frame?.parentId) {
        this.mainFrameId = message.params.frame?.id || this.mainFrameId;
        this.lastSnapshot = undefined;
        Promise.resolve(this.mainFrameNavigationListener?.(message.params.frame)).catch(() => {});
      }
      if (
        message.method === 'Page.navigatedWithinDocument'
        && message.params?.frameId
        && message.params.frameId === this.mainFrameId
      ) {
        this.lastSnapshot = undefined;
        Promise.resolve(this.mainFrameNavigationListener?.({
          id: message.params.frameId,
          url: message.params.url
        })).catch(() => {});
      }
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

  waitForEvent(method, predicate, timeoutMs = 15000) {
    return this.createEventWaiter(method, predicate, timeoutMs).promise;
  }

  createEventWaiter(method, predicate, timeoutMs = 15000) {
    let waiter;
    const promise = new Promise((resolve, reject) => {
      waiter = { predicate, resolve, reject };
      waiter.timer = setTimeout(() => {
        this.cancelEventWaiter(method, waiter);
        reject(new Error(`Timed out waiting for CDP event: ${method}`));
      }, timeoutMs);
      const waiters = this.eventWaiters.get(method) || [];
      waiters.push(waiter);
      this.eventWaiters.set(method, waiters);
    });
    return {
      promise,
      cancel: () => this.cancelEventWaiter(method, waiter)
    };
  }

  cancelEventWaiter(method, waiter) {
    if (!waiter) return;
    clearTimeout(waiter.timer);
    const remaining = (this.eventWaiters.get(method) || []).filter((entry) => entry !== waiter);
    if (remaining.length) this.eventWaiters.set(method, remaining);
    else this.eventWaiters.delete(method);
  }

  setNavigationListener(listener) {
    this.mainFrameNavigationListener = typeof listener === 'function' ? listener : undefined;
  }

  async waitForMainFrameNavigation(action, optional = false) {
    const crossDocument = this.createEventWaiter(
      'Page.frameNavigated',
      (params) => !params.frame?.parentId
    );
    const sameDocument = this.createEventWaiter(
      'Page.navigatedWithinDocument',
      (params) => params.frameId === this.mainFrameId
    );
    try {
      const result = await action();
      try {
        await Promise.race([crossDocument.promise, sameDocument.promise]);
      } catch (error) {
        if (!optional) throw error;
      }
      return result;
    } finally {
      crossDocument.cancel();
      sameDocument.cancel();
    }
  }

  async navigate(targetUrl) {
    this.lastSnapshot = undefined;
    const result = await this.waitForMainFrameNavigation(
      () => this.send('Page.navigate', { url: targetUrl })
    );
    if (result.errorText) throw new Error(`SoloBrowser navigation failed: ${result.errorText}`);
  }

  async command(command) {
    if (command === 'reload') {
      return this.waitForMainFrameNavigation(
        () => this.send('Page.reload', { ignoreCache: false })
      );
    }
    if (command === 'back' || command === 'forward') {
      const history = await this.send('Page.getNavigationHistory');
      const offset = command === 'back' ? -1 : 1;
      const entry = history.entries?.[Number(history.currentIndex) + offset];
      if (!entry) return;
      return this.waitForMainFrameNavigation(
        () => this.send('Page.navigateToHistoryEntry', { entryId: entry.id })
      );
    }
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

  async getViewport() {
    let result;
    for (let attempt = 0; attempt < 8; attempt++) {
      try {
        result = await this.send('Runtime.evaluate', {
          returnByValue: true,
          expression: '({ deviceWidth: window.innerWidth, deviceHeight: window.innerHeight, url: String(location.href) })'
        });
        break;
      } catch (error) {
        if (!isTransientNavigationError(error) || attempt === 7) throw error;
        await new Promise((resolve) => setTimeout(resolve, 100));
      }
    }
    const value = result.result?.value || {};
    return {
      deviceWidth: clampInteger(value.deviceWidth, 320, 3000),
      deviceHeight: clampInteger(value.deviceHeight, 240, 2200),
      url: typeof value.url === 'string' ? value.url : ''
    };
  }

  async startPageWebRtc(offer, clientId = 'default', connectionId = clientId, isCurrent) {
    await waitForPageCaptureReady((method, params) => this.send(method, params));
    if (typeof isCurrent === 'function' && !isCurrent()) {
      return { ok: false, stale: true };
    }
    const result = await this.send('Runtime.evaluate', {
      awaitPromise: true,
      returnByValue: true,
      expression: `(${pageWebRtcSource()})(${JSON.stringify(offer)}, ${JSON.stringify(clientId)}, ${JSON.stringify(connectionId)})`
    });
    const value = result.result?.value;
    if (value?.stale) return value;
    if (!value?.ok) {
      throw new Error(value?.error || 'SoloBrowser could not start current-tab WebRTC capture.');
    }
    return value;
  }

  async addPageWebRtcCandidate(candidate, clientId = 'default') {
    await this.send('Runtime.evaluate', {
      awaitPromise: true,
      expression: `window.__bmcpAddCandidate && window.__bmcpAddCandidate(${JSON.stringify(clientId)}, ${JSON.stringify(candidate)})`
    });
  }

  async closePageWebRtc(clientId) {
    await this.send('Runtime.evaluate', {
      awaitPromise: true,
      expression: `(${pageWebRtcCloseSource()})(${JSON.stringify(clientId)})`
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
    this.mainFrameNavigationListener = undefined;
    if (this.pageSocket.readyState === WebSocket.OPEN) {
      this.pageSocket.close();
    }
  }

  isOpen() {
    return this.pageSocket.readyState === WebSocket.OPEN;
  }
}

function isTransientNavigationError(error) {
  return /execution context was destroyed|cannot find context|inspected target navigated|context.*destroyed/i
    .test(String(error?.message || error || ''));
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
  return async function startBmcpPageWebRtc(offer, clientId = 'default', connectionId = clientId) {
    const surfaceKey = String(clientId || 'default');
    const key = String(connectionId || surfaceKey);
    let peer;
    let keepPeer = false;
    try {
      if (!window.__bmcpPeers) window.__bmcpPeers = new Map();
      if (!window.__bmcpPeerKeysByClient) window.__bmcpPeerKeysByClient = new Map();
      if (!window.__bmcpPendingCandidates) window.__bmcpPendingCandidates = new Map();
      if (!window.__bmcpStartingPeers) window.__bmcpStartingPeers = new Set();
      window.__bmcpStartingPeers.add(key);
      window.__bmcpAddCandidate = async (candidateClientId, candidate) => {
        const candidateKey = String(candidateClientId || 'default');
        const candidatePeer = window.__bmcpPeers.get(candidateKey);
        if (candidatePeer && candidatePeer.remoteDescription) {
          if (candidate) await candidatePeer.addIceCandidate(candidate);
          return;
        }
        const queued = window.__bmcpPendingCandidates.get(candidateKey) || [];
        if (candidate) queued.push(candidate);
        window.__bmcpPendingCandidates.set(candidateKey, queued);
      };
      const previousKey = window.__bmcpPeerKeysByClient.get(surfaceKey);
      const previousPeer = previousKey && window.__bmcpPeers.get(previousKey);
      if (previousPeer) {
        previousPeer.close();
        window.__bmcpPeers.delete(previousKey);
        window.__bmcpPendingCandidates.delete(previousKey);
      }
      window.__bmcpPeerKeysByClient.set(surfaceKey, key);
      const existingStream = window.__bmcpDisplayStream;
      let stream = existingStream?.getTracks?.().some((track) => track.readyState === 'live')
        ? existingStream
        : undefined;
      if (!stream) {
        if (!window.__bmcpDisplayStreamPromise) {
          window.__bmcpDisplayStreamPromise = navigator.mediaDevices.getDisplayMedia({
            audio: false,
            video: { frameRate: 60 },
            preferCurrentTab: true,
            selfBrowserSurface: 'include',
            surfaceSwitching: 'exclude'
          }).then((nextStream) => {
            window.__bmcpDisplayStream = nextStream;
            return nextStream;
          }).finally(() => {
            window.__bmcpDisplayStreamPromise = undefined;
          });
        }
        stream = await window.__bmcpDisplayStreamPromise;
      }
      window.__bmcpDisplayStream = stream;
      if (window.__bmcpPeerKeysByClient.get(surfaceKey) !== key) {
        return { ok: false, stale: true };
      }
      peer = new RTCPeerConnection({ iceServers: [] });
      window.__bmcpPeers.set(key, peer);
      for (const track of stream.getTracks()) {
        peer.addTrack(track, stream);
      }
      await peer.setRemoteDescription(offer);
      const queuedCandidates = window.__bmcpPendingCandidates.get(key) || [];
      window.__bmcpPendingCandidates.delete(key);
      for (const candidate of queuedCandidates) {
        await peer.addIceCandidate(candidate);
      }
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
      const localDescription = peer.localDescription;
      keepPeer = true;
      return {
        ok: true,
        answer: typeof localDescription?.toJSON === 'function'
          ? localDescription.toJSON()
          : { type: localDescription?.type, sdp: localDescription?.sdp }
      };
    } catch (error) {
      return { ok: false, error: `${error.name || 'Error'}: ${error.message || error}` };
    } finally {
      if (!keepPeer) {
        peer?.close();
        if (window.__bmcpPeers?.get(key) === peer) window.__bmcpPeers.delete(key);
        if (window.__bmcpPeerKeysByClient?.get(surfaceKey) === key) {
          window.__bmcpPeerKeysByClient.delete(surfaceKey);
        }
        window.__bmcpPendingCandidates?.delete(key);
      }
      window.__bmcpStartingPeers?.delete(key);
      if ((window.__bmcpPeers?.size || 0) === 0 && (window.__bmcpStartingPeers?.size || 0) === 0) {
        for (const track of window.__bmcpDisplayStream?.getTracks?.() || []) track.stop();
        window.__bmcpDisplayStream = undefined;
        window.__bmcpDisplayStreamPromise = undefined;
        window.__bmcpPendingCandidates?.clear();
      }
    }
  }.toString();
}

function pageWebRtcCloseSource() {
  return function closeBmcpPageWebRtc(clientId) {
    const surfaceKey = String(clientId || 'default');
    const prefix = `${surfaceKey}:`;
    for (const [key, peer] of window.__bmcpPeers || []) {
      if (key === surfaceKey || key.startsWith(prefix)) {
        peer.close();
        window.__bmcpPeers.delete(key);
        window.__bmcpPendingCandidates?.delete(key);
      }
    }
    window.__bmcpPeerKeysByClient?.delete(surfaceKey);
    if ((window.__bmcpPeers?.size || 0) === 0 && (window.__bmcpStartingPeers?.size || 0) === 0) {
      for (const track of window.__bmcpDisplayStream?.getTracks?.() || []) track.stop();
      window.__bmcpDisplayStream = undefined;
      window.__bmcpDisplayStreamPromise = undefined;
      window.__bmcpPendingCandidates?.clear();
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
  CdpClient,
  DEFAULT_IDLE_TIMEOUT_MS,
  captureManifest,
  captureOffscreenScript,
  captureServiceWorker,
  closeBrowserSurface,
  closeBrowserRuntime,
  createSingleFlight,
  createRuntimeNavigator,
  deriveRuntimeMetadataFromCommandLine,
  ensureBrowserRuntime,
  ensureCaptureExtension,
  findSystemBrowser,
  isReusableRuntimeMetadata,
  needsVirtualDisplay,
  normalizeBrowserCandidates: browserCandidates,
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
};
