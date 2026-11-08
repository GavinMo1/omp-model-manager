import {
  splitSelector, joinSelector, ROLE_DEFS, KIND_ROLES, SETTING_THINKING_LEVELS,
} from './role-selectors.js';

const $ = s => document.querySelector(s);
const esc = v => String(v ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
let state, selected, draft, dirty = false, saving = false, toastTimer, discoveryMode = false;

const freshModel = (discovery = false) => ({
  id: '', name: '', reasoning: false, input: ['text'],
  ...(discovery ? {} : { contextWindow: 131072, maxTokens: 8192 }),
});

function toast(text) { clearTimeout(toastTimer); $('#toast').textContent = text; $('#toast').style.display = 'block'; toastTimer = setTimeout(() => $('#toast').style.display = 'none', 5500); }
async function api(method = 'GET', body) {
  const response = await fetch('/api/config', { method, headers: { 'x-manager-token': window.MANAGER_TOKEN, ...(body ? { 'content-type': 'application/json' } : {}) }, body: body ? JSON.stringify(body) : undefined });
  const data = await response.json(); if (!response.ok) throw new Error(data.error || '操作失败'); return data;
}
function mayLeave() { return !saving && (!dirty || confirm('还有未保存的修改，确定放弃吗？')); }
window.addEventListener('beforeunload', e => { if (dirty) { e.preventDefault(); e.returnValue = ''; } });

function providerSummary(p) {
  const discovery = p.discovery?.type;
  if (discovery === 'openai-models-list') return `自动发现${p.models?.length ? ` · ${p.models.length} 个覆盖` : ''} · ${esc(p.api || '继承协议')}`;
  if (discovery) return `自定义发现（${esc(discovery)}） · ${esc(p.api || '继承协议')}`;
  if (p.models?.length) return `${p.models.length} 个模型 · ${esc(p.api || '继承协议')}`;
  if (p.baseUrl) return `空模型自定义服务 · ${esc(p.api || '继承协议')}`;
  return '内置服务参数覆盖';
}
function renderSidebar() {
  $('#directory').textContent = state.directory;
  $('#roles-nav').classList.toggle('active', selected === '$roles');
  $('#providers').innerHTML = Object.entries(state.providers).map(([id, p]) => `<button class="provider ${selected === id ? 'active' : ''}" data-provider="${esc(id)}"><span class="provider-symbol">◇</span><span><strong>${esc(id)}</strong><small>${providerSummary(p)}</small></span></button>`).join('');
  document.querySelectorAll('[data-provider]').forEach(el => el.onclick = () => { if (mayLeave()) openProvider(el.dataset.provider); });
}
function field(label, key, value, extra = '') { return `<label class="field">${label}<input data-key="${key}" value="${esc(value)}" ${extra}></label>`; }

function openProvider(id, imported) {
  selected = id; dirty = false;
  draft = structuredClone(imported || state.providers[id] || { api: 'anthropic-messages', baseUrl: '', apiKey: '', authHeader: true, models: [freshModel()] });
  draft.models = Array.isArray(draft.models) ? draft.models : [];
  if (id === '$new' && !imported && !draft.models.length) draft.models = [freshModel()];
  const discoveryType = draft.discovery && typeof draft.discovery === 'object' ? draft.discovery.type : '';
  const discoverySupported = !discoveryType || discoveryType === 'openai-models-list';
  discoveryMode = discoveryType === 'openai-models-list';
  renderSidebar(); $('#page-title').textContent = id === '$new' ? '添加模型服务' : '模型服务';

  // A provider without models, discovery or a base URL is an override-only
  // entry for a built-in service; it has nothing to edit here.
  if (id !== '$new' && !draft.models.length && !discoveryMode && !draft.baseUrl) {
    $('#content').innerHTML = `<section class="panel"><div class="panel-heading"><div><h2>${esc(id)}</h2><p>内置服务 · 参数覆盖</p></div><span class="badge">已配置</span></div><div class="form-body"><div class="override">这里保留了你为内置服务设置的高级参数。<br>请通过左侧「＋」添加自定义服务，通过「Role 配置」选择默认模型。</div><details class="advanced"><summary>查看参数覆盖</summary><pre style="overflow:auto;line-height:1.8">${esc(JSON.stringify(draft.modelOverrides || {}, null, 2))}</pre></details></div></section>`;
    return;
  }

  const discoveryControl = discoverySupported
    ? `<label class="check-line"><input id="discovery" type="checkbox" ${discoveryMode ? 'checked' : ''}>自动发现模型（openai-models-list）</label><small>由 OMP 在加载时向服务请求模型列表；本页不拉取、不探测。显式条目只覆盖填写的字段。</small>`
    : `<div class="readonly-note">该服务使用手写发现配置（<code>${esc(discoveryType)}</code>），本页不改动 discovery 字段。</div>`;

  $('#content').innerHTML = `<form id="provider-form" class="panel"><div class="panel-heading"><div><h2>连接你的模型服务</h2><p>填写连接信息，然后添加服务支持的模型。</p></div><span class="badge">${id === '$new' ? '待保存' : '已写入本机'}</span></div><div class="form-body"><div class="grid">${field('服务标识', 'providerId', id === '$new' ? '' : id, id === '$new' ? 'required placeholder="例如 local-anthropic" pattern="[a-zA-Z0-9][a-zA-Z0-9_-]{0,63}"' : 'readonly')}<label class="field">接口协议<select data-key="api"><option value="anthropic-messages">Anthropic / Claude</option><option value="openai-completions">OpenAI 兼容 / Chat Completions</option><option value="openai-responses">OpenAI / Responses</option></select></label><label class="field wide">服务地址<input data-key="baseUrl" type="url" required value="${esc(draft.baseUrl)}" placeholder="http://127.0.0.1:7864"><small>Claude 填写服务根地址；OpenAI 兼容服务通常需要包含 /v1。</small></label><label class="field wide">API 密钥<div class="password-wrap"><input data-key="apiKey" type="password" autocomplete="off" value="${esc(draft.apiKey)}" placeholder="填入密钥，也可填写已有环境变量名"><button type="button" id="toggle-key">显示</button></div><small>密钥保存在 omp 本机配置中，不上传至其他服务。</small></label></div><div class="discovery-box"><h3>模型目录</h3>${discoveryControl}</div><div class="section-heading"><h3>显式模型条目</h3><button id="add-model" type="button" class="text-button">＋ 添加模型</button></div><div id="models"></div><details class="advanced"><summary>连接选项</summary><div class="checks"><label><input id="bearer" type="checkbox" ${draft.authHeader ? 'checked' : ''}>使用 Bearer 身份认证</label></div><p>你的本地 Claude 转发服务适用此选项。</p></details></div><div id="form-error" class="error form-error" role="alert"></div><div class="actions"><button type="button" id="delete-provider" class="button danger" ${id === '$new' ? 'hidden' : ''}>删除服务</button><span ${id === '$new' ? '' : 'hidden'} class="save-hint">可以先填写，再保存</span><div class="save-area"><span class="save-hint" id="save-status">${imported ? '导入完成，检查后保存' : '保存时自动备份'}</span><button type="submit" class="button primary">保存配置</button></div></div></form>`;
  $('[data-key="api"]').value = draft.api || 'anthropic-messages';
  renderModels();
  $('#toggle-key').onclick = () => { const input = $('[data-key="apiKey"]'); input.type = input.type === 'password' ? 'text' : 'password'; $('#toggle-key').textContent = input.type === 'password' ? '显示' : '隐藏'; };
  const discoveryBox = $('#discovery');
  if (discoveryBox) discoveryBox.onchange = () => {
    syncModels();
    discoveryMode = discoveryBox.checked;
    draft.discovery = discoveryMode ? { type: 'openai-models-list' } : null;
    renderModels(); markDirty();
  };
  $('#provider-form').addEventListener('input', markDirty);
  $('#add-model').onclick = () => { syncModels(); draft.models.push(freshModel(discoveryMode)); renderModels(); markDirty(); };
  $('#provider-form').onsubmit = async e => {
    e.preventDefault(); syncModels();
    const get = key => $(`[data-key="${key}"]`).value.trim();
    const data = { api: get('api'), baseUrl: get('baseUrl'), apiKey: get('apiKey'), authHeader: $('#bearer').checked, models: draft.models };
    if (discoverySupported) data.discovery = $('#discovery').checked ? { type: 'openai-models-list' } : null;
    await save({ action: 'provider', id: get('providerId'), create: selected === '$new', data }, get('providerId'));
  };
  $('#delete-provider').onclick = async () => {
    if (confirm(`删除服务 ${selected} 及其自定义模型？原文件会自动备份。`)) await save({ action: 'delete', id: selected }, '$roles');
  };
  if (imported) { $('[data-key="providerId"]').value = imported.suggestedId || 'custom-service'; dirty = true; }
}
function markDirty() { dirty = true; const el = $('#save-status'); if (el) el.textContent = '有未保存的修改'; }

function renderModels() {
  const placeholder = discoveryMode ? '自动发现' : '';
  const contextExtra = discoveryMode ? `placeholder="${placeholder}"` : 'required type="number" min="1024" step="1"';
  const outputExtra = discoveryMode ? `placeholder="${placeholder}"` : 'required type="number" min="1" step="1"';
  $('#models').innerHTML = draft.models.map((m, i) => `<section class="model" data-index="${i}"><div class="model-head"><span>模型 ${i + 1}</span><button type="button" class="text-button remove-model" ${draft.models.length === 1 && !discoveryMode ? 'disabled' : ''}>移除</button></div><div class="grid">${field('模型 ID', 'id', m.id, 'required placeholder="例如 cn:auto 或 gpt-4.1"')}${field('显示名称', 'name', m.name, 'placeholder="可选，方便识别"')}${field('上下文长度', 'contextWindow', m.contextWindow ?? '', contextExtra)}${field('最大输出长度', 'maxTokens', m.maxTokens ?? '', outputExtra)}</div><div class="checks">${discoveryMode ? '' : `<label><input class="reasoning" type="checkbox" ${m.reasoning ? 'checked' : ''}>支持推理</label>`}<label><input class="vision" type="checkbox" ${m.input?.includes('image') ? 'checked' : ''}>支持图片</label></div></section>`).join('');
  document.querySelectorAll('.remove-model').forEach((el, i) => el.onclick = () => { syncModels(); draft.models.splice(i, 1); renderModels(); markDirty(); });
}
// Rebuild each editable entry from the form so cleared fields disappear instead
// of silently retaining the old value. Advanced fields on the entry survive.
function syncModels() {
  document.querySelectorAll('.model').forEach((el, i) => {
    const get = k => el.querySelector(`[data-key="${k}"]`)?.value.trim() ?? '';
    const next = { ...draft.models[i] };
    next.id = get('id');
    next.name = get('name') || next.id;
    if (discoveryMode) {
      delete next.reasoning;
      delete next.contextWindow;
      delete next.maxTokens;
    } else {
      for (const key of ['contextWindow', 'maxTokens']) {
        const raw = get(key);
        if (raw !== '' && Number.isFinite(Number(raw))) next[key] = Number(raw); else delete next[key];
      }
      next.reasoning = el.querySelector('.reasoning')?.checked ?? false;
    }
    next.input = el.querySelector('.vision')?.checked ? ['text', 'image'] : ['text'];
    draft.models[i] = next;
  });
}

function openRoles() {
  selected = '$roles'; dirty = false; renderSidebar(); $('#page-title').textContent = 'Role 配置';
  const knownModels = Object.entries(state.providers).flatMap(([id, p]) => (p.models || []).map(m => `${id}/${m.id}`));
  const options = new Set([...knownModels, ...Object.values(state.roles).map(v => splitSelector(v, knownModels).model)]);
  const allIds = new Set([...Object.keys(ROLE_DEFS), ...Object.keys(state.roles), ...Object.keys(state.roleTags || {})]);
  const removed = new Set();
  const effortOptions = [['', '继承 / 自动'], ['off', '关闭'], ['minimal', '最低'], ['low', '低'], ['medium', '中'], ['high', '高'], ['xhigh', '极高'], ['max', '最高']];
  const globalInitial = SETTING_THINKING_LEVELS.includes(state.defaultThinkingLevel) ? state.defaultThinkingLevel : '';
  const presetNames = Object.entries(state.presets).filter(([, p]) => p && typeof p === 'object' && !Array.isArray(p)).map(([name]) => name);
  const projectWarning = state.modelRoleStorage === 'project'
    ? '<div class="preset-warning">配置里设置了 <code>modelRoleStorage: project</code>，项目级配置可能覆盖这里的全局 Role。</div>' : '';

  function row(id, name, value = '') {
    const parts = splitSelector(value, knownModels), custom = !Object.hasOwn(ROLE_DEFS, id);
    return `<section class="role-card" data-role-card="${esc(id)}"><div class="role-card-head"><div><strong>${esc(name)}</strong><code>@${esc(id)}</code></div>${custom ? '<button type="button" class="text-button remove-role">删除</button>' : ''}</div><p>${esc(ROLE_DEFS[id]?.[1] || '自定义模型角色，可通过 @' + id + ' 选择')}</p>${custom ? `<label class="field">显示名称<input data-role-name value="${esc(name)}" maxlength="80"></label>` : ''}<label class="field">使用模型<input data-role="${esc(id)}" list="model-options" value="${esc(parts.model)}" placeholder="选择模型，或留空继承"></label>${!KIND_ROLES.includes(id) ? `<label class="field effort-field">推理档位<select data-role-effort>${effortOptions.map(([value, label]) => `<option value="${value}" ${parts.effort === value ? 'selected' : ''}>${label}</option>`).join('')}</select><small>具体支持的档位取决于模型。</small></label>` : '<small>此角色需要对应专用能力，普通聊天模型可能不适用。</small>'}</section>`;
  }

  $('#content').innerHTML = `<form id="roles-form" class="panel"><div class="panel-heading"><div><h2>让不同角色使用合适的模型</h2><p>Role 是模型的用途与快捷名称，保存后写入 omp 配置。</p></div><span class="badge">全局配置</span></div><div class="form-body">${projectWarning}<div class="preset-bar"><label>预设<select id="preset-select"><option value="">选择预设…</option>${presetNames.map(n => `<option value="${esc(n)}">${esc(n)}</option>`).join('')}</select></label><button id="preset-apply" type="button" class="button secondary">应用</button><button id="preset-save" type="button" class="button secondary">另存为当前</button><button id="preset-delete" type="button" class="button danger">删除预设</button><small>应用会整表替换全局 Role（未包含的角色会被清除），不切换当前运行会话的模型。</small></div><div class="role-help">可输入 <code>服务标识/模型ID</code>，或用 <code>@default</code> 跟随默认模型。留空表示清除本机全局分配。<br>项目配置和启动参数可能覆盖这里的设置。</div><div class="bulk-area"><h3>批量设置聊天角色</h3><div class="bulk-grid"><label class="field">模型<input id="bulk-model" list="model-options" placeholder="服务标识/模型ID"></label><label class="field">推理档位<select id="bulk-effort">${effortOptions.map(([value, labelLabel]) => `<option value="${value}">${labelLabel}</option>`).join('')}</select></label><label class="check-line"><input id="bulk-judge" type="checkbox">同时覆盖 judge（只写模型，不带档位）</label><button id="bulk-fill" type="button" class="button secondary">填入全部聊天角色</button></div><small>只填入表单，不会立即保存；judge 覆盖会失去原生评判模型。</small></div><div class="global-level"><label class="field">全局默认思考档位<select id="global-thinking"><option value="" ${globalInitial === '' ? 'selected' : ''}>保持当前</option><option value="__delete__">不设置（删除该键）</option>${SETTING_THINKING_LEVELS.map(v => `<option value="${v}" ${globalInitial === v ? 'selected' : ''}>${v}</option>`).join('')}</select><small>仅支持 7 个合法值；off/inherit 只能作为角色后缀。</small></label></div><div class="role-toolbar"><button id="follow-default" type="button" class="button secondary">常用角色跟随默认模型</button><button id="add-role" type="button" class="button secondary">＋ 自定义 Role</button></div><datalist id="model-options">${[...options].filter(Boolean).map(v => `<option value="${esc(v)}"></option>`).join('')}<option value="@default"></option></datalist><div class="section-heading"><h3>对话与任务角色</h3></div><div class="roles-grid" id="chat-roles">${[...allIds].filter(id => !KIND_ROLES.includes(id)).map(id => row(id, state.roleTags?.[id]?.name || ROLE_DEFS[id]?.[0] || id, state.roles[id])).join('')}</div><details class="advanced"><summary>专用能力角色 · 图像 / 搜索 / 语音 / 评判</summary><div class="roles-grid">${KIND_ROLES.map(id => row(id, state.roleTags?.[id]?.name || ROLE_DEFS[id][0], state.roles[id])).join('')}</div></details></div><div id="form-error" class="error form-error" role="alert"></div><div class="actions"><span class="save-hint" id="save-status">有改动时自动备份</span><button type="submit" class="button primary">保存 Role 配置</button></div></form>`;

  $('#roles-form').addEventListener('input', markDirty);

  function wireRows() {
    document.querySelectorAll('[data-role-card]').forEach(card => {
      const input = card.querySelector('[data-role]'), effort = card.querySelector('[data-role-effort]');
      function updateEffort() { if (effort) { effort.disabled = /^(?:@|pi\/)|^\*$/.test(input.value.trim()); if (effort.disabled) effort.value = ''; } }
      updateEffort(); input.oninput = updateEffort;
      const remove = card.querySelector('.remove-role');
      if (remove) remove.onclick = () => { if (!confirm(`删除自定义 Role ${card.dataset.roleCard}？保存后生效。`)) return; removed.add(card.dataset.roleCard); card.remove(); markDirty(); };
    });
  }
  wireRows();

  function collectRoles() {
    const roles = {};
    document.querySelectorAll('[data-role-card]').forEach(card => {
      const id = card.dataset.roleCard;
      const value = joinSelector(card.querySelector('[data-role]').value, card.querySelector('[data-role-effort]')?.value || '');
      roles[id] = value;
    });
    return roles;
  }

  $('#follow-default').onclick = () => {
    if (!$('[data-role="default"]').value.trim()) { toast('请先为 default 选择模型。'); return; }
    ['smol', 'slow', 'plan', 'commit', 'tiny', 'memory', 'task', 'advisor', 'widget'].forEach(id => { const el = $(`[data-role="${id}"]`); if (!el) return; el.value = '@default'; el.dispatchEvent(new Event('input', { bubbles: true })); });
    toast('常用角色已跟随默认模型；保存后生效。视觉及专用能力角色请按实际能力配置。');
  };
  $('#add-role').onclick = () => {
    const id = prompt('自定义 Role 标识，例如 coder、reviewer（以字母开头）');
    if (id === null) return;
    if (!/^[a-zA-Z][a-zA-Z0-9_.-]{0,63}$/.test(id) || ['constructor', 'prototype', '__proto__'].includes(id)) { toast('标识需以字母开头，只能包含字母、数字、下划线、点和短横线。'); return; }
    if ([...document.querySelectorAll('[data-role-card]')].some(el => el.dataset.roleCard === id)) { toast('该 Role 已存在。'); return; }
    removed.delete(id); $('#chat-roles').insertAdjacentHTML('beforeend', row(id, id)); wireRows(); markDirty();
    [...document.querySelectorAll('[data-role-card]')].find(el => el.dataset.roleCard === id).scrollIntoView({ block: 'center', behavior: 'smooth' });
  };
  $('#bulk-fill').onclick = () => {
    const model = $('#bulk-model').value.trim();
    if (!model) { toast('请先填写要批量使用的模型。'); return; }
    const effort = $('#bulk-effort').value;
    document.querySelectorAll('[data-role-card]').forEach(card => {
      const id = card.dataset.roleCard;
      if (KIND_ROLES.includes(id) && id !== 'judge') return;
      const input = card.querySelector('[data-role]');
      if (id === 'judge') {
        if ($('#bulk-judge').checked) { input.value = model; input.dispatchEvent(new Event('input', { bubbles: true })); }
        return;
      }
      input.value = model;
      const select = card.querySelector('[data-role-effort]');
      if (select) select.value = effort;
      input.dispatchEvent(new Event('input', { bubbles: true }));
    });
    const global = $('#global-thinking');
    if (SETTING_THINKING_LEVELS.includes(effort)) global.value = effort;
    else global.value = '';
    global.dispatchEvent(new Event('input', { bubbles: true }));
    toast('已填入表单；请检查后保存。');
  };
  $('#preset-save').onclick = async () => {
    const name = prompt('预设名称（1–64 个字符，不含斜杠）');
    if (name === null) return;
    const trimmed = name.trim();
    if (!trimmed) { toast('预设名称不能为空。'); return; }
    const exists = Object.hasOwn(state.presets, trimmed);
    if (exists && !confirm(`预设「${trimmed}」已存在，确定覆盖？`)) return;
    await save({ action: 'preset-save', name: trimmed, overwrite: exists }, '$roles');
  };
  $('#preset-apply').onclick = async () => {
    const name = $('#preset-select').value;
    if (!name) { toast('请先选择预设。'); return; }
    const preset = state.presets[name];
    if (!preset || typeof preset !== 'object' || Array.isArray(preset)) { toast('预设格式无效。'); return; }
    if (dirty && !confirm('还有未保存的修改，应用预设会覆盖这些修改。继续？')) return;
    const current = collectRoles();
    const target = preset.modelRoles && typeof preset.modelRoles === 'object' ? preset.modelRoles : {};
    const currentKeys = new Set(Object.keys(current).filter(k => current[k]));
    const targetKeys = new Set(Object.keys(target));
    const overwritten = [...targetKeys].filter(k => current[k] && current[k] !== target[k]).length;
    const added = [...targetKeys].filter(k => !current[k]).length;
    const cleared = [...currentKeys].filter(k => !targetKeys.has(k)).length;
    if (!confirm(`应用预设「${name}」？\n覆盖 ${overwritten} 个、新增 ${added} 个、清除 ${cleared} 个 Role。\n未包含在预设中的角色会被清空。`)) return;
    await save({ action: 'preset-apply', name }, '$roles');
  };
  $('#preset-delete').onclick = async () => {
    const name = $('#preset-select').value;
    if (!name) { toast('请先选择预设。'); return; }
    if (!confirm(`删除预设「${name}」？当前 Role 配置不受影响。`)) return;
    await save({ action: 'preset-delete', name }, '$roles');
  };
  $('#roles-form').onsubmit = async e => {
    e.preventDefault();
    const roles = collectRoles(), names = {};
    document.querySelectorAll('[data-role-card]').forEach(card => {
      const id = card.dataset.roleCard;
      const nameInput = card.querySelector('[data-role-name]');
      if (nameInput) names[id] = nameInput.value.trim() || id;
    });
    removed.forEach(id => roles[id] = '');
    const payload = { action: 'roles', roles, roleNames: names, removeRoles: [...removed] };
    const global = $('#global-thinking').value;
    if (global === '__delete__') payload.defaultThinkingLevel = null;
    else if (global) payload.defaultThinkingLevel = global;
    await save(payload, '$roles');
  };
}

async function save(payload, next) {
  if (saving) return; saving = true; const form = $('#content form');
  const buttons = [...form.querySelectorAll('button')]; const disabled = buttons.map(b => b.disabled); buttons.forEach(b => b.disabled = true); $('#form-error').textContent = '';
  try {
    const result = await api('POST', { ...payload, revision: state.revision });
    state = result; dirty = false;
    if (next === '$roles') openRoles(); else openProvider(next);
    if (!result.changedFiles?.length) toast('没有需要保存的改动。');
    else toast(result.backup ? '已保存到 omp 配置，原文件已自动备份。' : '已保存到 omp 配置。');
  } catch (err) { $('#form-error').textContent = err.message; buttons.forEach((b, i) => b.disabled = disabled[i]); }
  finally { saving = false; }
}

$('#add').onclick = () => { if (mayLeave()) openProvider('$new'); };
$('#roles-nav').onclick = () => { if (mayLeave()) openRoles(); };
$('#reload').onclick = async () => { if (!mayLeave()) return; try { state = await api(); if (selected === '$roles') openRoles(); else if (selected && state.providers[selected]) openProvider(selected); else openRoles(); toast('已重新加载本机配置。'); } catch (err) { toast(err.message); } };
$('#import').onclick = () => { if (!mayLeave()) return; $('#import-error').textContent = ''; $('#import-dialog').showModal(); };
$('#parse-import').onclick = () => {
  try {
    const source = JSON.parse($('#import-text').value);
    let imported;
    if (source.env) {
      const env = source.env;
      const anthropic = !!env.ANTHROPIC_BASE_URL;
      const baseUrl = anthropic ? env.ANTHROPIC_BASE_URL : env.OPENAI_BASE_URL;
      if (!baseUrl) throw new Error('未找到 ANTHROPIC_BASE_URL 或 OPENAI_BASE_URL。');
      const ids = [...new Set((anthropic ? [env.ANTHROPIC_MODEL, env.ANTHROPIC_DEFAULT_HAIKU_MODEL, env.ANTHROPIC_DEFAULT_SONNET_MODEL, env.ANTHROPIC_DEFAULT_OPUS_MODEL] : [env.OPENAI_MODEL]).filter(v => typeof v === 'string' && v.trim()))];
      if (!ids.length) throw new Error('未找到模型名称，请在 JSON 中填写 ANTHROPIC_MODEL 或 OPENAI_MODEL。');
      imported = { suggestedId: anthropic ? 'custom-anthropic' : 'custom-openai', api: anthropic ? 'anthropic-messages' : 'openai-completions', baseUrl, apiKey: env.ANTHROPIC_AUTH_TOKEN || env.ANTHROPIC_API_KEY || env.OPENAI_API_KEY || '', authHeader: true, models: ids.map(id => ({ ...freshModel(), id, name: id })) };
    } else if (source.baseUrl && source.api && source.models?.length) {
      imported = { ...source, suggestedId: source.provider || 'custom-service', models: source.models.map(m => ({ ...freshModel(), ...m })) };
    } else throw new Error('请粘贴包含 env 的 JSON，或包含 baseUrl、api、models 的服务 JSON。');
    $('#import-dialog').close(); $('#import-text').value = ''; openProvider('$new', imported); toast('已填入表单，请检查后保存。');
  } catch (err) { $('#import-error').textContent = err.message; }
};
async function init() {
  try {
    state = await api();
    const id = Object.keys(state.providers).find(k => state.providers[k].models?.length || state.providers[k].discovery?.type || state.providers[k].baseUrl);
    location.hash === '#roles' || !id ? openRoles() : openProvider(id);
  } catch (err) { $('#content').innerHTML = `<section class="panel empty"><h2>无法读取配置</h2><p>${esc(err.message)}</p><p>修正配置文件后，点击「重新加载」。</p></section>`; }
}
init();
