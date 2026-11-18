import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Readable } from 'node:stream';
import { apply, withFilterState } from '../index.js';

test('MCP catalog exposes actual tool names and descriptions per server', () => {
  const catalog = withFilterState({ config: {} }, { tools: { definitions: () => [
    { name: 'mcp__github__search', description: 'Search repository content' },
    { name: 'mcp__github__issues', description: 'Read issue details' },
    { name: 'bash', description: 'Not an MCP capability' },
  ] } });
  assert.deepEqual(catalog.mcpServers[0].tools, [
    { name: 'search', description: 'Search repository content' },
    { name: 'issues', description: 'Read issue details' },
  ]);
});

test('preset HTTP CRUD validates names and preserves omitted versus empty capability lists', async t => {
  const root = await mkdtemp(join(tmpdir(), 'dsh-preset-api-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  await mkdir(join(root, '.dsh'));
  let handler;
  const ctx = {
    inject(names, callback) { if (names.includes('webServer')) callback(this); },
    effect: fn => fn(),
    webServer: { register(route) { handler = route.handler; } },
    logger: { warn() {} },
    get() {},
  };
  apply(ctx);
  async function request(method, body) {
    return new Promise((resolve, reject) => {
      const req = Readable.from(body === undefined ? [] : [Buffer.from(JSON.stringify(body))]);
      req.method = method;
      req.url = `/dsh-workspace-capability/roles?workspace=${encodeURIComponent(root)}`;
      const res = { writeHead(status) { this.statusCode = status; }, setHeader() {}, end(value) { resolve({ status: this.statusCode, body: JSON.parse(value) }); } };
      try { handler(req, res); } catch (e) { reject(e); }
    });
  }
  assert.deepEqual((await request('GET')).body, { roles: [], problems: [] });
  assert.equal((await request('POST', { create: true, preset: { name: '../escape', description: 'x' } })).status, 400);
  assert.equal((await request('POST', { create: true, preset: { name: 'review', description: '' } })).status, 400);
  const preset = { name: 'review', description: '适合代码审查', skills: [], mcpServers: ['github'] };
  assert.equal((await request('POST', { create: true, preset })).status, 200);
  assert.equal((await request('POST', { create: true, preset })).status, 409);
  assert.deepEqual((await request('GET')).body.roles, [{ ...preset, id: 'review', displayName: 'review' }]);
  const text = await readFile(join(root, '.dsh', 'agents', 'review.md'), 'utf8');
  assert.ok(text.endsWith('---\n'));
  assert.ok(!text.includes('instructions'));
  assert.equal((await request('POST', { preset: { name: 'review', description: '继承父级' } })).status, 200);
  assert.deepEqual((await request('GET')).body.roles, [{ name: 'review', id: 'review', displayName: 'review', description: '继承父级' }]);
  assert.equal((await request('DELETE', { name: 'review' })).status, 200);
  assert.equal((await request('DELETE', { name: 'review' })).status, 404);
  assert.equal((await request('PUT')).status, 405);
  const created = await request('POST', { create: true, preset: { displayName: '代码审查', description: '检查变更' } });
  assert.equal(created.status, 200);
  const id = created.body.savedId;
  assert.match(id, /^preset-[a-f0-9-]+$/);
  assert.equal(created.body.roles[0].displayName, '代码审查');
  assert.equal((await request('POST', { preset: { name: id, displayName: '严格审查', description: '检查边界' } })).status, 200);
  const renamed = (await request('GET')).body.roles[0];
  assert.equal(renamed.name, id);
  assert.equal(renamed.displayName, '严格审查');
  assert.equal((await request('DELETE', { name: id })).status, 200);
});
