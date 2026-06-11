/**
 * 「家园」演绎引擎 —— 一轮"观测"的完整闭环。
 *
 * 成本模型（刻意不做真实时间常驻运行）：
 *   - 用户每次"观测"（手动推进）或每日有限次离线 tick 触发一轮演绎
 *   - 一轮 = 1 次 NPC 世界引擎调用（一口气演完所有 NPC，NPC 无记忆）
 *          + N 次角色调用（链式，每角色一次，确保没人开上帝视角）
 *   - 一轮推进半天剧情时间；"我不看的时候世界慢慢走，我一看就加速"
 *
 * 每个角色的调用复用聊天主链路 buildChatRequestPayload：
 *   ContextBuilder 人设 + 角色设定的私聊上下文条数 + 记忆宫殿
 *   （召回 query 注入"同世界其他角色"，让角色记得自己跟他们的过往）。
 *
 * 产出注入：每个成员的 1v1 聊天各落一条 world_card（可解析 metadata），
 * 与彼方 vr_card 同构，天然进入上下文与记忆管线。
 */

import type {
    CharacterProfile, UserProfile, GroupProfile, RealtimeConfig, APIConfig,
    WorldProfile, WorldEpisode, WorldCharBeat, WorldCardMeta,
} from '../../types';
import { DB } from '../db';
import { buildChatRequestPayload } from '../chatRequestPayload';
import { safeFetchJson } from '../safeApi';
import { processNewMessages } from '../memoryPalace/pipeline';
import {
    storyTimeLabel, buildWorldSystemAddendum, buildWorldCharTurn, buildNpcTurn,
    parseCharBeat, parseNpcScene,
} from './prompts';

interface MemoryConfigLike {
    embedding?: { baseUrl?: string; apiKey?: string; model?: string; dimensions?: number };
    lightLLM?: { baseUrl?: string; apiKey?: string; model?: string };
}

export interface WorldEpisodeDeps {
    world: WorldProfile;
    characters: CharacterProfile[];
    apiConfig: APIConfig;
    userProfile: UserProfile;
    groups: GroupProfile[];
    realtimeConfig?: RealtimeConfig;
    memoryPalaceConfig?: MemoryConfigLike;
    trigger: 'observe' | 'tick';
}

export interface WorldEpisodeResult {
    ok: boolean;
    reason?: string;
    episode?: WorldEpisode;
}

const genId = (p: string) => `${p}_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 7)}`;
const running = new Set<string>();

export function isWorldRunning(worldId: string): boolean {
    return running.has(worldId);
}

const dispatch = (name: string, detail: any) => {
    try { window.dispatchEvent(new CustomEvent(name, { detail })); } catch { /* SSR */ }
};

/**
 * 关系 delta 回填。关系有向：A 的演绎里"和 B 关系 +2"只代表 **A 对 B** 的好感变了，
 * B 对 A 怎么想由 B 自己的演绎轮决定——两边完全可以不对等。不存在的边按 50 起步。
 */
export function applyRelationshipDeltas(world: WorldProfile, beats: WorldCharBeat[], members: { id: string; name: string }[]): void {
    const idOf = (name: string) => members.find(m => m.name === name)?.id;
    for (const beat of beats) {
        for (const rd of beat.relationshipDeltas || []) {
            const otherId = idOf(rd.withName);
            if (!otherId || otherId === beat.charId) continue;
            let rel = world.relationships.find(r => r.fromId === beat.charId && r.toId === otherId);
            if (!rel) {
                rel = { fromId: beat.charId, toId: otherId, value: 50 };
                world.relationships.push(rel);
            }
            rel.value = Math.max(0, Math.min(100, rel.value + rd.delta));
        }
    }
}

/** 机械拼接本轮梗概（喂给下一轮，不再额外烧一次 LLM）。 */
function buildSummary(storyTime: string, beats: WorldCharBeat[], npcHooks: string[]): string {
    const parts = beats.map(b => `${b.charName}在${b.location}（${b.mood}）：${b.narrative.slice(0, 80)}${b.narrative.length > 80 ? '…' : ''}`);
    const hookPart = npcHooks.length > 0 ? ` ／镇上：${npcHooks.join('；')}` : '';
    return `${storyTime}：${parts.join(' ／ ')}${hookPart}`.slice(0, 1200);
}

/** 单个角色的 world_card 文本（进聊天上下文与记忆，所以带全量信息）。 */
function buildCardContent(world: WorldProfile, storyTime: string, beat: WorldCharBeat): string {
    const lines = [
        `「家园 · ${world.name}」${storyTime}`,
        `${beat.charName} 在${beat.location}（${beat.mood}）`,
        beat.narrative,
    ];
    if (beat.phone?.posts?.length) {
        for (const p of beat.phone.posts) lines.push(`发了动态：${p}`);
    }
    if (beat.phone?.dms?.length) {
        for (const d of beat.phone.dms) lines.push(`给 ${d.to} 发消息：${d.lines.join(' / ')}`);
    }
    return lines.join('\n');
}

export async function runWorldEpisode(deps: WorldEpisodeDeps): Promise<WorldEpisodeResult> {
    const { world, characters, apiConfig, userProfile, groups, realtimeConfig, memoryPalaceConfig, trigger } = deps;

    if (running.has(world.id)) return { ok: false, reason: 'busy' };

    const members = world.memberIds
        .map(id => characters.find(c => c.id === id))
        .filter(Boolean) as CharacterProfile[];
    if (members.length === 0) return { ok: false, reason: 'no-members' };

    const api = world.api?.baseUrl ? world.api : apiConfig;
    if (!api.baseUrl) return { ok: false, reason: 'no-api' };
    const baseUrl = api.baseUrl.replace(/\/+$/, '');

    running.add(world.id);
    const storyTime = storyTimeLabel(world.storyClock);
    dispatch('world-episode-start', { worldId: world.id, worldName: world.name, storyTime, total: members.length });

    try {
        const lastEpisodes = await DB.getWorldEpisodes(world.id, 2);
        // 给一点纵深：最近两轮的梗概都喂进去，世界才有"昨天"的概念
        const lastSummary = lastEpisodes.length > 0
            ? lastEpisodes.slice().reverse().map(e => e.summary).join('\n')
            : undefined;

        // ── 1. NPC 世界引擎（一次调用全搞定；没有 NPC 就跳过） ──
        let npcScene: string | undefined;
        let npcHooks: string[] = [];
        if (world.npcs.length > 0) {
            try {
                const npcData = await safeFetchJson(`${baseUrl}/chat/completions`, {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${api.apiKey || 'sk-none'}` },
                    body: JSON.stringify({
                        model: api.model,
                        messages: [{ role: 'user', content: buildNpcTurn({ world, members, storyTime, lastSummary }) }],
                        temperature: 0.9, stream: false,
                    }),
                }, 2, 0, { appName: '家园', purpose: `NPC世界引擎 · ${world.name}` });
                const parsed = parseNpcScene(npcData.choices?.[0]?.message?.content || '');
                npcScene = parsed.scene || undefined;
                npcHooks = parsed.hooks;
            } catch (e) {
                // NPC 失败不阻塞角色演绎——世界这半天只是安静一点
                console.warn('[WorldHome] NPC engine failed, continuing without npcScene:', e);
            }
        }
        dispatch('world-beat-done', { worldId: world.id, stage: 'npc', done: 0, total: members.length });

        // ── 2. 链式角色演绎（每角色一次独立调用，后者能"看到"前者的外部行为） ──
        const memberNames = members.map(m => m.name);
        const beats: WorldCharBeat[] = [];
        let anyCharOk = false;
        for (let i = 0; i < members.length; i++) {
            const char = members[i];
            try {
                const others = memberNames.filter(n => n !== char.name);
                // 与彼方同款的名字加权召回：让向量记忆召回"我和这些人的关系"，
                // 而不是被世界观情景词淹没。query = 当前世界的其他角色。
                const recallQueryHint = others.length > 0
                    ? [
                        `此刻在「${world.name}」共同生活的人：${others.join('、')}。`,
                        `${others.join(' ')} ${others.join(' ')}`,
                        `我对${others.join('、')}的印象、我和${others.join('、')}之间的关系与过往。`,
                    ].join('\n')
                    : undefined;

                const contextLimit = char.contextLimit || 500;
                const historyMsgs = await DB.getRecentMessagesByCharId(char.id, contextLimit);
                const payload = await buildChatRequestPayload({
                    char, userProfile, groups, emojis: [], categories: [],
                    historyMsgs, contextLimit, realtimeConfig, recallQueryHint,
                });
                const systemPrompt = payload.systemPrompt + buildWorldSystemAddendum(world, char, userProfile?.name || '');
                const turn = buildWorldCharTurn({
                    world, char, members, storyTime, lastSummary,
                    npcScene, npcHooks, beatsSoFar: beats, userName: userProfile?.name || '',
                });

                const data = await safeFetchJson(`${baseUrl}/chat/completions`, {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${api.apiKey || 'sk-none'}` },
                    body: JSON.stringify({
                        model: api.model,
                        messages: [{ role: 'system', content: systemPrompt }, ...payload.cleanedApiMessages, { role: 'user', content: turn }],
                        temperature: 0.9, stream: false,
                    }),
                }, 2, 0, { appName: '家园', charId: char.id, charName: char.name, purpose: `演绎 · ${world.name}` });
                const beat = parseCharBeat(data.choices?.[0]?.message?.content || '', char, memberNames);
                beats.push(beat);
                anyCharOk = true;
            } catch (e) {
                // 单个角色失败不拖垮整轮——这半天 ta 只是没什么动静
                console.error(`[WorldHome] beat failed for ${char.name}:`, e);
            }
            dispatch('world-beat-done', { worldId: world.id, stage: 'char', charId: char.id, charName: char.name, done: i + 1, total: members.length });
        }

        if (!anyCharOk) return { ok: false, reason: 'all-beats-failed' };

        // ── 3. 落库：episode + 关系回填 + 剧情时钟推进 ──
        const episode: WorldEpisode = {
            id: genId('we'),
            worldId: world.id,
            round: world.storyClock + 1,
            storyTime,
            trigger,
            npcScene,
            npcHooks: npcHooks.length > 0 ? npcHooks : undefined,
            beats,
            summary: buildSummary(storyTime, beats, npcHooks),
            createdAt: Date.now(),
        };
        await DB.saveWorldEpisode(episode);

        applyRelationshipDeltas(world, beats, members);
        const updatedWorld: WorldProfile = {
            ...world,
            relationships: world.relationships,
            storyClock: world.storyClock + 1,
            updatedAt: Date.now(),
        };
        await DB.saveWorld(updatedWorld);

        // ── 4. world_card 注入各成员 1v1 聊天（与彼方 vr_card 同构） ──
        if (world.injectToChat !== false) {
            for (const beat of beats) {
                const meta: WorldCardMeta = {
                    worldCard: true,
                    worldId: world.id,
                    worldName: world.name,
                    mode: world.mode,
                    round: episode.round,
                    storyTime,
                    location: beat.location,
                    mood: beat.mood,
                    narrative: beat.narrative,
                    statusPanel: beat.statusPanel,
                    phonePosts: beat.phone?.posts,
                };
                try {
                    await DB.saveMessage({
                        charId: beat.charId, role: 'assistant', type: 'world_card',
                        content: buildCardContent(world, storyTime, beat), metadata: meta,
                    });
                } catch (e) {
                    console.error(`[WorldHome] card inject failed for ${beat.charName}:`, e);
                }
            }

            // 记忆管线（fire-and-forget，逐角色）
            try {
                const mpEmb = memoryPalaceConfig?.embedding;
                const mpLLMConfigured = memoryPalaceConfig?.lightLLM;
                const mpLLM = (mpLLMConfigured?.baseUrl) ? mpLLMConfigured : { baseUrl: apiConfig.baseUrl, apiKey: apiConfig.apiKey, model: apiConfig.model };
                if (mpEmb?.baseUrl && mpEmb?.apiKey && mpLLM.baseUrl) {
                    for (const beat of beats) {
                        const char = members.find(m => m.id === beat.charId);
                        if (!char?.memoryPalaceEnabled) continue;
                        const recentMsgs = await DB.getRecentMessagesByCharId(char.id, 50);
                        void processNewMessages(recentMsgs, char.id, char.name, mpEmb as any, mpLLM as any, userProfile?.name || '', false).catch(() => {});
                    }
                }
            } catch { /* 记忆失败不影响主流程 */ }
        }

        dispatch('world-episode-done', { worldId: world.id, episodeId: episode.id, storyTime, round: episode.round });
        return { ok: true, episode };
    } catch (err) {
        console.error('[WorldHome] episode error:', err);
        return { ok: false, reason: 'error' };
    } finally {
        running.delete(world.id);
        dispatch('world-episode-end', { worldId: world.id });
    }
}
