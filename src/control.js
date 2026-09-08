const fs = require('node:fs');
const path = require('node:path');
const { randomUUID } = require('node:crypto');
const { CdpClient } = require('./browserRuntime.js');

// The control contract is independent of how the browser image reaches the editor.
class BrowserControl {
  constructor(cdp, onSelect = async () => {}) {
    this.cdp = cdp;
    this.onSelect = onSelect;
    this.key = `__soloControl_${randomUUID().replaceAll('-', '')}`;
  }

  async page(action, args = {}) {
    const result = await this.cdp.send('Runtime.evaluate', {
      expression: `(${pageOperation.toString()})(${JSON.stringify(this.key)},${JSON.stringify(action)},${JSON.stringify(args)})`,
      returnByValue: true, awaitPromise: true
    });
    if (result.exceptionDetails) throw new Error(result.exceptionDetails.exception?.description || result.exceptionDetails.text);
    return result.result?.value;
  }

  async run(action, args = {}) {
    if (['snapshot', 'read', 'type', 'fill', 'scroll'].includes(action)) return this.page(action, args);
    if (action === 'click') {
      const point = await this.page('point', args);
      await this.cdp.send('Input.dispatchMouseEvent', { type: 'mouseMoved', ...point, button: 'none' });
      await this.cdp.send('Input.dispatchMouseEvent', { type: 'mousePressed', ...point, button: 'left', clickCount: 1 });
      await this.cdp.send('Input.dispatchMouseEvent', { type: 'mouseReleased', ...point, button: 'left', clickCount: 1 });
      return { clicked: args.ref || args.selector };
    }
    if (action === 'press') {
      if (args.ref || args.selector) await this.page('focus', args);
      const parts = String(args.key || '').split('+');
      const key = parts.pop();
      const modifiers = parts.reduce((value, part) => {
        const bit = { Alt: 1, Control: 2, Ctrl: 2, Meta: 4, Shift: 8 }[part];
        if (!bit) throw new Error(`Unknown key modifier: ${part}`);
        return value | bit;
      }, 0);
      const codes = { Enter: 13, Tab: 9, Escape: 27, Backspace: 8, Delete: 46, ArrowLeft: 37, ArrowUp: 38, ArrowRight: 39, ArrowDown: 40, Home: 36, End: 35, PageUp: 33, PageDown: 34, Space: 32 };
      if (!key || (key.length !== 1 && !codes[key])) throw new Error('Provide one character or a supported key, e.g. Enter or Control+a.');
      const shiftFrom = '`1234567890-=[]\\;\',./';
      const shiftTo = '~!@#$%^&*()_+{}|:"<>?';
      const shifted = modifiers & 8 ? (shiftFrom.includes(key) && key.length === 1 ? shiftTo[shiftFrom.indexOf(key)] : key.toUpperCase()) : key;
      const text = key === 'Space' ? ' ' : key === 'Enter' ? '\r' : key.length === 1 ? shifted : undefined;
      const params = { key: key === 'Space' ? ' ' : key.length === 1 ? shifted : key, modifiers, windowsVirtualKeyCode: codes[key] || key.toUpperCase().charCodeAt(0) };
      await this.cdp.send('Input.dispatchKeyEvent', { ...params, type: 'keyDown', ...(!(modifiers & 7) && text ? { text } : {}) });
      await this.cdp.send('Input.dispatchKeyEvent', { ...params, type: 'keyUp' });
      return { pressed: args.key };
    }
    if (action === 'wait') {
      const timeoutMs = args.timeoutMs ?? 15000;
      if (!Number.isFinite(timeoutMs) || timeoutMs < 0) throw new Error('timeoutMs must be a non-negative number.');
      const deadline = Date.now() + timeoutMs;
      do {
        try {
          const result = await this.page('condition', args);
          if (result.matched) return result;
        } catch (error) {
          if (!/context.*destroyed|cannot find context/i.test(error.message)) throw error;
        }
        await new Promise(resolve => setTimeout(resolve, Math.min(100, Math.max(0, deadline - Date.now()))));
      } while (Date.now() < deadline);
      throw new Error('Browser wait timed out before the requested condition matched.');
    }
    if (action === 'screenshot') {
      const result = await this.cdp.send('Page.captureScreenshot', { format: 'png', captureBeyondViewport: Boolean(args.fullPage) });
      return { mimeType: 'image/png', data: result.data };
    }
    if (action === 'upload') {
      if (!Array.isArray(args.files) || !args.files.length) throw new Error('files must contain local absolute file paths.');
      for (const file of args.files) {
        if (typeof file !== 'string' || !path.isAbsolute(file) || !fs.statSync(file).isFile()) throw new Error('Upload paths must be existing absolute file paths.');
      }
      await this.page('file', args);
      const remote = await this.cdp.send('Runtime.evaluate', { expression: `window[${JSON.stringify(this.key)}].file` });
      if (!remote.result?.objectId) throw new Error('File input is no longer available. Take a new snapshot.');
      try {
        await this.cdp.send('DOM.setFileInputFiles', { objectId: remote.result.objectId, files: args.files });
      } finally {
        await this.cdp.send('Runtime.releaseObject', { objectId: remote.result.objectId });
      }
      return { uploaded: args.files.map(file => path.basename(file)) };
    }
    if (action === 'navigate') {
      if (!['back', 'forward', 'reload'].includes(args.action)) throw new Error('Navigation action must be back, forward or reload.');
      await this.cdp.command(args.action);
      return this.page('read');
    }
    if (action === 'tabs') {
      const result = await this.cdp.send('Target.getTargets');
      const pages = result.targetInfos.filter(target => target.type === 'page');
      if (args.action && !['list', 'select'].includes(args.action)) throw new Error('Tab action must be list or select.');
      if (args.action === 'select') {
        const selected = pages.find(target => target.targetId === args.tabId);
        if (!selected) throw new Error('Tab no longer exists. List tabs again.');
        if (selected.targetId !== this.cdp.pageId) {
          const previous = this.cdp;
          const next = await CdpClient.connect(previous.port, selected.targetId);
          try {
            await next.send('Page.bringToFront');
            await this.onSelect(next, selected);
            this.cdp = next;
            previous.close();
          } catch (error) { next.close(); throw error; }
        }
      }
      return { tabs: pages.map(target => ({ id: target.targetId, title: target.title, url: target.url, active: target.targetId === this.cdp.pageId })) };
    }
    throw new Error(`Unsupported browser action: ${action}`);
  }
}

function pageOperation(key, action, args) {
  const state = window[key] ||= { refs: new Map() };
  const visible = element => Boolean(element.getClientRects().length) && getComputedStyle(element).visibility !== 'hidden';
  function element() {
    const node = args.ref ? state.refs.get(String(args.ref).replace(/^@/, '')) : args.selector ? document.querySelector(args.selector) : null;
    if (!node?.isConnected) throw new Error('Element reference is stale or missing. Take a new snapshot.');
    return node;
  }
  const text = () => (document.body?.innerText || '').trim();
  if (action === 'snapshot') {
    state.refs.clear();
    const prefix = `${Date.now().toString(36)}${Math.random().toString(36).slice(2, 7)}-`;
    const nodes = Array.from(document.querySelectorAll('a[href],button,input,textarea,select,[role],[contenteditable=true],[tabindex]')).filter(visible);
    const elements = nodes.map((node, i) => {
      const ref = `${prefix}e${i + 1}`;
      state.refs.set(ref, node);
      const labels = Array.from(node.labels || []).map(label => label.textContent).join(' ');
      const labelled = (node.getAttribute('aria-labelledby') || '').split(/\s+/).map(id => document.getElementById(id)?.textContent || '').join(' ').trim();
      const label = node.getAttribute('aria-label') || labelled || labels || node.getAttribute('placeholder') || node.innerText || node.getAttribute('title') || '';
      const role = node.getAttribute('role') || ({ BUTTON: 'button', A: 'link', INPUT: 'textbox', TEXTAREA: 'textbox', SELECT: 'combobox' }[node.tagName] || node.tagName.toLowerCase());
      return { ref, role, label: label.trim(), disabled: Boolean(node.disabled), ...(node.type === 'password' ? {} : 'value' in node ? { value: node.value } : {}) };
    });
    return { title: document.title, url: location.href, text: text(), elements };
  }
  if (action === 'read') return { title: document.title, url: location.href, text: text() };
  if (action === 'condition') {
    if (!args.selector && !args.url && !args.text && !args.readyState) throw new Error('Wait requires selector, url, text or readyState.');
    if (args.state && !['visible', 'hidden', 'attached', 'detached'].includes(args.state)) throw new Error('Unknown wait state.');
    const node = args.selector ? document.querySelector(args.selector) : null;
    const matches = !args.selector || ({ attached: !!node, detached: !node, hidden: !node || !visible(node), visible: !!node && visible(node) }[args.state || 'visible']);
    return { matched: Boolean(matches && (!args.url || location.href.includes(args.url)) && (!args.text || text().includes(args.text)) && (!args.readyState || document.readyState === args.readyState)), url: location.href };
  }
  if (action === 'scroll') {
    const x = args.deltaX ?? 0, y = args.deltaY ?? 0;
    if (!Number.isFinite(x) || !Number.isFinite(y)) throw new Error('Scroll deltas must be numbers.');
    (args.ref || args.selector ? element() : window).scrollBy({ left: x, top: y, behavior: 'instant' });
    return { scrolled: true };
  }
  const node = element();
  if (node.disabled) throw new Error('Element is disabled.');
  if (action === 'file') {
    if (node.tagName !== 'INPUT' || node.type !== 'file') throw new Error('Select a file input for upload.');
    state.file = node;
    return { ready: true };
  }
  node.scrollIntoView({ block: 'center', inline: 'center' });
  node.focus();
  if (action === 'focus') return { focused: true };
  if (action === 'point') {
    const rect = node.getBoundingClientRect();
    const x = Math.max(0, Math.min(innerWidth - 1, rect.x + rect.width / 2));
    const y = Math.max(0, Math.min(innerHeight - 1, rect.y + rect.height / 2));
    const hit = document.elementFromPoint(x, y);
    if (!visible(node) || !hit || (hit !== node && !node.contains(hit))) throw new Error('Element is not visible or is covered by another element.');
    return { x, y };
  }
  if (action === 'type' || action === 'fill') {
    if (typeof args.text !== 'string') throw new Error('text must be a string.');
    if (node.readOnly) throw new Error('Element is read-only.');
    if (node.isContentEditable) node.textContent = args.text;
    else {
      if (!['INPUT', 'TEXTAREA'].includes(node.tagName) || node.type === 'file') throw new Error('Select an editable text field.');
      const prototype = node.tagName === 'TEXTAREA' ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype;
      Object.getOwnPropertyDescriptor(prototype, 'value').set.call(node, args.text);
    }
    node.dispatchEvent(new InputEvent('input', { bubbles: true, inputType: 'insertText', data: args.text }));
    node.dispatchEvent(new Event('change', { bubbles: true }));
    return { filled: args.ref || args.selector };
  }
  throw new Error('Unsupported page operation.');
}

async function connectMarkedPage(port, marker, existing) {
  const matches = async cdp => {
    if (!cdp?.isOpen()) return false;
    const result = await cdp.send('Runtime.evaluate', { expression: `Boolean(window[${JSON.stringify(marker)}])`, returnByValue: true });
    return result.result?.value === true;
  };
  if (await matches(existing).catch(() => false)) return existing;
  const response = await fetch(`http://127.0.0.1:${port}/json/list`, { signal: AbortSignal.timeout(10000) });
  for (const page of await response.json()) {
    if (page.type !== 'page') continue;
    const candidate = await CdpClient.connect(port, page.id);
    if (await matches(candidate).catch(() => false)) return candidate;
    candidate.close();
  }
  throw new Error('Displayed browser tab changed during attachment. Retry the action.');
}

module.exports = { BrowserControl, connectMarkedPage };
