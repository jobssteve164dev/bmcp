#!/usr/bin/env node
// MCP stdio, protocol 2025-11-25 (also negotiates the previous compatible versions).
const readline = require('node:readline');
const { tools, validateArguments } = require('../src/controlTools.js');
const { discoverInstances, selectInstance } = require('../src/discovery.js');
const { version } = require('../package.json');

let initialized = false;
let selectedId;
const workspace = process.env.SOLOBROWSER_WORKSPACE || process.cwd();

async function dispatch(message) {
  if (message.method === 'initialize') {
    initialized = true;
    const supported = ['2025-11-25', '2025-06-18', '2025-03-26', '2024-11-05'];
    return { protocolVersion: supported.includes(message.params?.protocolVersion) ? message.params.protocolVersion : supported[0], capabilities: { tools: {} }, serverInfo: { name: 'SoloBrowser', version } };
  }
  if (message.method === 'ping') return {};
  if (!initialized) throw Object.assign(new Error('Initialize the MCP connection first.'), { code: -32000 });
  if (message.method === 'tools/list') return { tools };
  if (message.method !== 'tools/call') throw Object.assign(new Error('Method not found.'), { code: -32601 });
  const tool = tools.find(tool => tool.name === message.params?.name);
  if (!tool) throw Object.assign(new Error('Unknown tool.'), { code: -32602 });
  const args = message.params.arguments || {};
  try { validateArguments(tool, args); } catch (error) { throw Object.assign(error, { code: -32602 }); }
  try {
    const instances = await discoverInstances();
    let result;
    if (tool.name === 'browser_instances') result = { instances };
    else if (tool.name === 'browser_select_instance') {
      const instance = selectInstance(instances, { instanceId: args.instanceId });
      selectedId = instance.instanceId;
      result = instance;
    } else {
      const instance = selectInstance(instances, selectedId ? { instanceId: selectedId } : { workspace });
      selectedId = instance.instanceId;
      const action = tool.name.slice('browser_'.length);
      const response = await fetch(`${instance.baseUrl}/${action}`, {
        method: 'POST', headers: { 'content-type': 'application/json', 'x-solobrowser-instance': selectedId },
        body: JSON.stringify(args), redirect: 'error', signal: AbortSignal.timeout(Math.max(30000, (args.timeoutMs || 0) + 5000))
      });
      const body = await response.json();
      if (!response.ok || !body.ok) throw new Error(body.error || `SoloBrowser HTTP ${response.status}`);
      result = body.snapshot || body.result;
    }
    if (tool.name === 'browser_screenshot') return { content: [{ type: 'image', mimeType: result.mimeType, data: result.data }] };
    return { content: [{ type: 'text', text: JSON.stringify(result) }] };
  } catch (error) { return { isError: true, content: [{ type: 'text', text: error.message }] }; }
}

const input = readline.createInterface({ input: process.stdin, crlfDelay: Infinity });
let queue = Promise.resolve();
input.on('line', line => {
  queue = queue.then(async () => {
    let message;
    try { message = JSON.parse(line); } catch { process.stdout.write(JSON.stringify({ jsonrpc: '2.0', id: null, error: { code: -32700, message: 'Parse error.' } }) + '\n'); return; }
    if (!message || message.jsonrpc !== '2.0' || typeof message.method !== 'string') {
      process.stdout.write(JSON.stringify({ jsonrpc: '2.0', id: message?.id ?? null, error: { code: -32600, message: 'Invalid request.' } }) + '\n'); return;
    }
    if (message.id === undefined) return;
    let response;
    try { response = { result: await dispatch(message) }; }
    catch (error) { response = { error: { code: error.code || -32603, message: error.message } }; }
    process.stdout.write(JSON.stringify({ jsonrpc: '2.0', id: message.id, ...response }) + '\n');
  }).catch(error => process.stderr.write(`${error.message}\n`));
});
