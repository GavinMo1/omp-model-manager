import { readFileSync, existsSync, mkdirSync, copyFileSync, writeFileSync, renameSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { createHash, randomUUID } from 'node:crypto';
import { ROLE_DEFS, SETTING_THINKING_LEVELS, parseRoleSelectors } from './role-selectors.js';

// Which YAML file each write action is allowed to touch. Keeping this explicit
// prevents an action from silently serializing the wrong file (or no file).
export const TOUCHES = {
  provider: [0],
  delete: [0],
  roles: [1],
  'preset-save': [1],
  'preset-apply': [1],
  'preset-delete': [1],
};

const FILE_NAMES = ['models.yml', 'config.yml'];
const BUILTIN_ROLES = new Set(Object.keys(ROLE_DEFS));
const MODEL_EDITABLE_FIELDS = ['name', 'reasoning', 'input', 'contextWindow', 'maxTokens'];
const PRESET_NAME_DENY = ['constructor', 'prototype', '__proto__'];

const isPlainObject = value => value !== null && typeof value === 'object' && !Array.isArray(value);
const serialize = doc => {
  const text = Bun.YAML.stringify(doc, null, 2);
  return text.endsWith('\n') ? text : text + '\n';
};

export class ConfigStore {
  constructor(dir) { this.dir = dir; }
  read() {
    const paths = FILE_NAMES.map(n => join(this.dir, n));
    const texts = paths.map(p => existsSync(p) ? readFileSync(p, 'utf8') : '');
    const docs = texts.map(t => Bun.YAML.parse(t) || {});
    if (docs.some(d => typeof d !== 'object' || Array.isArray(d))) throw new Error('配置文件必须是 YAML 对象，请先检查原文件。');
    return { paths, texts, docs, revision: createHash('sha256').update(JSON.stringify(texts)).digest('hex') };
  }
  snapshot() {
    const s = this.read();
    const config = s.docs[1];
    return {
      revision: s.revision,
      providers: s.docs[0].providers || {},
      roles: config.modelRoles || {},
      roleTags: config.modelTags || {},
      presets: isPlainObject(config.modelPresets) ? config.modelPresets : {},
      defaultThinkingLevel: config.defaultThinkingLevel,
      modelRoleStorage: config.modelRoleStorage,
      directory: this.dir,
    };
  }
  change(body) {
    const s = this.read();
    if (!body || typeof body !== 'object') throw new Error('请求内容无效。');
    if (body.revision !== s.revision) throw Object.assign(new Error('配置已被其他程序修改。请重新加载后再保存。'), { status: 409 });
    const [models, config] = s.docs;
    models.providers ||= {};
    let presetResult = {};
    if (body.action === 'provider') {
      this.changeProvider(models, config, body);
    } else if (body.action === 'delete') {
      if (!Object.hasOwn(models.providers, body.id)) throw new Error('服务不存在。');
      this.assertUnused(models, config, body.id);
      delete models.providers[body.id];
    } else if (body.action === 'roles') {
      this.changeRoles(config, body);
    } else if (body.action === 'preset-save') {
      this.presetSave(config, body);
    } else if (body.action === 'preset-apply') {
      presetResult = this.presetApply(config, body);
    } else if (body.action === 'preset-delete') {
      this.presetDelete(config, body);
    } else throw new Error('未知操作。');
    const outputs = [models, config].map(serialize);
    outputs.forEach(t => Bun.YAML.parse(t));
    const changed = outputs.map((t, i) => t !== s.texts[i]);
    const targets = TOUCHES[body.action];
    if (!targets) throw new Error('内部错误：action 未登记写盘目标。');
    const changedIndexes = targets.filter(i => changed[i]);
    let backup = null;
    const written = [];
    if (changedIndexes.length) {
      backup = join(this.dir, 'model-manager-backups', new Date().toISOString().replace(/[:.]/g, '-') + '-' + randomUUID().slice(0, 8));
      mkdirSync(backup, { recursive: true });
      try {
        for (const i of changedIndexes) {
          if (existsSync(s.paths[i])) copyFileSync(s.paths[i], join(backup, FILE_NAMES[i]));
          const temp = s.paths[i] + '.tmp-' + randomUUID();
          try { writeFileSync(temp, outputs[i], { encoding: 'utf8', flag: 'wx' }); renameSync(temp, s.paths[i]); }
          finally { rmSync(temp, { force: true }); }
          written.push(i);
        }
      } catch (err) {
        for (const i of written) writeFileSync(s.paths[i], s.texts[i], 'utf8');
        throw err;
      }
    }
    return { ...this.snapshot(), backup, changedFiles: changedIndexes.map(i => FILE_NAMES[i]), ...presetResult };
  }
  changeProvider(models, config, body) {
    const { id, data } = body;
    if (typeof id !== 'string' || !/^[a-zA-Z0-9][a-zA-Z0-9_-]{0,63}$/.test(id)) throw new Error('服务标识只能使用字母、数字、短横线和下划线。');
    if (body.create && Object.hasOwn(models.providers, id)) throw new Error('该服务标识已存在，请使用其他名称。');
    if (!body.create && !Object.hasOwn(models.providers, id)) throw new Error('服务已不存在，请重新加载。');
    if (!isPlainObject(data)) throw new Error('服务配置无效。');
    const old = models.providers[id] || {};
    if (Object.hasOwn(old, 'models') && !Array.isArray(old.models)) throw new Error('原模型列表格式无效。');
    const oldModels = Array.isArray(old.models) ? old.models : [];
    const oldAuth = old.auth;
    if (!['none', 'oauth'].includes(oldAuth) && !(typeof data.apiKey === 'string' && data.apiKey.trim())) {
      throw new Error('请输入 API 密钥，或填写已有环境变量名。');
    }
    let url; try { url = new URL(data.baseUrl); } catch { throw new Error('请输入完整服务地址，例如 http://127.0.0.1:7864'); }
    if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password) throw new Error('服务地址必须是 HTTP 或 HTTPS，且不能包含用户名和密码。');
    if (!['anthropic-messages', 'openai-completions', 'openai-responses'].includes(data.api)) throw new Error('请选择支持的接口协议。');
    const inputModels = data.models ?? [];
    if (!Array.isArray(inputModels)) throw new Error('模型列表格式无效。');
    const seen = new Set();
    const normalized = inputModels.map(raw => this.normalizeModel(raw, oldModels, seen));

    // `auth` is an advanced, hand-written provider field. The UI never edits
    // it, so the payload cannot flip it to `none` and silence key validation.
    const { discovery, auth, ...rest } = data;
    const merged = { ...old, ...rest, models: normalized };
    delete merged.auth;
    if (old.auth !== undefined) merged.auth = old.auth;
    if (['none', 'oauth'].includes(oldAuth)) delete merged.apiKey;
    else merged.apiKey = data.apiKey;

    if (discovery === null) {
      const previous = isPlainObject(old.discovery) ? old.discovery : {};
      if (previous.type && previous.type !== 'openai-models-list') throw new Error('该服务使用手写发现配置，本页不能修改。');
      delete merged.discovery;
    } else if (discovery !== undefined) {
      if (!isPlainObject(discovery)) throw new Error('自动发现配置无效。');
      const previous = isPlainObject(old.discovery) ? old.discovery : {};
      if (previous.type && previous.type !== 'openai-models-list') throw new Error('该服务使用手写发现配置，本页不能修改。');
      if (discovery.type !== undefined && discovery.type !== 'openai-models-list') throw new Error('仅支持 openai-models-list 自动发现。');
      merged.discovery = { ...previous, ...discovery };
    } else if (old.discovery !== undefined) {
      // Preserve hand-written advanced fields untouched.
      merged.discovery = old.discovery;
    }

    for (const m of oldModels) {
      if (m && typeof m.id === 'string' && !seen.has(m.id)) this.assertUnused(models, config, id, m.id);
    }
    models.providers[id] = merged;
  }
  normalizeModel(raw, oldModels, seen) {
    if (!isPlainObject(raw)) throw new Error('模型条目格式无效。');
    if (typeof raw.id !== 'string' || !raw.id.trim() || /[\r\n]/.test(raw.id) || seen.has(raw.id)) throw new Error('模型 ID 不能为空或重复。');
    seen.add(raw.id);
    const old = oldModels.find(m => m && m.id === raw.id);
    const entry = isPlainObject(old) ? { ...old } : {};
    for (const key of MODEL_EDITABLE_FIELDS) delete entry[key];
    entry.id = raw.id;
    if (raw.name !== undefined && raw.name !== null && raw.name !== '') {
      if (typeof raw.name !== 'string' || /[\r\n]/.test(raw.name)) throw new Error('模型显示名称无效。');
      if (raw.name.trim()) entry.name = raw.name.trim();
    }
    if (raw.reasoning === true || raw.reasoning === false) entry.reasoning = raw.reasoning;
    else if (raw.reasoning !== undefined && raw.reasoning !== null && raw.reasoning !== '') throw new Error('“支持推理”必须是布尔值。');
    if (raw.input !== undefined && raw.input !== null && raw.input !== '') {
      if (!Array.isArray(raw.input) || !raw.input.includes('text') || raw.input.some(v => !['text', 'image'].includes(v))) throw new Error('模型输入类型无效。');
      entry.input = raw.input;
    }
    for (const key of ['contextWindow', 'maxTokens']) {
      const value = raw[key];
      if (value === undefined || value === null || value === '') continue;
      if (typeof value !== 'number' || !Number.isSafeInteger(value)) throw new Error(key === 'contextWindow' ? '上下文长度必须是整数。' : '最大输出长度必须是整数。');
      if (key === 'contextWindow' && value < 1024) throw new Error('上下文至少为 1024。');
      if (key === 'maxTokens' && value < 1) throw new Error('最大输出必须大于 0。');
      entry[key] = value;
    }
    if (Number.isSafeInteger(entry.contextWindow) && Number.isSafeInteger(entry.maxTokens) && entry.maxTokens > entry.contextWindow) {
      throw new Error('最大输出不能超过上下文长度。');
    }
    return entry;
  }
  changeRoles(config, body) {
    if (!isPlainObject(body.roles)) throw new Error('模型用途配置无效。');
    if (config.modelRoles !== undefined && !isPlainObject(config.modelRoles)) throw new Error('现有 Role 配置必须是对象。');
    config.modelRoles ||= {};
    for (const [key, val] of Object.entries(body.roles)) {
      if (!/^[a-zA-Z][a-zA-Z0-9_.-]{0,63}$/.test(key) || PRESET_NAME_DENY.includes(key) || typeof val !== 'string' || /[\r\n]/.test(val)) throw new Error('Role 标识或模型配置无效。');
      if (val.trim()) config.modelRoles[key] = val.trim(); else delete config.modelRoles[key];
    }
    if (body.roleNames !== undefined) {
      if (!isPlainObject(body.roleNames)) throw new Error('Role 名称无效。');
      for (const [key, name] of Object.entries(body.roleNames)) {
        if (!Object.hasOwn(body.roles, key) || typeof name !== 'string' || name.length > 80) throw new Error('Role 名称无效。');
        if (config.modelTags !== undefined && !isPlainObject(config.modelTags)) throw new Error('现有 Role 名称配置必须是对象。');
        config.modelTags ||= {};
        if (name.trim()) config.modelTags[key] = { ...config.modelTags[key], name: name.trim() };
      }
    }
    if (body.removeRoles !== undefined) {
      if (!Array.isArray(body.removeRoles)) throw new Error('删除 Role 参数无效。');
      for (const key of body.removeRoles) {
        if (BUILTIN_ROLES.has(key) || !Object.hasOwn(body.roles, key) || body.roles[key] !== '') throw new Error('只能删除已清空的自定义 Role。');
        delete config.modelTags?.[key];
        if (Array.isArray(config.cycleOrder)) config.cycleOrder = config.cycleOrder.filter(r => r !== key);
      }
    }
    if (Object.hasOwn(body, 'defaultThinkingLevel')) {
      const level = body.defaultThinkingLevel;
      if (level === null) delete config.defaultThinkingLevel;
      else if (!SETTING_THINKING_LEVELS.includes(level)) throw new Error('全局思考档位无效。可选：' + SETTING_THINKING_LEVELS.join('、'));
      else config.defaultThinkingLevel = level;
    }
    this.validateModelRoles(config.modelRoles);
  }
  validateModelRoles(roles) {
    if (!isPlainObject(roles)) throw new Error('Role 配置必须是对象。');
    for (const [key, value] of Object.entries(roles)) {
      if (!/^[a-zA-Z][a-zA-Z0-9_.-]{0,63}$/.test(key) || PRESET_NAME_DENY.includes(key)) throw new Error('Role 标识无效：' + key);
      if (typeof value !== 'string' || /[\r\n]/.test(value)) throw new Error('Role 模型配置无效：' + key);
      for (const selector of parseRoleSelectors(value)) {
        if (selector.kind !== 'alias' || selector.raw === '*') continue;
        const target = selector.raw.slice(selector.raw.startsWith('pi/') ? 3 : 1);
        if (!Object.hasOwn(roles, target)) throw new Error('引用的 Role 尚未设置模型：' + target);
      }
    }
    // OMP supports @role aliases. Do not persist circular or dangling aliases.
    for (const start of Object.keys(roles)) {
      const seen = new Set(); let current = start;
      while (current) {
        if (seen.has(current)) throw new Error('Role 引用形成循环：' + start);
        seen.add(current);
        const value = roles[current];
        const next = value === '*' ? 'default' : value?.startsWith('@') ? value.slice(1) : value?.startsWith('pi/') ? value.slice(3) : null;
        if (next && !Object.hasOwn(roles, next)) throw new Error('引用的 Role 尚未设置模型：' + next);
        current = next;
      }
    }
  }
  presetSave(config, body) {
    const name = this.presetName(body.name);
    if (config.modelPresets !== undefined && !isPlainObject(config.modelPresets)) throw new Error('现有预设容器格式无效，请先手工检查配置。');
    config.modelPresets ||= {};
    const exists = Object.hasOwn(config.modelPresets, name);
    if (exists && body.overwrite !== true) throw new Error('同名预设已存在，请确认覆盖。');
    if (exists && !isPlainObject(config.modelPresets[name])) throw new Error('同名预设格式无效，无法覆盖。');
    const roles = structuredClone(config.modelRoles || {});
    this.validateModelRoles(roles);
    const preset = { modelRoles: roles };
    if (SETTING_THINKING_LEVELS.includes(config.defaultThinkingLevel)) preset.defaultThinkingLevel = config.defaultThinkingLevel;
    config.modelPresets[name] = preset;
  }
  presetApply(config, body) {
    const name = this.presetName(body.name);
    const presets = config.modelPresets;
    if (!isPlainObject(presets) || !Object.hasOwn(presets, name) || !isPlainObject(presets[name])) throw new Error('预设不存在或格式无效。');
    const preset = presets[name];
    if (!isPlainObject(preset.modelRoles)) throw new Error('预设内容格式无效。');
    this.validateModelRoles(preset.modelRoles);
    if (Object.hasOwn(preset, 'defaultThinkingLevel') && !SETTING_THINKING_LEVELS.includes(preset.defaultThinkingLevel)) throw new Error('预设中的全局思考档位无效。');
    const before = new Set(Object.keys(config.modelRoles || {}));
    config.modelRoles = structuredClone(preset.modelRoles);
    if (Object.hasOwn(preset, 'defaultThinkingLevel')) config.defaultThinkingLevel = preset.defaultThinkingLevel;
    const after = new Set(Object.keys(config.modelRoles));
    // Remove carousel metadata that would otherwise point at cleared roles.
    if (isPlainObject(config.modelTags)) for (const key of Object.keys(config.modelTags)) if (!after.has(key)) delete config.modelTags[key];
    if (Array.isArray(config.cycleOrder)) config.cycleOrder = config.cycleOrder.filter(r => after.has(r));
    return {
      added: [...after].filter(k => !before.has(k)),
      removed: [...before].filter(k => !after.has(k)),
    };
  }
  presetDelete(config, body) {
    const name = this.presetName(body.name);
    if (!isPlainObject(config.modelPresets) || !Object.hasOwn(config.modelPresets, name) || !isPlainObject(config.modelPresets[name])) throw new Error('预设不存在或格式无效。');
    delete config.modelPresets[name];
  }
  presetName(value) {
    if (typeof value !== 'string') throw new Error('预设名称无效。');
    const name = value.trim();
    if (!name || name.length > 64 || /[\/\\\r\n]/.test(name) || PRESET_NAME_DENY.includes(name)) throw new Error('预设名称需为 1–64 个字符，不能包含斜杠或换行。');
    return name;
  }
  // Compare every selector, including comma-separated lists and presets.
  assertUnused(models, config, provider, model) {
    const known = [];
    const providerModels = models.providers[provider]?.models;
    if (Array.isArray(providerModels)) {
      for (const m of providerModels) if (m && typeof m.id === 'string') known.push(`${provider}/${m.id}`);
    }
    if (model) known.push(`${provider}/${model}`);
    const target = model ? `${provider}/${model}` : provider + '/';
    const uses = new Set();
    const scan = (roles, source) => {
      for (const [role, value] of Object.entries(roles || {})) {
        if (typeof value !== 'string') continue;
        for (const selector of parseRoleSelectors(value, known)) {
          if (selector.kind !== 'model') continue;
          const hit = model ? selector.model === target : selector.model.startsWith(target);
          if (hit) uses.add(source ? `${role}（预设 ${source}）` : role);
        }
      }
    };
    scan(config.modelRoles);
    const presets = isPlainObject(config.modelPresets) ? config.modelPresets : {};
    for (const [name, preset] of Object.entries(presets)) if (isPlainObject(preset)) scan(preset.modelRoles, name);
    if (uses.size) throw new Error('该模型仍被以下用途使用：' + [...uses].join('、') + '。请先修改「Role 配置」或相关预设。');
  }
}
