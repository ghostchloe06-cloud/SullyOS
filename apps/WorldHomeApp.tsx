/**
 * 「家园」—— 同世界观多角色共同生活的大世界。
 *
 * 三个视图：
 *   - list：世界列表 + 新建
 *   - edit：世界编辑器（世界观/模式/成员/居住安排/NPC/关系/离线 tick/API 覆盖）
 *   - world：大世界主视图（观测推进、拜访各家、关系条、NPC 动静、时间线）
 *
 * 演绎引擎跑在 OSContext 全局（WorldScheduler.onTrigger → runWorldEpisode），
 * 本组件只负责触发与观察——用户点完"观测"就算切去和别人私聊，演绎照样完成。
 */
import React, { useState, useEffect, useCallback, useMemo } from 'react';
import { useOS } from '../context/OSContext';
import {
    ArrowLeft, Plus, GearSix, Eye, Trash, House, UsersThree,
    CaretRight, CaretDown, Sparkle, MapPin, DeviceMobile, X,
} from '@phosphor-icons/react';
import { DB } from '../utils/db';
import { getChibi } from '../utils/vrWorld/chibi';
import { WorldScheduler, WorldTickSlot } from '../utils/worldHome/scheduler';
import { isWorldRunning } from '../utils/worldHome/engine';
import { storyTimeLabel, houseOf } from '../utils/worldHome/prompts';
import type { WorldProfile, WorldEpisode, WorldHomeMode, WorldNPC, WorldHouse, CharacterProfile, WorldCharBeat } from '../types';

const genId = (p: string) => `${p}_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 7)}`;

const MODE_INFO: Record<WorldHomeMode, { name: string; desc: string }> = {
    light: { name: '轻度 · 以你为主', desc: '只是观察角色生活的一个切面。世界里 ta 依旧以你为最重要的人——和聊天里完全一致。' },
    medium: { name: '中度 · 你是一份子', desc: '你是这个世界的普通一员，存在但不特殊，角色不围着你转。' },
    heavy: { name: '重度 · 无你世界', desc: '你不存在（或只是透明的幽灵）。角色之间自行生活，演绎中完全无视你。' },
};

const TICK_SLOT_INFO: { id: WorldTickSlot; label: string }[] = [
    { id: 'morning', label: '早（9点后）' },
    { id: 'noon', label: '午（14点后）' },
    { id: 'evening', label: '晚（21点后）' },
];

/** Q版小人（彼方捏人系统的 chibi，兜底头像）。 */
const ChibiFigure: React.FC<{ char: CharacterProfile; size?: number }> = ({ char, size = 56 }) => {
    const c = getChibi(char);
    if (!c.img) {
        return <div className="rounded-full bg-emerald-200/60 flex items-center justify-center text-emerald-800 font-bold" style={{ width: size, height: size }}>{char.name.slice(0, 1)}</div>;
    }
    return (
        <div className="flex flex-col items-center" style={{ width: size }}>
            <img
                src={c.img}
                alt={char.name}
                className={c.isFallback ? 'rounded-full object-cover' : 'object-contain'}
                style={{
                    width: size, height: size,
                    transform: `${c.flip ? 'scaleX(-1) ' : ''}scale(${c.isFallback ? 1 : c.scale})`,
                    transformOrigin: 'bottom center',
                }}
                draggable={false}
            />
        </div>
    );
};

// ============================================================
// 编辑器
// ============================================================
const WorldEditor: React.FC<{
    draft: WorldProfile;
    characters: CharacterProfile[];
    onSave: (w: WorldProfile) => void;
    onCancel: () => void;
    onDelete?: () => void;
}> = ({ draft, characters, onSave, onCancel, onDelete }) => {
    const [w, setW] = useState<WorldProfile>(draft);
    const upd = (updates: Partial<WorldProfile>) => setW(prev => ({ ...prev, ...updates }));
    const members = useMemo(() => w.memberIds.map(id => characters.find(c => c.id === id)).filter(Boolean) as CharacterProfile[], [w.memberIds, characters]);

    const toggleMember = (id: string) => {
        if (w.memberIds.includes(id)) {
            upd({
                memberIds: w.memberIds.filter(m => m !== id),
                houses: w.houses.map(h => ({ ...h, residentIds: h.residentIds.filter(r => r !== id) })),
                relationships: w.relationships.filter(r => r.fromId !== id && r.toId !== id),
            });
        } else {
            upd({ memberIds: [...w.memberIds, id] });
        }
    };

    const toggleResident = (houseId: string, charId: string) => {
        upd({
            houses: w.houses.map(h => {
                if (h.id !== houseId) return { ...h, residentIds: h.residentIds.filter(r => r !== charId) };
                return h.residentIds.includes(charId)
                    ? { ...h, residentIds: h.residentIds.filter(r => r !== charId) }
                    : { ...h, residentIds: [...h.residentIds, charId] };
            }),
        });
    };

    // 成员两两关系（编辑用：每对展开成 A→B 和 B→A 两条有向边，可以不对等）
    const pairs = useMemo(() => {
        const out: { aId: string; bId: string; aName: string; bName: string }[] = [];
        for (let i = 0; i < members.length; i++) {
            for (let j = i + 1; j < members.length; j++) {
                out.push({ aId: members[i].id, bId: members[j].id, aName: members[i].name, bName: members[j].name });
            }
        }
        return out;
    }, [members]);

    const relOf = (fromId: string, toId: string) => w.relationships.find(r => r.fromId === fromId && r.toId === toId);
    const updRel = (fromId: string, toId: string, updates: { label?: string; value?: number }) => {
        const existing = relOf(fromId, toId);
        if (existing) {
            upd({ relationships: w.relationships.map(r => (r.fromId === fromId && r.toId === toId) ? { ...r, ...updates } : r) });
        } else {
            upd({ relationships: [...w.relationships, { fromId, toId, value: 50, ...updates }] });
        }
    };

    const inputCls = 'w-full px-3 py-2 rounded-xl bg-white border border-emerald-200 text-sm text-stone-800 focus:outline-none focus:border-emerald-400';
    const sectionCls = 'bg-white/70 rounded-2xl p-3.5 border border-emerald-100 space-y-2.5';
    const labelCls = 'text-[11px] font-bold text-emerald-800/80 tracking-wide';

    return (
        <div className="flex-1 overflow-y-auto no-scrollbar px-4 pb-28 pt-3 space-y-3">
            <div className={sectionCls}>
                <div className={labelCls}>世界名字</div>
                <input className={inputCls} value={w.name} onChange={e => upd({ name: e.target.value })} placeholder="比如：栗子镇" />
                <div className={labelCls}>世界观（这个世界是什么样的、大家以什么身份生活）</div>
                <textarea className={`${inputCls} h-28 resize-none`} value={w.worldview} onChange={e => upd({ worldview: e.target.value })}
                    placeholder="一个海边小镇，大家是多年的老邻居。镇上有一家面包店和一座旧灯塔……" />
            </div>

            <div className={sectionCls}>
                <div className={labelCls}>模式（你在这个世界里的存在感）</div>
                {(Object.keys(MODE_INFO) as WorldHomeMode[]).map(m => (
                    <button key={m} onClick={() => upd({ mode: m })}
                        className={`w-full text-left px-3 py-2.5 rounded-xl border transition-colors ${w.mode === m ? 'bg-emerald-600 border-emerald-600 text-white' : 'bg-white border-emerald-200 text-stone-700'}`}>
                        <div className="text-[12px] font-bold">{MODE_INFO[m].name}</div>
                        <div className={`text-[10.5px] mt-0.5 leading-snug ${w.mode === m ? 'text-emerald-50/90' : 'text-stone-500'}`}>{MODE_INFO[m].desc}</div>
                    </button>
                ))}
            </div>

            <div className={sectionCls}>
                <div className={labelCls}>住进这个世界的角色（同一世界观的放一起）</div>
                <div className="flex flex-wrap gap-2">
                    {characters.map(c => (
                        <button key={c.id} onClick={() => toggleMember(c.id)}
                            className={`flex items-center gap-1.5 pl-1 pr-2.5 py-1 rounded-full border transition-colors ${w.memberIds.includes(c.id) ? 'bg-emerald-600 border-emerald-600 text-white' : 'bg-white border-emerald-200 text-stone-700'}`}>
                            <img src={c.avatar} className="w-6 h-6 rounded-full object-cover" alt="" />
                            <span className="text-[12px] font-semibold">{c.name}</span>
                        </button>
                    ))}
                </div>
                {characters.length === 0 && <div className="text-[11px] text-stone-400">还没有角色，先去「神经链接」创建</div>}
            </div>

            <div className={sectionCls}>
                <div className="flex items-center justify-between">
                    <div className={labelCls}>居住安排（没分进小屋的成员独居）</div>
                    <button onClick={() => upd({ houses: [...w.houses, { id: genId('wh'), name: `小屋 ${w.houses.length + 1}`, residentIds: [] }] })}
                        className="text-[11px] px-2 py-1 rounded-lg bg-emerald-100 text-emerald-700 font-bold flex items-center gap-1"><Plus size={12} weight="bold" />同居小屋</button>
                </div>
                {w.houses.map(h => (
                    <div key={h.id} className="rounded-xl border border-emerald-200 bg-white p-2.5 space-y-2">
                        <div className="flex items-center gap-2">
                            <House size={14} className="text-emerald-600 shrink-0" weight="bold" />
                            <input className="flex-1 px-2 py-1 rounded-lg bg-emerald-50/60 border border-emerald-100 text-[12px]" value={h.name}
                                onChange={e => upd({ houses: w.houses.map(x => x.id === h.id ? { ...x, name: e.target.value } : x) })} />
                            <button onClick={() => upd({ houses: w.houses.filter(x => x.id !== h.id) })} className="p-1 text-stone-400"><X size={14} /></button>
                        </div>
                        <div className="flex flex-wrap gap-1.5">
                            {members.map(m => (
                                <button key={m.id} onClick={() => toggleResident(h.id, m.id)}
                                    className={`text-[11px] px-2 py-0.5 rounded-full border ${h.residentIds.includes(m.id) ? 'bg-emerald-600 border-emerald-600 text-white' : 'bg-white border-emerald-200 text-stone-600'}`}>
                                    {m.name}
                                </button>
                            ))}
                            {members.length === 0 && <span className="text-[10px] text-stone-400">先在上面选成员</span>}
                        </div>
                    </div>
                ))}
            </div>

            <div className={sectionCls}>
                <div className="flex items-center justify-between">
                    <div className={labelCls}>NPC（无记忆，纯为世界观服务，一次调用全演完）</div>
                    <button onClick={() => upd({ npcs: [...w.npcs, { id: genId('npc'), name: '', persona: '', emoji: '🙂' }] })}
                        className="text-[11px] px-2 py-1 rounded-lg bg-emerald-100 text-emerald-700 font-bold flex items-center gap-1"><Plus size={12} weight="bold" />NPC</button>
                </div>
                {w.npcs.map(n => (
                    <div key={n.id} className="rounded-xl border border-emerald-200 bg-white p-2.5 space-y-1.5">
                        <div className="flex items-center gap-2">
                            <input className="w-10 px-1 py-1 rounded-lg bg-emerald-50/60 border border-emerald-100 text-center text-[14px]" value={n.emoji || ''} maxLength={2}
                                onChange={e => upd({ npcs: w.npcs.map(x => x.id === n.id ? { ...x, emoji: e.target.value } : x) })} />
                            <input className="flex-1 px-2 py-1 rounded-lg bg-emerald-50/60 border border-emerald-100 text-[12px]" value={n.name} placeholder="名字"
                                onChange={e => upd({ npcs: w.npcs.map(x => x.id === n.id ? { ...x, name: e.target.value } : x) })} />
                            <button onClick={() => upd({ npcs: w.npcs.filter(x => x.id !== n.id) })} className="p-1 text-stone-400"><X size={14} /></button>
                        </div>
                        <input className="w-full px-2 py-1 rounded-lg bg-emerald-50/60 border border-emerald-100 text-[12px]" value={n.persona} placeholder="一句话人设（面包店老板娘，热心肠爱塞吃的）"
                            onChange={e => upd({ npcs: w.npcs.map(x => x.id === n.id ? { ...x, persona: e.target.value } : x) })} />
                    </div>
                ))}
            </div>

            {pairs.length > 0 && (
                <div className={sectionCls}>
                    <div className={labelCls}>初始关系（有向：两边可以不对等，比如单恋/单方面死对头；演绎会各自调整）</div>
                    {pairs.map(p => (
                        <div key={`${p.aId}_${p.bId}`} className="rounded-xl border border-emerald-200 bg-white p-2.5 space-y-2.5">
                            {([[p.aId, p.bId, p.aName, p.bName], [p.bId, p.aId, p.bName, p.aName]] as const).map(([fromId, toId, fromName, toName]) => {
                                const rel = relOf(fromId, toId);
                                return (
                                    <div key={`${fromId}_${toId}`} className="space-y-1.5">
                                        <div className="flex items-center gap-2">
                                            <span className="text-[12px] font-bold text-stone-700 shrink-0">{fromName} → {toName}</span>
                                            <input className="flex-1 min-w-0 px-2 py-0.5 rounded-lg bg-emerald-50/60 border border-emerald-100 text-[11px]" placeholder={`${fromName} 眼中的关系（挚友/单恋/死对头…）`}
                                                value={rel?.label || ''} onChange={e => updRel(fromId, toId, { label: e.target.value })} />
                                            <span className="text-[11px] text-emerald-700 font-bold w-7 text-right">{rel?.value ?? 50}</span>
                                        </div>
                                        <input type="range" min={0} max={100} value={rel?.value ?? 50} className="w-full accent-emerald-600"
                                            onChange={e => updRel(fromId, toId, { value: parseInt(e.target.value, 10) })} />
                                    </div>
                                );
                            })}
                        </div>
                    ))}
                </div>
            )}

            <div className={sectionCls}>
                <div className={labelCls}>离线 tick（不开 App 世界也慢慢走；每个时段当天最多一轮，链式调用 N 个角色比较贵）</div>
                <div className="flex gap-2">
                    {TICK_SLOT_INFO.map(s => {
                        const on = (w.offlineTickSlots || []).includes(s.id);
                        return (
                            <button key={s.id} onClick={() => upd({ offlineTickSlots: on ? (w.offlineTickSlots || []).filter(x => x !== s.id) : [...(w.offlineTickSlots || []), s.id] })}
                                className={`flex-1 text-[11px] py-1.5 rounded-xl border font-bold ${on ? 'bg-emerald-600 border-emerald-600 text-white' : 'bg-white border-emerald-200 text-stone-600'}`}>
                                {s.label}
                            </button>
                        );
                    })}
                </div>
                <label className="flex items-center justify-between pt-1">
                    <span className="text-[12px] text-stone-700">生成内容注入聊天（world_card，进上下文与记忆）</span>
                    <input type="checkbox" checked={w.injectToChat !== false} onChange={e => upd({ injectToChat: e.target.checked })} className="w-4 h-4 accent-emerald-600" />
                </label>
            </div>

            <div className={sectionCls}>
                <div className={labelCls}>独立 API 覆盖（可选，不填用全局）</div>
                <input className={inputCls} placeholder="Base URL" value={w.api?.baseUrl || ''}
                    onChange={e => upd({ api: { baseUrl: e.target.value, apiKey: w.api?.apiKey || '', model: w.api?.model || '' } })} />
                <input className={inputCls} placeholder="API Key" type="password" value={w.api?.apiKey || ''}
                    onChange={e => upd({ api: { baseUrl: w.api?.baseUrl || '', apiKey: e.target.value, model: w.api?.model || '' } })} />
                <input className={inputCls} placeholder="Model" value={w.api?.model || ''}
                    onChange={e => upd({ api: { baseUrl: w.api?.baseUrl || '', apiKey: w.api?.apiKey || '', model: e.target.value } })} />
            </div>

            {onDelete && (
                <button onClick={onDelete} className="w-full py-2.5 rounded-2xl border border-red-200 text-red-500 text-[12px] font-bold flex items-center justify-center gap-1.5">
                    <Trash size={14} weight="bold" />删除这个世界（连同演绎历史）
                </button>
            )}

            <div className="fixed bottom-0 left-0 right-0 p-3 bg-gradient-to-t from-emerald-50 via-emerald-50/95 to-transparent flex gap-2.5 max-w-md mx-auto">
                <button onClick={onCancel} className="flex-1 py-2.5 rounded-2xl bg-white border border-emerald-200 text-stone-600 text-[13px] font-bold">取消</button>
                <button
                    onClick={() => {
                        const cleaned: WorldProfile = {
                            ...w,
                            name: w.name.trim() || '未命名世界',
                            npcs: w.npcs.filter(n => n.name.trim()),
                            api: w.api?.baseUrl?.trim() ? w.api : undefined,
                            updatedAt: Date.now(),
                        };
                        onSave(cleaned);
                    }}
                    disabled={w.memberIds.length === 0}
                    className="flex-[2] py-2.5 rounded-2xl bg-emerald-600 text-white text-[13px] font-bold disabled:opacity-40">
                    保存世界
                </button>
            </div>
        </div>
    );
};

// ============================================================
// 大世界视图
// ============================================================
const WorldView: React.FC<{
    world: WorldProfile;
    characters: CharacterProfile[];
    onEdit: () => void;
    onWorldUpdated: () => void;
}> = ({ world, characters, onEdit, onWorldUpdated }) => {
    const { addToast } = useOS();
    const [episodes, setEpisodes] = useState<WorldEpisode[]>([]);
    const [progress, setProgress] = useState<{ done: number; total: number; charName?: string } | null>(
        isWorldRunning(world.id) ? { done: 0, total: world.memberIds.length } : null
    );
    const [openHouseId, setOpenHouseId] = useState<string | null>(null);
    const [openEpisodeId, setOpenEpisodeId] = useState<string | null>(null);

    const members = useMemo(() => world.memberIds.map(id => characters.find(c => c.id === id)).filter(Boolean) as CharacterProfile[], [world.memberIds, characters]);
    const latest = episodes[0];

    const loadEpisodes = useCallback(async () => {
        setEpisodes(await DB.getWorldEpisodes(world.id, 30));
    }, [world.id]);

    useEffect(() => { loadEpisodes(); }, [loadEpisodes]);

    useEffect(() => {
        const onStart = (e: any) => { if (e.detail?.worldId === world.id) setProgress({ done: 0, total: e.detail.total || members.length }); };
        const onBeat = (e: any) => { if (e.detail?.worldId === world.id) setProgress({ done: e.detail.done || 0, total: e.detail.total || members.length, charName: e.detail.charName }); };
        const onDone = (e: any) => { if (e.detail?.worldId === world.id) { loadEpisodes(); onWorldUpdated(); } };
        const onEnd = (e: any) => { if (e.detail?.worldId === world.id) setProgress(null); };
        window.addEventListener('world-episode-start', onStart);
        window.addEventListener('world-beat-done', onBeat);
        window.addEventListener('world-episode-done', onDone);
        window.addEventListener('world-episode-end', onEnd);
        return () => {
            window.removeEventListener('world-episode-start', onStart);
            window.removeEventListener('world-beat-done', onBeat);
            window.removeEventListener('world-episode-done', onDone);
            window.removeEventListener('world-episode-end', onEnd);
        };
    }, [world.id, members.length, loadEpisodes, onWorldUpdated]);

    const observe = () => {
        if (isWorldRunning(world.id)) { addToast('这一轮还在演绎中', 'error'); return; }
        if (members.length === 0) { addToast('这个世界还没有住进角色', 'error'); return; }
        setProgress({ done: 0, total: members.length });
        WorldScheduler.triggerNow(world.id);
        addToast('观测开始——世界推进半天，可以先去做别的', 'success');
    };

    // 拜访视图的住房编排：配置的小屋 + 没分配的成员各自独居
    const visitHouses = useMemo(() => {
        const out: { house: WorldHouse; residents: CharacterProfile[] }[] = [];
        for (const h of world.houses) {
            const residents = h.residentIds.map(id => members.find(m => m.id === id)).filter(Boolean) as CharacterProfile[];
            if (residents.length > 0) out.push({ house: h, residents });
        }
        for (const m of members) {
            if (!houseOf(world, m.id)) out.push({ house: { id: `solo_${m.id}`, name: `${m.name} 的小屋`, residentIds: [m.id] }, residents: [m] });
        }
        return out;
    }, [world, members]);

    const beatOf = (charId: string): WorldCharBeat | undefined => latest?.beats.find(b => b.charId === charId);
    const nameOf = (id: string) => members.find(m => m.id === id)?.name || world.npcs.find(n => n.id === id)?.name || '?';

    return (
        <div className="flex-1 overflow-y-auto no-scrollbar px-4 pb-24 pt-3 space-y-3.5">
            {/* 状态条 + 观测 */}
            <div className="bg-white/70 rounded-2xl p-3.5 border border-emerald-100">
                <div className="flex items-center justify-between">
                    <div>
                        <div className="text-[11px] text-emerald-700/70 font-bold tracking-wide">{MODE_INFO[world.mode].name}</div>
                        <div className="text-[15px] font-black text-stone-800 mt-0.5">{storyTimeLabel(world.storyClock)}{latest ? '' : ' · 尚未开始'}</div>
                    </div>
                    <button onClick={observe} disabled={!!progress}
                        className="px-4 py-2.5 rounded-2xl bg-emerald-600 text-white text-[12.5px] font-bold flex items-center gap-1.5 disabled:opacity-50 active:scale-95 transition-transform">
                        <Eye size={16} weight="bold" />{progress ? '演绎中…' : '观测 · 推进半天'}
                    </button>
                </div>
                {progress && (
                    <div className="mt-2.5">
                        <div className="flex justify-between text-[10px] text-emerald-700/80 mb-1">
                            <span>{progress.charName ? `正在演绎：${progress.charName}` : '世界引擎运转中（NPC）…'}</span>
                            <span>{progress.done}/{progress.total}</span>
                        </div>
                        <div className="h-1.5 rounded-full bg-emerald-100 overflow-hidden">
                            <div className="h-full bg-emerald-500 transition-all" style={{ width: `${Math.round((progress.done / Math.max(1, progress.total)) * 100)}%` }} />
                        </div>
                        <div className="text-[9.5px] text-stone-400 mt-1">可以离开这个界面，演绎在后台继续</div>
                    </div>
                )}
            </div>

            {/* 各家小屋（拜访） */}
            <div className="space-y-2">
                <div className="text-[11px] font-bold text-emerald-800/70 tracking-wide px-1 flex items-center gap-1"><House size={12} weight="bold" />去串门</div>
                {visitHouses.map(({ house, residents }) => {
                    const open = openHouseId === house.id;
                    return (
                        <div key={house.id} className="bg-white/70 rounded-2xl border border-emerald-100 overflow-hidden">
                            <button className="w-full flex items-center gap-3 p-3" onClick={() => setOpenHouseId(open ? null : house.id)}>
                                <div className="flex -space-x-3 items-end">
                                    {residents.map(r => <ChibiFigure key={r.id} char={r} size={46} />)}
                                </div>
                                <div className="flex-1 text-left min-w-0">
                                    <div className="text-[13px] font-bold text-stone-800">{house.name}</div>
                                    <div className="text-[10.5px] text-stone-500 truncate">
                                        {residents.map(r => {
                                            const b = beatOf(r.id);
                                            return b ? `${r.name}：${b.location}` : `${r.name}：还没动静`;
                                        }).join(' · ')}
                                    </div>
                                </div>
                                {open ? <CaretDown size={14} className="text-stone-400" /> : <CaretRight size={14} className="text-stone-400" />}
                            </button>
                            {open && (
                                <div className="px-3 pb-3 space-y-2.5">
                                    {residents.map(r => {
                                        const b = beatOf(r.id);
                                        if (!b) return <div key={r.id} className="text-[11px] text-stone-400 px-1">{r.name} 这半天还没有故事，先观测一轮。</div>;
                                        return (
                                            <div key={r.id} className="rounded-xl bg-emerald-50/70 border border-emerald-100 p-3">
                                                <div className="flex items-center gap-1.5 text-[11px] text-emerald-800 font-bold">
                                                    <MapPin size={11} weight="bold" />{b.charName} 在{b.location} · {b.mood}
                                                </div>
                                                <p className="text-[12px] leading-[1.6] text-stone-700 mt-1.5 whitespace-pre-wrap">{b.narrative}</p>
                                                {b.statusPanel && (
                                                    <div className="mt-2 flex flex-wrap gap-1">
                                                        {Object.entries(b.statusPanel).map(([k, v]) => (
                                                            <span key={k} className="text-[9.5px] px-1.5 py-0.5 rounded-full bg-white text-emerald-700 border border-emerald-200">{k} {String(v)}</span>
                                                        ))}
                                                    </div>
                                                )}
                                                {(b.phone?.posts?.length || b.phone?.dms?.length) ? (
                                                    <div className="mt-2 rounded-lg bg-white/80 border border-emerald-100 p-2 space-y-1">
                                                        <div className="text-[9.5px] text-emerald-700/70 font-bold flex items-center gap-1"><DeviceMobile size={10} weight="bold" />Ta 的手机</div>
                                                        {(b.phone?.posts || []).map((p, i) => <div key={`p${i}`} className="text-[10.5px] text-stone-600">动态：{p}</div>)}
                                                        {(b.phone?.dms || []).map((d, i) => <div key={`d${i}`} className="text-[10.5px] text-stone-600">→ {d.to}：{d.lines.join(' / ')}</div>)}
                                                    </div>
                                                ) : null}
                                            </div>
                                        );
                                    })}
                                </div>
                            )}
                        </div>
                    );
                })}
            </div>

            {/* 关系条（有向：同一对上下两根，直观看出不对等） */}
            {world.relationships.length > 0 && (
                <div className="bg-white/70 rounded-2xl p-3.5 border border-emerald-100 space-y-3">
                    <div className="text-[11px] font-bold text-emerald-800/70 tracking-wide flex items-center gap-1"><UsersThree size={12} weight="bold" />关系</div>
                    {(() => {
                        // 同一对的两条有向边排到一起展示
                        const seen = new Set<string>();
                        const groups: { fwd: typeof world.relationships[0]; rev?: typeof world.relationships[0] }[] = [];
                        for (const r of world.relationships) {
                            const key = [r.fromId, r.toId].sort().join('|');
                            if (seen.has(key)) continue;
                            seen.add(key);
                            groups.push({ fwd: r, rev: world.relationships.find(x => x.fromId === r.toId && x.toId === r.fromId) });
                        }
                        return groups.map(({ fwd, rev }) => (
                            <div key={`${fwd.fromId}_${fwd.toId}`} className="rounded-xl bg-emerald-50/50 border border-emerald-100 p-2.5 space-y-2">
                                {[fwd, rev].filter(Boolean).map(r => (
                                    <div key={`${r!.fromId}_${r!.toId}`}>
                                        <div className="flex justify-between text-[11px] text-stone-700">
                                            <span className="font-semibold">{nameOf(r!.fromId)} → {nameOf(r!.toId)}{r!.label ? ` · ${r!.label}` : ''}</span>
                                            <span className="text-emerald-700 font-bold">{r!.value}</span>
                                        </div>
                                        <div className="h-1.5 rounded-full bg-emerald-100 overflow-hidden mt-1">
                                            <div className="h-full bg-gradient-to-r from-emerald-400 to-amber-400" style={{ width: `${r!.value}%` }} />
                                        </div>
                                    </div>
                                ))}
                            </div>
                        ));
                    })()}
                </div>
            )}

            {/* 镇上的动静（NPC） */}
            {latest?.npcScene && (
                <div className="bg-white/70 rounded-2xl p-3.5 border border-emerald-100">
                    <div className="text-[11px] font-bold text-emerald-800/70 tracking-wide flex items-center gap-1 mb-1.5">
                        <Sparkle size={12} weight="bold" />镇上的动静 · {latest.storyTime}
                    </div>
                    <p className="text-[12px] leading-[1.6] text-stone-700 whitespace-pre-wrap">{latest.npcScene}</p>
                    {world.npcs.length > 0 && (
                        <div className="mt-2 flex flex-wrap gap-1.5">
                            {world.npcs.map(n => (
                                <span key={n.id} className="text-[10px] px-2 py-0.5 rounded-full bg-emerald-50 border border-emerald-200 text-emerald-800">{n.emoji || '🙂'} {n.name}</span>
                            ))}
                        </div>
                    )}
                </div>
            )}

            {/* 时间线 */}
            {episodes.length > 0 && (
                <div className="space-y-2">
                    <div className="text-[11px] font-bold text-emerald-800/70 tracking-wide px-1">世界的时间线</div>
                    {episodes.map(ep => {
                        const open = openEpisodeId === ep.id;
                        return (
                            <div key={ep.id} className="bg-white/70 rounded-2xl border border-emerald-100 overflow-hidden">
                                <button className="w-full flex items-center gap-2 p-3 text-left" onClick={() => setOpenEpisodeId(open ? null : ep.id)}>
                                    <div className="flex-1 min-w-0">
                                        <div className="text-[12px] font-bold text-stone-800">{ep.storyTime} <span className="text-[9.5px] font-normal text-stone-400">· {ep.trigger === 'tick' ? '离线推进' : '观测'} · {new Date(ep.createdAt).toLocaleString('zh-CN', { month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit' })}</span></div>
                                        {!open && <div className="text-[10.5px] text-stone-500 truncate mt-0.5">{ep.summary}</div>}
                                    </div>
                                    {open ? <CaretDown size={14} className="text-stone-400 shrink-0" /> : <CaretRight size={14} className="text-stone-400 shrink-0" />}
                                </button>
                                {open && (
                                    <div className="px-3 pb-3 space-y-2">
                                        {ep.npcScene && <p className="text-[11px] leading-relaxed text-stone-500 italic whitespace-pre-wrap">{ep.npcScene}</p>}
                                        {ep.beats.map(b => (
                                            <div key={b.charId} className="rounded-xl bg-emerald-50/70 border border-emerald-100 p-2.5">
                                                <div className="text-[11px] font-bold text-emerald-800">{b.charName} · {b.location} · {b.mood}</div>
                                                <p className="text-[11.5px] leading-[1.55] text-stone-700 mt-1 whitespace-pre-wrap">{b.narrative}</p>
                                            </div>
                                        ))}
                                    </div>
                                )}
                            </div>
                        );
                    })}
                </div>
            )}

            <button onClick={onEdit} className="w-full py-2.5 rounded-2xl bg-white border border-emerald-200 text-stone-600 text-[12px] font-bold flex items-center justify-center gap-1.5">
                <GearSix size={14} weight="bold" />世界设置
            </button>
        </div>
    );
};

// ============================================================
// 主组件
// ============================================================
const WorldHomeApp: React.FC = () => {
    const { closeApp, characters, addToast } = useOS();
    const [worlds, setWorlds] = useState<WorldProfile[]>([]);
    const [view, setView] = useState<'list' | 'edit' | 'world'>('list');
    const [activeId, setActiveId] = useState<string | null>(null);
    const [draft, setDraft] = useState<WorldProfile | null>(null);

    const reload = useCallback(async () => { setWorlds(await DB.getWorlds()); }, []);
    useEffect(() => { reload(); }, [reload]);

    const active = worlds.find(w => w.id === activeId) || null;

    const startCreate = () => {
        setDraft({
            id: genId('world'), name: '', worldview: '', mode: 'light',
            memberIds: [], npcs: [], houses: [], relationships: [],
            offlineTickSlots: [], storyClock: 0, injectToChat: true,
            createdAt: Date.now(), updatedAt: Date.now(),
        });
        setView('edit');
    };

    const saveWorld = async (w: WorldProfile) => {
        await DB.saveWorld(w);
        // 调度表对账：所有世界的离线 tick 设置一起重建
        const all = await DB.getWorlds();
        WorldScheduler.reconcile(all.filter(x => (x.offlineTickSlots?.length || 0) > 0).map(x => ({ worldId: x.id, slots: x.offlineTickSlots! })));
        setWorlds(all);
        setActiveId(w.id);
        setDraft(null);
        setView('world');
        addToast('世界已保存', 'success');
    };

    const deleteWorld = async (id: string) => {
        await DB.deleteWorld(id);
        const all = await DB.getWorlds();
        WorldScheduler.reconcile(all.filter(x => (x.offlineTickSlots?.length || 0) > 0).map(x => ({ worldId: x.id, slots: x.offlineTickSlots! })));
        setWorlds(all);
        setDraft(null);
        setActiveId(null);
        setView('list');
        addToast('世界已删除', 'success');
    };

    const headerTitle = view === 'edit' ? (draft && worlds.some(w => w.id === draft.id) ? '世界设置' : '创建世界')
        : view === 'world' ? (active?.name || '家园')
        : '家园';

    const goBack = () => {
        if (view === 'edit') { setDraft(null); setView(activeId && worlds.some(w => w.id === activeId) ? 'world' : 'list'); }
        else if (view === 'world') { setActiveId(null); setView('list'); }
        else closeApp();
    };

    return (
        <div className="h-full w-full bg-emerald-50 flex flex-col text-stone-900">
            {/* 顶栏 */}
            <div className="h-20 flex items-end pb-3 px-4 border-b border-emerald-200/70 shrink-0 bg-emerald-50 sticky top-0 z-10">
                <div className="flex items-center gap-2 w-full">
                    <button onClick={goBack} className="p-2 -ml-2 rounded-full hover:bg-black/5 active:scale-90 transition-transform">
                        <ArrowLeft size={22} weight="bold" className="text-emerald-800" />
                    </button>
                    <h1 className="text-xl font-bold tracking-wide text-emerald-900 flex items-center gap-2 truncate">
                        <House size={22} weight="bold" />{headerTitle}
                    </h1>
                    {view === 'list' && (
                        <button onClick={startCreate} className="ml-auto p-2 rounded-full hover:bg-black/5 active:scale-90 transition-transform">
                            <Plus size={20} weight="bold" className="text-emerald-800" />
                        </button>
                    )}
                </div>
            </div>

            {view === 'list' && (
                <div className="flex-1 overflow-y-auto no-scrollbar px-4 pb-24 pt-3 space-y-2.5">
                    <div className="rounded-2xl bg-emerald-900 text-emerald-50 p-3.5 text-[11px] leading-relaxed">
                        把同一世界观的角色放进一个世界，让他们在你不看的时候慢慢生活——你每次<b>观测</b>，世界推进半天。
                        每个角色一次独立调用（没人开上帝视角），NPC 由世界引擎一口气演完。生成内容会以卡片注入各自的聊天与记忆。
                    </div>
                    {worlds.map(w => {
                        const ms = w.memberIds.map(id => characters.find(c => c.id === id)).filter(Boolean) as CharacterProfile[];
                        return (
                            <button key={w.id} onClick={() => { setActiveId(w.id); setView('world'); }}
                                className="w-full bg-white/70 rounded-2xl border border-emerald-100 p-3.5 flex items-center gap-3 text-left active:scale-[0.99] transition-transform">
                                <div className="flex -space-x-3 items-end shrink-0">
                                    {ms.slice(0, 4).map(m => <ChibiFigure key={m.id} char={m} size={44} />)}
                                </div>
                                <div className="flex-1 min-w-0">
                                    <div className="text-[14px] font-bold text-stone-800 truncate">{w.name}</div>
                                    <div className="text-[10.5px] text-stone-500 mt-0.5">
                                        {MODE_INFO[w.mode].name} · {ms.length} 位角色{w.npcs.length > 0 ? ` · ${w.npcs.length} 个NPC` : ''} · {storyTimeLabel(w.storyClock)}
                                    </div>
                                </div>
                                <CaretRight size={14} className="text-stone-400 shrink-0" />
                            </button>
                        );
                    })}
                    {worlds.length === 0 && (
                        <button onClick={startCreate} className="w-full rounded-2xl border-2 border-dashed border-emerald-300 py-10 text-emerald-700 text-[13px] font-bold flex flex-col items-center gap-2">
                            <Plus size={24} weight="bold" />创建第一个世界
                        </button>
                    )}
                </div>
            )}

            {view === 'edit' && draft && (
                <WorldEditor
                    draft={draft}
                    characters={characters}
                    onSave={saveWorld}
                    onCancel={goBack}
                    onDelete={worlds.some(w => w.id === draft.id) ? () => deleteWorld(draft.id) : undefined}
                />
            )}

            {view === 'world' && active && (
                <WorldView
                    world={active}
                    characters={characters}
                    onEdit={() => { setDraft(active); setView('edit'); }}
                    onWorldUpdated={reload}
                />
            )}
        </div>
    );
};

export default WorldHomeApp;
