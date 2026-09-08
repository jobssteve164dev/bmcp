const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const http = require('node:http');
const { once } = require('node:events');

(async () => {
  assert(fs.existsSync(path.join(__dirname, '../src/discovery.js')), 'Instance discovery must exist');
  const { publishInstance, discoverInstances, selectInstance } = require('../src/discovery.js');
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'solo-discovery-'));
  let identity = 'right';
  const server = http.createServer((req, res) => res.end(JSON.stringify({ ok: true, name: 'SoloBrowser', instanceId: identity, panelVisible: true, workspaces: ['/work/project'], current: { url: 'https://example.com' } })));
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  try {
    publishInstance(root, { instanceId: 'right', port: server.address().port });
    publishInstance(root, { instanceId: 'stale', port: server.address().port });
    let found = await discoverInstances([root]);
    assert.equal(found.length, 1, 'Ignore reused ports with a different instance identity');
    assert.equal(selectInstance(found, { workspace: '/work/project/subdir' }).instanceId, 'right');
    assert.throws(() => selectInstance([...found, { ...found[0], instanceId: 'other' }], {}), /multiple|choose/i);
    assert.throws(() => selectInstance(found, { instanceId: 'missing' }), /no matching|not.*available|not.*found/i);
    assert.throws(() => selectInstance(found, { workspace: '/unrelated' }), /workspace/i);
    identity = 'changed';
    assert.equal((await discoverInstances([root])).length, 0);
    console.log('discovery.test OK');
  } finally { server.close(); }
})().catch(e => { console.error(e); process.exitCode = 1; });
