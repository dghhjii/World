// memory-engine-protocol.js — 记忆引擎独立响应协议与候选 JSON 校验
window.MEMORY_ENGINE_PROTOCOL = (function() {
  const VERSION = '2.0.0';
  const clean = value => String(value == null ? '' : value).trim();

  function error(message, category, raw) {
    const result = new Error(message);
    result.category = category || 'protocol_error';
    if (raw) result.rawResponse = String(raw).slice(0, 2000);
    return result;
  }

  function scanCandidates(text) {
    const candidates = [];
    let start = -1;
    let stack = [];
    let inString = false;
    let escaped = false;
    for (let i = 0; i < text.length; i++) {
      const ch = text[i];
      if (inString) {
        if (escaped) escaped = false;
        else if (ch === '\\') escaped = true;
        else if (ch === '"') inString = false;
        continue;
      }
      if (ch === '"') { inString = true; continue; }
      if (ch === '{' || ch === '[') {
        if (!stack.length) start = i;
        stack.push(ch);
      } else if (ch === '}' || ch === ']') {
        const open = stack.at(-1);
        if ((ch === '}' && open !== '{') || (ch === ']' && open !== '[')) {
          stack = [];
          start = -1;
          continue;
        }
        stack.pop();
        if (!stack.length && start >= 0) {
          candidates.push(text.slice(start, i + 1));
          start = -1;
        }
      }
    }
    return candidates;
  }

  function detectErrorEnvelope(value, raw) {
    if (!value || typeof value !== 'object') return value;
    if (Array.isArray(value)) return value;
    const detail = value.error && typeof value.error === 'object'
      ? (value.error.message || value.error.detail || JSON.stringify(value.error))
      : (value.error || value.message);
    if (detail && (value.error !== undefined || value.code !== undefined || value.status !== undefined)) {
      throw error('上游 API 返回错误：' + clean(detail), 'upstream_error', raw);
    }
    return value;
  }

  function parseRaw(raw) {
    const text = clean(raw).replace(/^```(?:json)?\s*/i, '').replace(/\s*```$/i, '');
    if (!text) throw error('API 返回为空', 'empty_response', text);
    if (/^<(?:!doctype|html|\?xml)/i.test(text)) {
      throw error('API 返回 HTML/XML，可能是网关错误或 URL 配置错误', 'non_json_response', text);
    }
    try { return detectErrorEnvelope(JSON.parse(text), text); } catch (first) {
      if (first?.category === 'upstream_error') throw first;
    }
    for (const candidate of scanCandidates(text).reverse()) {
      try { return detectErrorEnvelope(JSON.parse(candidate), text); } catch (ignored) {}
    }
    throw error(`API 返回不是有效 JSON：${text.replace(/\s+/g, ' ').slice(0, 500)}`, 'parse_error', text);
  }

  function validate(value, tasks) {
    if (Array.isArray(value)) {
      if (tasks?.memory) return value;
      throw error('当前任务必须返回 JSON 对象', 'schema_error', value);
    }
    if (!value || typeof value !== 'object') throw error('API 返回 JSON 不是对象或数组', 'schema_error', value);
    if (tasks?.memory) {
      if (!Array.isArray(value.personal_memory) || !Array.isArray(value.entity_updates)) {
        throw error('记忆任务返回缺少 personal_memory 或 entity_updates 数组', 'schema_error', value);
      }
    }
    if (tasks?.small && (!Object.hasOwn(value, 'small_summary') || !clean(value.small_summary))) {
      throw error('纪要任务返回缺少非空 small_summary', 'schema_error', value);
    }
    if (tasks?.big && (!Object.hasOwn(value, 'big_summary') || !clean(value.big_summary))) {
      throw error('总述任务返回缺少非空 big_summary', 'schema_error', value);
    }
    return value;
  }

  function parse(raw, tasks) {
    return validate(parseRaw(raw), tasks);
  }

  return { VERSION, scanCandidates, parseRaw, validate, parse };
})();
