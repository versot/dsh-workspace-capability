import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import vm from 'node:vm';

test('client preserves the existing settings entry and renders themed tabs', async () => {
  let module;
  let panel;
  let cursor = 0;
  const hookState = [];
  const refs = [];
  let refCursor = 0;
  const effects = [];
  const keyListeners = new Set();
  const React = {
    createElement(type, props, ...children) { return { type, props, children }; },
    useReducer() { return [0, () => {}]; },
    useState(initial) { const i = cursor++; if (!(i in hookState)) hookState[i] = initial; return [hookState[i], value => { hookState[i] = value; }]; },
    useRef(current) { const i = refCursor++; return refs[i] ??= { current }; },
    useCallback(fn) { return fn; },
    useEffect(fn) { effects.push(fn); },
  };
  const sandbox = {
    window: { __ModuleLoader__: { load(value) { module = value; } }, confirm: () => true },
    document: {
      addEventListener(type, listener) { if (type === 'keydown') keyListeners.add(listener); },
      removeEventListener(type, listener) { if (type === 'keydown') keyListeners.delete(listener); },
    },
    fetch: async () => ({ ok: true, json: async () => ({ workspace: '/workspace', config: {}, groups: [], mcpServers: [] }) }),
  };
  vm.runInNewContext(await readFile(new URL('../client.js', import.meta.url), 'utf8'), sandbox);
  const plugin = module.factory(name => name === 'react' ? React : { MenuItemButton: 'menu-button' });
  let menu;
  plugin.apply({ slots: {
    inject(_slot, callback) { callback(); },
    register(options, component) { if (options.id === 'workspace-capability') { if (options.name === 'shell.overlay') panel = component; else menu = component; } },
  } });
  const entry = menu({ sessionId: 'session', useMenuOpenState: () => [true, () => {}] });
  entry.props.onSelect();
  await new Promise(resolve => setImmediate(resolve));
  const tree = panel();
  const text = JSON.stringify(tree);
  assert.ok(text.includes('工作区范围'));
  assert.ok(text.includes('能力预设'));
  assert.ok(text.includes('var(--dsw-alias-bg-overlay)'));
  assert.ok(text.includes('wc-preset-layout'));
  assert.ok(text.includes('.wc-preset-field:focus-visible'));
  assert.ok(text.includes('outline:none!important'));
  assert.ok(text.includes('border-color:var(--dsw-alias-state-business-primary)!important'));
  assert.equal(tree.children[0].props.role, 'dialog');
  assert.equal(tree.children[0].props.style.width, 'min(1200px, 96vw)', 'workspace scope uses the same wide dialog as presets');
  assert.equal(tree.children[0].props.style.background, 'var(--dsw-alias-bg-base)');
  const nodes = tree => tree && typeof tree === 'object' ? [tree, ...(tree.children ?? []).flat(Infinity).flatMap(nodes)] : [];
  nodes(tree).find(n => n.props?.role === 'tab' && n.children.includes('能力预设')).props.onClick();
  cursor = 0; refCursor = 0;
  const presetTree = panel();
  assert.equal(presetTree.props.style.WebkitAppRegion, 'no-drag', 'overlay must receive native clicks over desktop drag rows');
  assert.equal(presetTree.props.style.paddingTop, 'var(--dsh-frame-overlay-top, 20px)');
  assert.equal(presetTree.props.style.boxSizing, 'border-box');
  assert.equal(presetTree.children[0].props.style.height, '100%');
  assert.equal(presetTree.children[0].props.style.maxHeight, '100%');
  assert.equal(nodes(presetTree).find(n => n.props?.['aria-label'] === '关闭').props.style.WebkitAppRegion, 'no-drag');
  refs[0].current = true;
  nodes(presetTree).find(n => n.props?.['aria-label'] === '关闭').props.onClick();
  cursor = 0; refCursor = 0;
  const presetConfirmation = panel();
  assert.ok(presetConfirmation, 'preset X keeps unsaved changes open until confirmed');
  const continueEditing = nodes(presetConfirmation).find(n => n.children?.includes('继续编辑'));
  assert.ok(continueEditing, 'preset X requests confirmation');
  continueEditing.props.onClick();
  cursor = 0; refCursor = 0;
  const editing = panel();
  assert.ok(!nodes(editing).some(n => n.props?.role === 'alertdialog'));
  const cleanups = effects.splice(0).map(effect => effect()).filter(value => typeof value === 'function');
  assert.ok(keyListeners.size > 0, 'Escape listener is installed');
  for (const listener of keyListeners) listener({ key: 'Escape', stopPropagation() {} });
  cursor = 0; refCursor = 0;
  const escapeConfirmation = panel();
  assert.ok(nodes(escapeConfirmation).some(n => n.props?.role === 'alertdialog'), 'Escape also protects unsaved preset changes');
  nodes(escapeConfirmation).find(n => n.children?.includes('继续编辑')).props.onClick();
  for (const cleanup of cleanups) cleanup();
  cursor = 0; refCursor = 0;
  const afterEscape = panel();
  const backdrop = {};
  afterEscape.props.onClick({ target: backdrop, currentTarget: backdrop });
  cursor = 0; refCursor = 0;
  const backdropConfirmation = panel();
  assert.ok(nodes(backdropConfirmation).some(n => n.props?.role === 'alertdialog'), 'backdrop also protects unsaved preset changes');
  nodes(backdropConfirmation).find(n => n.children?.includes('放弃并关闭')).props.onClick();
  cursor = 0; refCursor = 0;
  assert.equal(panel(), null);
  entry.props.onSelect();
  await new Promise(resolve => setImmediate(resolve));
  cursor = 0; refCursor = 0;
  const reopened = panel();
  assert.ok(reopened);
  nodes(reopened).find(n => n.props?.role === 'tab' && n.children.includes('工作区范围')).props.onClick();
  cursor = 0; refCursor = 0;
  const scopeTree = panel();
  refs[0].current = true;
  nodes(scopeTree).find(n => n.children?.includes('取消')).props.onClick();
  cursor = 0; refCursor = 0;
  const confirmation = panel();
  const discard = nodes(confirmation).find(n => n.children?.includes('放弃并关闭'));
  assert.ok(discard, 'dirty close uses an in-panel confirmation');
  discard.props.onClick();
  cursor = 0; refCursor = 0;
  assert.equal(panel(), null);

});

async function presetHarness() {
  let module;
  let cursor;
  const state = [{ roles: [], problems: [] }, { name: 'review', description: 'Review changes', skills: ['alpha'] }, null, '', false, ''];
  const React = {
    createElement(type, props, ...children) { return { type, props: props ?? {}, children }; },
    useState(initial) { const i = cursor++; if (!(i in state)) state[i] = initial; return [state[i], value => { state[i] = value; }]; },
    useEffect() {},
  };
  const window = { __ModuleLoader__: { load(value) { module = value; } }, confirm: () => true };
  const source = (await readFile(new URL('../client.js', import.meta.url), 'utf8')).replace('    return {\n      inject:', '    window.TestPresetManager = PresetManager;\n    return {\n      inject:');
  vm.runInNewContext(source, { window });
  module.factory(name => name === 'react' ? React : {});
  const data = { config: {}, groups: [
    { key: 'project-dsh', skills: [{ name: 'alpha', description: 'Inspect project changes' }] },
    { key: 'user-dsh', skills: [{ name: 'beta', description: 'Research references' }] },
  ], mcpServers: [{ name: 'github', visible: true, description: 'Read repository data', tools: [{ name: 'search_issues', description: 'Find bug reports' }] }] };
  const render = () => { cursor = 0; return window.TestPresetManager({ data, onDirty() {} }); };
  const nodes = tree => tree && typeof tree === 'object' ? [tree, ...(tree.children ?? []).flat(Infinity).flatMap(nodes)] : [];
  const sections = tree => nodes(tree).filter(n => n.type === 'section');
  const modes = section => nodes(section).filter(n => n.type === 'button' && 'aria-pressed' in n.props);
  return { render, nodes, sections, modes };
}

test('Chinese display names enable saving and missing fields explain disabled state', async () => {
  const h = await presetHarness();
  const input = tree => h.nodes(tree).find(n => n.props?.['aria-label'] === '预设名称');
  const save = tree => h.nodes(tree).find(n => n.children?.includes('保存预设'));
  let tree = h.render();
  input(tree).props.onChange({ target: { value: '代码审查' } });
  tree = h.render();
  assert.equal(save(tree).props.disabled, false);
  h.nodes(tree).find(n => n.props?.['aria-label'] === '推荐场景').props.onChange({ target: { value: '' } });
  tree = h.render();
  assert.equal(save(tree).props.disabled, true);
  assert.ok(JSON.stringify(tree).includes('请填写推荐场景'));
});

test('preset save actions stay outside the scrolling editor', async () => {
  const h = await presetHarness();
  const tree = h.render();
  const footer = tree.children.find(node => node?.props?.['aria-label'] === '预设操作');
  assert.ok(footer, 'actions are a direct sibling of the scrollable content');
  assert.equal(footer.props.style.flexShrink, 0);
  const editor = h.nodes(tree).find(node => node.props.className === 'wc-preset-layout');
  assert.equal(editor.props.style.overflow, 'hidden');
  assert.ok(!JSON.stringify(editor).includes('保存预设'));
  assert.ok(JSON.stringify(footer).includes('保存预设'));
});

test('preset modes clear the old selection highlight in both directions', async () => {
  const h = await presetHarness();
  let buttons = h.modes(h.sections(h.render())[0]);
  assert.deepEqual(buttons.map(b => b.props['aria-pressed']), [false, false, true]);
  buttons[0].props.onClick();
  buttons = h.modes(h.sections(h.render())[0]);
  assert.deepEqual(buttons.map(b => b.props['aria-pressed']), [true, false, false]);
  buttons[2].props.onClick();
  buttons = h.modes(h.sections(h.render())[0]);
  buttons[1].props.onClick();
  buttons = h.modes(h.sections(h.render())[0]);
  assert.deepEqual(buttons.map(b => b.props['aria-pressed']), [false, true, false]);
  assert.equal(buttons[0].props.style.border, buttons[2].props.style.border);
  assert.equal(buttons[0].props.style.borderColor, undefined);
  assert.ok(buttons[0].props.style.border.includes('var(--dsw-alias-border-l2)'));
});

test('preset Skill choices retain source categories and descriptions', async () => {
  const h = await presetHarness();
  const text = JSON.stringify(h.sections(h.render())[0]);
  assert.ok(text.includes('工作区 · .dsh/skills'));
  assert.ok(text.includes('用户级 · ~/.dsh/skills'));
  assert.ok(text.includes('Inspect project changes'));
  assert.ok(text.includes('Research references'));
  const section = h.sections(h.render())[0];
  const checkboxes = h.nodes(section).filter(n => n.type === 'input' && n.props.type === 'checkbox');
  checkboxes[2].props.onChange({ target: { checked: true } });
  const updated = h.nodes(h.sections(h.render())[0]).filter(n => n.type === 'input' && n.props.type === 'checkbox');
  assert.ok(updated.every(node => node.props.checked));
  updated[0].props.onChange({ target: { checked: false } });
  const remaining = h.nodes(h.sections(h.render())[0]).filter(n => n.type === 'input' && n.props.type === 'checkbox');
  assert.deepEqual(remaining.map(node => node.props.checked), [false, false, true, true]);
});

test('preset MCP choices display server capability descriptions', async () => {
  const h = await presetHarness();
  h.modes(h.sections(h.render())[1])[2].props.onClick();
  assert.ok(JSON.stringify(h.sections(h.render())[1]).includes('Read repository data'));
});


test('Skill search matches descriptions case-insensitively and preserves hidden selections', async () => {
  const h = await presetHarness();
  const search = () => h.nodes(h.sections(h.render())[0]).find(n => n.props.type === 'search');
  assert.ok(search(), 'Skill search input exists');
  search().props.onChange({ target: { value: '  RESEARCH  ' } });
  let section = h.sections(h.render())[0];
  assert.ok(!JSON.stringify(section).includes('Inspect project changes'));
  assert.ok(JSON.stringify(section).includes('Research references'));
  h.nodes(section).find(n => n.props.type === 'checkbox').props.onChange({ target: { checked: true } });
  search().props.onChange({ target: { value: '' } });
  const boxes = h.nodes(h.sections(h.render())[0]).filter(n => n.props.type === 'checkbox');
  assert.ok(boxes.every(n => n.props.checked), 'search group toggle preserves hidden alpha');
  search().props.onChange({ target: { value: 'nothing-matches' } });
  assert.ok(JSON.stringify(h.sections(h.render())[0]).includes('没有匹配结果'));
});

test('MCP search matches tool descriptions independently of Skill search', async () => {
  const h = await presetHarness();
  h.modes(h.sections(h.render())[1])[2].props.onClick();
  const search = () => h.nodes(h.sections(h.render())[1]).find(n => n.props.type === 'search');
  assert.ok(search(), 'MCP search input exists');
  search().props.onChange({ target: { value: 'BUG REPORTS' } });
  assert.ok(JSON.stringify(h.sections(h.render())[1]).includes('Read repository data'));
  search().props.onChange({ target: { value: 'unmatched' } });
  assert.ok(JSON.stringify(h.sections(h.render())[1]).includes('没有匹配结果'));
  assert.ok(JSON.stringify(h.sections(h.render())[0]).includes('Inspect project changes'));
});


test('capability groups collapse independently without changing selection and search reveals matches', async () => {
  const h = await presetHarness();
  const toggle = index => h.nodes(h.sections(h.render())[index]).find(n => n.type === 'button' && 'aria-expanded' in n.props);
  assert.ok(toggle(0), 'Skill group has collapse control');
  assert.equal(toggle(0).props['aria-expanded'], true);
  toggle(0).props.onClick();
  assert.equal(toggle(0).props['aria-expanded'], false);
  assert.ok(!JSON.stringify(h.sections(h.render())[0]).includes('Inspect project changes'));
  assert.ok(JSON.stringify(h.sections(h.render())[0]).includes('Research references'));
  h.modes(h.sections(h.render())[1])[2].props.onClick();
  toggle(1).props.onClick();
  assert.ok(!JSON.stringify(h.sections(h.render())[1]).includes('Read repository data'));
  const search = h.nodes(h.sections(h.render())[0]).find(n => n.props.type === 'search');
  search.props.onChange({ target: { value: 'alpha' } });
  assert.equal(toggle(0).props['aria-expanded'], true);
  assert.ok(JSON.stringify(h.sections(h.render())[0]).includes('Inspect project changes'));
  h.nodes(h.sections(h.render())[0]).find(n => n.props.type === 'search').props.onChange({ target: { value: '' } });
  assert.equal(toggle(0).props['aria-expanded'], false);
  toggle(0).props.onClick();
  const boxes = h.nodes(h.sections(h.render())[0]).filter(n => n.props.type === 'checkbox');
  assert.deepEqual(boxes.map(n => n.props.checked), [true, true, false, false]);
});


test('preset capability tabs show one list without nested scrolling and retain selections', async () => {
  const h = await presetHarness();
  const tabs = () => h.nodes(h.render()).filter(n => n.props.role === 'tab');
  assert.equal(tabs().length, 2);
  assert.deepEqual(tabs().map(n => n.props['aria-selected']), [true, false]);
  assert.deepEqual(h.sections(h.render()).map(n => n.props.hidden), [false, true]);
  tabs()[1].props.onClick();
  assert.deepEqual(h.sections(h.render()).map(n => n.props.hidden), [true, false]);
  h.modes(h.sections(h.render())[1])[2].props.onClick();
  h.nodes(h.sections(h.render())[1]).find(n => n.props.type === 'checkbox').props.onChange({ target: { checked: true } });
  tabs()[0].props.onClick();
  assert.ok(h.nodes(h.sections(h.render())[0]).find(n => n.props.type === 'checkbox').props.checked);
  tabs()[1].props.onClick();
  assert.ok(h.nodes(h.sections(h.render())[1]).find(n => n.props.type === 'checkbox').props.checked);
  for (const section of h.sections(h.render())) {
    const scrollers = h.nodes(section).filter(n => n.props.style?.overflowY === 'auto');
    assert.equal(scrollers.length, 1, 'only capability results scroll');
    assert.equal(scrollers[0].props['aria-label'], '能力列表');
    assert.ok(!h.nodes(scrollers[0]).some(n => n.props.type === 'search' || 'aria-pressed' in n.props), 'search and modes remain outside scrolling results');
    assert.equal(section.props.style.minHeight, 0);
    assert.equal(section.props.style.overflow, 'hidden');
  }
});
