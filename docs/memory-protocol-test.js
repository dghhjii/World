const fs = require('fs');
const vm = require('vm');
const assert = require('assert');
const sandbox = { window: null, console };
sandbox.window = sandbox;
vm.runInNewContext(fs.readFileSync(require('path').resolve(__dirname, '..', 'memory-engine-protocol.js'), 'utf8'), sandbox);
const protocol = sandbox.MEMORY_ENGINE_PROTOCOL;

assert.strictEqual(protocol.parse('<thinking>说明</thinking>{"small_summary":"有效纪要"}', { small: true }).small_summary, '有效纪要');
assert.strictEqual(protocol.parse('前置 [1]，正式结果 {"small_summary":"有效纪要"}', { small: true }).small_summary, '有效纪要');
assert.throws(() => protocol.parse('{"error":"模型不存在","code":404}', { memory: true }), /上游 API 返回错误/);
assert.throws(() => protocol.parse('<html>502 Bad Gateway</html>', { memory: true }), /HTML\/XML/);
assert.throws(() => protocol.parse('{}', { memory: true }), /缺少 personal_memory 或 entity_updates/);
const legacy = protocol.parse('[{"name":["旧人物"],"memory":"旧记忆"}]', { memory: true });
assert.strictEqual(legacy.length, 1, '旧版人物数组必须保留给业务归一化层');
console.log('memory protocol tests passed: 6/6');
