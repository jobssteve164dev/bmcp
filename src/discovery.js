const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');

function writeMcpLauncher(directory, entry) {
  fs.mkdirSync(directory, { recursive: true, mode: 0o700 });
  const file = path.join(directory, 'mcp.js');
  fs.writeFileSync(file, `require(${JSON.stringify(path.resolve(entry))});\n`, { mode: 0o600 });
  return file;
}

function publishInstance(directory, record) {
  fs.mkdirSync(directory, { recursive: true, mode: 0o700 });
  const file = path.join(directory, `${record.instanceId}.json`);
  fs.writeFileSync(file, JSON.stringify(record), { mode: 0o600 });
  return () => { try { fs.unlinkSync(file); } catch (error) { if (error.code !== 'ENOENT') throw error; } };
}

function defaultRegistries() {
  if (process.env.SOLOBROWSER_REGISTRY) return [process.env.SOLOBROWSER_REGISTRY];
  const home = os.homedir();
  const bases = [
    path.join(home, '.local/share/code-server'), path.join(home, '.config/Code'),
    path.join(home, '.config/Cursor'), path.join(home, '.vscode-server/data'),
    path.join(home, 'Library/Application Support/Code'), path.join(home, 'Library/Application Support/Cursor'),
    ...(process.env.APPDATA ? [path.join(process.env.APPDATA, 'Code'), path.join(process.env.APPDATA, 'Cursor')] : [])
  ];
  return bases.map(base => path.join(base, 'User/globalStorage/szlk.solobrowser/instances'));
}

async function discoverInstances(directories = defaultRegistries()) {
  const candidates = [];
  for (const directory of directories) {
    let files;
    try { files = fs.readdirSync(directory); } catch { continue; }
    for (const file of files.filter(file => file.endsWith('.json'))) {
      try {
        const record = JSON.parse(fs.readFileSync(path.join(directory, file), 'utf8'));
        if (Number.isInteger(record.port) && record.port > 0 && record.port < 65536 && record.instanceId) candidates.push(record);
      } catch { /* A process can disappear while its record is being read. */ }
    }
  }
  const results = await Promise.all(candidates.map(async record => {
    try {
      const baseUrl = `http://127.0.0.1:${record.port}`;
      const response = await fetch(`${baseUrl}/health`, { signal: AbortSignal.timeout(1500), redirect: 'error' });
      const health = await response.json();
      if (response.ok && health.ok && health.name === 'SoloBrowser' && health.instanceId === record.instanceId) return { ...health, baseUrl };
    } catch { /* Ignore stale registrations, never adopt a different service at the same port. */ }
  }));
  return Array.from(new Map(results.filter(Boolean).map(item => [item.instanceId, item])).values());
}

function selectInstance(instances, options = {}) {
  let choices = instances;
  if (options.instanceId) choices = choices.filter(item => item.instanceId === options.instanceId);
  else if (options.workspace) {
    const requested = path.resolve(options.workspace);
    choices = choices.filter(item => (item.workspaces || []).some(root => {
      const relative = path.relative(path.resolve(root), requested);
      return relative === '' || (!relative.startsWith(`..${path.sep}`) && relative !== '..' && !path.isAbsolute(relative));
    }));
  }
  if (!choices.length) throw new Error('No matching SoloBrowser instance is available for this workspace. Open SoloBrowser in the IDE or list instances.');
  if (choices.length === 1) return choices[0];
  const visible = choices.filter(item => item.panelVisible);
  if (visible.length === 1) return visible[0];
  throw new Error('Multiple SoloBrowser windows match. Use browser_instances and browser_select_instance to choose one.');
}

module.exports = { publishInstance, discoverInstances, selectInstance, defaultRegistries, writeMcpLauncher };
