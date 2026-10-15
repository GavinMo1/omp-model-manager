import { splitSelector, joinSelector } from './role-selectors.js';
const $ = s => document.querySelector(s);
const esc = v => String(v ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
let state, selected, draft, dirty = false, saving = false, toastTimer;
const roleNames = { default: ['默认模型', '日常对话与编码'], smol: ['快速模型', '轻量任务与快速处理'], slow: ['深度模型', '复杂分析与推理'], plan: ['规划模型', '方案与架构设计'], vision: ['视觉模型', '图片理解'], commit: ['提交说明', '生成 Git 提交信息'], tiny: ['微型任务', '标题等简单任务'], memory: ['记忆模型', '整理与提炼记忆'], task: ['子任务模型', '委派任务的默认选择'], advisor: ['顾问模型', '辅助审阅与建议'] };
const freshModel = () => ({ id: '', name: '', reasoning: false, input: ['text'], contextWindow: 131072, maxTokens: 8192 });
Object.assign(roleNames, { image: ['图像生成', '需要支持图像生成的模型'], web: ['网页检索', '需要支持搜索的模型或服务'], speech: ['语音合成', '需要支持语音输出的模型'], dictation: ['语音转写', '需要支持音频转文字的模型'], judge: ['评判模型', '需要支持评判任务的模型'] });
function toast(text) { clearTimeout(toastTimer); $('#toast').textContent = text; $('#toast').style.display = 'block'; toastTimer = setTimeout(() => $('#toast').style.display = 'none', 5500); }
async function api(method = 'GET', body) {
  const response = await fetch('/api/config', { method, headers: { 'x-manager-token': window.MANAGER_TOKEN, ...(body ? { 'content-type': 'application/json' } : {}) }, body: body ? JSON.stringify(body) : undefined });
  const data = await response.json(); if (!response.ok) throw new Error(data.error || '操作失败'); return data;
}
function mayLeave() { return !saving && (!dirty || confirm('还有未保存的修改，确定放弃吗？')); }
window.addEventListener('beforeunload', e => { if (dirty) { e.preventDefault(); e.returnValue = ''; } });
function renderSidebar() {
  $('#directory').textContent = state.directory;
  $('#roles-nav').classList.toggle('active', selected === '$roles');
  $('#providers').innerHTML = Object.entries(state.providers).map(([id, p]) => `<button class="provider ${selected === id ? 'active' : ''}" data-provider="${esc(id)}"><span class="provider-symbol">◇</span><span><strong>${esc(id)}</strong><small>${p.models?.length ? `${p.models.length} 个模型 · ${esc(p.api || '继承协议')}` : '内置服务参数覆盖'}</small></span></button>`).join('');
  document.querySelectorAll('[data-provider]').forEach(el => el.onclick = () => { if (mayLeave()) openProvider(el.dataset.provider); });
}
function field(label, key, value, extra = '') { return `<label class="field">${label}<input data-key="${key}" value="${esc(value)}" ${extra}></label>`; }
function openProvider(id, imported) {
  selected = id; dirty = false;
  draft = structuredClone(imported || state.providers[id] || { api: 'anthropic-messages', baseUrl: '', apiKey: '', authHeader: true, models: [freshModel()] });
  renderSidebar(); $('#page-title').textContent = id === '$new' ? '添加模型服务' : '模型服务';
  if (id !== '$new' && !draft.models?.length) {
    $('#content').innerHTML = `<section class="panel"><div class="panel-heading"><div><h2>${esc(id)}</h2><p>内置服务 · 参数覆盖</p></div><span class="badge">已配置</span></div><div class="form-body"><div class="override">这里保留了你为内置服务设置的高级参数。<br>请通过左侧「＋」添加自定义服务，通过「Role 配置」选择默认模型。</div><details class="advanced"><summary>查看参数覆盖</summary><pre style="overflow:auto;line-height:1.8">${esc(JSON.stringify(draft.modelOverrides || {}, null, 2))}</pre></details></div></section>`;
    return;
  }
  $('#content').innerHTML = `<form id="provider-form" class="panel"><div class="panel-heading"><div><h2>连接你的模型服务</h2><p>填写连接信息，然后添加服务支持的模型。</p></div><span class="badge">${id === '$new' ? '待保存' : '已写入本机'}</span></div><div class="form-body"><div class="grid">${field('服务标识', 'providerId', id === '$new' ? '' : id, id === '$new' ? 'required placeholder="例如 local-anthropic" pattern="[a-zA-Z0-9][a-zA-Z0-9_-]{0,63}"' : 'readonly')}<label class="field">接口协议<select data-key="api"><option value="anthropic-messages">Anthropic / Claude</option><option value="openai-completions">OpenAI 兼容 / Chat Completions</option><option value="openai-responses">OpenAI / Responses</option></select></label><label class="field wide">服务地址<input data-key="baseUrl" type="url" required value="${esc(draft.baseUrl)}" placeholder="http://127.0.0.1:7864"><small>Claude 填写服务根地址；OpenAI 兼容服务通常需要包含 /v1。</small></label><label class="field wide">API 密钥<div class="password-wrap"><input data-key="apiKey" type="password" autocomplete="off" value="${esc(draft.apiKey)}" placeholder="填入密钥，也可填写已有环境变量名"><button type="button" id="toggle-key">显示</button></div><small>密钥保存在 omp 本机配置中，不上传至其他服务。</small></label></div><div class="section-heading"><h3>可用模型</h3><button id="add-model" type="button" class="text-button">＋ 添加模型</button></div><div id="models"></div><details class="advanced"><summary>连接选项</summary><div class="checks"><label><input id="bearer" type="checkbox" ${draft.authHeader ? 'checked' : ''}>使用 Bearer 身份认证</label></div><p>你的本地 Claude 转发服务适用此选项。</p></details></div><div id="form-error" class="error form-error" role="alert"></div><div class="actions"><button type="button" id="delete-provider" class="button danger" ${id === '$new' ? 'hidden' : ''}>删除服务</button><span ${id === '$new' ? '' : 'hidden'} class="save-hint">可以先填写，再保存</span><div class="save-area"><span class="save-hint" id="save-status">${imported ? '导入完成，检查后保存' : '保存时自动备份'}</span><button type="submit" class="button primary">保存配置</button></div></div></form>`;
  $('[data-key="api"]').value = draft.api || 'anthropic-messages';
  renderModels();
  $('#toggle-key').onclick = () => { const input = $('[data-key="apiKey"]'); input.type = input.type === 'password' ? 'text' : 'password'; $('#toggle-key').textContent = input.type === 'password' ? '显示' : '隐藏'; };
  $('#provider-form').addEventListener('input', markDirty);
  $('#add-model').onclick = () => { syncModels(); draft.models.push(freshModel()); renderModels(); markDirty(); };
  $('#provider-form').onsubmit = async e => {
    e.preventDefault(); syncModels();
    const get = key => $(`[data-key="${key}"]`).value.trim();
    const data = { api: get('api'), baseUrl: get('baseUrl'), apiKey: get('apiKey'), authHeader: $('#bearer').checked, models: draft.models };
    await save({ action: 'provider', id: get('providerId'), create: selected === '$new', data }, get('providerId'));
  };
  $('#delete-provider').onclick = async () => {
    if (confirm(`删除服务 ${selected} 及其自定义模型？原文件会自动备份。`)) await save({ action: 'delete', id: selected }, '$roles');
  };
  if (imported) { $('[data-key="providerId"]').value = imported.suggestedId || 'custom-service'; dirty = true; }
}
function markDirty() { dirty = true; const el = $('#save-status'); if (el) el.textContent = '有未保存的修改'; }
function renderModels() {
  $('#models').innerHTML = draft.models.map((m, i) => `<section class="model" data-index="${i}"><div class="model-head"><span>模型 ${i + 1}</span><button type="button" class="text-button remove-model" ${draft.models.length === 1 ? 'disabled' : ''}>移除</button></div><div class="grid">${field('模型 ID', 'id', m.id, 'required placeholder="例如 cn:auto 或 gpt-4.1"')}${field('显示名称', 'name', m.name, 'placeholder="可选，方便识别"')}${field('上下文长度', 'contextWindow', m.contextWindow || 131072, 'required type="number" min="1024" step="1"')}${field('最大输出长度', 'maxTokens', m.maxTokens || 8192, 'required type="number" min="1" step="1"')}</div><div class="checks"><label><input class="reasoning" type="checkbox" ${m.reasoning ? 'checked' : ''}>支持推理</label><label><input class="vision" type="checkbox" ${m.input?.includes('image') ? 'checked' : ''}>支持图片</label></div></section>`).join('');
  document.querySelectorAll('.remove-model').forEach((el, i) => el.onclick = () => { syncModels(); draft.models.splice(i, 1); renderModels(); markDirty(); });
}
function syncModels() {
  document.querySelectorAll('.model').forEach((el, i) => {
    const get = k => el.querySelector(`[data-key="${k}"]`).value.trim();
    Object.assign(draft.models[i], { id: get('id'), name: get('name') || get('id'), contextWindow: Number(get('contextWindow')), maxTokens: Number(get('maxTokens')), reasoning: el.querySelector('.reasoning').checked, input: el.querySelector('.vision').checked ? ['text', 'image'] : ['text'] });
  });
}
function openRoles() {
  selected = '$roles'; dirty = false; renderSidebar(); $('#page-title').textContent = 'Role 配置';
  const knownModels = Object.entries(state.providers).flatMap(([id, p]) => (p.models || []).map(m => `${id}/${m.id}`));
  const options = new Set([...knownModels, ...Object.values(state.roles).map(v => splitSelector(v, knownModels).model)]);
  const kindIds = ['image', 'web', 'speech', 'dictation', 'judge'];
  const allIds = new Set([...Object.keys(roleNames), ...Object.keys(state.roles), ...Object.keys(state.roleTags || {})]);
  const removed = new Set();
  const effortOptions = [['', '继承 / 自动'], ['off', '关闭'], ['minimal', '最低'], ['low', '低'], ['medium', '中'], ['high', '高'], ['xhigh', '极高'], ['max', '最高']];
  function row(id, name, value = '') {
    const parts = splitSelector(value, knownModels), custom = !Object.hasOwn(roleNames, id);
    return `<section class="role-card" data-role-card="${esc(id)}"><div class="role-card-head"><div><strong>${esc(name)}</strong><code>@${esc(id)}</code></div>${custom ? '<button type="button" class="text-button remove-role">删除</button>' : ''}</div><p>${esc(roleNames[id]?.[1] || '自定义模型角色，可通过 @' + id + ' 选择')}</p>${custom ? `<label class="field">显示名称<input data-role-name value="${esc(name)}" maxlength="80"></label>` : ''}<label class="field">使用模型<input data-role="${esc(id)}" list="model-options" value="${esc(parts.model)}" placeholder="选择模型，或留空继承"></label>${!kindIds.includes(id) ? `<label class="field effort-field">推理档位<select data-role-effort>${effortOptions.map(([value, label]) => `<option value="${value}" ${parts.effort === value ? 'selected' : ''}>${label}</option>`).join('')}</select><small>具体支持的档位取决于模型。</small></label>` : '<small>此角色需要对应专用能力，普通聊天模型可能不适用。</small>'}</section>`;
  }
  $('#content').innerHTML = `<form id="roles-form" class="panel"><div class="panel-heading"><div><h2>让不同角色使用合适的模型</h2><p>Role 是模型的用途与快捷名称，保存后写入 omp 配置。</p></div><span class="badge">全局配置</span></div><div class="form-body"><div class="role-help">可输入 <code>服务标识/模型ID</code>，或用 <code>@default</code> 跟随默认模型。留空表示清除本机全局分配。<br>项目配置和启动参数可能覆盖这里的设置。</div><div class="role-toolbar"><button id="follow-default" type="button" class="button secondary">常用角色跟随默认模型</button><button id="add-role" type="button" class="button secondary">＋ 自定义 Role</button></div><datalist id="model-options">${[...options].filter(Boolean).map(v => `<option value="${esc(v)}"></option>`).join('')}<option value="@default"></option></datalist><div class="section-heading"><h3>对话与任务角色</h3></div><div class="roles-grid" id="chat-roles">${[...allIds].filter(id => !kindIds.includes(id)).map(id => row(id, state.roleTags?.[id]?.name || roleNames[id]?.[0] || id, state.roles[id])).join('')}</div><details class="advanced"><summary>专用能力角色 · 图像 / 搜索 / 语音 / 评判</summary><div class="roles-grid">${kindIds.map(id => row(id, state.roleTags?.[id]?.name || roleNames[id][0], state.roles[id])).join('')}</div></details></div><div id="form-error" class="error form-error" role="alert"></div><div class="actions"><span class="save-hint" id="save-status">修改前的配置会自动备份</span><button type="submit" class="button primary">保存 Role 配置</button></div></form>`;
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
  $('#follow-default').onclick = () => {
    if (!$('[data-role="default"]').value.trim()) { toast('请先为 default 选择模型。'); return; }
    ['smol', 'slow', 'plan', 'commit', 'tiny', 'memory', 'task', 'advisor'].forEach(id => { $(`[data-role="${id}"]`).value = '@default'; $(`[data-role="${id}"]`).dispatchEvent(new Event('input', { bubbles: true })); });
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
  $('#roles-form').onsubmit = async e => {
    e.preventDefault(); const roles = {}, names = {};
    document.querySelectorAll('[data-role-card]').forEach(card => { const id = card.dataset.roleCard; roles[id] = joinSelector(card.querySelector('[data-role]').value, card.querySelector('[data-role-effort]')?.value || ''); if (card.querySelector('[data-role-name]')) names[id] = card.querySelector('[data-role-name]').value.trim() || id; });
    removed.forEach(id => roles[id] = '');
    await save({ action: 'roles', roles, roleNames: names, removeRoles: [...removed] }, '$roles');
  };
}
async function save(payload, next) {
  if (saving) return; saving = true; const form = $('#content form');
  const buttons = [...form.querySelectorAll('button')]; const disabled = buttons.map(b => b.disabled); buttons.forEach(b => b.disabled = true); $('#form-error').textContent = '';
  try { state = await api('POST', { ...payload, revision: state.revision }); dirty = false; if (next === '$roles') openRoles(); else openProvider(next); toast('已保存到 omp 配置，原文件已自动备份。'); }
  catch (err) { $('#form-error').textContent = err.message; buttons.forEach((b, i) => b.disabled = disabled[i]); }
  finally { saving = false; }
}
$('#add').onclick = () => { if (mayLeave()) openProvider('$new'); };
$('#roles-nav').onclick = () => { if (mayLeave()) openRoles(); };
$('#reload').onclick = async () => { if (!mayLeave()) return; try { state = await api(); selected && state.providers[selected] ? openProvider(selected) : openRoles(); toast('已重新加载本机配置。'); } catch (err) { toast(err.message); } };
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
  try { state = await api(); const id = Object.keys(state.providers).find(k => state.providers[k].models?.length); location.hash === '#roles' || !id ? openRoles() : openProvider(id); }
  catch (err) { $('#content').innerHTML = `<section class="panel empty"><h2>无法读取配置</h2><p>${esc(err.message)}</p><p>修正配置文件后，点击「重新加载」。</p></section>`; }
}
init();
