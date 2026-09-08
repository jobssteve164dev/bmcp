// Opt-in acceptance against a dedicated IDE test window, using only a local fixture.
const assert = require('node:assert/strict');
const http = require('node:http');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawn } = require('node:child_process');
const { once } = require('node:events');
const readline = require('node:readline');
const { CdpClient } = require('../src/browserRuntime.js');
const { discoverInstances, selectInstance } = require('../src/discovery.js');

(async () => {
  assert(process.env.SOLOBROWSER_IDE_CDP, 'Set SOLOBROWSER_IDE_CDP to the dedicated test IDE browser CDP port.');
  assert(process.env.SOLOBROWSER_BROWSER_CDP, 'Set SOLOBROWSER_BROWSER_CDP to the plugin browser CDP port for test-tab cleanup.');
  const ide = await CdpClient.connect(Number(process.env.SOLOBROWSER_IDE_CDP));
  const instance = selectInstance(await discoverInstances(), { workspace: process.env.SOLOBROWSER_WORKSPACE || process.cwd() });
  const fixture = http.createServer((req, res) => {
    res.setHeader('content-type', 'text/html');
    res.end(`<title>SoloBrowser acceptance</title><h1>${req.url}</h1><p>Readable body</p>
      <input aria-label="Name" value="old"><input aria-label="File" type="file">
      <button onpointerdown="this.dataset.trusted=event.isTrusted" onclick="document.querySelector('h1').textContent=this.dataset.trusted==='true'?'trusted click':'bad click'">Go</button>
      <a href="/second" target="_blank">Second tab</a><div style="height:2000px"></div>`);
  });
  fixture.listen(0, '127.0.0.1'); await once(fixture, 'listening');
  const target = `http://127.0.0.1:${fixture.address().port}/first`;
  const child = spawn(process.execPath, [path.join(__dirname, '../scripts/mcp.js')], { env: process.env, stdio: ['pipe', 'pipe', 'inherit'] });
  const lines = readline.createInterface({ input: child.stdout });
  let id = 0;
  const pending = new Map();
  lines.on('line', line => { const d = JSON.parse(line); pending.get(d.id)?.(d); pending.delete(d.id); });
  const rpc = (method, params) => new Promise(resolve => { const key = ++id; pending.set(key, resolve); child.stdin.write(JSON.stringify({ jsonrpc: '2.0', id: key, method, params }) + '\n'); });
  const call = async (name, args = {}) => {
    const reply = await rpc('tools/call', { name: `browser_${name}`, arguments: args });
    assert(!reply.error && !reply.result.isError, JSON.stringify(reply));
    return reply.result.content[0].type === 'image' ? reply.result.content[0] : JSON.parse(reply.result.content[0].text);
  };
  const health = async () => (await fetch(`${instance.baseUrl}/health`)).json();
  const webview = async expression => {
    const result = await ide.send('Runtime.evaluate', { returnByValue: true, awaitPromise: true, expression: `(()=>{const frames=Array.from(document.querySelectorAll('iframe'));const w=frames.map(f=>{try{return f.contentDocument?.querySelector('iframe')?.contentWindow}catch{return null}}).filter(w=>w?.document?.getElementById('status-text')).at(-1);if(!w)return null;return (${expression})(w)})()` });
    if (result.exceptionDetails) throw Error(result.exceptionDetails.exception?.description || result.exceptionDetails.text);
    return result.result?.value;
  };
  let createdTab;
  let originalTab;
  try {
    await rpc('initialize', { protocolVersion: '2025-11-25', capabilities: {}, clientInfo: { name: 'acceptance', version: '1' } });
    await call('select_instance', { instanceId: instance.instanceId });
    await call('open', { url: target });
    await call('wait', { selector: 'input', timeoutMs: 5000 });
    const snap = await call('snapshot');
    const ref = snap.elements.find(e => e.label === 'Name').ref;
    await call('type', { ref, text: 'primary' });
    await call('press', { ref, key: 'Shift+a' });
    const primary = await call('read');
    assert(primary.text.includes('Readable body'));
    const upload = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'solo-live-upload-')), 'fixture.txt');
    fs.writeFileSync(upload, 'acceptance');
    await call('upload', { ref: snap.elements.find(e => e.label === 'File').ref, files: [upload] });
    assert.equal((await call('screenshot')).mimeType, 'image/png');
    originalTab = (await call('tabs')).tabs.find(t => t.active).id;
    await call('click', { ref: snap.elements.find(e => e.label === 'Second tab').ref });
    for (let i = 0; i < 50 && !createdTab; i++) {
      createdTab = (await call('tabs')).tabs.find(t => t.id !== originalTab && t.url.endsWith('/second'))?.id;
      if (!createdTab) await new Promise(resolve => setTimeout(resolve, 100));
    }
    assert(createdTab, 'The fixture popup must finish opening');
    await call('tabs', { action: 'select', tabId: createdTab });
    assert((await call('read')).url.endsWith('/second'));
    await call('tabs', { action: 'select', tabId: originalTab });
    // The old references must continue addressing the same document across display transport changes.
    for (let i = 0; i < 50; i++) {
      const ready = await webview('w => typeof w.startWebRtc === "function"');
      if (ready) break;
      await new Promise(r => setTimeout(r, 100));
    }
    await new Promise(r => setTimeout(r, 1000));
    await webview(`async w => {
      const Original=w.RTCPeerConnection;
      class InvalidOfferPeer { close(){} addTransceiver(){} async createOffer(){return {type:'offer',sdp:'v=0\\r\\n'}} async setLocalDescription(value){this.localDescription=value} }
      w.RTCPeerConnection=InvalidOfferPeer;
      try {await w.startWebRtc();} finally {w.RTCPeerConnection=Original;}
      return true;
    }`);
    for (let i = 0; i < 100 && (await health()).current.transport !== 'fallback'; i++) await new Promise(r => setTimeout(r, 100));
    assert.equal((await health()).current.transport, 'fallback', JSON.stringify(await webview('w=>({status:w.document.getElementById("status-text").textContent})')));
    await call('type', { ref, text: 'fallback' });
    assert.deepEqual(await call('read'), primary);
    const fallbackSnap = await call('snapshot');
    assert.equal(fallbackSnap.elements.find(e => e.label === 'Name').value, 'fallback');
    assert.deepEqual(Object.keys(fallbackSnap).sort(), Object.keys(snap).sort());
    await call('click', { ref: fallbackSnap.elements.find(e => e.label === 'Go').ref });
    await call('wait', { text: 'trusted click', timeoutMs: 2000 });
    await call('scroll', { deltaY: 500 });
    await call('tabs', { action: 'select', tabId: createdTab });
    assert((await call('read')).url.endsWith('/second'));
    let frame;
    for (let i = 0; i < 50; i++) {
      frame = await webview('w => ({address:w.document.getElementById("address").textContent, width:w.document.getElementById("frame").naturalWidth, visible:!w.document.getElementById("frame").classList.contains("hidden")})');
      if (frame?.width > 0 && frame.address.endsWith('/second')) break;
      await new Promise(r => setTimeout(r, 100));
    }
    assert(frame?.visible && frame.width > 0 && frame.address.endsWith('/second'), JSON.stringify(frame));
    await call('navigate', { action: 'reload' });
    const wrong = await fetch(`${instance.baseUrl}/read`, { method: 'POST', headers: { 'x-solobrowser-instance': 'stale', 'content-type': 'application/json' }, body: '{}' });
    assert.equal(wrong.status, 409);
    const origin = await fetch(`${instance.baseUrl}/read`, { method: 'POST', headers: { Origin: 'https://unrelated.example', 'content-type': 'application/json' }, body: '{}' });
    assert.equal(origin.status, 403);
    console.log('ide-live.test OK: MCP -> HTTP -> shared browser, WebRTC/fallback, trusted click, keys, upload, image, tabs and visible frame');
  } finally {
    try {
      if (originalTab) await call('tabs', { action: 'select', tabId: originalTab });
      if (createdTab) {
        const browser = await CdpClient.connect(Number(process.env.SOLOBROWSER_BROWSER_CDP));
        try { await browser.send('Target.closeTarget', { targetId: createdTab }); }
        finally { browser.close(); }
      }
      if (createdTab) assert(!(await call('tabs')).tabs.some(tab => tab.id === createdTab), 'Test tab must be closed');
      await call('open', { url: 'https://x.com/i/flow/login' });
    } finally {
      child.stdin.end(); child.kill(); lines.close(); ide.close(); fixture.close(); fixture.closeAllConnections();
    }
  }
})().catch(error => { console.error(error); process.exitCode = 1; });
