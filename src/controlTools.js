const str = description => ({ type: 'string', description });
const number = description => ({ type: 'number', description });
const target = { ref: str('Element reference from the latest snapshot.'), selector: str('CSS selector when no reference is available.') };
const definitions = [
  ['instances', 'List live SoloBrowser windows and their workspaces.', {}],
  ['select_instance', 'Choose the SoloBrowser window for subsequent calls.', { instanceId: str('Instance ID returned by browser_instances.') }, ['instanceId']],
  ['open', 'Open a URL in the visible SoloBrowser window.', { url: str('HTTP or HTTPS URL.') }, ['url']],
  ['snapshot', 'Read page text and fresh element references. Older references expire.', {}],
  ['read', 'Read the page title, URL and body text.', {}],
  ['click', 'Click an element.', target],
  ['type', 'Replace the entire contents of a field; empty text clears it.', { ...target, text: str('Replacement text.') }, ['text']],
  ['press', 'Press a key or chord, optionally focusing an element first.', { ...target, key: str('Examples: Enter, Tab, Control+a, Meta+a.') }, ['key']],
  ['scroll', 'Scroll the page or an element by pixels.', { ...target, deltaX: number('Horizontal pixels.'), deltaY: number('Vertical pixels.') }],
  ['wait', 'Wait for all supplied page conditions without changing the page.', { selector: str('CSS selector.'), state: { type: 'string', enum: ['visible', 'hidden', 'attached', 'detached'] }, url: str('URL substring.'), text: str('Body text substring.'), readyState: { type: 'string', enum: ['interactive', 'complete'] }, timeoutMs: { type: 'number', minimum: 0, description: 'Default 15000 milliseconds.' } }],
  ['screenshot', 'Capture the current browser page as a PNG image.', { fullPage: { type: 'boolean' } }],
  ['tabs', 'List tabs or select a tab; the editor follows the selected tab.', { action: { type: 'string', enum: ['list', 'select'] }, tabId: str('Tab ID from a previous list.') }],
  ['navigate', 'Go back, forward, or reload the selected page.', { action: { type: 'string', enum: ['back', 'forward', 'reload'] } }, ['action']],
  ['upload', 'Set files on a file input. Paths are on the IDE host.', { ...target, files: { type: 'array', items: str('Absolute local path.'), minItems: 1 } }, ['files']]
];
const tools = definitions.map(([action, description, properties, required = []]) => ({
  name: `browser_${action}`, description,
  inputSchema: { type: 'object', properties, required, additionalProperties: false }
}));

function validateArguments(tool, args) {
  if (!args || typeof args !== 'object' || Array.isArray(args)) throw new Error('Arguments must be an object.');
  for (const key of tool.inputSchema.required) if (!(key in args)) throw new Error(`Missing argument: ${key}`);
  for (const [key, value] of Object.entries(args)) {
    const schema = tool.inputSchema.properties[key];
    if (!schema) throw new Error(`Unknown argument: ${key}`);
    if (schema.type === 'array' ? !Array.isArray(value) || value.some(v => typeof v !== schema.items.type) || value.length < (schema.minItems || 0) : typeof value !== schema.type) throw new Error(`Invalid argument: ${key}`);
    if (schema.enum && !schema.enum.includes(value)) throw new Error(`Invalid value for ${key}`);
    if (schema.type === 'number' && (!Number.isFinite(value) || value < (schema.minimum ?? -Infinity))) throw new Error(`Invalid number: ${key}`);
  }
}
module.exports = { tools, validateArguments };
