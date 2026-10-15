import { readFileSync, existsSync, mkdirSync, copyFileSync, writeFileSync, renameSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { createHash, randomUUID } from 'node:crypto';

export class ConfigStore {
  constructor(dir) { this.dir = dir; }
  read() {
    const paths = ['models.yml', 'config.yml'].map(n => join(this.dir, n));
    const texts = paths.map(p => existsSync(p) ? readFileSync(p, 'utf8') : '');
    const docs = texts.map(t => Bun.YAML.parse(t) || {});
    if (docs.some(d => typeof d !== 'object' || Array.isArray(d))) throw new Error('配置文件必须是 YAML 对象，请先检查原文件。');
    return { paths, texts, docs, revision: createHash('sha256').update(JSON.stringify(texts)).digest('hex') };
  }
  snapshot() {
    const s = this.read();
    return { revision: s.revision, providers: s.docs[0].providers || {}, roles: s.docs[1].modelRoles || {}, roleTags: s.docs[1].modelTags || {}, directory: this.dir };
  }
  change(body) {
    const s = this.read();
    if (body.revision !== s.revision) throw Object.assign(new Error('配置已被其他程序修改。请重新加载后再保存。'), { status: 409 });
    const [models, config] = s.docs;
    models.providers ||= {};
    if (body.action === 'provider') {
      const { id, data } = body;
      if (typeof id !== 'string' || !/^[a-zA-Z0-9][a-zA-Z0-9_-]{0,63}$/.test(id)) throw new Error('服务标识只能使用字母、数字、短横线和下划线。');
      if (body.create && Object.hasOwn(models.providers, id)) throw new Error('该服务标识已存在，请使用其他名称。');
      if (!body.create && !Object.hasOwn(models.providers, id)) throw new Error('服务已不存在，请重新加载。');
      if (!data || typeof data !== 'object' || !Array.isArray(data.models) || !data.models.length) throw new Error('请至少添加一个模型。');
      let url; try { url = new URL(data.baseUrl); } catch { throw new Error('请输入完整服务地址，例如 http://127.0.0.1:7864'); }
      if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password) throw new Error('服务地址必须是 HTTP 或 HTTPS，且不能包含用户名和密码。');
      if (!['anthropic-messages', 'openai-completions', 'openai-responses'].includes(data.api)) throw new Error('请选择支持的接口协议。');
      if (typeof data.apiKey !== 'string') throw new Error('密钥格式无效。');
      const seen = new Set();
      for (const m of data.models) {
        if (!m || typeof m.id !== 'string' || !m.id.trim() || /[\r\n]/.test(m.id) || seen.has(m.id)) throw new Error('模型 ID 不能为空或重复。');
        seen.add(m.id);
        if (!Number.isSafeInteger(m.contextWindow) || m.contextWindow < 1024 || !Number.isSafeInteger(m.maxTokens) || m.maxTokens < 1 || m.maxTokens > m.contextWindow) throw new Error('上下文至少为 1024，最大输出必须大于 0 且不超过上下文。');
        if (!Array.isArray(m.input) || !m.input.includes('text') || m.input.some(v => !['text', 'image'].includes(v))) throw new Error('模型输入类型无效。');
      }
      // Retain advanced provider fields, model overrides and unknown future fields.
      const old = models.providers[id] || {};
      if (Object.hasOwn(old, 'models') && !Array.isArray(old.models)) throw new Error('原模型列表格式无效。');
      const removed = (old.models || []).filter(m => !seen.has(m.id));
      for (const m of removed) this.assertUnused(config, id, m.id);
      models.providers[id] = { ...old, ...data, models: data.models.map(m => ({ ...(old.models || []).find(o => o.id === m.id), ...m })) };
    } else if (body.action === 'delete') {
      if (!Object.hasOwn(models.providers, body.id)) throw new Error('服务不存在。');
      this.assertUnused(config, body.id);
      delete models.providers[body.id];
    } else if (body.action === 'roles') {
      if (!body.roles || typeof body.roles !== 'object') throw new Error('模型用途配置无效。');
      for (const [key, val] of Object.entries(body.roles)) {
        if (!/^[a-zA-Z][a-zA-Z0-9_.-]{0,63}$/.test(key) || ['constructor', 'prototype', '__proto__'].includes(key) || typeof val !== 'string' || /[\r\n]/.test(val)) throw new Error('Role 标识或模型配置无效。');
        config.modelRoles ||= {};
        if (val.trim()) config.modelRoles[key] = val.trim(); else delete config.modelRoles[key];
      }
      if (body.roleNames) for (const [key, name] of Object.entries(body.roleNames)) {
        if (!Object.hasOwn(body.roles, key) || typeof name !== 'string' || name.length > 80) throw new Error('Role 名称无效。');
        config.modelTags ||= {};
        if (name.trim()) config.modelTags[key] = { ...config.modelTags[key], name: name.trim() };
      }
      if (body.removeRoles) {
        const builtin = ['default', 'smol', 'slow', 'plan', 'vision', 'commit', 'tiny', 'memory', 'task', 'advisor', 'image', 'web', 'speech', 'dictation', 'judge'];
        if (!Array.isArray(body.removeRoles)) throw new Error('删除 Role 参数无效。');
        for (const key of body.removeRoles) {
          if (builtin.includes(key) || !Object.hasOwn(body.roles, key) || body.roles[key] !== '') throw new Error('只能删除已清空的自定义 Role。');
          delete config.modelTags?.[key];
          if (Array.isArray(config.cycleOrder)) config.cycleOrder = config.cycleOrder.filter(r => r !== key);
        }
      }
      // OMP supports @role aliases. Do not persist circular or dangling aliases.
      for (const start of Object.keys(config.modelRoles || {})) {
        const seen = new Set(); let current = start;
        while (current) {
          if (seen.has(current)) throw new Error('Role 引用形成循环：' + start);
          seen.add(current);
          const value = config.modelRoles[current];
          const next = value === '*' ? 'default' : value?.startsWith('@') ? value.slice(1) : value?.startsWith('pi/') ? value.slice(3) : null;
          if (next && !Object.hasOwn(config.modelRoles, next)) throw new Error('引用的 Role 尚未设置模型：' + next);
          current = next;
        }
      }
    } else throw new Error('未知操作。');
    const outputs = [models, config].map(d => Bun.YAML.stringify(d));
    outputs.forEach(t => Bun.YAML.parse(t));
    const changed = outputs.map((t, i) => t !== s.texts[i]);
    // Only serialize a file affected by this action.
    if (body.action === 'roles') changed[0] = false; else changed[1] = false;
    const backup = join(this.dir, 'model-manager-backups', new Date().toISOString().replace(/[:.]/g, '-') + '-' + randomUUID().slice(0, 8));
    mkdirSync(backup, { recursive: true });
    const written = [];
    try {
      for (let i = 0; i < 2; i++) if (changed[i]) {
        if (existsSync(s.paths[i])) copyFileSync(s.paths[i], join(backup, i ? 'config.yml' : 'models.yml'));
        const temp = s.paths[i] + '.tmp-' + randomUUID();
        try { writeFileSync(temp, outputs[i], { encoding: 'utf8', flag: 'wx' }); renameSync(temp, s.paths[i]); }
        finally { rmSync(temp, { force: true }); }
        written.push(i);
      }
    } catch (err) {
      for (const i of written) writeFileSync(s.paths[i], s.texts[i], 'utf8');
      throw err;
    }
    return { ...this.snapshot(), backup };
  }
  assertUnused(config, provider, model) {
    const prefix = provider + '/' + (model || '');
    const uses = Object.entries(config.modelRoles || {}).filter(([, value]) => typeof value === 'string' && (model ? value === prefix || value.startsWith(prefix + ':') : value.startsWith(prefix)));
    if (uses.length) throw new Error('该模型仍被以下用途使用：' + uses.map(([k]) => k).join('、') + '。请先修改「Role 配置」。');
  }
}
