#!/usr/bin/env bun
// One-shot: point every chat role of the global OMP config at the current
// model with a fixed thinking level, then save `config.yml`.
//
// Usage:
//   bun run switch-all-to-deepseek.js              # apply
//   bun run switch-all-to-deepseek.js --dry-run    # show the diff only
//   bun run switch-all-to-deepseek.js --thinking=low --model=wb-api/cn:deepseek-v4.1-flash
//   bun run switch-all-to-deepseek.js --include-judge
//   bun run switch-all-to-deepseek.js --exclude=designer
//
// `web`, `image`, `speech`, `dictation` are model-kind roles and are never
// touched: a chat model cannot serve them (web search, image generation, TTS, STT).
// `judge` is also left alone unless `--include-judge` is given.

import {
  copyFileSync, existsSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync,
} from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import {
  ROLE_DEFS, KIND_ROLES, SELECTOR_EFFORTS, SETTING_THINKING_LEVELS, parseRoleSelectors,
} from './role-selectors.js';

const NON_CHAT_ROLES = new Set(KIND_ROLES.filter(role => role !== 'judge'));
const CHAT_ROLES = Object.keys(ROLE_DEFS).filter(role => !KIND_ROLES.includes(role));

function parseArgs(argv) {
  const opts = { dryRun: false, thinking: 'low', model: null, dir: null, exclude: [], includeJudge: false };
  for (const arg of argv) {
    if (arg === '--dry-run' || arg === '-n') opts.dryRun = true;
    else if (arg === '--include-judge') opts.includeJudge = true;
    else if (arg.startsWith('--thinking=')) opts.thinking = arg.slice('--thinking='.length);
    else if (arg.startsWith('--model=')) opts.model = arg.slice('--model='.length);
    else if (arg.startsWith('--dir=')) opts.dir = arg.slice('--dir='.length);
    else if (arg.startsWith('--exclude=')) opts.exclude = arg.slice('--exclude='.length).split(',').map(s => s.trim()).filter(Boolean);
    else throw new Error(`未知参数：${arg}`);
  }
  if (!SELECTOR_EFFORTS.includes(opts.thinking)) {
    throw new Error(`思考档位无效：${opts.thinking}（可选：${SELECTOR_EFFORTS.join(', ')}）`);
  }
  return opts;
}

function resolveModel(value, known) {
  if (known.has(value)) return value;
  const match = /^(.*):(off|minimal|low|medium|high|xhigh|max|auto|inherit)$/.exec(value);
  if (match && known.has(match[1])) return match[1];
  return null;
}

function pickTarget(models, config, override) {
  const known = new Set();
  const discoveryProviders = new Set();
  for (const [pid, provider] of Object.entries(models.providers || {})) {
    if (provider?.discovery && typeof provider.discovery === 'object' && provider.discovery.type) discoveryProviders.add(pid);
    for (const model of provider?.models || []) if (model && typeof model.id === 'string') known.add(`${pid}/${model.id}`);
  }
  if (override) {
    const pid = override.includes('/') ? override.slice(0, override.indexOf('/')) : '';
    // Discovery providers may expose IDs that are not in models.yml. Accept
    // the override verbatim so a suffix-looking model ID is never damaged.
    if (pid && discoveryProviders.has(pid)) return override;
    const resolved = resolveModel(override, known);
    if (!resolved) throw new Error(`models.yml 中找不到模型：${override}`);
    return resolved;
  }
  const deepseek = [...known].filter(id => /deepseek/i.test(id));
  if (deepseek.length === 1) return deepseek[0];
  if (deepseek.length > 1) {
    throw new Error(`找到多个 DeepSeek 模型，请用 --model= 指定：\n  ${deepseek.join('\n  ')}`);
  }
  const currentDefault = config.modelRoles?.default;
  if (typeof currentDefault === 'string') {
    for (const selector of parseRoleSelectors(currentDefault, [...known])) {
      const resolved = resolveModel(selector.model, known);
      if (resolved) return resolved;
    }
  }
  throw new Error('models.yml 中没有 DeepSeek 模型，请用 --model=provider/model 指定（模型也可能来自自动发现）。');
}

function backupFile(path, backupDir) {
  mkdirSync(backupDir, { recursive: true });
  copyFileSync(path, join(backupDir, 'config.yml'));
}

function atomicWrite(path, text) {
  const temp = `${path}.tmp-${process.pid}-${Date.now()}`;
  try {
    writeFileSync(temp, text, { encoding: 'utf8', flag: 'wx' });
    renameSync(temp, path);
  } finally {
    rmSync(temp, { force: true });
  }
}

async function main() {
  const opts = parseArgs(process.argv.slice(2));
  const dir = opts.dir || process.env.OMP_MANAGER_CONFIG_DIR || join(homedir(), '.omp', 'agent');
  const modelsPath = join(dir, 'models.yml');
  const configPath = join(dir, 'config.yml');
  if (!existsSync(modelsPath)) throw new Error(`找不到 ${modelsPath}`);
  if (!existsSync(configPath)) throw new Error(`找不到 ${configPath}`);

  const modelsText = readFileSync(modelsPath, 'utf8');
  const configText = readFileSync(configPath, 'utf8');
  const models = Bun.YAML.parse(modelsText) || {};
  const config = Bun.YAML.parse(configText) || {};
  if (typeof models !== 'object' || Array.isArray(models)) throw new Error('models.yml 顶层不是映射。');
  if (typeof config !== 'object' || Array.isArray(config)) throw new Error('config.yml 顶层不是映射。');

  const target = pickTarget(models, config, opts.model);
  const value = `${target}:${opts.thinking}`;
  const excluded = new Set([...NON_CHAT_ROLES, ...opts.exclude]);
  if (!opts.includeJudge) excluded.add('judge');
  const oldRoles = (config.modelRoles && typeof config.modelRoles === 'object') ? config.modelRoles : {};
  const roleNames = [...new Set([
    ...Object.keys(oldRoles).filter(role => !excluded.has(role)),
    ...CHAT_ROLES.filter(role => !excluded.has(role)),
    ...(opts.includeJudge && !excluded.has('judge') ? ['judge'] : []),
  ])];

  const managed = new Set(roleNames);
  const nextRoles = {};
  const changes = [];
  // Preserve the original key order; leave unmanaged roles untouched.
  for (const [role, roleValue] of Object.entries(oldRoles)) {
    if (!managed.has(role)) { nextRoles[role] = roleValue; continue; }
    const next = role === 'judge' ? target : value;
    nextRoles[role] = next;
    if (roleValue !== next) changes.push({ role, from: roleValue ?? '(未设置)', to: next });
  }
  for (const role of roleNames) {
    if (Object.hasOwn(nextRoles, role)) continue;
    const next = role === 'judge' ? target : value;
    nextRoles[role] = next;
    changes.push({ role, from: '(未设置)', to: next });
  }

  const nextConfig = { ...config, modelRoles: nextRoles };
  const oldDefaultThinking = config.defaultThinkingLevel;
  const writeGlobal = SETTING_THINKING_LEVELS.includes(opts.thinking);
  if (writeGlobal) nextConfig.defaultThinkingLevel = opts.thinking;

  const lines = [];
  lines.push(`配置目录：${dir}`);
  lines.push(`目标模型：${value}`);
  lines.push('');
  if (changes.length) {
    const width = Math.max(...changes.map(c => c.role.length), 4);
    lines.push(`${'Role'.padEnd(width)}  原值 -> 新值`);
    for (const c of changes) lines.push(`${c.role.padEnd(width)}  ${c.from} -> ${c.to}`);
  } else {
    lines.push('所有受管 Role 已经是目标值，无需改动。');
  }
  if (writeGlobal && oldDefaultThinking !== opts.thinking) {
    lines.push('');
    lines.push(`defaultThinkingLevel：${oldDefaultThinking ?? '(默认)'} -> ${opts.thinking}`);
  } else if (!writeGlobal) {
    lines.push('');
    lines.push(`defaultThinkingLevel：保持不变（${opts.thinking} 仅作为角色后缀）。`);
  }
  const keptKindRoles = Object.entries(oldRoles).filter(([role]) => NON_CHAT_ROLES.has(role) || (role === 'judge' && !opts.includeJudge));
  if (keptKindRoles.length) {
    lines.push('');
    lines.push('保持不动（非聊天模型角色）：');
    for (const [role, roleValue] of keptKindRoles) lines.push(`  ${role}: ${roleValue}`);
  }
  if (opts.exclude.length) lines.push(`\n按 --exclude 跳过：${opts.exclude.join(', ')}`);
  if (!opts.includeJudge) lines.push('judge 未改动；需要时加 --include-judge（只写模型，不带档位）。');

  const warnings = [];
  if (config.modelPresets && Object.keys(config.modelPresets).length) {
    warnings.push(`modelPresets 中有 ${Object.keys(config.modelPresets).length} 个预设仍引用旧模型；脚本不会改动，切换预设时会覆盖本脚本结果。`);
  }
  if (config.task?.agentModelOverrides && Object.keys(config.task.agentModelOverrides).length) {
    warnings.push('task.agentModelOverrides 非空：子 Agent 会按该表固定模型，脚本未改动。');
  }
  if (existsSync(join(process.cwd(), '.omp', 'config.yml'))) {
    warnings.push('当前目录存在项目级 .omp/config.yml，其中 modelRoles 优先级高于全局配置。');
  }
  if (warnings.length) {
    lines.push('');
    lines.push('注意：');
    for (const w of warnings) lines.push(`  - ${w}`);
  }

  console.log(lines.join('\n'));

  if (opts.dryRun) {
    console.log('\n[dry-run] 未写入任何文件。');
    return;
  }

  const serialized = Bun.YAML.stringify(nextConfig, null, 2);
  const output = serialized.endsWith('\n') ? serialized : serialized + '\n';
  const reparsed = Bun.YAML.parse(output);
  if (!reparsed || JSON.stringify(reparsed.modelRoles) !== JSON.stringify(nextRoles)) {
    throw new Error('生成的 YAML 校验失败，未写入。');
  }

  if (configText !== output) {
    const backupDir = join(dir, 'model-manager-backups',
      new Date().toISOString().replace(/[:.]/g, '-') + '-switch-deepseek');
    backupFile(configPath, backupDir);
    atomicWrite(configPath, output);
    console.log(`\n已写入 ${configPath}`);
    console.log(`已备份原文件到 ${backupDir}\\config.yml`);
  } else {
    console.log('\n配置内容没有变化。');
  }
}

try {
  await main();
} catch (err) {
  console.error(`失败：${err.message}`);
  process.exit(1);
}
