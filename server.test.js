import { test, expect } from 'bun:test';
import { mkdtempSync, writeFileSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

test('HTTP read/save flow, origin protection, and stale-write rejection', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'omp-manager-http-'));
  writeFileSync(join(dir, 'models.yml'), 'providers: {}\n');
  writeFileSync(join(dir, 'config.yml'), 'theme: {dark: titanium}\n');
  const proc = Bun.spawn([process.execPath, 'run', join(import.meta.dir, 'server.js')], { env: { ...process.env, OMP_MANAGER_CONFIG_DIR: dir, OMP_MANAGER_PORT: '18765' }, stdout: 'pipe', stderr: 'pipe' });
  try {
    const reader = proc.stdout.getReader();
    let started = false;
    for (let i = 0; i < 5; i++) { const chunk = await reader.read(); if (chunk.done) break; if (new TextDecoder().decode(chunk.value).includes('http://')) { started = true; break; } }
    expect(started).toBe(true);
    const base = 'http://127.0.0.1:18765';
    const html = await (await fetch(base)).text();
    const token = html.match(/window.MANAGER_TOKEN='([^']+)'/)[1];
    const headers = { 'x-manager-token': token, 'content-type': 'application/json' };
    expect((await fetch(base + '/api/config')).status).toBe(403);
    expect((await fetch(base + '/api/config', { headers: { ...headers, origin: 'https://example.com' } })).status).toBe(403);
    const snapshot = await (await fetch(base + '/api/config', { headers })).json();
    const body = { revision: snapshot.revision, action: 'provider', id: 'test-gateway', create: true, data: { baseUrl: 'http://127.0.0.1:7864', api: 'anthropic-messages', apiKey: 'fake-test-key', authHeader: true, models: [{ id: 'cn:auto', name: '测试模型', input: ['text'], reasoning: false, contextWindow: 131072, maxTokens: 8192 }] } };
    const response = await fetch(base + '/api/config', { method: 'POST', headers, body: JSON.stringify(body) });
    expect(response.status).toBe(200);
    const saved = await response.json();
    expect(saved.providers['test-gateway'].models[0].id).toBe('cn:auto');
    expect(Bun.YAML.parse(readFileSync(join(dir, 'models.yml'), 'utf8')).providers['test-gateway'].apiKey).toBe('fake-test-key');
    expect((await fetch(base + '/api/config', { method: 'POST', headers, body: JSON.stringify(body) })).status).toBe(409);
    const roles = await fetch(base + '/api/config', { method: 'POST', headers, body: JSON.stringify({ revision: saved.revision, action: 'roles', roles: { default: 'test-gateway/cn:auto' } }) });
    expect(roles.status).toBe(200);
    expect(Bun.YAML.parse(readFileSync(join(dir, 'config.yml'), 'utf8')).modelRoles.default).toBe('test-gateway/cn:auto');
    expect((await fetch(base + '/style.css')).status).toBe(200);
    expect((await fetch(base + '/app.js')).status).toBe(200);
  } finally { proc.kill(); await proc.exited; rmSync(dir, { recursive: true, force: true }); }
}, 15000);
