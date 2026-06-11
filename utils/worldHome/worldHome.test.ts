import { describe, it, expect, beforeEach, vi, afterEach } from 'vitest';
import { extractJson, parseCharBeat, parseNpcScene, storyTimeLabel, buildModeRule, buildWorldCharTurn } from './prompts';
import { applyRelationshipDeltas } from './engine';
import { WorldScheduler } from './scheduler';
import type { CharacterProfile, WorldProfile } from '../../types';

// scheduler 的 attachListeners 会访问 document/window（node 环境下没有），补最简 stub。
const g = globalThis as any;
if (typeof g.document === 'undefined') g.document = { visibilityState: 'hidden', addEventListener() {}, removeEventListener() {} };
if (typeof g.window === 'undefined') g.window = { addEventListener() {}, removeEventListener() {} };

const mkChar = (id: string, name: string): CharacterProfile => ({ id, name } as CharacterProfile);

const mkWorld = (overrides: Partial<WorldProfile> = {}): WorldProfile => ({
    id: 'w1', name: '栗子镇', worldview: '海边小镇', mode: 'light',
    memberIds: ['a', 'b'], npcs: [], houses: [], relationships: [],
    storyClock: 0, createdAt: 0, updatedAt: 0,
    ...overrides,
});

describe('storyTimeLabel', () => {
    it('半天为单位推进：偶数白天，奇数夜晚', () => {
        expect(storyTimeLabel(0)).toBe('第1天白天');
        expect(storyTimeLabel(1)).toBe('第1天夜晚');
        expect(storyTimeLabel(2)).toBe('第2天白天');
        expect(storyTimeLabel(5)).toBe('第3天夜晚');
    });
});

describe('extractJson', () => {
    it('解析 ```json 围栏', () => {
        expect(extractJson('前导文字\n```json\n{"a":1}\n```\n尾巴')).toEqual({ a: 1 });
    });
    it('解析裸 JSON（夹杂正文）', () => {
        expect(extractJson('我来啦 {"a":1} 完事')).toEqual({ a: 1 });
    });
    it('容忍尾逗号', () => {
        expect(extractJson('{"a":1,}')).toEqual({ a: 1 });
    });
    it('剥掉 <think> 块', () => {
        expect(extractJson('<think>{"x":9}</think>{"a":1}')).toEqual({ a: 1 });
    });
    it('解析失败返回 null', () => {
        expect(extractJson('完全不是 JSON')).toBeNull();
    });
});

describe('parseCharBeat', () => {
    const char = mkChar('a', '小满');
    const members = ['小满', '阿岚'];

    it('完整解析一拍', () => {
        const raw = JSON.stringify({
            location: '同居小屋的厨房',
            narrative: '小满把昨晚剩的汤热了。',
            mood: '松弛',
            statusPanel: { 体力: 72, 心情值: 88 },
            phone: { posts: ['今天的汤'], dms: [{ to: '阿岚', lines: ['汤好了，快回来'] }] },
            relationships: [{ with: '阿岚', delta: 2, reason: '一起吃了早饭' }],
        });
        const beat = parseCharBeat(raw, char, members);
        expect(beat.location).toBe('同居小屋的厨房');
        expect(beat.mood).toBe('松弛');
        expect(beat.statusPanel).toEqual({ 体力: 72, 心情值: 88 });
        expect(beat.phone?.dms?.[0].to).toBe('阿岚');
        expect(beat.relationshipDeltas?.[0]).toMatchObject({ withName: '阿岚', delta: 2 });
    });

    it('JSON 解析失败时把原文兜底进 narrative，不丢内容', () => {
        const beat = parseCharBeat('她只是安静地坐在窗边，看了一下午的海。', char, members);
        expect(beat.narrative).toContain('看了一下午的海');
        expect(beat.charName).toBe('小满');
    });

    it('过滤非成员的私聊对象与关系对象，delta 截断到 ±5', () => {
        const raw = JSON.stringify({
            location: '镇上', narrative: 'x', mood: 'y',
            phone: { dms: [{ to: '陌生人', lines: ['?'] }, { to: '阿岚', lines: ['在吗'] }] },
            relationships: [{ with: '路人甲', delta: 3 }, { with: '阿岚', delta: 99 }],
        });
        const beat = parseCharBeat(raw, char, members);
        expect(beat.phone?.dms).toHaveLength(1);
        expect(beat.relationshipDeltas).toHaveLength(1);
        expect(beat.relationshipDeltas?.[0].delta).toBe(5);
    });
});

describe('parseNpcScene', () => {
    it('解析 scene + hooks', () => {
        const out = parseNpcScene('```json\n{"scene":"面包店飘香。","hooks":["老板娘多烤了一炉"]}\n```');
        expect(out.scene).toBe('面包店飘香。');
        expect(out.hooks).toEqual(['老板娘多烤了一炉']);
    });
    it('解析失败时原文兜底', () => {
        const out = parseNpcScene('镇子很安静。');
        expect(out.scene).toBe('镇子很安静。');
        expect(out.hooks).toEqual([]);
    });
});

describe('buildModeRule（三档 user 存在感）', () => {
    it('轻度：user 依旧是最重要的人', () => {
        expect(buildModeRule('light', '阿月')).toContain('最重要的人');
    });
    it('中度：user 是普通一员', () => {
        expect(buildModeRule('medium', '阿月')).toContain('普通一员');
    });
    it('重度：user 不存在，禁止提及', () => {
        const rule = buildModeRule('heavy', '阿月');
        expect(rule).toContain('不存在');
        expect(rule).toContain('绝对不要提及');
    });
});

describe('buildWorldCharTurn', () => {
    it('链式调用：后续角色能看到前面角色的外部摘要（截断，不带内心字段）', () => {
        const world = mkWorld();
        const members = [mkChar('a', '小满'), mkChar('b', '阿岚')];
        const turn = buildWorldCharTurn({
            world, char: members[1], members, storyTime: '第1天白天',
            beatsSoFar: [{ charId: 'a', charName: '小满', location: '厨房', narrative: '热汤。'.repeat(100), mood: '松弛' }],
            userName: '阿月',
        });
        expect(turn).toContain('小满 在厨房');
        expect(turn).toContain('…'); // 200 字截断
        expect(turn).not.toContain('松弛'); // 心情属于内心状态，不外泄给其他角色
    });

    it('关系有向：自己的视角带数值，对方对自己只有模糊体感（不泄露数值与关系名）', () => {
        const world = mkWorld({
            relationships: [
                { fromId: 'a', toId: 'b', label: '单恋', value: 85 },
                { fromId: 'b', toId: 'a', label: '普通同事', value: 30 },
            ],
        });
        const members = [mkChar('a', '小满'), mkChar('b', '阿岚')];
        const turn = buildWorldCharTurn({ world, char: members[0], members, storyTime: '第1天白天', beatsSoFar: [], userName: '' });
        expect(turn).toContain('你对 阿岚：单恋，非常亲近（85/100）');
        expect(turn).toContain('你能隐约感觉到 阿岚 对你的态度：有些疏远');
        expect(turn).not.toContain('30/100');     // 对方的数值是对方的内心
        expect(turn).not.toContain('普通同事');   // 对方眼中的关系名同理
    });

    it('独居与同居安排都体现在 prompt 里', () => {
        const world = mkWorld({ houses: [{ id: 'h1', name: '合租屋', residentIds: ['a', 'b'] }], memberIds: ['a', 'b', 'c'] });
        const members = [mkChar('a', '小满'), mkChar('b', '阿岚'), mkChar('c', '十一')];
        const turn = buildWorldCharTurn({ world, char: members[0], members, storyTime: '第1天白天', beatsSoFar: [], userName: '' });
        expect(turn).toContain('合租屋：小满、阿岚 同住');
        expect(turn).toContain('十一 独居');
    });
});

describe('applyRelationshipDeltas（有向回填）', () => {
    const members = [{ id: 'a', name: '小满' }, { id: 'b', name: '阿岚' }];

    it('只改"该角色→对方"这条边，反向不动', () => {
        const world = mkWorld({
            relationships: [
                { fromId: 'a', toId: 'b', value: 60 },
                { fromId: 'b', toId: 'a', value: 20 },
            ],
        });
        applyRelationshipDeltas(world, [
            { charId: 'a', charName: '小满', location: 'x', narrative: 'y', mood: 'z', relationshipDeltas: [{ withName: '阿岚', delta: 3 }] },
        ], members);
        expect(world.relationships.find(r => r.fromId === 'a' && r.toId === 'b')!.value).toBe(63);
        expect(world.relationships.find(r => r.fromId === 'b' && r.toId === 'a')!.value).toBe(20);
    });

    it('不存在的边按 50 起步，且数值钳在 0-100', () => {
        const world = mkWorld({ relationships: [{ fromId: 'a', toId: 'b', value: 99 }] });
        applyRelationshipDeltas(world, [
            { charId: 'a', charName: '小满', location: 'x', narrative: 'y', mood: 'z', relationshipDeltas: [{ withName: '阿岚', delta: 5 }] },
            { charId: 'b', charName: '阿岚', location: 'x', narrative: 'y', mood: 'z', relationshipDeltas: [{ withName: '小满', delta: -4 }] },
        ], members);
        expect(world.relationships.find(r => r.fromId === 'a' && r.toId === 'b')!.value).toBe(100);
        expect(world.relationships.find(r => r.fromId === 'b' && r.toId === 'a')!.value).toBe(46);
    });
});

describe('WorldScheduler', () => {
    beforeEach(() => {
        localStorage.removeItem('world_tick_slots');
        localStorage.removeItem('world_tick_fired');
        vi.useFakeTimers();
    });
    afterEach(() => {
        vi.useRealTimers();
        WorldScheduler.onTrigger(() => {});
    });

    it('reconcile：今天已过去的时段视为已耗尽，不补火（防止配置完瞬间连烧）', () => {
        vi.setSystemTime(new Date('2026-06-11T15:00:00')); // 15点：早/午已过
        const fired: string[] = [];
        WorldScheduler.onTrigger((id) => { fired.push(id); });
        WorldScheduler.reconcile([{ worldId: 'w1', slots: ['morning', 'noon', 'evening'] }]);
        const rec = JSON.parse(localStorage.getItem('world_tick_fired')!).w1;
        expect(rec.fired).toEqual(['morning', 'noon']);
        expect(fired).toEqual([]); // 不立即触发
    });

    it('到点触发当天未跑的时段，且每时段一天最多一次', () => {
        vi.setSystemTime(new Date('2026-06-11T08:00:00'));
        const fired: string[] = [];
        WorldScheduler.onTrigger((id, trigger) => { fired.push(`${id}:${trigger}`); });
        WorldScheduler.reconcile([{ worldId: 'w1', slots: ['morning'] }]);
        expect(fired).toEqual([]);
        vi.setSystemTime(new Date('2026-06-11T09:30:00'));
        vi.advanceTimersByTime(61_000); // 主线程轮询
        expect(fired).toEqual(['w1:tick']);
        vi.advanceTimersByTime(10 * 61_000); // 同一天不再重复
        expect(fired).toEqual(['w1:tick']);
    });

    it('跨天后时段配额重置', () => {
        vi.setSystemTime(new Date('2026-06-11T10:00:00'));
        const fired: string[] = [];
        WorldScheduler.onTrigger(() => { fired.push('x'); });
        WorldScheduler.reconcile([{ worldId: 'w1', slots: ['morning'] }]); // 10点：morning 已耗尽
        vi.advanceTimersByTime(61_000);
        expect(fired).toHaveLength(0);
        vi.setSystemTime(new Date('2026-06-12T09:30:00')); // 第二天早上
        vi.advanceTimersByTime(61_000);
        expect(fired).toHaveLength(1);
    });

    it('移除世界后清掉残留', () => {
        WorldScheduler.reconcile([{ worldId: 'w1', slots: ['evening'] }]);
        expect(JSON.parse(localStorage.getItem('world_tick_slots')!).w1).toBeTruthy();
        WorldScheduler.reconcile([]);
        expect(localStorage.getItem('world_tick_slots')).toBeNull();
    });
});
