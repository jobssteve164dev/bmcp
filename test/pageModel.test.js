const assert = require('assert');
const { JSDOM } = require('jsdom');
const { collectSnapshot } = require('../src/pageModel');

const dom = new JSDOM(`<!doctype html>
<html>
<head><title>Sign in</title></head>
<body>
  <main>
    <h1>Sign in</h1>
    <label for="username">Username</label>
    <input id="username" name="username" />
    <label for="password">Password</label>
    <input id="password" name="password" type="password" />
    <button id="login-button">Sign in</button>
  </main>
</body>
</html>`, {
  url: 'https://example.test/login',
  pretendToBeVisual: true
});

Object.defineProperty(dom.window.HTMLElement.prototype, 'innerText', {
  get() {
    return this.textContent;
  }
});

dom.window.HTMLElement.prototype.getBoundingClientRect = function getBoundingClientRect() {
  return {
    x: 10,
    y: 20,
    width: this.tagName === 'MAIN' ? 500 : 120,
    height: 32
  };
};

global.document = dom.window.document;

const snapshot = collectSnapshot(dom.window.document);

assert.strictEqual(snapshot.title, 'Sign in');
assert.strictEqual(snapshot.url, 'https://example.test/login');
assert(snapshot.text.includes('Username'));
assert(snapshot.elements.some((element) => element.ref === 'e1' && element.label === 'Username'));
assert(snapshot.elements.some((element) => element.role === 'button' && element.label === 'Sign in'));

console.log('pageModel.test OK');
