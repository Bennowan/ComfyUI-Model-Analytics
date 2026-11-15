// Unit tests for the appearance layer.  Run:  node --test tests/appearance.test.mjs
import assert from 'node:assert/strict';
import test from 'node:test';
import {
  COLOR_TOKENS,
  applyAppearance,
  parseCustomAppearance,
  readComfyPaletteSnapshot,
  serializeCustomAppearance,
} from '../web/js/appearance.js';

function fakeElement() {
  const props = new Map();
  return {
    props,
    dataset: {},
    style: {
      colorScheme: '',
      setProperty: (name, value) => props.set(name, value),
      removeProperty: (name) => props.delete(name),
    },
  };
}

test('empty or malformed input yields an empty customisation', () => {
  for (const raw of ['', undefined, null, 'not json', '[]', '42']) {
    assert.deepEqual(parseCustomAppearance(raw), { colors: {} });
  }
  assert.equal(serializeCustomAppearance({}), '');
});

test('only known tokens with valid #rrggbb colours survive', () => {
  const parsed = parseCustomAppearance(JSON.stringify({
    colors: { bg: '#112233', accent: '#ABCDEF', hover: 'red', nope: '#000000', fg: '#fff' },
  }));
  assert.deepEqual(parsed.colors, { bg: '#112233', accent: '#abcdef' });
});

test('radius and font size are clamped, scheme is validated', () => {
  const parsed = parseCustomAppearance({ radius: 99, fontSize: 2, scheme: 'dark' });
  assert.equal(parsed.radius, 12);
  assert.equal(parsed.fontSize, 11);
  assert.equal(parsed.scheme, 'dark');
  assert.equal(parseCustomAppearance({ scheme: 'sepia' }).scheme, undefined);
  assert.equal(parseCustomAppearance({ radius: '' }).radius, undefined);
});

test('serialize and parse round-trip', () => {
  const custom = { colors: { surface: '#202020', bg: '#101010' }, radius: 4, scheme: 'light' };
  const again = parseCustomAppearance(serializeCustomAppearance(custom));
  assert.deepEqual(again, custom);
});

test('follow mode writes nothing and clears earlier overrides', () => {
  const el = fakeElement();
  applyAppearance(el, 'custom', { colors: { bg: '#101010' }, radius: 8, scheme: 'dark' });
  assert.equal(el.props.get('--ma-custom-bg'), '#101010');
  assert.equal(el.props.get('--ma-custom-radius'), '8px');
  assert.equal(el.style.colorScheme, 'dark');
  assert.equal(el.dataset.maAppearance, 'custom');

  applyAppearance(el, 'follow', { colors: { bg: '#101010' } });
  assert.equal(el.props.size, 0);
  assert.equal(el.style.colorScheme, '');
  assert.equal(el.dataset.maAppearance, 'follow');
});

test('custom mode only sets what the user chose', () => {
  const el = fakeElement();
  applyAppearance(el, 'custom', { colors: { accent: '#e35d12' } });
  assert.deepEqual([...el.props.keys()], ['--ma-custom-accent']);
  assert.equal(el.style.colorScheme, '');
});

test('every token has a unique id', () => {
  const ids = COLOR_TOKENS.map((token) => token.id);
  assert.equal(new Set(ids).size, ids.length);
});


test('palette snapshots read from the ComfyUI registry without switching global state', () => {
  const registry = {
    palettesLookup: {
      dark: { id: 'dark', light_theme: false, colors: { theme: { background: '#111111', primary: '#4488ff' } } },
      nord: { id: 'nord', name: 'Nord', light_theme: false, colors: { theme: { background: '#2e3440', primary: '#88c0d0' } } },
    },
    completePalette: (palette) => palette,
  };
  let activeId = 'dark';
  const snapshot = readComfyPaletteSnapshot(registry, 'nord', activeId);
  assert.deepEqual(snapshot, {
    variables: { '--background': '#2e3440', '--primary': '#88c0d0' },
    colorScheme: 'dark',
  });
  assert.equal(activeId, 'dark', 'reading another palette must not change ComfyUI\'s active theme');

  const dashboard = fakeElement();
  applyAppearance(dashboard, 'palette', {}, snapshot);
  assert.equal(dashboard.props.get('--background'), '#2e3440');
  assert.equal(dashboard.props.get('--primary'), '#88c0d0');
  assert.equal(dashboard.style.colorScheme, 'dark');
  assert.equal(dashboard.dataset.maAppearance, 'palette');
});

test('legacy palette JSON is converted to modern theme tokens', () => {
  const snapshot = readComfyPaletteSnapshot(null, 'custom_nord', '', {
    custom_nord: {
      id: 'custom_nord',
      light_theme: false,
      colors: {
        comfy_base: { 'comfy-menu-bg': '#222222', 'fg-color': '#eeeeee' },
        litegraph_base: { NODE_DEFAULT_BGCOLOR: '#333333', NODE_DEFAULT_COLOR: '#444444', NODE_TEXT_COLOR: '#dddddd' },
      },
    },
  });
  assert.equal(snapshot.variables['--background'], '#222222');
  assert.equal(snapshot.variables['--foreground'], '#eeeeee');
  assert.equal(snapshot.variables['--node'], '#333333');
  assert.equal(snapshot.variables['--node-header'], '#444444');
});

test('the active palette can be snapshotted without the optional palette service', () => {
  const originalDocument = globalThis.document;
  const originalGetComputedStyle = globalThis.getComputedStyle;
  const root = { getAttribute: () => null, setAttribute() {}, removeAttribute() {} };
  globalThis.document = { documentElement: root };
  globalThis.getComputedStyle = () => ({ getPropertyValue: (property) => property === '--background' ? '#222222' : '', colorScheme: 'dark' });
  try {
    assert.deepEqual(readComfyPaletteSnapshot(null, 'dark', 'dark'), {
      variables: { '--background': '#222222' },
      colorScheme: 'dark',
    });
    assert.equal(readComfyPaletteSnapshot(null, 'nord', 'dark'), null);
  } finally {
    globalThis.document = originalDocument;
    globalThis.getComputedStyle = originalGetComputedStyle;
  }
});
