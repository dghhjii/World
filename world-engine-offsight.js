// world-engine-offsight.js — 角色幕后推演（不在场角色 + 社交圈）
// 思路源自主人的「世界后台状态.自动化系统」与「社交圈」体系：
// 不在{{user}}视线内的角色也按自己的日程生活、社交、行动；推演时维护
// 「幕后角色档案 + 后台动态日志 + 社交圈」三块状态，供正文注入与面板展示。
window.WORLD_ENGINE_OFFSIGHT = (function() {
  const core = window.WORLD_ENGINE_CORE;

  function settings() {
    return window.WORLD_ENGINE_API && window.WORLD_ENGINE_API.getSettings
      ? window.WORLD_ENGINE_API.getSettings()
      : {};
  }

  function intSetting(key, fallback, min) {
    const n = Number(settings()[key]);
    let v = Number.isFinite(n) ? n : fallback;
    if (min !== undefined) v = Math.max(min, v);
    return Math.round(v);
  }

  function isEnabled() {
    return settings().offscreenEnabled === true;
  }

  /** 圈层类型（与主人的社交圈一致：地缘/业缘/血缘 + 补充类型） */
  const CIRCLE_TYPES = ['地缘', '业缘', '血缘', '志缘', '利缘'];

  /** 过滤数组中的 null / 非对象元素（防御脏数据） */
  function objects(arr) {
    return (arr || []).filter(x => x && typeof x === 'object');
  }

  /**
   * 构建喂给推演 API 的幕后推演段落。
   * 要求 API 每轮推演不在场角色的生活动态（不替{{user}}做决定、不越感知边界），
   * 并维护社交圈结构。
   */
  function buildPromptSection(state) {
    if (!isEnabled()) return '';
    const charCap = intSetting('offscreenCharacterCap', 8, 1);
    const circleCap = intSetting('socialCircleCap', 6, 1);

    const offscreen = state.offscreen || {};
    const chars = objects(offscreen.characters);
    const updates = objects(offscreen.updates);
    const circles = objects(state.socialCircles);

    const charsText = chars.length
      ? chars.map(c => `- ${c.name}（最近出现第${c.lastSeenRound || 0}轮，位置：${c.location || '未知'}；当前动向：${c.activity || '日常'}；目标：${c.goal || '不明'}；状态：${c.mood || '平稳'}）`).join('\n')
      : '（暂无幕后角色档案）';
    // updates 为 newest-first（unshift 头部插入），取前 4 条即最近 4 条
    const updatesText = updates.slice(0, 4).map(u => `- 第${u.round}轮 ${u.character}：${u.activity}`).join('\n')
      || '（暂无动态记录）';
    const circlesText = circles.length
      ? circles.map(c => `- ${c.name}（${c.type || '地缘'}圈，成员：${(c.members || []).join('、') || '不明'}；互动：${c.interactions || '日常'}；信息范围：${c.infoScope || '圈内事务'}；当前动态：${c.currentActivity || '无'}）`).join('\n')
      : '（暂无社交圈）';

    return `
========== 角色幕后推演（不在场角色）==========
世界是活的。不在{{user}}视线内的人也在过自己的生活。

【核心约束】
- 只推演本轮确实可能发生、且与{{user}}无直接因果的后台动态；不得为了让{{user}}卷入而硬造事件。
- 严格遵守感知边界：幕后角色的私密行动、未公开信息不得进入风声/声誉/事件链；只有经过合法传播路径才能影响正文。
- 不得替{{user}}做决定，不得虚构目击、传播或情报来源。
- 角色档案上限 ${charCap} 个、社交圈上限 ${circleCap} 个；只保留对世界有实质影响的角色与圈子。

【当前幕后角色档案】
${charsText}

【最近后台动态日志】
${updatesText}

【当前社交圈】
${circlesText}

【本轮输出格式】
返回 offscreen 字段：
{
  "offscreen": {
    "characters": [  // 全量角色档案（继承上轮所有角色，只更新有变化的字段）
      { "id": null, "name": "角色名", "lastSeenRound": 轮次, "location": "位置", "activity": "本轮动向", "goal": "当前目标", "mood": "状态" }
    ],
    "updates": [  // 本轮新增后台动态（1-3条）
      { "character": "角色名", "activity": "该角色本轮做了什么" }
    ]
  },
  "socialCircles": [  // 全量社交圈（继承已有圈，只更新有变化的字段；新圈用 id:null 语义新增）
    { "id": null, "name": "圈子名", "type": "${CIRCLE_TYPES.join('/')}", "members": ["成员"], "interactions": "互动频率与方式", "infoScope": "圈内信息范围", "currentActivity": "当前动态", "description": "一句话描述" }
  ]
}
- characters 必须全量返回：已有角色沿用 id，新角色 id 填 null（由本地分配）；已从世界消失的角色直接不返回（本地自动移除）。
- socialCircles 必须全量返回：已有圈沿用 id，新圈 id 填 null；信息可在成员变化时更新，但不得为凑数重复创建。
`;
  }

  /**
   * 合并 API 返回的 offscreen 与 socialCircles 字段。
   * 认领规则（防 LLM 顶替/幻觉）：
   * - id 命中旧状态且名字一致 → 沿用旧 id；
   * - id 为 null → 按名字兜底认领（保持继承语义）；
   * - 其他情况（id 不存在于旧状态 / id 命中但名字不同）→ 一律按新对象分配新 id，
   *   被抢占的旧角色保留、新对象拿新 id。
   */
  function mergeUpdate(state, update) {
    if (!isEnabled()) return;
    if (!state || typeof state !== 'object' || !state.offscreen || typeof state.offscreen !== 'object') return;
    if (!update || typeof update !== 'object') return;
    const offscreen = state.offscreen;
    const oldChars = Array.isArray(offscreen.characters) ? offscreen.characters : [];
    const oldCircles = Array.isArray(state.socialCircles) ? state.socialCircles : [];
    let dirty = false;

    // —— 幕后角色档案：全量替换 + 存在性认领 + 删除保护 + 上限裁剪 ——
    if (Array.isArray(update.offscreen?.characters)) {
      let chars = [];
      for (const c of update.offscreen.characters) {
        if (!c || typeof c !== 'object' || !c.name) continue;
        const name = String(c.name).slice(0, 40);
        // id 认领：id 存在时要求「id 命中旧状态且名字一致」；id 为空时按名字兜底。
        // 名字双侧截断比对：旧存档可能是未截断的全名（>40 字符），单侧截断会认领失败 → 新 id + 重复条目。
        const claimed = c.id
          ? (oldChars.find(oc => oc && oc.id === c.id && String(oc.name).slice(0, 40) === name) || null)
          : (oldChars.find(oc => oc && String(oc.name).slice(0, 40) === name) || null);
        chars.push({
          id: claimed ? claimed.id : null,
          name,
          lastSeenRound: c.lastSeenRound === undefined ? (state.round || 0) : Math.max(0, parseInt(c.lastSeenRound) || 0),
          location: String(c.location || '').slice(0, 60),
          activity: String(c.activity || '').slice(0, 120),
          goal: String(c.goal || '').slice(0, 120),
          mood: String(c.mood || '平稳').slice(0, 40)
        });
      }
      // 旧角色保留：
      // ① id 冲突保护 —— 本轮返回对象带旧 id 但未认领成功（名字不符）→ 旧角色被抢占，保留；
      // ② 删除保护 —— 本轮刚活跃（lastSeenRound === state.round）但 API 漏返回 → 保留（防单轮截断误删）。
      const roundNow = state.round || 0;
      const preservedIds = new Set();
      for (const c of update.offscreen.characters) {
        if (!c || typeof c !== 'object' || !c.name) continue;
        const m = String(c.id || '').match(/^offscreen_(\d+)$/);
        if (m && oldChars.some(oc => oc && oc.id === c.id) && !chars.some(nc => nc.id === c.id)) {
          preservedIds.add(c.id);
        }
      }
      for (const oc of oldChars) {
        if (oc && typeof oc === 'object' && oc.id && oc.lastSeenRound === roundNow) {
          preservedIds.add(oc.id);
        }
      }
      // 保护角色优先保留：先收集保留的旧角色（含原 id 与旧档案）放数组头部，
      // 再拼接本轮新角色，最后统一 slice(0, charCap)——避免 cap 压力下
      // 本轮活跃/被抢占的旧角色被新角色挤掉（保护角色被裁的优先级倒置）。
      const preservedChars = [];
      for (const oc of oldChars) {
        if (oc && typeof oc === 'object' && oc.id && preservedIds.has(oc.id) && !chars.some(nc => nc.id === oc.id)) {
          preservedChars.push(oc); // 沿用原档案（含原 id 与旧 activity）
        }
      }
      chars = preservedChars.concat(chars);
      // 分配新 id（含旧状态全部 id，防 ID 幻觉/冲突；沿用 core 的实体 id 风格）。
      // 保护角色已带 id，seen 集合先收录它们，新角色编号自动避让。
      let max = 0;
      for (const oc of oldChars) {
        const m = String((oc && oc.id) || '').match(/^offscreen_(\d+)$/);
        if (m) max = Math.max(max, Number(m[1]));
      }
      const seen = new Set();
      for (const c of chars) {
        const n = String(c.id || '').match(/^offscreen_(\d+)$/);
        if (n && !seen.has(c.id)) { seen.add(c.id); continue; }
        do { max++; } while (seen.has('offscreen_' + max));
        c.id = 'offscreen_' + max;
        seen.add(c.id);
      }
      const charCap = intSetting('offscreenCharacterCap', 8, 1);
      offscreen.characters = chars.slice(0, charCap);
      dirty = true;
    }

    // —— 后台动态日志：追加本轮更新（同轮同角色同动态去重）——
    if (Array.isArray(update.offscreen?.updates)) {
      for (const u of update.offscreen.updates) {
        if (!u || typeof u !== 'object' || !u.character || !u.activity) continue;
        const character = String(u.character).slice(0, 40);
        const activity = String(u.activity).slice(0, 200);
        const dup = offscreen.updates.some(ex => ex && ex.round === state.round && ex.character === character && ex.activity === activity);
        if (dup) continue;
        offscreen.updates.unshift({ round: state.round, character, activity });
        dirty = true;
      }
      const updateCap = intSetting('offscreenUpdateCap', 16, 1);
      if (offscreen.updates.length > updateCap) offscreen.updates.length = updateCap;
    }

    // —— 社交圈：全量替换 + 存在性认领 + 上限裁剪（不做删除保护，但 id 校验必做）——
    if (Array.isArray(update.socialCircles)) {
      const circles = [];
      for (const c of update.socialCircles) {
        if (!c || typeof c !== 'object' || !c.name) continue;
        const name = String(c.name).slice(0, 40);
        // 与角色认领一致：名字双侧截断比对，防旧存档全名（>40 字符）认领失败
        const claimed = c.id
          ? (oldCircles.find(oc => oc && oc.id === c.id && String(oc.name).slice(0, 40) === name) || null)
          : (oldCircles.find(oc => oc && String(oc.name).slice(0, 40) === name) || null);
        circles.push({
          id: claimed ? claimed.id : null,
          name,
          type: CIRCLE_TYPES.includes(c.type) ? c.type : '地缘',
          members: Array.isArray(c.members) ? c.members.map(m => String(m).slice(0, 20)).slice(0, 12) : [],
          interactions: String(c.interactions || '').slice(0, 120),
          infoScope: String(c.infoScope || '').slice(0, 120),
          currentActivity: String(c.currentActivity || '').slice(0, 120),
          description: String(c.description || '').slice(0, 200)
        });
      }
      let max = 0;
      for (const oc of oldCircles) {
        const m = String((oc && oc.id) || '').match(/^circle_(\d+)$/);
        if (m) max = Math.max(max, Number(m[1]));
      }
      const seen = new Set();
      for (const c of circles) {
        const n = String(c.id || '').match(/^circle_(\d+)$/);
        if (n && !seen.has(c.id)) { seen.add(c.id); continue; }
        do { max++; } while (seen.has('circle_' + max));
        c.id = 'circle_' + max;
        seen.add(c.id);
      }
      const circleCap = intSetting('socialCircleCap', 6, 1);
      state.socialCircles = circles.slice(0, circleCap);
      dirty = true;
    }

    // 脏检查：仅本轮确实发生变更才落盘
    if (dirty) core.saveState(state);
    if (update.offscreen?.updates?.length) {
      console.log(`[世界引擎] 🎭 幕后推演更新：${update.offscreen.updates.map(u => (u && u.character ? u.character + '「' + (u.activity || '') + '」' : '')).join('、')}`);
    }
  }

  /** 构建注入正文用的幕后动态段（只注入最近动态，不泄露私密） */
  function buildContextSection(state) {
    if (!isEnabled()) return '';
    const offscreen = state.offscreen || {};
    const updates = objects(offscreen.updates).slice(0, 3);
    if (!updates.length) return '';
    return `\n【后台动态】\n${updates.map(u => `${u.character}：${u.activity}`).join('；')}`;
  }

  return {
    buildPromptSection,
    mergeUpdate,
    buildContextSection,
    CIRCLE_TYPES
  };
})();
