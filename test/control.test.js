const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const http = require('node:http');
const { spawn } = require('node:child_process');
const { once } = require('node:events');
const { CdpClient } = require('../src/browserRuntime');

async function main() {
  assert(fs.existsSync(path.join(__dirname, '../src/control.js')), 'Unified browser controls must exist');
  const { BrowserControl, connectMarkedPage } = require('../src/control');
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'solobrowser-control-test-'));
  const fixture = http.createServer((req, res) => {
    res.setHeader('content-type', 'text/html');
    res.end(`<title>Control fixture</title><h1>Readable body</h1>
      <input aria-label="Name" value="old"><input type="file" aria-label="File">
      <button onclick="document.querySelector('h1').textContent='Clicked'">Go</button>
      <div style="height:3000px"></div><a href="/next">Next</a>
      <script>setTimeout(()=>{const e=document.createElement('p');e.id='ready';e.textContent='Ready';document.body.append(e)},300)</script>`);
  });
  fixture.listen(0, '127.0.0.1');
  await once(fixture, 'listening');
  const target = `http://127.0.0.1:${fixture.address().port}`;
  const child = spawn(process.env.BROWSER_PATH || '/usr/bin/chromium', [
    '--headless=new', '--no-sandbox', '--disable-dev-shm-usage', '--remote-debugging-port=0',
    `--user-data-dir=${root}`, target
  ], { stdio: 'ignore' });
  let cdp;
  try {
    const deadline = Date.now() + 15000;
    while (!fs.existsSync(path.join(root, 'DevToolsActivePort')) && Date.now() < deadline) {
      await new Promise(r => setTimeout(r, 50));
    }
    const port = Number(fs.readFileSync(path.join(root, 'DevToolsActivePort'), 'utf8').split('\n')[0]);
    cdp = await CdpClient.connect(port);
    const control = new BrowserControl(cdp);
    await control.run('wait', { selector: 'input', state: 'visible' });
    let snap = await control.run('snapshot', {});
    assert(snap.text.includes('Readable body'));
    const name = snap.elements.find(e => e.label === 'Name').ref;
    await control.run('type', { ref: name, text: 'new' });
    assert.equal((await cdp.send('Runtime.evaluate', { expression: 'document.querySelector("input").value', returnByValue: true })).result.value, 'new');
    await control.run('type', { ref: name, text: '' });
    assert.equal((await cdp.send('Runtime.evaluate', { expression: 'document.querySelector("input").value', returnByValue: true })).result.value, '');
    await control.run('press', { ref: name, key: 'a' });
    assert.equal((await cdp.send('Runtime.evaluate', { expression: 'document.querySelector("input").value', returnByValue: true })).result.value, 'a');
    await cdp.send('Runtime.evaluate', { expression: "window.lastKey='';document.addEventListener('keydown',e=>window.lastKey=e.key)" });
    await control.run('press', { ref: name, key: 'Shift+a' });
    assert.equal((await cdp.send('Runtime.evaluate', { expression: 'window.lastKey', returnByValue: true })).result.value, 'A');
    assert.equal((await cdp.send('Runtime.evaluate', { expression: 'document.querySelector("input").value', returnByValue: true })).result.value, 'aA');
    await control.run('press', { ref: name, key: 'Shift+1' });
    assert.equal((await cdp.send('Runtime.evaluate', { expression: 'window.lastKey', returnByValue: true })).result.value, '!');
    assert.equal((await cdp.send('Runtime.evaluate', { expression: 'document.querySelector("input").value', returnByValue: true })).result.value, 'aA!');
    await cdp.send('Runtime.evaluate', { expression: "window.pointerProof=false;document.querySelector('button').addEventListener('pointerdown',e=>window.pointerProof=e.isTrusted)" });
    await control.run('click', { ref: snap.elements.find(e => e.label === 'Go').ref });
    assert.equal((await cdp.send('Runtime.evaluate', { expression: 'window.pointerProof', returnByValue: true })).result.value, true, 'Click must preserve trusted pointer events');
    assert((await control.run('read', {})).text.includes('Clicked'));
    await control.run('wait', { selector: '#ready', state: 'visible', timeoutMs: 2000 });
    await assert.rejects(control.run('wait', { selector: '#missing', timeoutMs: 50 }), /timed out/i);
    await control.run('scroll', { deltaY: 700 });
    await new Promise(r => setTimeout(r, 150));
    assert((await cdp.send('Runtime.evaluate', { expression: 'scrollY', returnByValue: true })).result.value > 0);
    const png = await control.run('screenshot', {});
    assert.equal(Buffer.from(png.data, 'base64').subarray(1, 4).toString(), 'PNG');
    const full = Buffer.from((await control.run('screenshot', { fullPage: true })).data, 'base64');
    assert(full.readUInt32BE(20) > 3000, 'Full-page screenshot must include below-the-fold content');
    const file = path.join(root, 'upload.txt');
    fs.writeFileSync(file, 'fixture');
    await control.run('upload', { ref: snap.elements.find(e => e.label === 'File').ref, files: [file] });
    assert.equal((await cdp.send('Runtime.evaluate', { expression: 'document.querySelector("input[type=file]").files[0].name', returnByValue: true })).result.value, 'upload.txt');
    await control.run('snapshot', {});
    await assert.rejects(control.run('click', { ref: name }), /stale|snapshot/i);
    const first = cdp.pageId;
    const { targetId } = await cdp.send('Target.createTarget', { url: `${target}/second` });
    const second = await CdpClient.connect(port, targetId);
    await second.send('Runtime.evaluate', { expression: 'window.__testDisplayedPage=true' });
    assert.equal(typeof connectMarkedPage, 'function', 'Fallback must resolve the displayed page, not the first page');
    const matched = await connectMarkedPage(port, '__testDisplayedPage', cdp);
    assert.equal(matched.pageId, targetId);
    if (matched !== cdp) matched.close();
    second.close();
    await control.run('tabs', { action: 'select', tabId: targetId });
    assert.equal(control.cdp.pageId, targetId);
    assert((await control.run('tabs', {})).tabs.some(t => t.id === targetId && t.active));
    await control.run('wait', { url: '/second', timeoutMs: 2000 });
    await control.run('navigate', { action: 'reload' });
    await control.run('tabs', { action: 'select', tabId: first });
    await control.cdp.send('Target.closeTarget', { targetId });
    cdp = control.cdp;
    console.log('control.test OK (real Chromium)');
  } finally {
    cdp?.close();
    child.kill('SIGTERM');
    fixture.close();
  }
}
main().catch(e => { console.error(e); process.exitCode = 1; });
