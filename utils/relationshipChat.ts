// 人际关系系统 · 核心引擎
// 查手机「人际关系」模块的纯逻辑 + LLM 链路：真假甄别、好感、双 LLM 私下对话（A 发 B 回）、AI 玩 AI。
// UI 层（CheckPhone.tsx）负责把这里的结果落库 / 镜像到对方角色，本文件只产数据，不碰 React。

import { CharacterProfile, PhoneContact, UserProfile } from '../types';
import { ContextBuilder } from './context';
import { injectMemoryPalace } from './memoryPalace/pipeline';
import { DB } from './db';
import { safeResponseJson } from './safeApi';

export interface MiniApiConfig {
    baseUrl: string;
    apiKey: string;
    model: string;
}

// ============================================================
//  纯函数（可单测，不触网）
// ============================================================

/** 归一化人名用于匹配：去空白、去括号身份后缀、转小写 */
export function normName(s: string): string {
    return (s || '')
        .replace(/[（(].*?[）)]/g, '') // 去掉「名字(身份)」里的身份部分
        .replace(/\s+/g, '')
        .trim()
        .toLowerCase();
}

/**
 * 真假甄别兜底：把一个联系人名字跟神经链接里的真实角色名单做匹配。
 * 命中返回该角色 id；否则 undefined（=纯 NPC）。
 * 先精确匹配，再做包含匹配（「学长阿哲」含「阿哲」也算命中）。
 */
export function matchRealChar(
    name: string,
    roster: { id: string; name: string }[],
): string | undefined {
    const n = normName(name);
    if (!n) return undefined;
    const exact = roster.find(r => normName(r.name) === n);
    if (exact) return exact.id;
    const contains = roster.find(r => {
        const rn = normName(r.name);
        return rn.length >= 2 && (n.includes(rn) || rn.includes(n));
    });
    return contains?.id;
}

/** 好感度钳制到 -100..100 */
export function clampAffinity(n: number): number {
    if (!Number.isFinite(n)) return 0;
    return Math.max(-100, Math.min(100, Math.round(n)));
}

/**
 * 以 name 为键把一条联系人 upsert 进列表（不可变，返回新数组）。
 * 已存在则浅合并（保留原 id/affinity/createdAt，除非 incoming 显式带了）。
 */
export function upsertContact(
    contacts: PhoneContact[],
    incoming: Partial<PhoneContact> & { name: string },
): PhoneContact[] {
    const key = normName(incoming.name);
    const idx = contacts.findIndex(c => normName(c.name) === key);
    if (idx === -1) {
        const fresh: PhoneContact = {
            id: incoming.id || `ct-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`,
            name: incoming.name,
            identity: incoming.identity,
            note: incoming.note,
            avatar: incoming.avatar,
            kind: incoming.kind || 'npc',
            linkedCharId: incoming.linkedCharId,
            affinity: clampAffinity(incoming.affinity ?? 0),
            status: incoming.status || 'friend',
            lastInteraction: incoming.lastInteraction,
            createdAt: Date.now(),
        };
        return [...contacts, fresh];
    }
    const next = [...contacts];
    const cur = next[idx];
    next[idx] = {
        ...cur,
        ...incoming,
        affinity: incoming.affinity != null ? clampAffinity(incoming.affinity) : cur.affinity,
        createdAt: cur.createdAt,
        id: cur.id,
    };
    return next;
}

/**
 * 把一段「我:/对方:」对话脚本翻转视角。
 * A 视角的 detail（"我"=A，"对方"=B）→ B 视角（"我"=B，"对方"=A）。
 * 用于把同一段真实对话镜像写进对方角色的手机。
 */
export function flipTranscript(detail: string): string {
    return (detail || '')
        .split('\n')
        .map(line => {
            const m = line.match(/^\s*(我|对方|Me|Them)\s*[:：]\s*(.*)$/);
            if (!m) return line;
            const who = m[1];
            const isMe = who === '我' || who === 'Me';
            return `${isMe ? '对方' : '我'}: ${m[2]}`;
        })
        .join('\n');
}

// ============================================================
//  LLM 调用
// ============================================================

async function chatCompletion(
    api: MiniApiConfig,
    userContent: string,
    temperature = 0.85,
): Promise<string> {
    const res = await fetch(`${api.baseUrl.replace(/\/+$/, '')}/chat/completions`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${api.apiKey}` },
        body: JSON.stringify({
            model: api.model,
            messages: [{ role: 'user', content: userContent }],
            temperature,
        }),
    });
    if (!res.ok) throw new Error(`LLM ${res.status}`);
    const data = await safeResponseJson(res);
    return (data?.choices?.[0]?.message?.content || '').trim();
}

/** 取某角色最近上下文（按 chatapp 设置的 contextLimit，默认 500），压成纯文本 */
async function recentContextText(
    char: CharacterProfile,
    selfLabel: string,
    userName: string,
): Promise<string> {
    const limit = char.contextLimit && char.contextLimit > 0 ? char.contextLimit : 500;
    const msgs = await DB.getRecentMessagesByCharId(char.id, limit);
    if (!msgs.length) return '（暂无最近聊天）';
    return msgs
        .map(m => {
            const who = m.role === 'user' ? userName : selfLabel;
            const body = m.type === 'text' ? m.content : `[${m.type}]`;
            return `${who}: ${body}`;
        })
        .join('\n');
}

/**
 * 按需注入记忆宫殿，query=对方的人名（用户指定的输入契约），返回 buildCoreContext 结果。
 * 记忆宫殿关闭时自动跳过（injectMemoryPalace 内部已 guard）。
 */
async function buildSpeakerContext(
    speaker: CharacterProfile,
    user: UserProfile,
    otherName: string,
): Promise<string> {
    try {
        if (speaker.memoryPalaceEnabled) {
            const recent = await DB.getRecentMessagesByCharId(
                speaker.id,
                speaker.contextLimit && speaker.contextLimit > 0 ? speaker.contextLimit : 500,
            );
            await injectMemoryPalace(speaker, recent, otherName, user.name);
        }
    } catch {
        /* 记忆宫殿失败不阻塞对话 */
    }
    return ContextBuilder.buildCoreContext(speaker, user, true);
}

export interface RealConversationResult {
    /** A 机主视角脚本（"我"=A，"对方"=B） */
    aDetail: string;
    /** B 机主视角脚本（"我"=B，"对方"=A） */
    bDetail: string;
    aDelta: number;
    bDelta: number;
}

interface RunRealConversationParams {
    a: CharacterProfile;
    b: CharacterProfile;
    user: UserProfile;
    api: MiniApiConfig;
    /** A 对 B 的当前好感 */
    affinityA: number;
    /** B 对 A 的当前好感 */
    affinityB: number;
    /** 往返轮数（每轮 = A 说一次 + B 回一次），默认 3 */
    rounds?: number;
    /** 续写时已有的 A 视角脚本（"我"=A） */
    existingDetail?: string;
    aNote?: string;
    bNote?: string;
}

/**
 * 双 LLM 私下对话：A 用 A 自己的人设/记忆/上下文发消息，B 用 B 自己的人设/记忆/上下文回。
 * 每一方都按用户指定的输入契约：buildCoreContext(true) + 记忆宫殿(query=对方名) + 最近上下文(contextLimit)。
 */
export async function runRealConversation(
    p: RunRealConversationParams,
): Promise<RealConversationResult> {
    const { a, b, user, api, affinityA, affinityB } = p;
    // 默认 1 个往返 = A 发一次 + B 回一次 = 正好 2 次 LLM 调用（好感变化折进各自回复，不再额外调用）
    const rounds = Math.max(1, Math.min(8, p.rounds ?? 1));

    const ctxA = await buildSpeakerContext(a, user, b.name);
    const ctxB = await buildSpeakerContext(b, user, a.name);
    const recentA = await recentContextText(a, a.name, user.name);
    const recentB = await recentContextText(b, b.name, user.name);

    // transcript: 用名字标注，喂给两边的 prompt
    const turns: { speaker: 'A' | 'B'; text: string }[] = [];

    // 续写：把已有 A 视角脚本解析回 turns
    if (p.existingDetail) {
        for (const line of p.existingDetail.split('\n')) {
            const m = line.match(/^\s*(我|对方|Me|Them)\s*[:：]\s*(.*)$/);
            if (!m || !m[2].trim()) continue;
            const isA = m[1] === '我' || m[1] === 'Me';
            turns.push({ speaker: isA ? 'A' : 'B', text: m[2].trim() });
        }
    }

    const labeled = () =>
        turns.length
            ? turns.map(t => `${t.speaker === 'A' ? a.name : b.name}: ${t.text}`).join('\n')
            : '';

    // 从一段回复里抽出 [[Δ:+N]] 好感变化并剥掉标记，再去掉可能的「名字:」前缀
    const extract = (raw: string, selfName: string): { text: string; delta: number } => {
        let delta = 0;
        let text = raw.replace(/\[\[\s*Δ?\s*[:：]?\s*([+-]?\d+)\s*\]\]/g, (_m, n) => {
            delta += parseInt(n, 10) || 0;
            return '';
        });
        text = text
            .replace(/^[「"']|[」"']$/g, '')
            .replace(new RegExp(`^\\s*(我|${selfName.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')})\\s*[:：]\\s*`), '')
            .trim();
        return { text, delta: Math.max(-20, Math.min(20, delta)) };
    };

    let aDelta = 0;
    let bDelta = 0;

    for (let i = 0; i < rounds; i++) {
        // ---- A 发 ----
        const aPrompt = `${ctxA}

### [你的最近上下文（和用户的私聊）]
${recentA}

### [人际关系 · 私下对话（用户看不到）]
你是「${a.name}」。你正在用手机和「${b.name}」私聊，这是你背着用户的真实社交。${
            p.bNote ? `\n你对 ${b.name} 的备注：${p.bNote}` : ''
        }
你对 TA 的好感度：${affinityA}（范围 -100~100，负数=反感）。

已经发生的对话（"${a.name}:" 是你，"${b.name}:" 是对方）：
"""
${labeled() || '（还没开始，由你起头）'}
"""

任务：以「${a.name}」的身份，发给「${b.name}」接下来的一段消息（3-6 句、可以连发几条，IM 聊天风格，信息量要够，贴合你的人设和当前好感）。
只输出消息正文，不要加「${a.name}:」之类前缀，不要解释、不要旁白。
最后另起一行，用 [[Δ:+N]] 标注说完这段后你对 TA 的好感变化（N 为 -20~20 的整数，没变化写 [[Δ:0]]）。`;
        let aRaw = '';
        try {
            aRaw = await chatCompletion(api, aPrompt);
        } catch {
            break;
        }
        const aParsed = extract(aRaw, a.name);
        aDelta += aParsed.delta;
        if (aParsed.text) turns.push({ speaker: 'A', text: aParsed.text });

        // ---- B 回 ----
        const bPrompt = `${ctxB}

### [你的最近上下文（和用户的私聊）]
${recentB}

### [人际关系 · 私下对话（用户看不到）]
你是「${b.name}」。「${a.name}」正在用手机私聊你。${
            p.aNote ? `\n你对 ${a.name} 的备注：${p.aNote}` : ''
        }
你对 TA 的好感度：${affinityB}（范围 -100~100）。

对话记录（"${b.name}:" 是你，"${a.name}:" 是对方）：
"""
${labeled()}
"""

任务：以「${b.name}」的身份回复「${a.name}」（3-6 句、可以连发几条，IM 风格，信息量要够，贴合人设与好感）。
只输出回复正文，不要前缀，不要解释、不要旁白。
最后另起一行，用 [[Δ:+N]] 标注回完这段后你对 TA 的好感变化（N 为 -20~20 的整数，没变化写 [[Δ:0]]）。`;
        let bRaw = '';
        try {
            bRaw = await chatCompletion(api, bPrompt);
        } catch {
            break;
        }
        const bParsed = extract(bRaw, b.name);
        bDelta += bParsed.delta;
        if (bParsed.text) turns.push({ speaker: 'B', text: bParsed.text });
    }

    // A 视角脚本（"我"=A）
    const aDetail = turns
        .map(t => `${t.speaker === 'A' ? '我' : '对方'}: ${t.text}`)
        .join('\n');
    const bDetail = flipTranscript(aDetail);

    return {
        aDetail,
        bDetail,
        aDelta: Math.max(-20, Math.min(20, aDelta)),
        bDelta: Math.max(-20, Math.min(20, bDelta)),
    };
}

interface RunNpcConversationParams {
    /** 机主角色 */
    host: CharacterProfile;
    user: UserProfile;
    api: MiniApiConfig;
    /** 虚构联系人名字 */
    npcName: string;
    /** 虚构联系人身份/关系标签 */
    identity?: string;
    /** 机主对此人的备注 */
    note?: string;
    rounds?: number;
    existingDetail?: string;
}

/**
 * 与虚构 NPC 的对话：机主按人设脑补出这个不存在的人，单 LLM 分饰两角生成聊天脚本。
 * 纯虚构产物——不镜像、不涉及任何真实角色。
 */
export async function runNpcConversation(
    p: RunNpcConversationParams,
): Promise<{ detail: string }> {
    const rounds = Math.max(1, Math.min(8, p.rounds ?? 4));
    const ctxHost = ContextBuilder.buildCoreContext(p.host, p.user, true);

    const prompt = `${ctxHost}

### [人际关系 · 与虚构联系人的聊天]
你是「${p.host.name}」。你正在用手机和「${p.npcName}」私聊。${
        p.identity ? `对方身份：${p.identity}。` : ''
    }${p.note ? `你对 TA 的备注：${p.note}。` : ''}
「${p.npcName}」是按你的人设合理虚构出来的人（不是真实存在的角色），由你脑补出 TA 的性格与说话方式。

${p.existingDetail ? `已经聊了：\n"""\n${p.existingDetail}\n"""\n请接着往下聊。` : '现在开始这段对话。'}

任务：生成你（${p.host.name}）和「${p.npcName}」接下来 ${rounds} 个来回的对话，信息量要够。
格式：每行一句，"我: ..." 代表你（${p.host.name}），"对方: ..." 代表「${p.npcName}」。
只输出对话行，不要解释、不要旁白、不要重复已有内容。`;

    let out = '';
    try {
        out = await chatCompletion(p.api, prompt, 0.9);
    } catch {
        return { detail: p.existingDetail || '' };
    }
    out = out.replace(/```/g, '').trim();
    const detail = p.existingDetail ? `${p.existingDetail}\n${out}` : out;
    return { detail };
}
