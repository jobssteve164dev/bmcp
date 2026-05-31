const assert = require('assert');

const port = Number(process.env.BMCP_PORT || 17333);
const base = `http://127.0.0.1:${port}`;

async function main() {
  const health = await get('/health');
  assert.strictEqual(health.ok, true);

  await post('/open', { url: 'bmcp:demo' });
  const demo = await post('/demo', {});

  assert.strictEqual(demo.ok, true);
  assert.strictEqual(demo.result.completed, true);
  assert(demo.result.visibleText.includes('Inventory'));

  console.log('BMCP HTTP smoke OK');
}

async function get(path) {
  const response = await fetch(`${base}${path}`);
  return response.json();
}

async function post(path, body) {
  const response = await fetch(`${base}${path}`, {
    method: 'POST',
    headers: {
      'content-type': 'application/json'
    },
    body: JSON.stringify(body)
  });
  return response.json();
}

main().catch((error) => {
  console.error(error.message);
  process.exit(1);
});
