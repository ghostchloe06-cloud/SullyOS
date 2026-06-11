/**
 * 「家园」提示词与输出解析。
 *
 * 设计原则（与产品诉求一一对应）：
 *   - 一次 LLM 调用只演绎一个角色，prompt 里只给该角色"外部可观察"的世界信息，
 *     确保没人开上帝视角；其他角色的内心活动绝不进入它的上下文。
 *   - NPC 没有记忆系统，由"世界引擎"一次调用全部演绎，完全服务于世界观氛围。
 *   - 三种模式只在"user 的存在感"上做提示词差异，记忆/人设注入对三种模式一致
 *     （buildChatRequestPayload 那条链路不变）。
 */

import type { CharacterProfile, WorldProfile, WorldHouse, WorldCharBeat, WorldHomeMode } from '../../types';

/** 剧情时钟 → 时间标签。一轮推进半天：偶数=白天，奇数=夜晚。 */
export function storyTimeLabel(storyClock: number): string {
    return `第${Math.floor(storyClock / 2) + 1}天${storyClock % 2 === 0 ? '白天' : '夜晚'}`;
}

/** 找出某成员住在哪（不在任何小屋 = 独居）。 */
export function houseOf(world: WorldProfile, charId: string): WorldHouse | null {
    return world.houses.find(h => h.residentIds.includes(charId)) || null;
}

/** user 存在感的三档规则文本。 */
export function buildModeRule(mode: WorldHomeMode, userName: string): string {
    const u = userName || '用户';
    switch (mode) {
        case 'light':
            return `【模式：轻度】这只是观察你生活的一个切面。在这个世界里，${u} 依旧是你最重要的人——与你们平时聊天里的关系完全一致。你的生活里可以自然地惦记 ta、想给 ta 发消息、期待 ta 的出现；但此刻 ta 不在场，不要凭空让 ta 登场。`;
        case 'medium':
            return `【模式：中度】${u} 是这个世界里的普通一员，和其他人没有什么不同。可以自然提及 ta，但 ta 不特殊，你的生活不围着 ta 转。此刻 ta 不在场，不要替 ta 行动或说话。`;
        case 'heavy':
            return `【模式：重度·重要】在这个世界里，${u} 不存在（或者说只是一个谁也看不见的幽灵）。演绎中绝对不要提及、暗示、想起或寻找 ta。你的生活完全由这个世界里的居民和事件构成。即使你的记忆里有 ta，在这个世界里那些记忆也如同上辈子的梦，不会浮现。`;
    }
}

/** 注入到角色 systemPrompt 末尾的家园场景框定。 */
export function buildWorldSystemAddendum(world: WorldProfile, char: CharacterProfile, userName: string): string {
    return `

---
[家园 · ${world.name}]
接下来不是和 ${userName || '用户'} 的聊天，而是你在共同世界「${world.name}」里的一段真实生活演绎。
${buildModeRule(world.mode, userName)}
铁律：你只扮演你自己（${char.name}）。同世界的其他角色各有自己的演绎轮，你看不到他们的内心，只能根据他们外在的言行做反应；不要替任何其他角色做决定或编造他们的内心戏。NPC 的言行可以引用（他们由世界引擎给出）。
保持你在聊天中一贯的人设、记忆与行事风格——这是同一个你，只是生活在这个世界里。`;
}

/** 居住安排的可读文本。 */
function describeHousing(world: WorldProfile, members: CharacterProfile[]): string {
    const lines: string[] = [];
    const housed = new Set<string>();
    for (const h of world.houses) {
        const names = h.residentIds
            .map(id => members.find(m => m.id === id)?.name)
            .filter(Boolean) as string[];
        if (names.length === 0) continue;
        names.forEach(n => housed.add(n));
        lines.push(`- ${h.name}：${names.join('、')} 同住`);
    }
    for (const m of members) {
        if (!housed.has(m.name)) lines.push(`- ${m.name} 独居（自己的住处）`);
    }
    return lines.join('\n');
}

const relTone = (v: number) => v >= 80 ? '非常亲近' : v >= 60 ? '关系不错' : v >= 40 ? '一般' : v >= 20 ? '有些疏远' : '关系紧张';

/**
 * 与某角色相关的关系条文本。关系是**有向**的（你对ta ≠ ta对你）：
 *   - 你→别人：给精确的关系名 + 数值（这是你自己的内心，你当然清楚）
 *   - 别人→你：只给粗粒度的"你能感觉到的态度"——对方心里的定位和具体程度是对方的
 *     内心戏，给了数值就等于替这个角色开了上帝视角
 *   - 他人之间的关系一概不给
 */
function describeRelationsFor(world: WorldProfile, charId: string, members: CharacterProfile[], npcNames: Map<string, string>): string {
    const nameOf = (id: string) => members.find(m => m.id === id)?.name || npcNames.get(id) || '';
    const outgoing = world.relationships.filter(r => r.fromId === charId);
    const incoming = world.relationships.filter(r => r.toId === charId);
    if (outgoing.length === 0 && incoming.length === 0) return '（还没有建立明确的关系记录，凭你对他们的记忆与第一印象相处）';
    const lines: string[] = [];
    for (const r of outgoing) {
        const other = nameOf(r.toId);
        if (!other) continue;
        lines.push(`- 你对 ${other}：${r.label ? `${r.label}，` : ''}${relTone(r.value)}（${r.value}/100）`);
    }
    for (const r of incoming) {
        const other = nameOf(r.fromId);
        if (!other) continue;
        lines.push(`- 你能隐约感觉到 ${other} 对你的态度：${relTone(r.value)}（只是体感，对方心里真正怎么想你并不知道）`);
    }
    return lines.join('\n');
}

/**
 * 单个角色的演绎回合（user turn）。
 * @param beatsSoFar 本轮已演绎完的其他角色的"外部可观察"摘要（位置+行为节选，不含内心）
 */
export function buildWorldCharTurn(args: {
    world: WorldProfile;
    char: CharacterProfile;
    members: CharacterProfile[];
    storyTime: string;
    lastSummary?: string;
    npcScene?: string;
    npcHooks?: string[];
    beatsSoFar: WorldCharBeat[];
    userName: string;
}): string {
    const { world, char, members, storyTime, lastSummary, npcScene, npcHooks, beatsSoFar, userName } = args;
    const others = members.filter(m => m.id !== char.id);
    const npcNames = new Map(world.npcs.map(n => [n.id, n.name]));
    const myHouse = houseOf(world, char.id);

    const observable = beatsSoFar.length > 0
        ? beatsSoFar.map(b => `- ${b.charName} 在${b.location}：${b.narrative.slice(0, 200)}${b.narrative.length > 200 ? '…' : ''}`).join('\n')
        : '（这半天你是最先行动的人）';

    return `【家园 · ${world.name}】剧情时间：${storyTime}

## 这个世界
${world.worldview || '（一个安静的小世界）'}

## 居住安排
${describeHousing(world, members)}
你的住处：${myHouse ? `${myHouse.name}${myHouse.residentIds.length > 1 ? `（和 ${myHouse.residentIds.filter(id => id !== char.id).map(id => members.find(m => m.id === id)?.name).filter(Boolean).join('、')} 同住）` : ''}` : '你自己的住处（独居）'}

## 同世界的人
${others.length > 0 ? others.map(m => `- ${m.name}`).join('\n') : '（暂时只有你）'}
${world.npcs.length > 0 ? `\n## 镇上的 NPC\n${world.npcs.map(n => `- ${n.name}：${n.persona}`).join('\n')}` : ''}

## 你的关系
${describeRelationsFor(world, char.id, members, npcNames)}

## 之前发生的事
${lastSummary || '（这是这个世界的第一个半天，一切刚刚开始）'}
${npcScene ? `\n## 这半天镇上的动静（NPC）\n${npcScene}${npcHooks && npcHooks.length > 0 ? `\n可以接住的事件：${npcHooks.join('；')}` : ''}` : ''}

## 这半天其他人的动静（你能看到/听说的部分）
${observable}

---
现在轮到你了。根据你所在的环境自行判定你此刻在哪、在做什么，演绎你这半天（${storyTime}）的生活。一次调用要产出信息量很高的完整生活切片。
严格输出一个 JSON 对象（建议用 \`\`\`json 代码块包裹，不要输出 JSON 之外的正文）：
{
  "location": "你此刻在哪（自己房间/同居小屋的客厅/镇上的某处…自行判定，要和居住安排与他人动静自洽）",
  "narrative": "小说式的行为与生活描述，第三人称，300~600字。要具体：做了什么、和谁（在场角色按其外在言行互动、NPC 可引用）、环境细节、有温度的小事。",
  "mood": "一两个词的此刻心情",
  "statusPanel": { "体力": 0到100的数字, "心情值": 0到100的数字, "其他你想记录的状态": "自由发挥（最多再加2项）" },
  "phone": {
    "posts": ["这半天发的动态（0~2条，没有就给空数组）"],
    "dms": [{ "to": "同世界某成员的名字", "lines": ["你发给ta的私聊消息（像真的在手机上打字）"] }]
  },
  "relationships": [{ "with": "同世界某成员的名字", "delta": -5到5的整数, "reason": "这半天发生了什么让关系变化" }]
}
注意：
- ${world.mode === 'heavy' ? `这个世界里不存在 ${userName || '用户'}，narrative、phone、所有字段都绝不出现 ta。` : world.mode === 'light' ? `${userName || '用户'} 是你心里最重要的人，但此刻不在场——可以在 narrative 或动态里自然流露惦记。` : `${userName || '用户'} 只是世界里的普通一员，不必特意提及。`}
- phone.dms 只发给同世界成员；没话想说就给空数组。
- relationships 只在真的发生了影响关系的事时才给，没有就空数组。`;
}

/** NPC 世界引擎回合（一次调用演完所有 NPC；NPC 无记忆，仅靠世界观+上轮梗概）。 */
export function buildNpcTurn(args: {
    world: WorldProfile;
    members: CharacterProfile[];
    storyTime: string;
    lastSummary?: string;
}): string {
    const { world, members, storyTime, lastSummary } = args;
    return `你是共同世界「${world.name}」的世界引擎，负责一次性扮演镇上所有 NPC。NPC 没有独立记忆，完全为世界观氛围服务。

## 世界观
${world.worldview || '（一个安静的小世界）'}

## NPC 名单
${world.npcs.map(n => `- ${n.name}：${n.persona}`).join('\n')}

## 世界的主角们（你不扮演他们，只能让 NPC 与他们擦肩、寒暄、留下钩子）
${members.map(m => m.name).join('、')}

## 之前发生的事
${lastSummary || '（这是这个世界的第一个半天）'}

剧情时间：${storyTime}。
一次性输出这半天所有 NPC 的群像动静。严格输出一个 JSON 对象（建议用 \`\`\`json 包裹）：
{
  "scene": "200~400字的 NPC 群像叙述：谁在做什么、市井气息、天气与街景、和主角们擦肩的小事件。生活感优先，不要推进重大剧情。",
  "hooks": ["1~3个可以被主角们接住的小事件钩子（例：面包店老板娘今天多烤了一炉栗子面包，见人就塞）"]
}`;
}

// ── 输出解析 ──────────────────────────────────────────────

/** 从 LLM 输出里捞出第一个 JSON 对象（支持 ```json 围栏 / 裸 JSON / 夹杂正文）。 */
export function extractJson(raw: string): any | null {
    const text = (raw || '').replace(/<think>[\s\S]*?<\/think>/gi, '').trim();
    // 1) 围栏代码块优先
    const fence = text.match(/```(?:json)?\s*([\s\S]*?)```/i);
    const candidates: string[] = [];
    if (fence?.[1]) candidates.push(fence[1].trim());
    // 2) 第一个 { 到最后一个 } 的贪婪截取
    const first = text.indexOf('{');
    const last = text.lastIndexOf('}');
    if (first >= 0 && last > first) candidates.push(text.slice(first, last + 1));
    for (const c of candidates) {
        try { return JSON.parse(c); } catch { /* try next */ }
        // 宽松修复：去掉尾逗号再试
        try { return JSON.parse(c.replace(/,\s*([}\]])/g, '$1')); } catch { /* try next */ }
    }
    return null;
}

const clampNum = (v: any, lo: number, hi: number, fallback: number): number => {
    const n = typeof v === 'number' ? v : parseInt(String(v), 10);
    if (!Number.isFinite(n)) return fallback;
    return Math.max(lo, Math.min(hi, Math.round(n)));
};

/** 解析单角色演绎输出 → WorldCharBeat（解析失败时整段原文兜底进 narrative，绝不丢内容）。 */
export function parseCharBeat(raw: string, char: CharacterProfile, memberNames: string[]): WorldCharBeat {
    const j = extractJson(raw);
    const fallbackNarrative = (raw || '').replace(/<think>[\s\S]*?<\/think>/gi, '').replace(/```(?:json)?|```/g, '').trim().slice(0, 800);
    if (!j || typeof j !== 'object') {
        return { charId: char.id, charName: char.name, location: '住处', narrative: fallbackNarrative || '安静地度过了这半天。', mood: '平静' };
    }
    const nameSet = new Set(memberNames);
    const statusPanel: Record<string, number | string> = {};
    if (j.statusPanel && typeof j.statusPanel === 'object') {
        let count = 0;
        for (const [k, v] of Object.entries(j.statusPanel)) {
            if (count >= 5) break;
            statusPanel[String(k).slice(0, 12)] = typeof v === 'number' ? clampNum(v, 0, 100, 50) : String(v).slice(0, 30);
            count += 1;
        }
    }
    const dms = Array.isArray(j.phone?.dms)
        ? j.phone.dms
            .filter((d: any) => d && typeof d.to === 'string' && nameSet.has(d.to) && Array.isArray(d.lines))
            .map((d: any) => ({ to: d.to, lines: d.lines.map((l: any) => String(l).slice(0, 200)).slice(0, 6) }))
            .slice(0, 3)
        : [];
    const posts = Array.isArray(j.phone?.posts) ? j.phone.posts.map((p: any) => String(p).slice(0, 200)).slice(0, 2) : [];
    const relationshipDeltas = Array.isArray(j.relationships)
        ? j.relationships
            .filter((r: any) => r && typeof r.with === 'string' && nameSet.has(r.with))
            .map((r: any) => ({ withName: r.with, delta: clampNum(r.delta, -5, 5, 0), reason: r.reason ? String(r.reason).slice(0, 100) : undefined }))
            .slice(0, 5)
        : [];
    return {
        charId: char.id,
        charName: char.name,
        location: typeof j.location === 'string' && j.location.trim() ? j.location.trim().slice(0, 40) : '住处',
        narrative: typeof j.narrative === 'string' && j.narrative.trim() ? j.narrative.trim() : (fallbackNarrative || '安静地度过了这半天。'),
        mood: typeof j.mood === 'string' && j.mood.trim() ? j.mood.trim().slice(0, 16) : '平静',
        statusPanel: Object.keys(statusPanel).length > 0 ? statusPanel : undefined,
        phone: (dms.length > 0 || posts.length > 0) ? { posts, dms } : undefined,
        relationshipDeltas: relationshipDeltas.length > 0 ? relationshipDeltas : undefined,
    };
}

/** 解析 NPC 世界引擎输出。 */
export function parseNpcScene(raw: string): { scene: string; hooks: string[] } {
    const j = extractJson(raw);
    if (j && typeof j.scene === 'string') {
        return {
            scene: j.scene.trim(),
            hooks: Array.isArray(j.hooks) ? j.hooks.map((h: any) => String(h).slice(0, 120)).slice(0, 3) : [],
        };
    }
    const fallback = (raw || '').replace(/<think>[\s\S]*?<\/think>/gi, '').replace(/```(?:json)?|```/g, '').trim().slice(0, 500);
    return { scene: fallback, hooks: [] };
}
