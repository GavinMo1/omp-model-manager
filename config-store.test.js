import { test, expect, beforeEach, afterEach } from 'bun:test';
import { mkdtempSync, writeFileSync, readFileSync, rmSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ConfigStore } from './config-store.js';

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
