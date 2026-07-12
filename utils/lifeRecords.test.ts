/**
 * 生活记录：生理期状态机 + [[LIFE:...]] 代记指令执行 + 卡片裁决回滚。
 * IndexedDB 由 test-setup 的 fake-indexeddb 提供，走真实 DB 层。
 */
import { describe, it, expect, afterAll } from 'vitest';
import {
    buildLifeRecordInjection, computePeriodStatus, executeLifeDirectives, resolveLifeRecordCard,
    getPeriodIntervals, isMedPlanDueToday, lifeToday,
} from './lifeRecords';
import { DB } from './db';
import { CharacterProfile, LifeRecord, MedPlan, Message } from '../types';

const noToast = () => {};

const mkPeriod = (kind: 'start' | 'end', date: string, extra?: Partial<LifeRecord>): LifeRecord => ({
    id: `t-${kind}-${date}-${Math.random()}`,
    module: 'period', kind, date,
    timestamp: new Date(`${date}T08:00:00Z`).getTime(),
    payload: {}, recordedBy: 'user', reviewStatus: 'confirmed', ...extra,
});

const mkChar = (overrides?: Partial<CharacterProfile>): CharacterProfile => ({
    id: `char-${Math.random().toString(36).slice(2, 8)}`,
    name: '江屿',
    lifeRecordEnabled: true,
    ...overrides,
} as unknown as CharacterProfile);

describe('computePeriodStatus 生理期状态机', () => {
    it('只有 start：在经期中，天数 1-based', () => {
        const st = computePeriodStatus([mkPeriod('start', '2026-07-01')], null, '2026-07-03');
        expect(st.inPeriod).toBe(true);
        expect(st.dayN).toBe(3);
        expect(st.nextPredicted).toBe('2026-07-29'); // 默认 28 天周期
    });

    it('start + 之后的 end：不在经期', () => {
        const st = computePeriodStatus(
            [mkPeriod('start', '2026-07-01'), mkPeriod('end', '2026-07-05')],
            null, '2026-07-06',
        );
        expect(st.inPeriod).toBe(false);
        expect(st.lastEnd).toBe('2026-07-05');
    });

    it('被否决的 start 不算数', () => {
        const st = computePeriodStatus(
            [mkPeriod('start', '2026-07-01', { reviewStatus: 'rejected' })],
            null, '2026-07-03',
        );
        expect(st.inPeriod).toBe(false);
    });

    it('忘记记结束：超过兜底天数后自动视为已结束', () => {
        const st = computePeriodStatus([mkPeriod('start', '2026-06-01')], null, '2026-07-03');
        expect(st.inPeriod).toBe(false);
    });

    it('自定义周期长度影响预测', () => {
        const st = computePeriodStatus(
            [mkPeriod('start', '2026-07-01')],
            { id: 'main', cycleLength: 30 }, '2026-07-02',
        );
        expect(st.nextPredicted).toBe('2026-07-31');
    });

    it('排卵期预测：排卵日 = 下次经期 − 14 天，排卵期窗口 −5 ~ +1', () => {
        const st = computePeriodStatus([mkPeriod('start', '2026-07-01')], null, '2026-07-08');
        expect(st.nextPredicted).toBe('2026-07-29');
        expect(st.ovulationDate).toBe('2026-07-15');
        expect(st.ovulationStart).toBe('2026-07-10');
        expect(st.ovulationEnd).toBe('2026-07-16');
    });
});

describe('getPeriodIntervals 日历区间', () => {
    it('start+end 配对成闭区间；未闭合区间截到今天', () => {
        const ivs = getPeriodIntervals([
            mkPeriod('start', '2026-06-01'), mkPeriod('end', '2026-06-05'),
            mkPeriod('start', '2026-06-29'),
        ], '2026-07-02');
        expect(ivs).toHaveLength(2);
        expect(ivs[0]).toMatchObject({ start: '2026-06-01', end: '2026-06-05' });
        expect(ivs[1]).toMatchObject({ start: '2026-06-29', end: '2026-07-02', open: true });
    });

    it('连续两个 start：上一段在新开始前一天收口', () => {
        const ivs = getPeriodIntervals([
            mkPeriod('start', '2026-06-01'), mkPeriod('start', '2026-06-04'), mkPeriod('end', '2026-06-08'),
        ], '2026-07-02');
        expect(ivs[0]).toMatchObject({ start: '2026-06-01', end: '2026-06-03' });
        expect(ivs[1]).toMatchObject({ start: '2026-06-04', end: '2026-06-08' });
    });
});

describe('isMedPlanDueToday 药盒频率', () => {
    const mkPlan = (overrides?: Partial<MedPlan>): MedPlan => ({
        id: 'p1', name: '维D', time: '08:00', enabled: true,
        createdAt: new Date('2026-07-01T00:00:00Z').getTime(), ...overrides,
    });

    it('默认（无频率字段）= 长期每天，与旧数据兼容', () => {
        expect(isMedPlanDueToday(mkPlan(), '2026-07-06')).toBe(true);
    });

    it('隔天吃：锚点日起偶数天差才到期', () => {
        const p = mkPlan({ intervalDays: 2, startDate: '2026-07-01' });
        expect(isMedPlanDueToday(p, '2026-07-01')).toBe(true);
        expect(isMedPlanDueToday(p, '2026-07-02')).toBe(false);
        expect(isMedPlanDueToday(p, '2026-07-03')).toBe(true);
    });

    it('短期疗程：日期段外不生效（含结束当天）', () => {
        const p = mkPlan({ planKind: 'course', startDate: '2026-07-01', endDate: '2026-07-05' });
        expect(isMedPlanDueToday(p, '2026-06-30')).toBe(false);
        expect(isMedPlanDueToday(p, '2026-07-05')).toBe(true);
        expect(isMedPlanDueToday(p, '2026-07-06')).toBe(false);
    });

    it('停用的计划永远不到期', () => {
        expect(isMedPlanDueToday(mkPlan({ enabled: false }), '2026-07-06')).toBe(false);
    });
});

describe('executeLifeDirectives 代记指令', () => {
    it('MED 指令：写记录 + 落 life_card + 剥 tag', async () => {
        const char = mkChar();
        const out = await executeLifeDirectives('好，我帮你记下了 [[LIFE:MED|布洛芬]]', char, noToast);
        expect(out).toBe('好，我帮你记下了');

        const records = (await DB.getAllLifeRecords()).filter(r => r.recordedBy === char.id);
        expect(records).toHaveLength(1);
        expect(records[0].module).toBe('med');
        expect(records[0].payload.name).toBe('布洛芬');
        expect(records[0].reviewStatus).toBe('active');

        const msgs = await DB.getMessagesByCharId(char.id, true);
        const card = msgs.find((m: Message) => m.type === 'life_card');
        expect(card).toBeTruthy();
        expect(card!.metadata.recordId).toBe(records[0].id);
    });

    it('同日同药重复代记：不重复写库，卡片标 duplicate', async () => {
        const char = mkChar();
        await executeLifeDirectives('[[LIFE:MED|维生素C]]', char, noToast);
        const char2 = mkChar({ name: '林深' });
        await executeLifeDirectives('[[LIFE:MED|维生素C]]', char2, noToast);

        const records = (await DB.getAllLifeRecords()).filter(r => r.payload.name === '维生素C');
        expect(records).toHaveLength(1); // 只有第一次写进去
        const msgs = await DB.getMessagesByCharId(char2.id, true);
        const card = msgs.find((m: Message) => m.type === 'life_card');
        expect(card!.metadata.duplicate).toBe(true);
    });

    it('总开关关闭：只剥 tag，不写任何东西', async () => {
        const char = mkChar({ lifeRecordEnabled: false });
        const out = await executeLifeDirectives('记好了[[LIFE:MED|阿莫西林]]', char, noToast);
        expect(out).toBe('记好了');
        const records = (await DB.getAllLifeRecords()).filter(r => r.recordedBy === char.id);
        expect(records).toHaveLength(0);
    });

    it('模块小开关关闭：该模块指令被静默丢弃', async () => {
        const char = mkChar({ lifeRecordExerciseEnabled: false });
        const out = await executeLifeDirectives('[[LIFE:EXERCISE|跑步|30分钟]]', char, noToast);
        expect(out).toBe('');
        const records = (await DB.getAllLifeRecords()).filter(r => r.recordedBy === char.id);
        expect(records).toHaveLength(0);
    });

    it('EXPENSE：同步写银行流水，否决时回滚删除', async () => {
        const char = mkChar();
        await executeLifeDirectives('[[LIFE:EXPENSE|38|打车]]', char, noToast);

        const records = (await DB.getAllLifeRecords()).filter(r => r.recordedBy === char.id);
        expect(records).toHaveLength(1);
        const rec = records[0];
        expect(rec.bankTxId).toBeTruthy();
        let txs = await DB.getAllTransactions();
        expect(txs.some(t => t.id === rec.bankTxId && t.amount === 38)).toBe(true);

        // 否决：记录 rejected + 欠反馈 + 银行流水回滚
        const msgs = await DB.getMessagesByCharId(char.id, true);
        const card = msgs.find((m: Message) => m.type === 'life_card')!;
        await resolveLifeRecordCard(card, 'rejected');

        const after = await DB.getLifeRecordById(rec.id);
        expect(after!.reviewStatus).toBe('rejected');
        expect(after!.pendingFeedback).toBe(true);
        txs = await DB.getAllTransactions();
        expect(txs.some(t => t.id === rec.bankTxId)).toBe(false);
    });

    it('不在经期时收到 PERIOD_END：按"无需记录"处理，不写库', async () => {
        const char = mkChar();
        await executeLifeDirectives('[[LIFE:PERIOD_END]]', char, noToast);
        const records = (await DB.getAllLifeRecords()).filter(r => r.recordedBy === char.id);
        expect(records).toHaveLength(0);
        const msgs = await DB.getMessagesByCharId(char.id, true);
        const card = msgs.find((m: Message) => m.type === 'life_card');
        expect(card!.metadata.duplicate).toBe(true);
    });

    it('PERIOD_START 后再次 START：判重；且状态机对今日生效', async () => {
        const charA = mkChar({ name: 'A' });
        await executeLifeDirectives('[[LIFE:PERIOD_START]]', charA, noToast);
        const st = computePeriodStatus(await DB.getAllLifeRecords(), null, lifeToday());
        expect(st.inPeriod).toBe(true);

        const charB = mkChar({ name: 'B' });
        await executeLifeDirectives('[[LIFE:PERIOD_START]]', charB, noToast);
        const starts = (await DB.getAllLifeRecords()).filter(r => r.module === 'period' && r.kind === 'start');
        expect(starts).toHaveLength(1);
    });
});

describe('全局隐藏模块（长按页签隐藏）', () => {
    afterAll(async () => {
        // 复原，避免污染同文件其他潜在用例
        await DB.saveLifeRecordSettings({ id: 'main', hiddenModules: [] });
    });

    it('隐藏的模块：角色开关全开也不执行代记指令', async () => {
        await DB.saveLifeRecordSettings({ id: 'main', hiddenModules: ['med'] });
        const char = mkChar();
        const out = await executeLifeDirectives('记下了[[LIFE:MED|感冒灵]]', char, noToast);
        expect(out).toBe('记下了');
        const records = (await DB.getAllLifeRecords()).filter(r => r.recordedBy === char.id);
        expect(records).toHaveLength(0);
    });

    it('隐藏的模块：注入里不出现对应数据与指令说明', async () => {
        await DB.saveLifeRecordSettings({ id: 'main', hiddenModules: ['med', 'exercise'] });
        const char = mkChar();
        const text = await buildLifeRecordInjection(char, '小鱼');
        expect(text).toContain('生理期');
        expect(text).not.toContain('今日用药计划');
        expect(text).not.toContain('LIFE:MED');
        expect(text).not.toContain('锻炼');
        expect(text).not.toContain('LIFE:EXERCISE');
    });

    it('全部模块隐藏：整段注入为空', async () => {
        await DB.saveLifeRecordSettings({ id: 'main', hiddenModules: ['period', 'med', 'expense', 'exercise'] });
        const char = mkChar();
        const text = await buildLifeRecordInjection(char, '小鱼');
        expect(text).toBe('');
    });
});
