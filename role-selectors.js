// Shared role metadata and selector parsing for the browser UI, server and CLI.
// Model IDs may contain colons (for example `cn:auto`); only strip a trailing
// effort when the complete selector is not itself a known model ID.

export const SELECTOR_EFFORTS = ['off', 'minimal', 'low', 'medium', 'high', 'xhigh', 'max', 'auto', 'inherit'];
// `defaultThinkingLevel` accepts a subset: `off`/`inherit` are role-only.
export const SETTING_THINKING_LEVELS = ['minimal', 'low', 'medium', 'high', 'xhigh', 'max', 'auto'];

export const KIND_ROLES = ['image', 'web', 'speech', 'dictation', 'judge'];

export const ROLE_DEFS = {
  default: ['默认模型', '日常对话与编码'],
  smol: ['快速模型', '轻量任务与快速处理'],
  slow: ['深度模型', '复杂分析与推理'],
  plan: ['规划模型', '方案与架构设计'],
  vision: ['视觉模型', '图片理解'],
  commit: ['提交说明', '生成 Git 提交信息'],
  tiny: ['微型任务', '标题等简单任务'],
  memory: ['记忆模型', '整理与提炼记忆'],
  task: ['子任务模型', '委派任务的默认选择'],
  advisor: ['顾问模型', '辅助审阅与建议'],
  widget: ['组件模型', '小型界面与组件任务'],
  image: ['图像生成', '需要支持图像生成的模型'],
  web: ['网页检索', '需要支持搜索的模型或服务'],
  speech: ['语音合成', '需要支持语音输出的模型'],
  dictation: ['语音转写', '需要支持音频转文字的模型'],
  judge: ['评判模型', '需要支持评判任务的模型'],
};

// The Role page only offers the original 7-value dropdown. `auto`/`inherit`
// are intentionally not surfaced here: the UI cannot round-trip them yet.
export function splitSelector(value = '', knownModels = []) {
  if (knownModels.includes(value)) return { model: value, effort: '' };
  const match = value.match(/^(.*):(off|minimal|low|medium|high|xhigh|max)$/);
  return match ? { model: match[1], effort: match[2] } : { model: value, effort: '' };
}

export function joinSelector(model, effort = '') {
  return model.trim() ? model.trim() + (effort ? ':' + effort : '') : '';
}

// Split a value that may contain a comma-separated list of selectors.
// Aliases (`@role`, `pi/role`, `*`) are returned with kind `alias`.
// A trailing effort is stripped only when the full selector is not a known
// model ID, so `provider/cn:auto` and `provider/cn:auto:high` both work.
export function parseRoleSelectors(value, knownModels = []) {
  if (typeof value !== 'string') return [];
  return value.split(',').map(s => s.trim()).filter(Boolean).map(raw => {
    if (raw === '*' || raw.startsWith('@') || raw.startsWith('pi/')) {
      return { raw, kind: 'alias', model: raw, effort: '' };
    }
    if (!knownModels.length || knownModels.includes(raw)) {
      return { raw, kind: 'model', model: raw, effort: '' };
    }
    for (const effort of SELECTOR_EFFORTS) {
      const suffix = ':' + effort;
      if (!raw.endsWith(suffix)) continue;
      const model = raw.slice(0, -suffix.length);
      if (knownModels.includes(model)) return { raw, kind: 'model', model, effort };
    }
    return { raw, kind: 'model', model: raw, effort: '' };
  });
}
