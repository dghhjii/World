// 回归测试：world-engine-offsight.js 的 S1/M2/M5 及轻微问题修复
// 覆盖：①id 存在性校验（复用旧 id 但名字不同→新 id，旧角色保留）
//       ②本轮活跃角色删除保护（lastSeenRound === state.round 才保护）
//       ③updates 去重 ④ID 幻觉重分配 ⑤slice(0,4) 取最近
//       ⑥null 防御 ⑦脏检查（无变更不 saveState）⑧社交圈 id 校验 ⑨getRenderData 已删除
// 用法：node test-offsight-regression.js
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

// ---------- mock 环境（与 test-assets-offsight.js 同构）----------
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
  const api = { getSettings: () => settings };
  sandbox.WORLD_ENGINE_API = api;
  sandbox.WORLD_ENGINE_STORE = store;
  return { sandbox, store, storage, api };
}

function defaultState(sandbox) {
  return sandbox.WORLD_ENGINE_CORE.getDefaultState();
}

/** 包装 store.setItem 统计落盘次数 */
function countSaves(env) {
  const orig = env.store.setItem.bind(env.store);
  let n = 0;
  env.store.setItem = (k, v) => { n++; return orig(k, v); };
  return () => n;
}

// ============================================================
section('① id 存在性校验：复用旧 id 但名字不同 → 新 id，旧角色保留');
{
  const env = makeEnv(makeSettings({ offscreenEnabled: true }));
  const s = defaultState(env.sandbox);
  s.round = 3;
  const O = env.sandbox.WORLD_ENGINE_OFFSIGHT;

  O.mergeUpdate(s, {
    offscreen: { characters: [
      { id: null, name: '吴明达', lastSeenRound: 3 },
      { id: null, name: '萧子山', lastSeenRound: 2 }
    ]}
  });
  t('基线：新角色分配 offscreen_1/offscreen_2',
    s.offscreen.characters[0].id === 'offscreen_1' && s.offscreen.characters[1].id === 'offscreen_2');

  // 李四错误复用 offscreen_1（原属吴明达）；萧子山正常沿用 offscreen_2
  O.mergeUpdate(s, {
    offscreen: { characters: [
      { id: 'offscreen_1', name: '李四', lastSeenRound: 3 },
      { id: 'offscreen_2', name: '萧子山', lastSeenRound: 2 }
    ]}
  });
  const byId = id => s.offscreen.characters.find(c => c.id === id);
  t('旧角色 offscreen_1（吴明达）未被顶替、保留',
    !!byId('offscreen_1') && byId('offscreen_1').name === '吴明达');
  t('萧子山沿用原 id offscreen_2', !!byId('offscreen_2') && byId('offscreen_2').name === '萧子山');
  t('李四拿到新 id（不是 offscreen_1）',
    s.offscreen.characters.some(c => c.name === '李四' && c.id !== 'offscreen_1'));
  t('全量 3 个角色都在', s.offscreen.characters.length === 3);
}

section('①b id 冲突保留独立于删除保护（lastSeenRound 不等于本轮也保留）');
{
  const env = makeEnv(makeSettings({ offscreenEnabled: true }));
  const s = defaultState(env.sandbox);
  s.round = 5;
  const O = env.sandbox.WORLD_ENGINE_OFFSIGHT;
  // 旧角色 lastSeenRound=3（既非本轮 5，也非上轮 4），无删除保护，仅靠 id 冲突保留
  s.offscreen.characters = [
    { id: 'offscreen_1', name: '吴明达', lastSeenRound: 3, activity: '旧动向' }
  ];
  O.mergeUpdate(s, {
    offscreen: { characters: [
      { id: 'offscreen_1', name: '李四', lastSeenRound: 5 }
    ]}
  });
  t('吴明达（id 被抢占但名字不符）仍保留',
    s.offscreen.characters.some(c => c.id === 'offscreen_1' && c.name === '吴明达'));
  t('李四拿新 id offscreen_2', s.offscreen.characters.some(c => c.name === '李四' && c.id === 'offscreen_2'));
}

section('② 删除保护：本轮活跃（lastSeenRound === state.round）漏返回则保留，上轮的不保');
{
  const env = makeEnv(makeSettings({ offscreenEnabled: true }));
  const s = defaultState(env.sandbox);
  s.round = 4;
  const O = env.sandbox.WORLD_ENGINE_OFFSIGHT;
  s.offscreen.characters = [
    { id: 'offscreen_1', name: '吴明达', lastSeenRound: 4, activity: '本轮活跃', location: '丙字巷' }, // 本轮刚出现
    { id: 'offscreen_2', name: '萧子山', lastSeenRound: 3, activity: '上轮活跃' }                     // 上轮（round-1）
  ];
  O.mergeUpdate(s, {
    offscreen: { characters: [
      { id: null, name: '程栋', lastSeenRound: 4 } // API 截断：漏返回吴明达、萧子山
    ]}
  });
  t('本轮活跃角色（lastSeenRound=4）被保留',
    s.offscreen.characters.some(c => c.id === 'offscreen_1' && c.name === '吴明达'));
  t('上轮角色（lastSeenRound=3）仍按全量替换移除',
    !s.offscreen.characters.some(c => c.name === '萧子山'));
  t('新角色正常并入', s.offscreen.characters.some(c => c.name === '程栋'));
}

section('②b 删除保护角色沿用原 id 与档案，不重新编号');
{
  const env = makeEnv(makeSettings({ offscreenEnabled: true }));
  const s = defaultState(env.sandbox);
  s.round = 2;
  const O = env.sandbox.WORLD_ENGINE_OFFSIGHT;
  s.offscreen.characters = [
    { id: 'offscreen_1', name: '吴明达', lastSeenRound: 2, activity: '组织灯会', location: '丙字巷', goal: '修缮', mood: '热络' }
  ];
  O.mergeUpdate(s, {
    offscreen: { characters: [] } // 全量空返回（极端截断）
  });
  t('保护角色保留原 id offscreen_1', s.offscreen.characters.length === 1 && s.offscreen.characters[0].id === 'offscreen_1');
  t('保护角色档案原样保留', s.offscreen.characters[0].activity === '组织灯会' && s.offscreen.characters[0].location === '丙字巷');
}

section('③ updates 去重：同轮同角色同动态不重复追加');
{
  const env = makeEnv(makeSettings({ offscreenEnabled: true }));
  const s = defaultState(env.sandbox);
  s.round = 1;
  const O = env.sandbox.WORLD_ENGINE_OFFSIGHT;
  const upd = { offscreen: { updates: [{ character: '吴明达', activity: '在丙字巷组织停电互助' }] } };
  O.mergeUpdate(s, upd);
  O.mergeUpdate(s, upd);
  O.mergeUpdate(s, upd);
  t('重复 update 只追加一条', s.offscreen.updates.length === 1);
  t('不同活动正常追加', (() => {
    O.mergeUpdate(s, { offscreen: { updates: [{ character: '吴明达', activity: '筹备巷内灯会' }] } });
    return s.offscreen.updates.length === 2;
  })());
  // 不同轮次同动态不算重复（round 字段不同）
  s.round = 2;
  O.mergeUpdate(s, upd);
  t('跨轮同动态允许追加', s.offscreen.updates.length === 3);
}

section('④ ID 幻觉重分配：旧状态不存在的 id 一律重分配');
{
  const env = makeEnv(makeSettings({ offscreenEnabled: true }));
  const s = defaultState(env.sandbox);
  s.round = 1;
  const O = env.sandbox.WORLD_ENGINE_OFFSIGHT;
  s.offscreen.characters = [
    { id: 'offscreen_1', name: '吴明达', lastSeenRound: 1 }
  ];
  O.mergeUpdate(s, {
    offscreen: { characters: [
      { id: 'offscreen_9', name: '张三', lastSeenRound: 1 } // LLM 幻觉 id
    ]}
  });
  const zhang = s.offscreen.characters.find(c => c.name === '张三');
  t('幻觉 id offscreen_9 被重分配', !!zhang && zhang.id !== 'offscreen_9');
  t('新 id 编号连续且不冲突（offscreen_2）', !!zhang && zhang.id === 'offscreen_2');
}

section('⑤ slice(0,4)：最近后台动态取最新 4 条（newest-first）');
{
  const env = makeEnv(makeSettings({ offscreenEnabled: true }));
  const s = defaultState(env.sandbox);
  s.round = 1;
  const O = env.sandbox.WORLD_ENGINE_OFFSIGHT;
  // 分两批 unshift：updates[0] 为最新
  O.mergeUpdate(s, { offscreen: { updates: [
    { character: '丁', activity: '动态D' },
    { character: '丙', activity: '动态C' }
  ]}});
  O.mergeUpdate(s, { offscreen: { updates: [
    { character: '乙', activity: '动态B' },
    { character: '甲', activity: '动态A' }
  ]}});
  // 期望顺序（newest-first）：动态A、动态B、动态C、动态D
  t('updates 顺序为 newest-first', s.offscreen.updates[0].activity === '动态A' && s.offscreen.updates[3].activity === '动态D');
  const seg = O.buildPromptSection(s);
  t('prompt 段含最近 4 条（A/B/C/D）',
    seg.includes('动态A') && seg.includes('动态B') && seg.includes('动态C') && seg.includes('动态D'));
  // 追加更多旧条目后，仅取最新 4 条
  O.mergeUpdate(s, { offscreen: { updates: [
    { character: '戊', activity: '动态E' },
    { character: '己', activity: '动态F' }
  ]}});
  const seg2 = O.buildPromptSection(s);
  t('slice(0,4) 取最新 4 条（F/E/B/A）',
    seg2.includes('动态F') && seg2.includes('动态E') && seg2.includes('动态B') && seg2.includes('动态A'));
  t('最旧条目（C/D）不再出现在 prompt 段', !seg2.includes('动态C') && !seg2.includes('动态D'));
}

section('⑥ null 防御：脏元素不抛错');
{
  const env = makeEnv(makeSettings({ offscreenEnabled: true }));
  const s = defaultState(env.sandbox);
  s.round = 1;
  const O = env.sandbox.WORLD_ENGINE_OFFSIGHT;
  s.offscreen.characters = [null, '字符串', { id: null, name: '吴明达', lastSeenRound: 1 }];
  s.offscreen.updates = [null, { round: 1, character: '吴明达', activity: '组织互助' }, 42];
  s.socialCircles = [null, { id: null, name: '丙字巷邻里圈', type: '地缘' }];
  let seg = '';
  t('buildPromptSection 遇 null/非对象不炸', (() => { try { seg = O.buildPromptSection(s); return true; } catch (e) { return false; } })());
  t('prompt 段仍含有效角色', seg.includes('吴明达') && seg.includes('丙字巷邻里圈'));
  t('mergeUpdate 遇 null 元素不炸', (() => {
    try {
      O.mergeUpdate(s, { offscreen: { characters: [null, 3, { id: null, name: '程栋' }], updates: [null, { character: '程栋', activity: 'x' }] }, socialCircles: [null, { id: null, name: '元老院政务圈' }] });
      return true;
    } catch (e) { return false; }
  })());
  t('mergeUpdate 入参为 null/非对象不炸',
    (() => { try { O.mergeUpdate(s, null); O.mergeUpdate(null, {}); O.mergeUpdate(s, 'x'); return true; } catch (e) { return false; } })());
}

section('⑦ 脏检查：无变更不 saveState，有变更才落盘');
{
  const env = makeEnv(makeSettings({ offscreenEnabled: true }));
  const s = defaultState(env.sandbox);
  s.round = 1;
  const O = env.sandbox.WORLD_ENGINE_OFFSIGHT;
  const saves = countSaves(env);
  O.mergeUpdate(s, {});
  O.mergeUpdate(s, { offscreen: null });
  t('空 update 不触发 saveState', saves() === 0);
  O.mergeUpdate(s, { offscreen: { characters: [{ id: null, name: '吴明达' }] } });
  t('characters 变更触发 saveState', saves() === 1);
  O.mergeUpdate(s, { offscreen: { updates: [{ character: '吴明达', activity: '组织互助' }] } });
  t('updates 新增触发 saveState', saves() === 2);
  O.mergeUpdate(s, { socialCircles: [] });
  t('socialCircles 清空（空数组全量替换）触发 saveState', saves() === 3);
  O.mergeUpdate(s, { offscreen: { updates: [{ character: '吴明达', activity: '组织互助' }] } });
  t('重复 update（去重后无变更）不触发 saveState', saves() === 3);
}

section('⑧ 社交圈 id 校验：id+名字一致才沿用，幻觉 id 重分配');
{
  const env = makeEnv(makeSettings({ offscreenEnabled: true }));
  const s = defaultState(env.sandbox);
  s.round = 1;
  const O = env.sandbox.WORLD_ENGINE_OFFSIGHT;
  s.socialCircles = [{ id: 'circle_1', name: '丙字巷邻里圈', type: '地缘' }];
  O.mergeUpdate(s, { socialCircles: [
    { id: 'circle_1', name: '丙字巷邻里圈', type: '地缘' },  // 正常沿用
    { id: 'circle_1', name: '元老院政务圈', type: '业缘' },  // 复用 id 但名字不同 → 新对象
    { id: 'circle_99', name: '商帮圈', type: '志缘' }        // 幻觉 id → 重分配
  ]});
  const byId = id => s.socialCircles.find(c => c.id === id);
  t('同名同 id 沿用 circle_1', !!byId('circle_1') && byId('circle_1').name === '丙字巷邻里圈');
  t('政务圈拿新 id（非 circle_1/非 circle_99）',
    s.socialCircles.some(c => c.name === '元老院政务圈' && c.id !== 'circle_1' && c.id !== 'circle_99'));
  t('商帮圈幻觉 id 重分配（按序为 circle_3，不与 circle_2 冲突）', s.socialCircles.some(c => c.name === '商帮圈' && c.id === 'circle_3'));
}

section('⑨ getRenderData 死代码已删除');
{
  const env = makeEnv(makeSettings({ offscreenEnabled: true }));
  const O = env.sandbox.WORLD_ENGINE_OFFSIGHT;
  t('导出中无 getRenderData', O.getRenderData === undefined);
}

section('⑩ L1 修复：cap 压力下保护角色优先保留（不被新角色挤掉）');
{
  // 场景 A：cap=2，3 个新角色 + 2 个本轮活跃旧角色（删除保护）
  const env = makeEnv(makeSettings({ offscreenEnabled: true, offscreenCharacterCap: 2 }));
  const s = defaultState(env.sandbox);
  s.round = 5;
  const O = env.sandbox.WORLD_ENGINE_OFFSIGHT;
  s.offscreen.characters = [
    { id: 'offscreen_1', name: '吴明达', lastSeenRound: 5, activity: '本轮活跃甲' },
    { id: 'offscreen_2', name: '萧子山', lastSeenRound: 5, activity: '本轮活跃乙' }
  ];
  O.mergeUpdate(s, {
    offscreen: { characters: [
      { id: null, name: '程栋', lastSeenRound: 5 },
      { id: null, name: '张三', lastSeenRound: 5 },
      { id: null, name: '李四', lastSeenRound: 5 }
    ]}
  });
  t('cap=2 时结果长度恰为 2', s.offscreen.characters.length === 2);
  t('两个本轮活跃保护角色都在结果中（优先保留）',
    s.offscreen.characters.some(c => c.id === 'offscreen_1' && c.name === '吴明达')
    && s.offscreen.characters.some(c => c.id === 'offscreen_2' && c.name === '萧子山'));
  t('保护角色沿用原 id 与档案（未被重编号）',
    s.offscreen.characters[0].id === 'offscreen_1' && s.offscreen.characters[0].activity === '本轮活跃甲');
  t('新角色被 cap 裁剪（三个新角色都不在结果中）',
    !s.offscreen.characters.some(c => ['程栋', '张三', '李四'].includes(c.name)));

  // 场景 B：cap=2，id 冲突保护角色（非本轮活跃，仅名字不符被保留）同样优先
  const env2 = makeEnv(makeSettings({ offscreenEnabled: true, offscreenCharacterCap: 2 }));
  const s2 = defaultState(env2.sandbox);
  s2.round = 5;
  const O2 = env2.sandbox.WORLD_ENGINE_OFFSIGHT;
  s2.offscreen.characters = [
    { id: 'offscreen_1', name: '吴明达', lastSeenRound: 3, activity: '旧动向' } // 非本轮，仅 id 冲突保护
  ];
  O2.mergeUpdate(s2, {
    offscreen: { characters: [
      { id: 'offscreen_1', name: '李四', lastSeenRound: 5 }, // 抢占 offscreen_1 但名字不符
      { id: null, name: '张三', lastSeenRound: 5 },
      { id: null, name: '王五', lastSeenRound: 5 }
    ]}
  });
  t('id 冲突保护角色同样优先于新角色（cap=2 仍保留）',
    s2.offscreen.characters.length === 2
    && s2.offscreen.characters.some(c => c.id === 'offscreen_1' && c.name === '吴明达'));
}

section('⑪ L2 修复：超长名字（>40 字符）旧存档认领成功、不产生重复条目');
{
  const env = makeEnv(makeSettings({ offscreenEnabled: true }));
  const s = defaultState(env.sandbox);
  s.round = 1;
  const O = env.sandbox.WORLD_ENGINE_OFFSIGHT;
  const longName = '超长角色名'.repeat(9); // 45 字符 > 40
  // 旧存档为未截断全名（模拟一次性迁移前的历史数据）
  s.offscreen.characters = [
    { id: 'offscreen_1', name: longName, lastSeenRound: 1, activity: '旧动向' },
    { id: 'offscreen_2', name: '乙'.repeat(45), lastSeenRound: 1 }
  ];
  // API 返回同 id 同超长名（id 认领路径）+ 同名 id:null（名字兜底路径）
  O.mergeUpdate(s, {
    offscreen: { characters: [
      { id: 'offscreen_1', name: longName, lastSeenRound: 1 },
      { id: null, name: '乙'.repeat(45), lastSeenRound: 1 }
    ]}
  });
  t('id 认领路径：超长名沿用旧 id offscreen_1（不产生新 id/重复条目）',
    s.offscreen.characters.filter(c => c.name === longName.slice(0, 40)).length === 1
    && s.offscreen.characters.some(c => c.name === longName.slice(0, 40) && c.id === 'offscreen_1'));
  t('名字兜底路径：超长名同样认领成功（沿用 offscreen_2）',
    s.offscreen.characters.some(c => c.name === '乙'.repeat(40) && c.id === 'offscreen_2'));
  t('超长名在档案中按规则截断为 40 字符',
    s.offscreen.characters.every(c => c.name.length === 40));
  t('无重复条目（两个超长角色各只出现一次）',
    s.offscreen.characters.length === 2);

  // 社交圈同样双侧截断认领
  const env2 = makeEnv(makeSettings({ offscreenEnabled: true }));
  const s2 = defaultState(env2.sandbox);
  s2.round = 1;
  const O2 = env2.sandbox.WORLD_ENGINE_OFFSIGHT;
  const longCircle = '超长圈名'.repeat(11); // 44 字符 > 40
  s2.socialCircles = [{ id: 'circle_1', name: longCircle, type: '地缘' }];
  O2.mergeUpdate(s2, { socialCircles: [{ id: 'circle_1', name: longCircle, type: '地缘' }] });
  t('社交圈超长名沿用 circle_1、不重复',
    s2.socialCircles.length === 1
    && s2.socialCircles[0].id === 'circle_1'
    && s2.socialCircles[0].name === longCircle.slice(0, 40));
}

console.log('\n==========');
console.log(`通过 ${passed} / ${passed + failed}`);
process.exit(failed ? 1 : 0);
