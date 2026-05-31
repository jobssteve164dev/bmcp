function collectSnapshot(root = document) {
  const selectors = [
    'a[href]',
    'button',
    'input',
    'textarea',
    'select',
    '[role="button"]',
    '[tabindex]:not([tabindex="-1"])'
  ];
  const elements = Array.from(root.querySelectorAll(selectors.join(',')))
    .filter((element) => !element.disabled && isVisible(element));

  return {
    title: root.title || '',
    url: root.location ? String(root.location.href) : '',
    text: getVisibleText(root.body || root),
    elements: elements.map((element, index) => describeElement(element, index + 1))
  };
}

function describeElement(element, index) {
  const tag = element.tagName.toLowerCase();
  const role = element.getAttribute('role') || inferRole(element);
  const label = getLabel(element);
  const value = 'value' in element ? element.value : undefined;
  const rect = element.getBoundingClientRect ? element.getBoundingClientRect() : null;

  return {
    ref: `e${index}`,
    tag,
    role,
    label,
    value,
    selector: getSelector(element),
    bounds: rect
      ? {
          x: Math.round(rect.x),
          y: Math.round(rect.y),
          width: Math.round(rect.width),
          height: Math.round(rect.height)
        }
      : null
  };
}

function isVisible(element) {
  const style = element.ownerDocument.defaultView.getComputedStyle(element);
  if (style.display === 'none' || style.visibility === 'hidden' || style.opacity === '0') {
    return false;
  }
  const rect = element.getBoundingClientRect();
  return rect.width > 0 && rect.height > 0;
}

function getVisibleText(element) {
  const text = element.innerText || element.textContent || '';
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
      .map((id) => element.ownerDocument.getElementById(id)?.textContent || '')
      .join(' ')
      .replace(/\s+/g, ' ')
      .trim();
    if (text) return text;
  }

  if (element.id) {
    const label = element.ownerDocument.querySelector(`label[for="${cssEscape(element.id)}"]`);
    if (label?.textContent) return label.textContent.replace(/\s+/g, ' ').trim();
  }

  const text = element.innerText || element.textContent || element.getAttribute('placeholder') || '';
  return text.replace(/\s+/g, ' ').trim();
}

function getSelector(element) {
  if (element.id) return `#${cssEscape(element.id)}`;
  const dataTest = element.getAttribute('data-testid') || element.getAttribute('data-test');
  if (dataTest) return `[data-testid="${cssEscape(dataTest)}"]`;
  const name = element.getAttribute('name');
  if (name) return `${element.tagName.toLowerCase()}[name="${cssEscape(name)}"]`;
  return element.tagName.toLowerCase();
}

function cssEscape(value) {
  return String(value).replace(/["\\#.:,[\]>+~*^$|= ]/g, '\\$&');
}

if (typeof module !== 'undefined') {
  module.exports = {
    collectSnapshot,
    describeElement,
    getVisibleText,
    getLabel,
    inferRole
  };
}
