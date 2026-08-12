// world-engine-assets.js — 资产账本（记账员体系）
// 思路源自主人的「资产账本预设 v11.0」：对话推演时同步维护资产/产业/势力账目，
// 保留「重大结算门禁」与「重大结算事件」设计，但融入世界引擎「一次推演全量更新」架构，
// 不额外调用 API、不占用独立任务调度。
window.WORLD_ENGINE_ASSETS = (function() {
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
    return settings().assetLedgerEnabled === true;
  }

  /** 重大结算事件类型：命中这些情形时，本轮必须完整记账并同步产出风声/事件链
   *  P0-3：补 人事调度/制度变更/灾害（对齐 v5.7 口径） */
  const MAJOR_EVENT_HINTS = [
    '大额交易', '开张营业', '营业周期', '战损', '收购', '迁入迁出',
    '投资理财', '获得新资产', '破产', '融资', '大额支出', '产业升级',
    '人事调度', '制度变更', '灾害'
  ];

  /**
   * P0-1：取当前故事天数（故事时间门禁用）。
   * 优先 core.getLastStoryDay()（按时间推演模式已在维护的最新解析值）；
   * 取不到时回退到从近期对话（最近 6 条消息）parseStoryDay 解析。
   * 两种途径都解析不到返回 null，调用方自动回退轮数门禁。
   */
  function getStoryDayNow() {
    if (core && typeof core.getLastStoryDay === 'function') {
      const v = core.getLastStoryDay();
      if (v != null && Number.isFinite(Number(v))) return Number(v);
    }
    let text = '';
    try {
      const ctx = window.SillyTavern && typeof window.SillyTavern.getContext === 'function'
        ? window.SillyTavern.getContext() : null;
      const chat = ctx && Array.isArray(ctx.chat) ? ctx.chat : [];
      text = chat.slice(-6).map(m => (m && (m.content || m.mes)) || '').join('\n');
    } catch (e) { text = ''; }
    if (text && core && typeof core.parseStoryDay === 'function') {
      const v = core.parseStoryDay(text, settings());
      if (v != null && Number.isFinite(Number(v))) return Number(v);
    }
    return null;
  }

  /**
   * 构建喂给推演 API 的资产账本段落。
   * 门禁：距上次完整结算的轮次/故事时间不足 threshold 且无重大结算事件时，
   * API 只更新 ledgerTime（沿用上次账目），不重写 overview/entries。
   */
  function buildPromptSection(state) {
    if (!isEnabled()) return '';
    if (!state || typeof state !== 'object') return '';
    const threshold = intSetting('assetMajorThresholdHours', 24, 1);
    const cats = String(settings().assetCategories || '产业,资产,资金,势力')
      .split(/[,，]/).map(s => s.trim()).filter(Boolean);

    const assets = state.assets || {};
    const entries = assets.entries || [];
    const majorEvents = assets.majorEvents || [];
    const lastSettledRound = assets.lastSettledRound || 0;
    const roundsSince = Math.max(0, (state.round || 0) - lastSettledRound);
    const settledAt = (assets.ledgerTime && assets.ledgerTime.settledAt) || '尚未结算';

    // 遍历前过滤 null/非对象元素，防止坏存档（如 entries=[null]）直接属性访问抛 TypeError；
    // 有效条目（含 name）同时用于「从未结算」判定
    const validEntries = entries.filter(e => e && typeof e === 'object' && e.name);
    // 展示上限：entries 为 oldest-first（旧条目在前、新条目在尾部），slice(-15) 取最近 15 条，
    // 防 note 放宽后 40 条全量展示把 prompt 撑爆（API 截断反而显示不全）
    const shownEntries = validEntries.slice(-15);
    const entriesText = validEntries.length
      ? `（共 ${validEntries.length} 条，展示最近 ${shownEntries.length} 条）\n`
        + shownEntries.map(e => `[${e.category || '其他'}] ${e.name} — ${e.amount ?? '未知'}（变化：${e.change || '持平'}${e.note ? '；' + e.note : ''}）`).join('\n')
      : '（暂无账目记录）';

    // B-S1：从未结算（无结算轮次且无任何账目条目）时，首轮没有可沿用的账目，
    // 门禁必须是「本轮完整记账」，而不是「只更新 ledgerTime」（否则首轮永远不记账）
    const neverSettled = !lastSettledRound && validEntries.length === 0;

    // P0-1：门禁双轨。assetGateMode='story'（故事时间模式）时，若能解析出
    // 当前故事天数且上次结算留有 storyDay，按「故事日」判定并提示；解析不到
    // （getLastStoryDay 为 null 且近期对话解析失败，或 storyDay 为 0）自动回退轮数门禁。
    // rounds 模式完全保持现状（roundsSince 判定、文案含「轮」）。
    const storyMode = settings().assetGateMode === 'story';
    let gapText = `距今 ${roundsSince} 轮`;
    let gateBody = '';
    if (storyMode && !neverSettled) {
      const now = getStoryDayNow();
      const settledDay = Number(assets.ledgerTime && assets.ledgerTime.storyDay) || 0;
      if (now != null && settledDay > 0) {
        const gapDays = Math.max(0, now - settledDay);
        gapText = `距今 ${gapDays} 个故事日`;
        gateBody = `- 若距上次结算不足 ${threshold} 个故事日，且本轮没有重大结算事件：只更新 ledgerTime（沿用上次账目数据，账目结算时间锁定为上次结算时间保持不变，仅追加门禁说明），不得重写 overview 与 entries。\n- 若已满 ${threshold} 个故事日，或本轮发生重大结算事件（${MAJOR_EVENT_HINTS.join('、')}等），必须完整记账：更新 overview 全部四项 + entries 全部条目。`;
      }
    }
    if (!gateBody) {
      // rounds 模式 / story 模式回退：轮数门禁（现状文案 + 结算时间锁定语义）
      gateBody = `- 若距上次完整结算不足 ${threshold} 轮，且本轮没有重大结算事件：只更新 ledgerTime（沿用上次账目数据，账目结算时间锁定为上次结算时间保持不变，仅追加门禁说明），不得重写 overview 与 entries。\n- 若已满 ${threshold} 轮，或本轮发生重大结算事件（${MAJOR_EVENT_HINTS.join('、')}等），必须完整记账：更新 overview 全部四项 + entries 全部条目。`;
    }
    const gateLines = neverSettled
      ? '- 首次建立账本：本轮必须完整记账，输出 overview 全部四项（assets/distribution/production/funds）与 entries 全部条目，并设置 settledAt。'
      : gateBody;

    // P0-2：记账质量守则（精简 6 条，反偷懒 + 闭环优先 + 个人资金隔离）
    const qualityRules = `
【记账质量守则】
- 数字可追溯：任何汇总数字必须在同实体明细中可溯源，不可溯源写「待补明细」。
- 百分比落地：任意百分比写成 基数×比率=绝对值。
- 无变动要有原因：允许 Δ=0，但至少 1 个关键模块写明本期不变原因。
- 删减禁令：上轮常设条目不得静默消失，消失必须写明 拆除/战损/转移/封存/被占 及后果。
- 闭环优先：资金/库存/核心物资 写 期初+流入-流出=期末，可为 0 但显式写 0。
- 个人资金隔离：{{user}} 个人随身收支不计入账本、不算「获得新资产」。`;

    // P1-2→V57：记账 COT 完整版（吸收 v5.7 七步思考框架，适配本引擎 state 结构）。
    // assetCOT 默认开，false 时省略。未触发结算时只需 Step1 门禁裁定后直接输出，
    // 触发完整记账时按 7 步推进（每步 1-2 行，总长可控；最终 JSON 必须完整独立可解析）。
    const cotSection = settings().assetCOT !== false ? `
【记账思考流程】（记账前必须按以下步数推进思考，不得减少或跳过；思考用 <thinking>...</thinking> 包裹，仅供人类查看）
Step1 门禁裁定：
- 账目初始化判定：若从未结算（无 ledgerTime/entries）→ 直接执行门禁规则2) 初始化更新；
- 否则计算距上次结算的经过（轮数或故事日，故事日以 [账目结算时间] 为准，严禁从其它数据源自行推导）；
- 时间线对齐：从上次 [账目结算时间] 对应的正文段落开始回顾（忽略之前已结算的事件，防重复计入），总结之后到剧情截止的事件；
- 检查是否发生重大结算事件（${MAJOR_EVENT_HINTS.join('、')}等；{{user}} 个人资金变动不计入）；
- 裁定：未满阈值且无重大事件 → 执行门禁规则1)（只更新 ledgerTime，[账目结算时间] 锁定不变，追加 [LedgerGap] 本轮未触发结算，沿用上次账目数据），直接输出，无需后续步骤；满阈值或有重大事件 → 执行门禁规则2) 进入 Step2。
Step2 账本规则与逻辑：列出本轮构建账目必须遵守的至少 5 条规则与需自检的 3 个潜在矛盾。
Step3 经济事件与传导：识别近期经济事件（饥荒/涨价/技术封锁/行业暴利等）对本地账目的传导渠道，思考在本期如何体现。
Step4 账本更新前置：从上次期末数据对齐本期期初（各实体资金/库存/币种余额），规划需要从近期对话与当前世界状态中检索的佐证点。
Step5 收支计算预验证：以基准货币推演每笔收入（数量×单价，单价与行情一致）与支出（人员×薪资、建筑×维护），库存-资金联动校验（销售：库存减少×售价=收入；采购：库存增加×采购价=支出），多币种按汇率折算，汇兑损益计入非经营项。
Step6 更新必填自检：逐项检查 时间推进/波动归因/建筑功效/投入约束/支出口径/品质损耗/成员变动/口径一致/收支完整/百分比落地/闭环等式（11 项，每项一行结论）。
Step7 输出确认：所有金额带单位币种、汇总=明细之和、百分比已转绝对值，输出 Ready。` : '';

    // majorEvents 为 unshift 头部插入（newest-first），slice(0,3) 取最近三条
    const majorText = majorEvents.length
      ? majorEvents.filter(m => m && typeof m === 'object').slice(0, 3).map(m => `第${m.round}轮 ${m.title}：${m.desc || ''}`).join('\n')
      : '（暂无重大结算事件）';

    return `
========== 资产账本（记账员）==========
你是{{user}}的专职记账员。在完成世界推演的同时，同步维护一份完整、可追溯的资产账目。
只记录{{user}}的资产、产业、势力与资金动态，不记录个人随身物品、技能与零用收支。

【账目类别】${cats.join(' / ')}
【上次结算时间】${settledAt}（第${lastSettledRound}轮，${gapText}）

【门禁规则】
${gateLines}
- {{user}} 个人资金/随身物品变动不计入重大结算事件。
- 更新账目时严禁简写省略历史信息；每一次更新必须完整继承上一版本的全部条目，数据演化清晰可溯。
- entries 中每条 { category, name, amount, change, note }：amount 为当前数值，change 为本轮变化（如「+500两」「-3%」「持平」），note 为变化原因（可选）。

【结构化账本字段】（完整记账时按需输出，均为可选数组；空数组/缺省=无变化）
- externalFactors: 外在波动因子 [{ name, desc }]——世界层面的价格/政策/灾荒/行情波动对本账目的影响
- internalFactors: 内生变化因子 [{ name, desc }]——本实体内部的结构变化（扩产/停工/人事/制度）
- liquidAssets: 流动资产闭环 [{ currency, opening, inflow, outflow, exchange, closing, pass }]——多币种分别列，期初+流入-流出+汇兑=期末，pass 标 true/false
- assetDistribution: 资产分布 [{ entity, buildings, status }]——实体×建筑树，出现过的建筑类型不得缺席（可停工）
- productionStats: 生产效率 [{ entity, building, status, input, output, quality, bottleneck }]——每类建筑至少给 运行状态/投入/产出/品质损耗/瓶颈 中的 3 项
- operations: 运营监控 [{ entity, income, expense, net, reason }]——每实体收入/支出明细（各至少 3 项，不足全列），净值可追溯，运转中无支出必须写原因
- closures: 闭环等式 [{ subject, opening, inflow, outflow, natural, closing, pass }]——资金与至少两类关键库存（粮食/矿产）分别列闭环，期初+流入-流出±自然增减=期末，标 Pass/Fail，Fail 写「待补明细」
${qualityRules}${cotSection}
【当前账目】
${entriesText}

【最近重大结算事件】
${majorText}
`;
  }

  /**
   * 增量合并账目条目：同名更新（category/amount/change/note/round），新 name 追加；绝不整组覆盖。
   * existing 中的坏元素（null/非对象/无 name）顺带清理。
   */
  function mergeEntries(existing, incoming, round) {
    const out = (Array.isArray(existing) ? existing : [])
      .filter(e => e && typeof e === 'object' && e.name);
    for (const e of incoming) {
      const name = String(e.name).slice(0, 60);
      const norm = {
        category: String(e.category || '其他').slice(0, 20),
        name: name,
        amount: e.amount === undefined ? '' : String(e.amount).slice(0, 60),
        change: String(e.change || '持平').slice(0, 40),
        note: String(e.note || '').slice(0, 200),
        round: round
      };
      const idx = out.findIndex(x => x.name === name);
      if (idx >= 0) out[idx] = norm;
      else out.push(norm);
    }
    return out;
  }

  /**
   * 合并 API 返回的 assets 字段。
   * update.assets = { settledAt, overview: {assets,distribution,production,funds}, entries, majorEvents }
   * 门禁逻辑在 prompt 侧约束；本地只做结构校验、增量合并与上限裁剪。
   * 防御要点（MOA 审查修复）：
   *  - S2：entries 按 name 增量合并（同名更新、新 name 追加），绝不整组覆盖；
   *  - S2a：overview 为空对象 {}（无任何非空字段）不视为完整结算；
   *  - S2b：entries 过滤后无有效条目且本地账目非空 → 视为截断/坏响应，不替换、不推进 lastSettledRound；
   *  - M5：state.assets 缺失/损坏时先补齐骨架，null/undefined 输入不抛错；
   *  - #7：完整结算但未给 settledAt 时，settledAt 追加「（第N轮）」标记保持时间轴可追溯；
   *  - 脏检查：本轮确有变更（entries/overview/majorEvents/settledAt/lastSettledRound）才 core.saveState。
   */
  function mergeUpdate(state, update) {
    if (!isEnabled() || !update || !update.assets || typeof update.assets !== 'object') return;
    if (!state || typeof state !== 'object') return;

    // M5：浅层防御——state.assets 缺失/损坏时先补齐骨架，避免中途抛错留下半合并状态
    const assets = (state.assets && typeof state.assets === 'object') ? state.assets : (state.assets = {});
    if (!assets.ledgerTime || typeof assets.ledgerTime !== 'object') assets.ledgerTime = {};
    if (!assets.overview || typeof assets.overview !== 'object') assets.overview = {};
    if (!Array.isArray(assets.entries)) assets.entries = [];
    if (!Array.isArray(assets.majorEvents)) assets.majorEvents = [];
    if (typeof assets.lastSettledRound !== 'number') assets.lastSettledRound = 0;

    const incoming = update.assets;
    const round = Number.isFinite(state.round) ? state.round : 0;
    let changed = false;

    // 上次结算时间：API 明确给 settledAt 才更新
    if (incoming.settledAt) {
      assets.ledgerTime.settledAt = String(incoming.settledAt).slice(0, 200);
      assets.ledgerTime.gap = String(incoming.gap || '').slice(0, 200);
      // P0-1：从结算时间文本解析故事天数写入 ledgerTime.storyDay（故事时间门禁用）。
      // 解析不到（返回 null/0）维持 0——buildPromptSection 自动回退轮数门禁。
      let storyDay = 0;
      if (core && typeof core.parseStoryDay === 'function') {
        const sd = core.parseStoryDay(String(incoming.settledAt), settings());
        const n = Number(sd);
        if (Number.isFinite(n) && n > 0) storyDay = Math.round(n);
      }
      if (assets.ledgerTime.storyDay !== storyDay) {
        assets.ledgerTime.storyDay = storyDay;
      }
      changed = true;
    }

    // 有效条目：剔除 null/非对象/无 name（S2b 截断保护的关键）
    const validEntries = Array.isArray(incoming.entries)
      ? incoming.entries.filter(e => e && typeof e === 'object' && e.name)
      : [];

    // overview 是否携带真实数据：空对象 {} 或全空字段不视为完整结算（S2a）
    const ov = (incoming.overview && typeof incoming.overview === 'object') ? incoming.overview : {};
    const overviewHasData = ['assets', 'distribution', 'production', 'funds']
      .some(k => ov[k] !== undefined && ov[k] !== null && String(ov[k]).trim() !== '');

    // 完整记账判定（S2/S2a）：overview 有真实数据 或 存在有效条目
    const fullySettled = overviewHasData || validEntries.length > 0;
    let settledThisRound = false;

    if (fullySettled) {
      // overview 逐字段更新（仅 API 显式给出的字段）
      if (ov.assets !== undefined) { assets.overview.assets = String(ov.assets).slice(0, 600); changed = true; }
      if (ov.distribution !== undefined) { assets.overview.distribution = String(ov.distribution).slice(0, 600); changed = true; }
      if (ov.production !== undefined) { assets.overview.production = String(ov.production).slice(0, 600); changed = true; }
      if (ov.funds !== undefined) { assets.overview.funds = String(ov.funds).slice(0, 600); changed = true; }

      if (validEntries.length > 0) {
        // S2：增量合并——同名更新字段，新 name 追加；绝不整组覆盖
        assets.entries = mergeEntries(assets.entries, validEntries, round);
        const cap = intSetting('assetEntryCap', 40, 1);
        // A-M1：entries 为 oldest-first（旧条目在前、新条目在尾部），
        // 裁剪必须保最新 cap 条；length=cap 截尾部会丢弃最新条目，导致账本冻结在最早 cap 条
        if (assets.entries.length > cap) assets.entries = assets.entries.slice(-cap);
        assets.lastSettledRound = round;
        changed = true;
        settledThisRound = true;
      } else if (overviewHasData && assets.entries.length === 0) {
        // 仅 overview 且本地账目为空：视为首次结算，推进结算轮（避免每轮都被要求完整结算）
        assets.lastSettledRound = round;
        changed = true;
        settledThisRound = true;
      }
      // 其余情形（有效条目为 0 且本地账目非空）：响应疑似截断/坏数据 → 不替换 entries、不推进 lastSettledRound（S2b）

      // #7：完整结算但 API 未给 settledAt 时，追加「（第N轮）」标记保持时间轴可追溯
      if (settledThisRound && !incoming.settledAt) {
        const mark = '（第' + round + '轮）';
        const cur = assets.ledgerTime.settledAt || '';
        if (!cur.includes(mark)) {
          assets.ledgerTime.settledAt = (cur ? cur + mark : mark).slice(0, 200);
          changed = true;
        }
      }
    }

    // 重大结算事件记录（不依赖 fullySettled，保持原行为）
    if (Array.isArray(incoming.majorEvents)) {
      let added = 0;
      for (const m of incoming.majorEvents) {
        if (!m || !m.title) continue;
        // A-M2：同 (round, title) 去重——redo/自动重roll（round 不变）或 LLM 回显时
        // 同一事件会重复 unshift，仅靠 cap=12 兜底不够；title 用 String 归一化比较
        const title = String(m.title).slice(0, 60);
        const dup = assets.majorEvents.some(x => x && x.round === round && String(x.title) === title);
        if (dup) continue;
        assets.majorEvents.unshift({
          round: round,
          title: title,
          desc: String(m.desc || '').slice(0, 200)
        });
        added++;
      }
      if (added) {
        const cap = intSetting('assetMajorEventCap', 12, 1);
        if (assets.majorEvents.length > cap) assets.majorEvents.length = cap;
        changed = true;
      }
    }

    // ===== v5.7 结构化账本字段解析（完整结算时随 API 返回；防御式：非数组忽略，逐项 slice）=====
    const structFields = {
      externalFactors:   { cap: 8,  map: x => ({ name: String(x.name || '').slice(0, 40), desc: String(x.desc || '').slice(0, 200) }) },
      internalFactors:   { cap: 8,  map: x => ({ name: String(x.name || '').slice(0, 40), desc: String(x.desc || '').slice(0, 200) }) },
      liquidAssets:      { cap: 8,  map: x => ({ currency: String(x.currency || '').slice(0, 20), opening: String(x.opening ?? '').slice(0, 40), inflow: String(x.inflow ?? '').slice(0, 40), outflow: String(x.outflow ?? '').slice(0, 40), exchange: String(x.exchange ?? '').slice(0, 40), closing: String(x.closing ?? '').slice(0, 40), pass: x.pass === true || x.pass === 'true' }) },
      assetDistribution: { cap: 12, map: x => ({ entity: String(x.entity || '').slice(0, 40), buildings: Array.isArray(x.buildings) ? x.buildings.map(b => String(b).slice(0, 20)).slice(0, 12) : [], status: String(x.status || '').slice(0, 40) }) },
      productionStats:   { cap: 20, map: x => ({ entity: String(x.entity || '').slice(0, 40), building: String(x.building || '').slice(0, 40), status: String(x.status || '').slice(0, 40), input: String(x.input ?? '').slice(0, 60), output: String(x.output ?? '').slice(0, 60), quality: String(x.quality ?? '').slice(0, 40), bottleneck: String(x.bottleneck ?? '').slice(0, 60) }) },
      operations:        { cap: 12, map: x => ({ entity: String(x.entity || '').slice(0, 40), income: String(x.income ?? '').slice(0, 60), expense: String(x.expense ?? '').slice(0, 60), net: String(x.net ?? '').slice(0, 60), reason: String(x.reason || '').slice(0, 120) }) },
      closures:          { cap: 8,  map: x => ({ subject: String(x.subject || '').slice(0, 40), opening: String(x.opening ?? '').slice(0, 40), inflow: String(x.inflow ?? '').slice(0, 40), outflow: String(x.outflow ?? '').slice(0, 40), natural: String(x.natural ?? '').slice(0, 40), closing: String(x.closing ?? '').slice(0, 40), pass: x.pass === true || x.pass === 'true' }) }
    };
    for (const key of Object.keys(structFields)) {
      const cfg = structFields[key];
      if (!Array.isArray(incoming[key])) continue;
      const parsed = incoming[key]
        .filter(x => x && typeof x === 'object')
        .map(cfg.map)
        .slice(0, cfg.cap);
      // 结构相同才替换（避免坏数据覆盖好数据）；有内容或清空（显式空数组=无变化）都算变更
      if (JSON.stringify(parsed) !== JSON.stringify(assets[key] || [])) {
        assets[key] = parsed;
        changed = true;
      }
    }

    // 脏检查：本轮确实发生变更才落盘
    if (changed && core && typeof core.saveState === 'function') core.saveState(state);
    if (settledThisRound) {
      console.log(`[世界引擎] 💰 资产账本已完整结算（第${round}轮，${assets.entries.length}条账目）`);
    }
  }

  /** 构建注入正文用的资产概览段（简洁，供正文模型感知） */
  function buildContextSection(state) {
    if (!isEnabled()) return '';
    if (!state || typeof state !== 'object') return '';
    const assets = state.assets || {};
    const parts = [];
    if (assets.overview?.assets) parts.push(`资产总览：${assets.overview.assets}`);
    if (assets.overview?.funds) parts.push(`资金：${assets.overview.funds}`);
    if (assets.overview?.production) parts.push(`产业：${assets.overview.production}`);
    if (assets.overview?.distribution) parts.push(`分布：${assets.overview.distribution}`);
    if (!parts.length && (assets.entries || []).length) {
      const e = (assets.entries || []).filter(x => x && typeof x === 'object').slice(0, 3);
      parts.push('主要资产：' + e.map(x => `${x.name}（${x.amount ?? '未知'}）`).join('、'));
    }
    if (!parts.length) return '';
    return `\n【资产账目】\n${parts.join('\n')}`;
  }

  return {
    buildPromptSection,
    mergeUpdate,
    buildContextSection,
    MAJOR_EVENT_HINTS
  };
})();
