import { test, expect, beforeEach, afterEach } from 'bun:test';
import { mkdtempSync, writeFileSync, readFileSync, rmSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ConfigStore, TOUCHES } from './config-store.js';

let dir, store;
const model = { id: 'cn:auto', contextWindow: 131072, maxTokens: 8192, reasoning: false, input: ['text'] };
const provider = { baseUrl: 'http://127.0.0.1:7864', api: 'anthropic-messages', apiKey: 'test-token', authHeader: true, models: [model] };
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'omp-manager-test-'));
  writeFileSync(join(dir, 'models.yml'), Bun.YAML.stringify({ providers: { xiaomi: { modelOverrides: { mimo: { maxTokens: 1234 } } }, local: { ...provider, headers: { 'x-custom': 'keep' }, models: [{ ...model, cost: { input: 2, output: 3, cacheRead: 0, cacheWrite: 0 } }] } }, futureKey: 'keep' }));
  writeFileSync(join(dir, 'config.yml'), '# retain byte-for-byte unless editing roles\nmodelRoles:\n  default: local/cn:auto\n  slow: local/cn:auto:high\ntheme:\n  dark: titanium\n');
  store = new ConfigStore(dir);
});
afterEach(() => rmSync(dir, { recursive: true, force: true }));
test('saving provider retains advanced fields, unrelated settings and exact backup', () => {
  const original = readFileSync(join(dir, 'models.yml'), 'utf8');
  const config = readFileSync(join(dir, 'config.yml'), 'utf8');
  const result = store.change({ revision: store.snapshot().revision, action: 'provider', id: 'local', data: { ...provider, apiKey: 'updated' } });
  expect(result.providers.local.apiKey).toBe('updated');
  expect(result.providers.local.headers['x-custom']).toBe('keep');
  expect(result.providers.local.models[0].cost.input).toBe(2);
  expect(result.providers.xiaomi.modelOverrides.mimo.maxTokens).toBe(1234);
  expect(Bun.YAML.parse(readFileSync(join(dir, 'models.yml'), 'utf8')).futureKey).toBe('keep');
  expect(readFileSync(join(result.backup, 'models.yml'), 'utf8')).toBe(original);
  expect(readFileSync(join(dir, 'config.yml'), 'utf8')).toBe(config);
});
test('conflicting external changes never get overwritten', () => {
  const revision = store.snapshot().revision;
  writeFileSync(join(dir, 'config.yml'), 'theme: {dark: changed}\n');
  expect(() => store.change({ revision, action: 'delete', id: 'local' })).toThrow('其他程序');
  expect(store.snapshot().providers.local).toBeDefined();
});
test('in-use providers and models are protected, including thinking suffix', () => {
  expect(() => store.change({ revision: store.snapshot().revision, action: 'delete', id: 'local' })).toThrow('default、slow');
  expect(() => store.change({ revision: store.snapshot().revision, action: 'provider', id: 'local', data: { ...provider, models: [{ ...model, id: 'replacement' }] } })).toThrow('default、slow');
});
test('role edits preserve settings, support clearing, and allow deleting unused providers', () => {
  const originalModels = readFileSync(join(dir, 'models.yml'), 'utf8');
  const result = store.change({ revision: store.snapshot().revision, action: 'roles', roles: { default: 'xiaomi/mimo', slow: '' } });
  expect(result.roles.default).toBe('xiaomi/mimo');
  expect(result.roles.slow).toBeUndefined();
  expect(Bun.YAML.parse(readFileSync(join(dir, 'config.yml'), 'utf8')).theme.dark).toBe('titanium');
  expect(readFileSync(join(dir, 'models.yml'), 'utf8')).toBe(originalModels);
  expect(existsSync(join(result.backup, 'config.yml'))).toBe(true);
  expect(store.change({ revision: result.revision, action: 'delete', id: 'local' }).providers.local).toBeUndefined();
});
test('duplicate creation and invalid token limits fail without writing', () => {
  const revision = store.snapshot().revision;
  expect(() => store.change({ revision, action: 'provider', id: 'local', create: true, data: provider })).toThrow('已存在');
  expect(() => store.change({ revision, action: 'provider', id: 'new', create: true, data: { ...provider, models: [{ ...model, maxTokens: 999999 }] } })).toThrow('最大输出');
  expect(store.snapshot().revision).toBe(revision);
});

test('custom and specialized roles persist with metadata and thinking suffix', () => {
  const result = store.change({ revision: store.snapshot().revision, action: 'roles', roles: { reviewer: 'local/cn:auto:high', web: 'web/perplexity', smol: '@default' }, roleNames: { reviewer: '代码审阅' } });
  expect(result.roles.reviewer).toBe('local/cn:auto:high');
  expect(result.roles.smol).toBe('@default');
  expect(result.roles.web).toBe('web/perplexity');
  expect(result.roleTags.reviewer.name).toBe('代码审阅');
  expect(() => store.change({ revision: result.revision, action: 'roles', roles: { default: '@reviewer', reviewer: '@default' } })).toThrow('循环');
  expect(store.snapshot().revision).toBe(result.revision);
});

test('deleting a custom role cleans its tag and carousel entry while keeping other metadata', () => {
  const config = Bun.YAML.parse(readFileSync(join(dir, 'config.yml'), 'utf8'));
  config.modelRoles.reviewer = 'local/cn:auto';
  config.modelTags = { reviewer: { name: 'Review', color: 'accent' }, default: { name: 'Main', hidden: true } };
  config.cycleOrder = ['default', 'reviewer', 'smol'];
  writeFileSync(join(dir, 'config.yml'), Bun.YAML.stringify(config));
  const saved = store.change({ revision: store.snapshot().revision, action: 'roles', roles: { reviewer: '' }, removeRoles: ['reviewer'] });
  expect(saved.roles.reviewer).toBeUndefined();
  expect(saved.roleTags.reviewer).toBeUndefined();
  expect(saved.roleTags.default.hidden).toBe(true);
  expect(Bun.YAML.parse(readFileSync(join(dir, 'config.yml'), 'utf8')).cycleOrder).toEqual(['default', 'smol']);
  expect(() => store.change({ revision: saved.revision, action: 'roles', roles: { default: '' }, removeRoles: ['default'] })).toThrow('自定义');
});

test('YAML is written as readable block text with a trailing newline and no-op saves skip backups', () => {
  const data = { ...provider, apiKey: 'updated' };
  const first = store.change({ revision: store.snapshot().revision, action: 'provider', id: 'local', data });
  const text = readFileSync(join(dir, 'models.yml'), 'utf8');
  expect(text).toContain('\n  ');
  expect(text.endsWith('\n')).toBe(true);
  expect(first.backup).not.toBeNull();
  const second = store.change({ revision: first.revision, action: 'provider', id: 'local', data });
  expect(second.changedFiles).toEqual([]);
  expect(second.backup).toBeNull();
});

test('write targets are explicit and unknown actions are rejected', () => {
  expect(TOUCHES).toEqual({ provider: [0], delete: [0], roles: [1], 'preset-save': [1], 'preset-apply': [1], 'preset-delete': [1] });
  expect(() => store.change({ revision: store.snapshot().revision, action: 'nope' })).toThrow('未知操作');
});

test('global thinking level accepts only settings values and can be deleted', () => {
  const saved = store.change({ revision: store.snapshot().revision, action: 'roles', roles: {}, defaultThinkingLevel: 'low' });
  expect(saved.defaultThinkingLevel).toBe('low');
  expect(() => store.change({ revision: saved.revision, action: 'roles', roles: {}, defaultThinkingLevel: 'off' })).toThrow('全局思考档位');
  const cleared = store.change({ revision: saved.revision, action: 'roles', roles: {}, defaultThinkingLevel: null });
  expect(cleared.defaultThinkingLevel).toBeUndefined();
});

test('presets snapshot roles, apply as a whole table, and never share references', () => {
  const saved = store.change({ revision: store.snapshot().revision, action: 'preset-save', name: 'A' });
  expect(saved.presets.A.modelRoles).toEqual({ default: 'local/cn:auto', slow: 'local/cn:auto:high' });
  const changed = store.change({ revision: saved.revision, action: 'roles', roles: { default: 'xiaomi/mimo', slow: '' } });
  expect(changed.presets.A.modelRoles).toEqual({ default: 'local/cn:auto', slow: 'local/cn:auto:high' });
  const text = readFileSync(join(dir, 'config.yml'), 'utf8');
  expect(text).not.toMatch(/(^|\s)[&*][A-Za-z]/m);
  const applied = store.change({ revision: changed.revision, action: 'preset-apply', name: 'A' });
  expect(applied.roles).toEqual({ default: 'local/cn:auto', slow: 'local/cn:auto:high' });
  expect(applied.added).toEqual(['slow']);
  expect(applied.removed).toEqual([]);
});

test('preset apply clears absent roles and prunes carousel metadata', () => {
  const config = Bun.YAML.parse(readFileSync(join(dir, 'config.yml'), 'utf8'));
  config.modelTags = { reviewer: { name: 'Review' }, default: { name: 'Main' } };
  config.cycleOrder = ['default', 'reviewer', 'slow'];
  writeFileSync(join(dir, 'config.yml'), Bun.YAML.stringify(config));
  const saved = store.change({ revision: store.snapshot().revision, action: 'preset-save', name: 'A' });
  expect(saved.presets.A.modelRoles.reviewer).toBeUndefined();
  const added = store.change({ revision: saved.revision, action: 'roles', roles: { reviewer: 'local/cn:auto' } });
  expect(added.roleTags.reviewer.name).toBe('Review');
  expect(Bun.YAML.parse(readFileSync(join(dir, 'config.yml'), 'utf8')).cycleOrder).toEqual(['default', 'reviewer', 'slow']);
  const applied = store.change({ revision: added.revision, action: 'preset-apply', name: 'A' });
  expect(applied.roles.reviewer).toBeUndefined();
  expect(applied.roleTags.reviewer).toBeUndefined();
  expect(Bun.YAML.parse(readFileSync(join(dir, 'config.yml'), 'utf8')).cycleOrder).toEqual(['default', 'slow']);
  expect(applied.presets.A.modelRoles.reviewer).toBeUndefined();
});

test('preset names and containers are validated without throwing TypeErrors', () => {
  const revision = store.snapshot().revision;
  expect(() => store.change({ revision, action: 'preset-save', name: '__proto__' })).toThrow('预设名称');
  const saved = store.change({ revision, action: 'preset-save', name: 'A' });
  expect(() => store.change({ revision: saved.revision, action: 'preset-save', name: 'A' })).toThrow('同名预设');
  const overwritten = store.change({ revision: saved.revision, action: 'preset-save', name: 'A', overwrite: true });
  expect(overwritten.presets.A).toBeDefined();
  expect(() => store.change({ revision: overwritten.revision, action: 'preset-delete', name: 'missing' })).toThrow('预设不存在');
  const config = Bun.YAML.parse(readFileSync(join(dir, 'config.yml'), 'utf8'));
  config.modelPresets = { bad: null };
  writeFileSync(join(dir, 'config.yml'), Bun.YAML.stringify(config));
  expect(() => store.change({ revision: store.snapshot().revision, action: 'preset-apply', name: 'bad' })).toThrow('预设不存在或格式无效');
  expect(() => store.change({ revision: store.snapshot().revision, action: 'preset-delete', name: 'bad' })).toThrow('预设不存在或格式无效');
});

test('preset apply rejects dangling aliases and invalid global levels', () => {
  const saved = store.change({ revision: store.snapshot().revision, action: 'preset-save', name: 'A' });
  const config = Bun.YAML.parse(readFileSync(join(dir, 'config.yml'), 'utf8'));
  config.modelPresets.dangling = { modelRoles: { default: '@missing' } };
  config.modelPresets.invalidLevel = { modelRoles: { default: 'local/cn:auto' }, defaultThinkingLevel: 'off' };
  writeFileSync(join(dir, 'config.yml'), Bun.YAML.stringify(config));
  const revision = store.snapshot().revision;
  expect(() => store.change({ revision, action: 'preset-apply', name: 'dangling' })).toThrow('引用的 Role');
  expect(() => store.change({ revision, action: 'preset-apply', name: 'invalidLevel' })).toThrow('全局思考档位');
  expect(saved.presets.A).toBeDefined();
});

test('model references are checked per comma item, including presets and colon IDs', () => {
  const config = Bun.YAML.parse(readFileSync(join(dir, 'config.yml'), 'utf8'));
  config.modelRoles.default = 'local/cn:auto:high, xiaomi/mimo';
  config.modelRoles.slow = 'local/other';
  writeFileSync(join(dir, 'config.yml'), Bun.YAML.stringify(config));
  expect(() => store.change({ revision: store.snapshot().revision, action: 'provider', id: 'local', data: { ...provider, models: [{ ...model, id: 'new' }] } })).toThrow('default');
  const saved = store.change({ revision: store.snapshot().revision, action: 'preset-save', name: 'A' });
  const edited = store.change({ revision: saved.revision, action: 'roles', roles: { default: 'local/new', slow: 'local/other' } });
  expect(() => store.change({ revision: edited.revision, action: 'provider', id: 'local', data: { ...provider, models: [{ ...model, id: 'new' }] } })).toThrow('预设 A');
});

test('discovery providers allow empty models and preserve advanced discovery fields', () => {
  const base = { api: 'anthropic-messages', baseUrl: 'http://127.0.0.1:7864', apiKey: 'fake', authHeader: true };
  const created = store.change({ revision: store.snapshot().revision, action: 'provider', id: 'discovered', create: true, data: { ...base, models: [], discovery: { type: 'openai-models-list', injectV1: false, timeoutMs: 5000 } } });
  expect(created.providers.discovered.models).toEqual([]);
  expect(created.providers.discovered.discovery.injectV1).toBe(false);
  const reopened = store.change({ revision: created.revision, action: 'provider', id: 'discovered', data: { ...base, models: [], discovery: { type: 'openai-models-list' } } });
  expect(reopened.providers.discovered.discovery.timeoutMs).toBe(5000);
  const cancelled = store.change({ revision: reopened.revision, action: 'provider', id: 'discovered', data: { ...base, models: [], discovery: null } });
  expect(cancelled.providers.discovered.discovery).toBeUndefined();
  expect(Bun.YAML.parse(readFileSync(join(dir, 'models.yml'), 'utf8')).providers.discovered.discovery).toBeUndefined();
});

test('explicit model entries only override supplied fields and clearing limits removes them', () => {
  const created = store.change({ revision: store.snapshot().revision, action: 'provider', id: 'discovered', create: true, data: { api: 'anthropic-messages', baseUrl: 'http://127.0.0.1:7864', apiKey: 'fake', models: [{ id: 'cn:auto', input: ['text', 'image'] }], discovery: { type: 'openai-models-list' } } });
  const entry = created.providers.discovered.models[0];
  expect(entry.contextWindow).toBeUndefined();
  expect(entry.maxTokens).toBeUndefined();
  const edited = store.change({ revision: created.revision, action: 'provider', id: 'discovered', data: { api: 'anthropic-messages', baseUrl: 'http://127.0.0.1:7864', apiKey: 'fake', models: [{ id: 'cn:auto', input: ['text'] }], discovery: { type: 'openai-models-list' } } });
  expect(edited.providers.discovered.models[0].contextWindow).toBeUndefined();
});

test('empty apiKey is rejected unless auth is none/oauth, where the key is removed', () => {
  const config = Bun.YAML.parse(readFileSync(join(dir, 'models.yml'), 'utf8'));
  config.providers.oauth = { baseUrl: 'http://127.0.0.1:1', api: 'openai-completions', auth: 'oauth', models: [{ id: 'm', input: ['text'], contextWindow: 4096, maxTokens: 512 }] };
  writeFileSync(join(dir, 'models.yml'), Bun.YAML.stringify(config));
  const saved = store.change({ revision: store.snapshot().revision, action: 'provider', id: 'oauth', data: { baseUrl: 'http://127.0.0.1:1', api: 'openai-completions', apiKey: '', auth: 'none', models: [{ id: 'm', input: ['text'], contextWindow: 4096, maxTokens: 512 }] } });
  expect(Object.hasOwn(saved.providers.oauth, 'apiKey')).toBe(false);
  expect(saved.providers.oauth.auth).toBe('oauth');
  expect(() => store.change({ revision: saved.revision, action: 'provider', id: 'local', data: { ...provider, apiKey: '' } })).toThrow('API 密钥');
});

test('numeric model fields reject strings and bad reasoning values', () => {
  const revision = store.snapshot().revision;
  expect(() => store.change({ revision, action: 'provider', id: 'local', data: { ...provider, models: [{ ...model, contextWindow: '131072' }] } })).toThrow('整数');
  expect(() => store.change({ revision, action: 'provider', id: 'local', data: { ...provider, models: [{ ...model, reasoning: 'yes' }] } })).toThrow('布尔');
});

test('widget is a built-in role and cannot be deleted', () => {
  const result = store.change({ revision: store.snapshot().revision, action: 'roles', roles: { widget: '' } });
  expect(result.roles.widget).toBeUndefined();
  expect(() => store.change({ revision: result.revision, action: 'roles', roles: { widget: '' }, removeRoles: ['widget'] })).toThrow('自定义');
});
