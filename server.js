import { join, dirname } from 'node:path';
import { homedir } from 'node:os';
import { randomBytes } from 'node:crypto';
import { ConfigStore } from './config-store.js';

const root = dirname(import.meta.path);
const store = new ConfigStore(process.env.OMP_MANAGER_CONFIG_DIR || join(homedir(), '.omp', 'agent'));
const token = randomBytes(32).toString('hex');
const port = Number(process.env.OMP_MANAGER_PORT || 18764);
const origin = `http://127.0.0.1:${port}`;
const json = (data, status = 200) => Response.json(data, { status, headers: { 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff' } });
const server = Bun.serve({
  hostname: '127.0.0.1', port,
  async fetch(req) {
    const url = new URL(req.url);
    if (url.host !== `127.0.0.1:${port}`) return json({ error: 'Invalid host' }, 403);
    if (req.headers.get('origin') && req.headers.get('origin') !== origin) return json({ error: 'Invalid origin' }, 403);
    if (url.pathname.startsWith('/api/')) {
      if (req.headers.get('x-manager-token') !== token) return json({ error: '请刷新页面后重试。' }, 403);
      try {
        if (req.method === 'GET' && url.pathname === '/api/config') return json(store.snapshot());
        if (req.method === 'POST' && url.pathname === '/api/config') {
          if (!req.headers.get('content-type')?.includes('application/json')) return json({ error: 'Expected JSON' }, 415);
          if (Number(req.headers.get('content-length')) > 1048576) return json({ error: '内容过大。' }, 413);
          const raw = await req.text();
          if (raw.length > 1048576) return json({ error: '内容过大。' }, 413);
          return json(store.change(JSON.parse(raw)));
        }
      } catch (err) { return json({ error: err.message }, err.status || 400); }
      return json({ error: 'Not found' }, 404);
    }
    if (req.method !== 'GET') return new Response('Method not allowed', { status: 405 });
    if (url.pathname === '/') {
      const html = (await Bun.file(join(root, 'index.html')).text()).replace('__MANAGER_TOKEN__', token);
      return new Response(html, { headers: { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store', 'Content-Security-Policy': "default-src 'self'; script-src 'self' 'unsafe-inline'; style-src 'self' 'unsafe-inline'; connect-src 'self'; frame-ancestors 'none'; base-uri 'none'", 'X-Content-Type-Options': 'nosniff', 'Referrer-Policy': 'no-referrer' } });
    }
    if (['/app.js', '/style.css', '/roles.css', '/role-selectors.js'].includes(url.pathname)) return new Response(Bun.file(join(root, url.pathname.slice(1))), { headers: { 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff' } });
    return new Response('Not found', { status: 404 });
  }
});
console.log(`OMP 模型管理器已启动：${origin}`);
