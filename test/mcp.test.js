const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { spawn } = require('node:child_process');
const readline = require('node:readline');

(async () => {
  const entry = path.join(__dirname, '../scripts/mcp.js');
  assert(fs.existsSync(entry), 'Local MCP entry must exist');
  const { writeMcpLauncher } = require('../src/discovery.js');
  assert.equal(typeof writeMcpLauncher, 'function', 'MCP configuration needs a stable upgrade-safe launcher');
  const launcher = writeMcpLauncher(fs.mkdtempSync(path.join(require('node:os').tmpdir(), 'solo-mcp-launcher-')), entry);
  const child = spawn(process.execPath, [launcher], { stdio: ['pipe', 'pipe', 'inherit'] });
  const lines = readline.createInterface({ input: child.stdout });
  const pending = new Map();
  let id = 0;
  lines.on('line', line => { const message = JSON.parse(line); pending.get(message.id)?.(message); pending.delete(message.id); });
  const call = (method, params = {}) => new Promise(resolve => { const key = ++id; pending.set(key, resolve); child.stdin.write(JSON.stringify({ jsonrpc: '2.0', id: key, method, params }) + '\n'); });
  try {
    assert.equal((await call('initialize', { protocolVersion: '2025-11-25', capabilities: {}, clientInfo: { name: 'test', version: '1' } })).result.serverInfo.name, 'SoloBrowser');
    child.stdin.write(JSON.stringify({ jsonrpc: '2.0', method: 'notifications/initialized' }) + '\n');
    const list = await call('tools/list');
    for (const name of ['browser_instances', 'browser_open', 'browser_type', 'browser_press', 'browser_wait', 'browser_screenshot', 'browser_tabs', 'browser_upload']) assert(list.result.tools.some(t => t.name === name));
    const bad = await call('tools/call', { name: 'not_a_tool' });
    assert.equal(bad.error.code, -32602);
    const ping = await call('ping');
    assert.deepEqual(ping.result, {});
    console.log('mcp.test OK (stdio initialize/tools/list/error/ping)');
  } finally { child.stdin.end(); lines.close(); child.kill(); }
})().catch(e => { console.error(e); process.exitCode = 1; });
