// 集成测试：evolution.js 接入资产账本/幕后推演后的完整调用链
// 用法：node test-evolution-integration.js
'use strict';
const fs = require('fs');
const path = require('path');
const vm = require('vm');

let passed = 0, failed = 0;
function t(name, cond) {
  if (cond) { passed++; console.log('  ✅ ' + name); }
  else { failed++; console.log('  ❌ ' + name); }
}
function section(name) { console.log('\n== ' + name + ' =='); }

const settings = {
  assetLedgerEnabled: true,
  assetCategories: '产业,资产,资金,势力',
  assetMajorThresholdHours: 24,
  assetEntryCap: 40,
  assetMajorEventCap: 12,
  offscreenEnabled: true,
  offscreenCharacterCap: 8,
  offscreenUpdateCap: 16,
  socialCircleCap: 6,
  engineEnabled: true,
  apiAutoRetries: 0,
  apiTimeoutMs: 120000,
  tonePrompt: '',
  evolveFilterRegex: ''
};

const storage = new Map();
const store = {
  hydrate: async () => {},
  getItem: k => storage.has(k) ? storage.get(k) : null,
  setItem: (k, v) => storage.set(k, String(v)),
  removeItem: k => storage.delete(k),
  keys: () => [...storage.keys()],
  setSyncSink: () => {}
};

const sandbox = {
  window: {},
  console,
  setTimeout, clearTimeout,
  indexedDB: undefined,
  localStorage: {
    getItem: k => storage.has(k) ? storage.get(k) : null,
    setItem: (k, v) => storage.set(k, String(v)),
    removeItem: k => storage.delete(k),
    key: i => [...storage.keys()][i] || null,
    length: 0
  }
};
sandbox.window = sandbox;
sandbox.SillyTavern = { getContext: () => ({ chatId: 'it', chat: [], name1: '用户', name2: 'AI' }) };
sandbox.AbortController = AbortController;
sandbox.AbortSignal = AbortSignal;
vm.createContext(sandbox);

function load(name) {
  vm.runInContext(fs.readFileSync(path.join(__dirname, name), 'utf8'), sandbox, { filename: name });
}

// 基础模块
load('world-engine-core.js');
load('world-engine-store.js');
sandbox.WORLD_ENGINE_STORE = store;

// 规则/预设/世界书 mock
sandbox.WORLD_ENGINE_RULES = { getAllRulesText: () => '## 规则\n- 世界是活的', getCoreRulesSummary: () => '' };
sandbox.WORLD_ENGINE_PRESET = { getOverrides: () => null };
sandbox.WORLD_ENGINE_WORLDBOOK = { buildPromptSection: async () => '' };
sandbox.MEMORY_ENGINE = { buildWorldEngineContext: () => '' };

// API mock：记录收到的 prompt，返回含新字段的 JSON
let lastPrompt = '';
let callCount = 0;
sandbox.WORLD_ENGINE_API = {
  getSettings: () => settings,
  callApi: async (prompt) => { lastPrompt = prompt; callCount++; return JSON.stringify({
    world_digest: '世界平稳运行。',
    assets: {
      settledAt: '澳宋-1638年-09月-02日',
      overview: { assets: '两处产业、一处庄园', distribution: '临高60%/广州40%', production: '日产布300匹', funds: '白银1200两' },
      entries: [ { category: '产业', name: '博铺造船厂', amount: '500吨级船坞', change: '+1新船坞', note: '二期扩建过半' } ],
      majorEvents: [ { title: '博铺造船厂二期扩建', desc: '新电解槽投产' } ]
    },
    offscreen: {
      characters: [ { id: null, name: '吴明达', lastSeenRound: 1, location: '丙字巷', activity: '组织停电互助', goal: '修缮提案', mood: '热络' } ],
      updates: [ { character: '吴明达', activity: '在丙字巷组织停电互助' } ]
    },
    socialCircles: [ { id: null, name: '丙字巷邻里圈', type: '地缘', members: ['吴明达'], interactions: '每日街头照面', infoScope: '巷内琐事', currentActivity: '停电互助', description: '元老住宅区' } ]
  }); },
  parseJSON: (text) => sandbox.WORLD_ENGINE_API.callApi && (() => { try { return JSON.parse(String(text).replace(/^```json\s*/i, '').replace(/\s*```\s*$/, '').trim()); } catch (e) { return null; } })()
};

// 资产/幕后模块（真实）
load('world-engine-assets.js');
load('world-engine-offsight.js');

// 主入口模块（用于 SHARED_CONTRACTS 静态验证 + 加载链路）
load('world-engine.js');

// 推演核心（真实，含资产/幕后接入）
load('world-engine-evolution.js');

section('F. evolve 完整调用链');
(async () => {
  const core = sandbox.WORLD_ENGINE_CORE;
  const state = core.getDefaultState();
  state.round = 1;

  const debug = sandbox.WORLD_ENGINE_DEBUG;
  t('DEBUG 暴露 evolve/callEvolutionAPI', typeof debug.evolve === 'function' && typeof debug.callEvolutionAPI === 'function');

  // 走真实 evolve：forward 模式（新轮次）
  const ok = await debug.evolve(state, '用户消息', 'AI消息', { mode: 'forward', dialogueText: '近期对话' });
  t('evolve 成功', ok === true);

  t('prompt 包含世界推演规则', lastPrompt.includes('世界推演规则'));
  t('prompt 包含资产账本段（开启时）', lastPrompt.includes('资产账本（记账员）'));
  t('prompt 包含幕后推演段（开启时）', lastPrompt.includes('角色幕后推演'));
  t('prompt 包含当前世界状态 JSON', lastPrompt.includes('当前世界状态'));
  t('prompt 包含输出字段说明', lastPrompt.includes('JSON 输出字段说明'));
  t('prompt 包含 JSON 示例字段', lastPrompt.includes('world_digest') && lastPrompt.includes('influenceChain'));

  // 段顺序：资产段/幕后段在状态段之前注入（prompt 拼接顺序）
  // 注意：状态段标题用「## 当前世界状态（第N轮）」精确匹配——COT 记账思考里也含「当前世界状态」字样
  const iAssets = lastPrompt.indexOf('资产账本（记账员）');
  const iState = lastPrompt.indexOf('## 当前世界状态');
  const iOffsight = lastPrompt.indexOf('角色幕后推演');
  t('资产段先于状态段', iAssets !== -1 && iState !== -1 && iAssets < iState);
  t('幕后段先于状态段', iOffsight !== -1 && iOffsight < iState);

  // merge 生效：state 更新（evolve 内部调用 ASSETS.mergeUpdate / OFFSIGHT.mergeUpdate）
  const saved = core.loadState();
  t('资产账本 entries 已合并', saved.assets.entries.length === 1 && saved.assets.entries[0].name === '博铺造船厂');
  t('资产账本 overview 已合并', saved.assets.overview.funds === '白银1200两');
  t('幕后角色已合并', saved.offscreen.characters.length === 1 && saved.offscreen.characters[0].name === '吴明达');
  t('幕后动态已合并', saved.offscreen.updates.length >= 1);
  t('社交圈已合并', saved.socialCircles.length === 1 && saved.socialCircles[0].name === '丙字巷邻里圈');
  t('world_digest 正常', saved.worldDigest.includes('世界平稳运行'));
  t('round 推进到2', saved.round === 2);

  // 关闭新功能时 prompt 不包含新段、merge 无副作用
  settings.assetLedgerEnabled = false;
  settings.offscreenEnabled = false;
  const state2 = core.loadState();
  const ok2 = await debug.evolve(state2, '用户消息2', 'AI消息2', { mode: 'forward', dialogueText: '近期对话2' });
  t('关闭时 evolve 仍成功', ok2 === true);
  t('关闭时 prompt 不含资产账本段', !lastPrompt.includes('资产账本（记账员）'));
  t('关闭时 prompt 不含幕后推演段', !lastPrompt.includes('角色幕后推演'));
  const saved2 = core.loadState();
  t('关闭时 assets 保持不变', saved2.assets.entries.length === 1);

  console.log('\n==========');
  console.log(`通过 ${passed} / ${passed + failed}`);
  process.exit(failed ? 1 : 0);
})().catch(e => { console.error('测试崩溃:', e); process.exit(1); });
