// 回归测试：world-engine-assets.js MOA 审查修复（S2/S2a/S2b/M2/M5 + 轻微问题）
// 覆盖：①entries 增量合并（同名更新、不同名追加、未返回条目保留）
//       ②entries 全无效不替换不清空  ③overview 空对象不推进 lastSettledRound
//       ④截断保护（entries 有值但过滤后为空）  ⑤majorEvents slice(0,3) 取最近
//       ⑥null 元素防御  + M5 null/undefined 输入、脏检查、settledAt 轮次标记
// 用法：node test-assets-regression.js
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

// ---------- mock 环境（与 test-assets-offsight.js 同款写法） ----------
function makeSettings(overrides) {
  return Object.assign({
    assetLedgerEnabled: true,
    assetCategories: '产业,资产,资金,势力',
    assetMajorThresholdHours: 24,
    assetEntryCap: 40,
    assetMajorEventCap: 12
  }, overrides || {});
}

function makeEnv(settings) {
  const storage = new Map();
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
    getContext: () => ({ chatId: 'reg', chat: [], name1: '用户', name2: 'AI', characters: [] })
  };
  vm.createContext(sandbox);
  vm.runInContext(coreSrc, sandbox, { filename: 'world-engine-core.js' });
  vm.runInContext(assetsSrc, sandbox, { filename: 'world-engine-assets.js' });
  const api = { getSettings: () => settings };
  sandbox.WORLD_ENGINE_API = api;
  sandbox.WORLD_ENGINE_STORE = store;
  return { sandbox, store, storage, api };
}

function defaultState(sandbox) {
  return sandbox.WORLD_ENGINE_CORE.getDefaultState();
}

// ============================================================
section('① S2：entries 增量合并（同名更新、不同名追加、未返回保留）');
{
  const env = makeEnv(makeSettings());
  const s = defaultState(env.sandbox);
  const A = env.sandbox.WORLD_ENGINE_ASSETS;

  // 首轮完整结算
  s.round = 3;
  A.mergeUpdate(s, { assets: {
    settledAt: '澳宋-1638年-09月-02日',
    overview: { assets: '产业两处', funds: '1000两' },
    entries: [
      { category: '资金', name: '现金储备', amount: '1000两', change: '+100两' },
      { category: '产业', name: '博铺造船厂', amount: '500吨级', change: '持平' }
    ]
  }});
  t('首轮：2 条新条目全部追加', s.assets.entries.length === 2);
  t('首轮：lastSettledRound 推进', s.assets.lastSettledRound === 3);

  // 第二轮：同名更新 + 新 name 追加；未返回的旧条目必须保留（不整组覆盖）
  s.round = 4;
  A.mergeUpdate(s, { assets: {
    entries: [
      { category: '资金', name: '现金储备', amount: '1300两', change: '+300两', note: '香料回款' },
      { category: '产业', name: '新产业-纺织坊', amount: '日产布300匹', change: '新建' }
    ]
  }});
  t('增量合并：条目总数 3（旧2 + 新1）', s.assets.entries.length === 3);
  const cash = s.assets.entries.find(e => e.name === '现金储备');
  t('同名条目更新 amount', !!cash && cash.amount === '1300两');
  t('同名条目更新 change/note', !!cash && cash.change === '+300两' && cash.note === '香料回款');
  t('同名条目更新 round', !!cash && cash.round === 4);
  const ship = s.assets.entries.find(e => e.name === '博铺造船厂');
  t('未返回的旧条目保留且不被改写', !!ship && ship.amount === '500吨级' && ship.round === 3);
  const newE = s.assets.entries.find(e => e.name === '新产业-纺织坊');
  t('新 name 追加到末尾', !!newE && s.assets.entries[s.assets.entries.length - 1].name === '新产业-纺织坊');
  t('增量结算推进 lastSettledRound', s.assets.lastSettledRound === 4);
}

section('② S2b：entries 全无效 → 不替换、不清空、不推进');
{
  const env = makeEnv(makeSettings());
  const s = defaultState(env.sandbox);
  const A = env.sandbox.WORLD_ENGINE_ASSETS;

  s.round = 2;
  A.mergeUpdate(s, { assets: { entries: [{ name: '现金储备', amount: '900两' }] } });
  const before = JSON.stringify(s.assets.entries);

  s.round = 3;
  A.mergeUpdate(s, { assets: { entries: [null, { foo: 'bar' }, '字符串', 42, { name: '' }] } });
  t('全无效条目：本地 entries 不被替换', JSON.stringify(s.assets.entries) === before);
  t('全无效条目：不推进 lastSettledRound', s.assets.lastSettledRound === 2);

  // 混合场景：一半有效一半无效 → 只合并有效部分
  s.round = 4;
  A.mergeUpdate(s, { assets: { entries: [null, { name: '现金储备', amount: '950两' }, { name: '' }] } });
  t('混合条目：只合并有效部分', s.assets.entries.length === 1 && s.assets.entries[0].amount === '950两');
  t('混合条目：有效部分推进 lastSettledRound', s.assets.lastSettledRound === 4);
}

section('③ S2a：overview 空对象/全空字段不推进 lastSettledRound');
{
  const env = makeEnv(makeSettings());
  const s = defaultState(env.sandbox);
  const A = env.sandbox.WORLD_ENGINE_ASSETS;

  s.round = 1;
  A.mergeUpdate(s, { assets: { entries: [{ name: '现金', amount: '1两' }] } });

  s.round = 2;
  A.mergeUpdate(s, { assets: { overview: {} } });
  t('空 overview {}：不推进 lastSettledRound', s.assets.lastSettledRound === 1);
  t('空 overview {}：entries 不变', s.assets.entries.length === 1);
  t('空 overview {}：overview 字段不被污染', s.assets.overview.assets === '');

  s.round = 3;
  A.mergeUpdate(s, { assets: { overview: { assets: '', funds: '', production: '', distribution: '' } } });
  t('全空字段 overview：不推进 lastSettledRound', s.assets.lastSettledRound === 1);

  // 对照：全新空账目 + 仅 overview（无 entries）→ 视为首次结算推进，避免死锁
  const s4 = defaultState(env.sandbox);
  s4.round = 4;
  A.mergeUpdate(s4, { assets: { overview: { assets: '一处产业', funds: '300两' } } });
  t('有数据 overview：本地账目为空时推进 lastSettledRound', s4.assets.lastSettledRound === 4);
  t('有数据 overview：字段落盘', s4.assets.overview.assets === '一处产业' && s4.assets.overview.funds === '300两');
}

section('④ S2b 截断保护：entries 有值但过滤后为空（本地账目非空）');
{
  const env = makeEnv(makeSettings());
  const s = defaultState(env.sandbox);
  const A = env.sandbox.WORLD_ENGINE_ASSETS;

  s.round = 5;
  A.mergeUpdate(s, { assets: {
    overview: { assets: '两处产业', funds: '500两' },
    entries: [{ name: '现金储备', amount: '500两' }, { name: '博铺造船厂', amount: '300吨级' }]
  }});
  const beforeEntries = JSON.stringify(s.assets.entries);

  // 截断响应：overview 有数据但 entries 全是无效条目
  s.round = 6;
  A.mergeUpdate(s, { assets: { overview: { assets: '截断后的概览' }, entries: [{ foo: 'x' }, null] } });
  t('截断保护：entries 不被清空', JSON.stringify(s.assets.entries) === beforeEntries);
  t('截断保护：lastSettledRound 不推进', s.assets.lastSettledRound === 5);
  t('截断保护：overview 正常更新', s.assets.overview.assets === '截断后的概览');

  // 只回 overview（无 entries 字段）同样不视为替换依据
  s.round = 7;
  A.mergeUpdate(s, { assets: { overview: { assets: '仅概览' } } });
  t('仅 overview 且本地账目非空：entries 仍保留', JSON.stringify(s.assets.entries) === beforeEntries);
  t('仅 overview 且本地账目非空：lastSettledRound 不推进', s.assets.lastSettledRound === 5);
}

section('⑤ M2：majorEvents slice(0,3) 取最近三条（newest-first）');
{
  const env = makeEnv(makeSettings());
  const s = defaultState(env.sandbox);
  const A = env.sandbox.WORLD_ENGINE_ASSETS;

  s.round = 9;
  A.mergeUpdate(s, { assets: { majorEvents: [
    { title: '事件-最旧', desc: 'd' },
    { title: '事件-较旧', desc: 'd' },
    { title: '事件-中间', desc: 'd' },
    { title: '事件-次新', desc: 'd' },
    { title: '事件-最新', desc: 'd' }
  ] }});
  // unshift 头部插入 → 数组顺序 = [最新, 次新, 中间, 较旧, 最旧]
  t('majorEvents 最新在前', s.assets.majorEvents[0].title === '事件-最新' && s.assets.majorEvents[4].title === '事件-最旧');
  const seg = A.buildPromptSection(s);
  t('slice(0,3)：包含最近三条', seg.includes('事件-最新') && seg.includes('事件-次新') && seg.includes('事件-中间'));
  t('slice(0,3)：不含最旧两条', !seg.includes('事件-较旧') && !seg.includes('事件-最旧'));
}

section('⑥ null 元素防御（坏存档 entries=[null,...] 不抛错）');
{
  const env = makeEnv(makeSettings());
  const s = defaultState(env.sandbox);
  const A = env.sandbox.WORLD_ENGINE_ASSETS;

  s.round = 2;
  s.assets.entries = [null, 42, '垃圾', { category: '产业', name: '博铺造船厂', amount: '500吨级' }, { name: '现金储备' }];
  s.assets.majorEvents = [null, { round: 1, title: '历史事件', desc: 'x' }];

  let seg = '', threw = false;
  try { seg = A.buildPromptSection(s); } catch (e) { threw = true; }
  t('buildPromptSection：null 元素不抛错', !threw);
  t('buildPromptSection：有效条目正常渲染', seg.includes('博铺造船厂') && seg.includes('现金储备'));
  t('buildPromptSection：majorEvents 中 null 被跳过', seg.includes('历史事件'));

  let ctx = '', ctxThrew = false;
  try { ctx = A.buildContextSection(s); } catch (e) { ctxThrew = true; }
  t('buildContextSection：null 元素不抛错', !ctxThrew);

  let threw2 = false;
  try {
    A.mergeUpdate(s, { assets: { entries: [null, { name: '新条目', amount: '1' }] } });
  } catch (e) { threw2 = true; }
  t('mergeUpdate：null 元素不抛错', !threw2);
  t('mergeUpdate：null 元素后的有效条目被合并', s.assets.entries.some(e => e && e.name === '新条目'));
  t('mergeUpdate：坏存档条目被清理', !s.assets.entries.some(e => e === 42 || e === '垃圾'));
}

section('⑦ M5 防御 + 脏检查 + settledAt 轮次标记');
{
  const env = makeEnv(makeSettings());
  const s = defaultState(env.sandbox);
  const A = env.sandbox.WORLD_ENGINE_ASSETS;

  // 脏检查：无变更不 saveState
  const core = env.sandbox.WORLD_ENGINE_CORE;
  const origSave = core.saveState;
  let saves = 0;
  core.saveState = function(st) { saves++; return origSave(st); };

  s.round = 1;
  A.mergeUpdate(s, { assets: {} });
  t('脏检查：全空 update 不触发 saveState', saves === 0);
  A.mergeUpdate(s, { assets: { overview: { assets: '一处产业' } } });
  t('脏检查：overview 更新触发 saveState', saves === 1);
  A.mergeUpdate(s, { assets: { settledAt: '澳宋-1638年-09月-02日' } });
  t('脏检查：settledAt 更新触发 saveState', saves === 2);

  // M5：null/undefined 输入全部不抛错
  let ok = true;
  try {
    A.mergeUpdate(null, { assets: { entries: [{ name: 'x' }] } });
    A.mergeUpdate(undefined, { assets: {} });
    A.mergeUpdate({}, { assets: { entries: [{ name: 'x' }] } });
    A.mergeUpdate(s, null);
    A.mergeUpdate(s, { assets: null });
    A.mergeUpdate(s, {});
  } catch (e) { ok = false; }
  t('M5：null/undefined 输入全部不抛错', ok);

  // state.assets 缺失/损坏时自动补齐骨架
  const s2 = { round: 7, assets: null };
  A.mergeUpdate(s2, { assets: { entries: [{ name: '现金', amount: '1两' }] } });
  t('M5：assets=null 自动补齐骨架', !!s2.assets && Array.isArray(s2.assets.entries) && s2.assets.entries.length === 1);
  t('M5：补齐后 lastSettledRound 推进', s2.assets.lastSettledRound === 7);

  const s3 = defaultState(env.sandbox);
  s3.round = 10;
  s3.assets.ledgerTime.settledAt = '澳宋-1638年-09月-02日';
  A.mergeUpdate(s3, { assets: { entries: [{ name: '现金储备', amount: '800两' }] } });
  t('#7：未给 settledAt 时追加轮次标记', s3.assets.ledgerTime.settledAt.includes('（第10轮）'));
  t('#7：保留旧 settledAt 文本', s3.assets.ledgerTime.settledAt.includes('1638'));

  s3.round = 11;
  A.mergeUpdate(s3, { assets: { entries: [{ name: '现金储备', amount: '900两' }] } });
  A.mergeUpdate(s3, { assets: { entries: [{ name: '现金储备', amount: '910两' }] } });
  t('#7：不同轮追加新标记', s3.assets.ledgerTime.settledAt.includes('（第11轮）'));
  t('#7：同轮重复结算不重复追加标记', (s3.assets.ledgerTime.settledAt.match(/（第11轮）/g) || []).length === 1);
  t('#7：同名条目同轮不重复', s3.assets.entries.length === 1);
}

section('⑧ A-M1：entries cap 裁剪保留最新（cap=3 合并 A/B/C/D → B/C/D）');
{
  const env = makeEnv(makeSettings({ assetEntryCap: 3 }));
  const s = defaultState(env.sandbox);
  const A = env.sandbox.WORLD_ENGINE_ASSETS;

  // 连续 4 轮各追加一条：A→B→C→D；entries 为 oldest-first，cap=3 应保留最新三条 B/C/D
  for (const [round, name] of [[1, '资产A'], [2, '资产B'], [3, '资产C'], [4, '资产D']]) {
    s.round = round;
    A.mergeUpdate(s, { assets: { entries: [{ category: '资产', name, amount: round + '两' }] } });
  }
  t('cap=3：entries 长度裁剪到 3', s.assets.entries.length === 3);
  t('cap=3：保留最新三条 B/C/D（顺序不变）', s.assets.entries.map(e => e.name).join(',') === '资产B,资产C,资产D');
  t('cap=3：最早条目 A 被裁剪', !s.assets.entries.some(e => e.name === '资产A'));
  t('cap=3：lastSettledRound 为最新轮 4', s.assets.lastSettledRound === 4);
}

section('⑨ A-M2：majorEvents 同 (round, title) 去重');
{
  const env = makeEnv(makeSettings());
  const s = defaultState(env.sandbox);
  const A = env.sandbox.WORLD_ENGINE_ASSETS;

  // 同轮（round=5）重复回显同一事件两次（redo/重roll/LLM 回显场景）→ 只记录一条
  s.round = 5;
  A.mergeUpdate(s, { assets: { majorEvents: [{ title: '临高危机', desc: 'v1' }] } });
  A.mergeUpdate(s, { assets: { majorEvents: [{ title: '临高危机', desc: 'v2' }] } });
  t('同轮同标题：不重复追加', s.assets.majorEvents.length === 1);
  t('同轮同标题：保留首次 desc', s.assets.majorEvents[0].desc === 'v1');
  t('同轮同标题：round 正确', s.assets.majorEvents[0].round === 5);

  // 不同轮同标题 → 各轮独立事件，允许追加
  s.round = 6;
  A.mergeUpdate(s, { assets: { majorEvents: [{ title: '临高危机', desc: 'v3' }] } });
  t('不同轮同标题：允许追加', s.assets.majorEvents.length === 2);
  t('不同轮同标题：新事件在最前（newest-first）', s.assets.majorEvents[0].round === 6);

  // 同轮不同标题 → 均保留
  s.round = 7;
  A.mergeUpdate(s, { assets: { majorEvents: [{ title: '新事件甲' }, { title: '新事件乙' }] } });
  t('同轮不同标题：均追加', s.assets.majorEvents.length === 4);
}

section('⑩ B-S1：首轮门禁——从未结算强制完整记账');
{
  const env = makeEnv(makeSettings({ assetMajorThresholdHours: 24 }));
  const s = defaultState(env.sandbox);
  const A = env.sandbox.WORLD_ENGINE_ASSETS;

  // 从未结算（lastSettledRound=0 且 entries 为空）→ 门禁必须是「首次建立账本：完整记账」
  s.round = 1;
  const seg1 = A.buildPromptSection(s);
  t('从未结算：含「首次建立账本」强制完整记账文案', seg1.includes('首次建立账本') && seg1.includes('必须完整记账'));
  t('从未结算：强制首次完整记账', seg1.includes('首次建立账本') && seg1.includes('必须完整记账'));
  t('从未结算：仍显示「尚未结算」', seg1.includes('尚未结算'));

  // 首次完整记账后（round=1 结算），round=2 距上次结算 1 轮 < 24 → 恢复轮数门禁
  A.mergeUpdate(s, { assets: {
    settledAt: '澳宋-1638年-09月-02日',
    overview: { assets: '一处产业', funds: '100两' },
    entries: [{ category: '资金', name: '现金储备', amount: '100两' }]
  }});
  s.round = 2;
  const seg2 = A.buildPromptSection(s);
  t('已有账目且不足 threshold：恢复「只更新 ledgerTime」门禁提示', seg2.includes('只更新 ledgerTime'));
  t('已有账目且不足 threshold：不再提示首次建立', !seg2.includes('首次建立账本'));
  t('已有账目：显示上次结算时间', seg2.includes('09月-02日'));
  t('已有账目：显示距上次结算轮数', seg2.includes('距今 1 轮'));
}

section('⑪ P0-1：故事时间门禁双轨（assetGateMode）');
{
  // rounds 模式（默认，未设 assetGateMode）：门禁按轮数判定，文案含「轮」不含「故事日」
  const env = makeEnv(makeSettings());
  const s = defaultState(env.sandbox);
  const A = env.sandbox.WORLD_ENGINE_ASSETS;
  s.round = 1;
  A.mergeUpdate(s, { assets: {
    settledAt: '澳宋-1638年-09月-02日',
    overview: { assets: '一处产业', funds: '100两' },
    entries: [{ category: '资金', name: '现金储备', amount: '100两' }]
  }});
  s.round = 2;
  const segRounds = A.buildPromptSection(s);
  t('rounds 模式：门禁按轮数判定（含「不足 24 轮」）', segRounds.includes('不足 24 轮'));
  t('rounds 模式：显示距今轮数', segRounds.includes('距今 1 轮'));
  t('rounds 模式：门禁按轮数（含「不足 24 轮」）', segRounds.includes('不足 24 轮'));

  // story 模式：core.setLastStoryDay(5) + 上次结算 storyDay=3 → gapDays=2 < 24 → 故事日门禁
  const env2 = makeEnv(makeSettings({ assetGateMode: 'story' }));
  const s2 = defaultState(env2.sandbox);
  const A2 = env2.sandbox.WORLD_ENGINE_ASSETS;
  s2.round = 1;
  A2.mergeUpdate(s2, { assets: {
    settledAt: '澳宋-1638年-09月-02日',
    overview: { assets: '一处产业', funds: '100两' },
    entries: [{ category: '资金', name: '现金储备', amount: '100两' }]
  }});
  s2.assets.ledgerTime.storyDay = 3; // 直接注入上次结算故事日
  env2.sandbox.WORLD_ENGINE_CORE.setLastStoryDay(5);
  s2.round = 2;
  const segStory = A2.buildPromptSection(s2);
  t('story 模式：门禁按故事日判定（含「不足 24 个故事日」）', segStory.includes('不足 24 个故事日'));
  t('story 模式：显示距今故事日数', segStory.includes('距今 2 个故事日'));
  t('story 模式：不出现轮数门禁文案', !segStory.includes('不足 24 轮'));
  t('story 模式：保留结算时间锁定语义', segStory.includes('结算时间锁定为上次结算时间保持不变'));

  // story 模式解析不到当前故事日（getLastStoryDay 为 null、对话为空）→ 自动回退轮数门禁
  const env3 = makeEnv(makeSettings({ assetGateMode: 'story' }));
  const s3 = defaultState(env3.sandbox);
  const A3 = env3.sandbox.WORLD_ENGINE_ASSETS;
  s3.round = 1;
  A3.mergeUpdate(s3, { assets: {
    settledAt: '澳宋-1638年-09月-02日',
    overview: { assets: '一处产业', funds: '100两' },
    entries: [{ category: '资金', name: '现金储备', amount: '100两' }]
  }});
  s3.assets.ledgerTime.storyDay = 3;
  s3.round = 2;
  const segFallback = A3.buildPromptSection(s3);
  t('story 模式解析不到故事日：自动回退轮数门禁', segFallback.includes('不足 24 轮'));
}

section('⑫ P0-2：记账质量守则（精简 6 条）');
{
  const env = makeEnv(makeSettings());
  const s = defaultState(env.sandbox);
  const A = env.sandbox.WORLD_ENGINE_ASSETS;
  const seg = A.buildPromptSection(s);
  t('含「记账质量守则」段', seg.includes('记账质量守则'));
  t('①数字可追溯：含「待补明细」', seg.includes('数字可追溯') && seg.includes('待补明细'));
  t('②百分比落地：基数×比率=绝对值', seg.includes('百分比落地') && seg.includes('基数×比率=绝对值'));
  t('③无变动要有原因：Δ=0 归因', seg.includes('无变动要有原因') && seg.includes('Δ=0'));
  t('④删减禁令：不得静默消失', seg.includes('删减禁令') && seg.includes('拆除/战损/转移/封存/被占'));
  t('⑤闭环优先：期初+流入-流出=期末', seg.includes('闭环优先') && seg.includes('期初+流入-流出=期末'));
  t('⑥个人资金隔离：不算「获得新资产」', seg.includes('个人资金隔离') && seg.includes('不算「获得新资产」'));
}

section('⑬ P0-3：重大事件口径补全 + 个人资金排除');
{
  const env = makeEnv(makeSettings());
  const A = env.sandbox.WORLD_ENGINE_ASSETS;
  t('MAJOR_EVENT_HINTS 含 人事调度', A.MAJOR_EVENT_HINTS.includes('人事调度'));
  t('MAJOR_EVENT_HINTS 含 制度变更', A.MAJOR_EVENT_HINTS.includes('制度变更'));
  t('MAJOR_EVENT_HINTS 含 灾害', A.MAJOR_EVENT_HINTS.includes('灾害'));
  const s = defaultState(env.sandbox);
  const seg = A.buildPromptSection(s);
  t('gateLines 含个人资金排除条款', seg.includes('个人资金/随身物品变动不计入重大结算事件'));
}

section('⑭ P1-2：记账 COT 轻量版（assetCOT 默认开）');
{
  const env = makeEnv(makeSettings());
  const s = defaultState(env.sandbox);
  const A = env.sandbox.WORLD_ENGINE_ASSETS;
  const seg = A.buildPromptSection(s);
  t('默认开启：含「记账思考流程」段', seg.includes('记账思考流程'));
  t('要求 <thinking> 包裹', seg.includes('<thinking>'));
  t('①门禁裁定', seg.includes('门禁裁定'));
  t('②收支预验证（COT Step5）', seg.includes('Step5 收支计算预验证'));
  t('③自检（删减/百分比/隔离三查）', seg.includes('自检'));

  const env2 = makeEnv(makeSettings({ assetCOT: false }));
  const s2 = defaultState(env2.sandbox);
  const seg2 = env2.sandbox.WORLD_ENGINE_ASSETS.buildPromptSection(s2);
  t('assetCOT=false：不附加思考段', !seg2.includes('记账思考流程') && !seg2.includes('<thinking>'));
}

section('⑮ P0-1：mergeUpdate 解析 settledAt 写入 storyDay');
{
  const env = makeEnv(makeSettings());
  const s = defaultState(env.sandbox);
  const A = env.sandbox.WORLD_ENGINE_ASSETS;
  const core = env.sandbox.WORLD_ENGINE_CORE;

  // mock parseStoryDay 返回 42 → 写入 ledgerTime.storyDay
  core.parseStoryDay = () => 42;
  s.round = 1;
  A.mergeUpdate(s, { assets: {
    settledAt: '澳宋-1638年-09月-02日',
    overview: { assets: '一处产业', funds: '100两' },
    entries: [{ category: '资金', name: '现金储备', amount: '100两' }]
  }});
  t('settledAt 解析成功：storyDay 写入 42', s.assets.ledgerTime.storyDay === 42);
  t('解析成功：结算照常推进', s.assets.lastSettledRound === 1);

  // mock 解析不到（返回 null）→ storyDay 维持 0
  core.parseStoryDay = () => null;
  s.round = 2;
  A.mergeUpdate(s, { assets: { settledAt: '无法解析的结算时间' } });
  t('解析不到：storyDay 维持 0', s.assets.ledgerTime.storyDay === 0);
  t('解析不到：settledAt 文本照常更新', s.assets.ledgerTime.settledAt.includes('无法解析的结算时间'));

  // 真实 parseStoryDay（无 evolveTimeRe 设置）→ 返回 null，storyDay 保持 0（自动回退轮数门禁）
  delete core.parseStoryDay;
  s.round = 3;
  A.mergeUpdate(s, { assets: { settledAt: '澳宋-1638年-09月-03日' } });
  t('真实 parseStoryDay 无时间设置：storyDay 保持 0', s.assets.ledgerTime.storyDay === 0);
}

section('⑯ 结构化账本字段解析（M4 缺口补测）');
{
  const env = makeEnv(makeSettings());
  const A = env.sandbox.WORLD_ENGINE_ASSETS;
  const core = env.sandbox.WORLD_ENGINE_CORE;
  const s = defaultState(env.sandbox);
  s.round = 1;

  // 1) 正常解析：7 字段全部落盘
  const upd = { assets: {
    settledAt: '澳宋-1638年-09月-03日',
    overview: { assets: 'x', distribution: 'y', production: 'z', funds: 'w' },
    entries: [{ name: '博铺造船厂', category: '产业', amount: '1000两', change: '+100两' }],
    externalFactors: [{ name: '海贸波动', desc: '南洋航线涨价' }],
    internalFactors: [{ name: '扩建船坞', desc: '新增三号船坞' }],
    liquidAssets: [{ currency: '白银', opening: '100', inflow: '50', outflow: '30', exchange: '0', closing: '120', pass: 'Pass' }],
    assetDistribution: [{ entity: '博铺造船厂', buildings: ['一号船坞', '铁匠铺'], status: '运转' }],
    productionStats: [{ entity: '博铺造船厂', building: '一号船坞', status: '运转', input: '木材', output: '新船', quality: '良', bottleneck: '缺铁' }],
    operations: [{ entity: '博铺造船厂', income: '300', expense: '120', net: '+180', reason: '造船款' }],
    closures: [{ subject: '流动资金', opening: '100', inflow: '50', outflow: '30', natural: '0', closing: '120', pass: 'TRUE' }]
  }};
  A.mergeUpdate(s, upd);
  t('外部因子落盘', s.assets.externalFactors.length === 1 && s.assets.externalFactors[0].name === '海贸波动');
  t('内部因子落盘', s.assets.internalFactors.length === 1);
  t('流动资产落盘 + Pass 归一化', s.assets.liquidAssets.length === 1 && s.assets.liquidAssets[0].pass === true);
  t('资产分布落盘（buildings 数组）', s.assets.assetDistribution.length === 1 && Array.isArray(s.assets.assetDistribution[0].buildings));
  t('生产效率落盘', s.assets.productionStats.length === 1 && s.assets.productionStats[0].bottleneck === '缺铁');
  t('运营监控落盘', s.assets.operations.length === 1);
  t('闭环等式落盘 + TRUE 归一化', s.assets.closures.length === 1 && s.assets.closures[0].pass === true);

  // 2) 门禁轮（仅 settledAt，无 overview/entries）：结构化字段不得被幻觉覆盖
  s.round = 2;
  A.mergeUpdate(s, { assets: { settledAt: '澳宋-1638年-09月-04日', externalFactors: [{ name: '幻觉因子', desc: '不应落盘' }] } });
  t('门禁轮：结构化字段不被覆盖', s.assets.externalFactors.length === 1 && s.assets.externalFactors[0].name === '海贸波动');

  // 3) 空数组不覆盖非空旧数据（S1）
  s.round = 3;
  A.mergeUpdate(s, { assets: { settledAt: '澳宋-1638年-09月-05日', overview: { assets: 'x2', distribution: 'y2', production: 'z2', funds: 'w2' }, entries: [{ name: '博铺造船厂', category: '产业', amount: '1100两', change: '+100两' }], externalFactors: [], closures: [] } });
  t('空数组：外部因子保持上次', s.assets.externalFactors.length === 1);
  t('空数组：闭环保持上次', s.assets.closures.length === 1);

  // 4) pass 各种写法归一化
  s.round = 4;
  A.mergeUpdate(s, { assets: { settledAt: '澳宋-1638年-09月-06日', overview: { assets: 'x3', distribution: 'y3', production: 'z3', funds: 'w3' }, entries: [{ name: '博铺造船厂', category: '产业', amount: '1200两', change: '+100两' }], closures: [{ subject: '粮仓', opening: '1', inflow: '1', outflow: '1', natural: '1', closing: '2', pass: '是' }, { subject: '铁矿', opening: '1', inflow: '1', outflow: '1', natural: '1', closing: '2', pass: 1 }] } });
  t('pass=是 → true', s.assets.closures[0].pass === true);
  t('pass=1 → true', s.assets.closures[1].pass === true);

  // 5) 坏数据：null 元素/超长/非数组 → 不抛错、防御裁剪
  s.round = 5;
  A.mergeUpdate(s, { assets: { settledAt: '澳宋-1638年-09月-07日', overview: { assets: 'x4', distribution: 'y4', production: 'z4', funds: 'w4' }, entries: [{ name: '博铺造船厂', category: '产业', amount: '1300两', change: '+100两' }], productionStats: [null, { entity: '很长的名字'.repeat(20), building: 'b', status: 's', input: 'i', output: 'o', quality: 'q', bottleneck: 'bt' }, '字符串垃圾'] } });
  t('坏数据：null/字符串被过滤', s.assets.productionStats.length === 1);
  t('坏数据：超长 entity 被裁剪', s.assets.productionStats[0].entity.length <= 40);
}

console.log('\n==========');
console.log(`通过 ${passed} / ${passed + failed}`);
process.exit(failed ? 1 : 0);
