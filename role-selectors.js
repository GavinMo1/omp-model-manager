// Keep IDs such as cn:auto intact; explicit effort suffixes are optional.
export function splitSelector(value = '', knownModels = []) {
  if (knownModels.includes(value)) return { model: value, effort: '' };
  const match = value.match(/^(.*):(off|minimal|low|medium|high|xhigh|max)$/);
  return match ? { model: match[1], effort: match[2] } : { model: value, effort: '' };
}
export function joinSelector(model, effort = '') {
  return model.trim() ? model.trim() + (effort ? ':' + effort : '') : '';
}
