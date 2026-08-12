// 离线逻辑测试：world-engine-assets.js + world-engine-offsight.js + core 迁移
// 用法：node test-assets-offsight.js
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

// ---------- mock 环境 ----------
function makeSettings(overrides) {
  return Object.assign({
    assetLedgerEnabled: false,
    assetCategories: '产业,资产,资金,势力',
    assetMajorThresholdHours: 24,
    assetEntryCap: 40,
    assetMajorEventCap: 12,
    offscreenEnabled: false,
    offscreenCharacterCap: 8,
    offscreenUpdateCap: 16,
    socialCircleCap: 6
  }, overrides || {});
}

function makeEnv(settings, saved) {
  const storage = new Map();
  if (saved) storage.set('world_engine_test', JSON.stringify(saved));
  const store = {
    hydrate: async () => {},
    getItem: k => storage.has(k) ? storage.get(k) : null,
    setItem: (k, v) => storage.set(k, String(v)),
    removeItem: k => storage.delete(k),
    keys: () => [...storage.keys()],
    setSyncSink: () => {}
  };
  const coreSrc = fs.readFileSync(path.join(__dirname, 'world-engine-core.js'), 'utf8');
  const assetsSrc = fs.readFileSync(path.join(__dirname, 'world-engine-assets.js'), 'utf8');
  const offsightSrc = fs.readFileSync(path.join(__dirname, 'world-engine-offsight.js'), 'utf8');
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
  sandbox.SillyTavern = {
    getContext: () => ({ chatId: 'test', chat: [], name1: '用户', name2: 'AI', characters: [] })
  };
  vm.createContext(sandbox);
  vm.runInContext(coreSrc, sandbox, { filename: 'world-engine-core.js' });
  vm.runInContext(assetsSrc, sandbox, { filename: 'world-engine-assets.js' });
  vm.runInContext(offsightSrc, sandbox, { filename: 'world-engine-offsight.js' });
  // API mock（挂到 window 上，供 assets/offsight 的 settings() 读取）
  const api = { getSettings: () => settings };
  sandbox.WORLD_ENGINE_API = api;
  sandbox.WORLD_ENGINE_STORE = store;
  return { sandbox, store, storage, api };
}

function defaultState(sandbox) {
  return sandbox.WORLD_ENGINE_CORE.getDefaultState();
}

// ============================================================
section('A. 资产账本：默认关闭时零行为改变');
{
  const env = makeEnv(makeSettings({ assetLedgerEnabled: false }));
  const s = defaultState(env.sandbox);
  const A = env.sandbox.WORLD_ENGINE_ASSETS;
  t('buildPromptSection 返回空', A.buildPromptSection(s) === '');
  t('mergeUpdate 空操作不炸', (() => { try { A.mergeUpdate(s, { assets: { entries: [{ name: 'x' }] } }); return true; } catch (e) { return false; } })());
  t('buildContextSection 返回空', A.buildContextSection(s) === '');
}

section('B. 资产账本：开启后 prompt 段与合并');
{
  const env = makeEnv(makeSettings({ assetLedgerEnabled: true }));
  const s = defaultState(env.sandbox);
  const A = env.sandbox.WORLD_ENGINE_ASSETS;
  const seg = A.buildPromptSection(s);
  t('prompt 段含记账员身份', seg.includes('专职记账员'));
  t('prompt 段含门禁说明', seg.includes('门禁规则'));
  t('prompt 段含账目类别', seg.includes('产业'));
  t('prompt 段含尚未结算', seg.includes('尚未结算'));

  // 完整结算
  const upd = {
    assets: {
      settledAt: '澳宋-1638年-09月-02日',
      overview: { assets: '两处产业、一处庄园', distribution: '临高60%/广州40%', production: '日产布300匹', funds: '白银1200两' },
      entries: [
        { category: '产业', name: '博铺造船厂', amount: '500吨级船坞', change: '+1新船坞', note: '二期扩建过半' },
        { category: '资金', name: '现金储备', amount: '1200两', change: '+300两', note: '香料贸易回款' }
      ],
      majorEvents: [{ title: '博铺造船厂二期扩建过半', desc: '新电解槽投产，产能+25%' }]
    }
  };
  A.mergeUpdate(s, upd);
  t('overview.assets 更新', s.assets.overview.assets === '两处产业、一处庄园');
  t('overview.funds 更新', s.assets.overview.funds === '白银1200两');
  t('entries 全量落盘', s.assets.entries.length === 2);
  t('entries 继承 round', s.assets.entries[0].round === 0);
  t('majorEvents 记录', s.assets.majorEvents.length === 1 && s.assets.majorEvents[0].title.includes('博铺'));
  t('lastSettledRound 更新', s.assets.lastSettledRound === 0);
  t('ledgerTime.settledAt 更新', s.assets.ledgerTime.settledAt.includes('1638'));

  // 未满门禁：只更新 settledAt，不动 entries
  const before = JSON.stringify(s.assets.entries);
  A.mergeUpdate(s, { assets: { settledAt: '澳宋-1638年-09月-03日' } });
  t('门禁轮：entries 保持不变', JSON.stringify(s.assets.entries) === before);
  t('门禁轮：settledAt 可更新', s.assets.ledgerTime.settledAt.includes('09月-03日'));

  // context 注入
  const ctx = A.buildContextSection(s);
  t('注入段含资产总览', ctx.includes('资产总览'));
  t('注入段含资金', ctx.includes('资金'));
  // 关闭时注入为空
  const env2 = makeEnv(makeSettings({ assetLedgerEnabled: false }));
  const s2 = defaultState(env2.sandbox);
  Object.assign(s2, { assets: s.assets });
  t('关闭时注入为空', env2.sandbox.WORLD_ENGINE_ASSETS.buildContextSection(s2) === '');

  // 上限裁剪
  const updBig = { assets: { entries: [], majorEvents: Array.from({length: 30}, (_, i) => ({ title: '事件' + i })) } };
  A.mergeUpdate(s, updBig);
  t('majorEvents 上限裁剪到12', s.assets.majorEvents.length === 12);
}

section('C. 幕后推演：默认关闭时零行为改变');
{
  const env = makeEnv(makeSettings({ offscreenEnabled: false }));
  const s = defaultState(env.sandbox);
  const O = env.sandbox.WORLD_ENGINE_OFFSIGHT;
  t('buildPromptSection 返回空', O.buildPromptSection(s) === '');
  t('mergeUpdate 空操作不炸', (() => { try { O.mergeUpdate(s, { offscreen: { updates: [{ character: 'x', activity: 'y' }] } }); return true; } catch (e) { return false; } })());
  t('buildContextSection 返回空', O.buildContextSection(s) === '');
}

section('D. 幕后推演：开启后角色/动态/社交圈');
{
  const env = makeEnv(makeSettings({ offscreenEnabled: true }));
  const s = defaultState(env.sandbox);
  const O = env.sandbox.WORLD_ENGINE_OFFSIGHT;
  const seg = O.buildPromptSection(s);
  t('prompt 段含核心约束', seg.includes('世界是活的'));
  t('prompt 段含角色档案', seg.includes('幕后角色档案'));
  t('prompt 段含社交圈类型', seg.includes('地缘'));

  const upd = {
    offscreen: {
      characters: [
        { id: null, name: '吴明达', lastSeenRound: 2, location: '丙字巷', activity: '替邻居代领物资', goal: '修缮提案通过', mood: '热络' },
        { id: null, name: '萧子山', lastSeenRound: 2, location: '元老院', activity: '推进修缮提案', goal: '协调预算', mood: '沉稳' }
      ],
      updates: [
        { character: '吴明达', activity: '在丙字巷组织停电互助' },
        { character: '萧子山', activity: '与程栋商谈预算分配' }
      ]
    },
    socialCircles: [
      { id: null, name: '丙字巷邻里圈', type: '地缘', members: ['吴明达', '朱存炯'], interactions: '每日街头照面', infoScope: '巷内琐事', currentActivity: '停电互助', description: '元老住宅区普通巷子' },
      { id: null, name: '元老院政务圈', type: '业缘', members: ['萧子山', '程栋'], interactions: '每周例会', infoScope: '政策动向', currentActivity: '预算协调', description: '核心行政层' }
    ]
  };
  O.mergeUpdate(s, upd);
  t('角色 id 自动分配', s.offscreen.characters[0].id === 'offscreen_1' && s.offscreen.characters[1].id === 'offscreen_2');
  t('角色字段完整', s.offscreen.characters[0].name === '吴明达' && s.offscreen.characters[0].mood === '热络');
  t('动态日志追加', s.offscreen.updates.length === 2 && s.offscreen.updates.some(u => u.character === '吴明达'));
  t('社交圈 id 分配', s.socialCircles[0].id === 'circle_1' && s.socialCircles[1].id === 'circle_2');
  t('社交圈类型正确', s.socialCircles[0].type === '地缘' && s.socialCircles[1].type === '业缘');

  // 第二轮：角色全量替换 + 同名认领 id
  O.mergeUpdate(s, {
    offscreen: {
      characters: [
        { id: 'offscreen_1', name: '吴明达', lastSeenRound: 3, location: '丙字巷', activity: '组织灯会', goal: '修缮提案通过', mood: '热络' }
      ],
      updates: [{ character: '吴明达', activity: '筹备巷内灯会' }]
    },
    socialCircles: []
  });
  t('第二轮：未返回的角色被移除', s.offscreen.characters.length === 1);
  t('第二轮：沿用原 id', s.offscreen.characters[0].id === 'offscreen_1');
  t('第二轮：动态日志追加', s.offscreen.updates.length === 3);

  // 上限裁剪
  const updBig = { offscreen: { updates: Array.from({length: 30}, (_, i) => ({ character: 'c' + i, activity: 'a' })) } };
  O.mergeUpdate(s, updBig);
  t('updates 上限裁剪到16', s.offscreen.updates.length === 16);

  // context 注入
  const ctx = O.buildContextSection(s);
  t('注入段含后台动态', ctx.includes('后台动态'));
  const env2 = makeEnv(makeSettings({ offscreenEnabled: false }));
  const s2 = defaultState(env2.sandbox);
  t('关闭时注入为空', env2.sandbox.WORLD_ENGINE_OFFSIGHT.buildContextSection(s2) === '');
}

section('E. core 迁移与修复');
{
  const env = makeEnv(makeSettings());
  const sandbox = env.sandbox;
  const core = sandbox.WORLD_ENGINE_CORE;
  const s = core.getDefaultState();
  t('默认 state 含 assets', !!s.assets && s.assets.enabled === true);
  t('默认 state 含 offscreen', !!s.offscreen && Array.isArray(s.offscreen.characters));
  t('默认 state 含 socialCircles', Array.isArray(s.socialCircles));
  // 旧存档（无新字段）经 loadState 迁移
  const legacy = core.getDefaultState();
  delete legacy.assets; delete legacy.offscreen; delete legacy.socialCircles;
  env.storage.set('world_engine_test', JSON.stringify(legacy));
  const loaded = core.loadState();
  t('旧存档迁移出 assets', !!loaded.assets && loaded.assets.enabled === true);
  t('旧存档迁移出 offscreen', !!loaded.offscreen && Array.isArray(loaded.offscreen.updates));
  t('旧存档迁移出 socialCircles', Array.isArray(loaded.socialCircles));
  // 异常值修复：assets=null 落盘后 loadState 修复
  const bad = core.getDefaultState();
  bad.assets = null;
  env.storage.set('world_engine_test', JSON.stringify(bad));
  const loaded2 = core.loadState();
  t('assets=null 被修复', !!loaded2.assets && Array.isArray(loaded2.assets.entries));
}

console.log('\n==========');
console.log(`通过 ${passed} / ${passed + failed}`);
process.exit(failed ? 1 : 0);
