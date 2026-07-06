import React, { useState, useEffect, useRef } from 'react';
import { CharacterProfile, RoomItem, DailySchedule, ScheduleSlot, Message } from '../../types';
import TokenImg from '../os/TokenImg';
import { getLastInnerState } from '../../utils/emotionApply';
import { getFlowNarrativeKey } from '../../utils/scheduleGenerator';

/**
 * 角色看板（Gotchi 风主界面）：进小屋后的第一屏。
 * 布局：状态头卡 → LIVE 小屋直播窗 → 当前日程 → 一句心声 → 消息（可一键跳去回）。
 *
 * 等比例缩放的关键（MiniRoomStage）：全屏小屋的家具是「位置百分比 + 尺寸固定像素」
 * （width = 80*scale px、小人 120px），直接塞进小窗会出现"位置缩了、东西不缩"的错位。
 * 这里把整个舞台按固定虚拟画布（VIRTUAL_W 宽）原样渲染，再对画布整体 transform:scale——
 * 墙、地板、家具、小人一起缩，比例与全屏视图完全一致。
 */

const VIRTUAL_W = 390;
const VIRTUAL_H = 300;
const FLOOR_HORIZON = 65; // 与 RoomApp 保持一致：地板从 65% 开始

/** 与全屏小屋同一套交互状态（由 RoomApp 传入，两个视图共用同一份 state/handler）。 */
export interface StageInteraction {
    actorState: { x: number; y: number; action: string };
    aiBubble: { text: string; visible: boolean };
    onLookAt: (item: RoomItem, e?: React.MouseEvent) => void;
    onPokeActor: () => void;
    onDismissBubble: () => void;
}

const MiniRoomStage: React.FC<{
    items: RoomItem[];
    wallStyle: string;
    floorStyle: string;
    actorImage?: string;
    interaction: StageInteraction;
}> = ({ items, wallStyle, floorStyle, actorImage, interaction }) => {
    const boxRef = useRef<HTMLDivElement>(null);
    const [scale, setScale] = useState(0);
    const { actorState, aiBubble, onLookAt, onPokeActor, onDismissBubble } = interaction;

    useEffect(() => {
        const el = boxRef.current;
        if (!el) return;
        const update = () => setScale(el.clientWidth / VIRTUAL_W);
        update();
        const ro = new ResizeObserver(update);
        ro.observe(el);
        return () => ro.disconnect();
    }, []);

    return (
        <div ref={boxRef} className="w-full overflow-hidden" style={{ height: scale ? VIRTUAL_H * scale : undefined, aspectRatio: scale ? undefined : `${VIRTUAL_W}/${VIRTUAL_H}` }}>
            {scale > 0 && (
                <div className="relative" style={{ width: VIRTUAL_W, height: VIRTUAL_H, transform: `scale(${scale})`, transformOrigin: 'top left' }}>
                    <div className="absolute top-0 left-0 w-full h-[65%] bg-center" style={{ background: wallStyle }}></div>
                    <div className="absolute bottom-0 left-0 w-full h-[35%] bg-center" style={{ background: floorStyle }}></div>
                    <div className="absolute top-[65%] w-full h-6 bg-gradient-to-b from-black/10 to-transparent pointer-events-none"></div>
                    {items.map(item => (
                        <div
                            key={item.id}
                            onClick={(e) => { e.stopPropagation(); onLookAt(item, e); }}
                            className={`absolute ${item.isInteractive ? 'cursor-pointer active:scale-95' : ''}`}
                            style={{
                                left: `${item.x}%`,
                                top: `${item.y}%`,
                                width: `${80 * item.scale}px`,
                                transform: `translate(-50%, -100%) rotate(${item.rotation}deg)`,
                                zIndex: Math.floor(item.y),
                                transition: 'transform 0.2s ease-out',
                            }}
                        >
                            <TokenImg value={item.image} className="w-full h-auto object-contain pointer-events-none select-none" draggable={false} loading="lazy" />
                        </div>
                    ))}
                    {/* 小人：与全屏同一份 actorState，走位/弹跳/气泡在两个视图间连续 */}
                    {actorImage && (
                        <div
                            onClick={(e) => { e.stopPropagation(); onPokeActor(); }}
                            className="absolute transition-[left,top] duration-[1000ms] ease-in-out cursor-pointer active:scale-95"
                            style={{
                                left: `${actorState.x}%`,
                                top: `${Math.max(FLOOR_HORIZON, actorState.y)}%`,
                                width: '120px',
                                transform: `translate(-50%, -100%) scale(${actorState.action === 'walk' ? 1.05 : (actorState.action === 'bounce' ? 1.1 : 1)})`,
                                zIndex: Math.floor(actorState.y) + 20,
                            }}
                        >
                            <img src={actorImage} className={`w-full h-full object-contain ${actorState.action === 'walk' ? 'animate-bounce' : ''}`} alt="" />
                            {aiBubble.visible && (
                                <div className="absolute bottom-[105%] left-1/2 -translate-x-1/2 bg-white px-4 py-3 rounded-[20px] rounded-bl-none shadow-lg border-2 border-black/5 min-w-[120px] max-w-[280px] z-50">
                                    <p className="text-xs font-bold text-slate-700 leading-tight text-center break-words">{aiBubble.text}</p>
                                    <button onClick={(e) => { e.stopPropagation(); onDismissBubble(); }} className="absolute -top-2 -right-2 bg-slate-200 text-slate-500 rounded-full w-5 h-5 flex items-center justify-center text-[9px]">×</button>
                                </div>
                            )}
                        </div>
                    )}
                </div>
            )}
        </div>
    );
};

/** 与 context.ts buildScheduleInjection 同款：从后往前找第一个已开始的 slot。 */
function findCurrentSlot(schedule: DailySchedule | null): { current: ScheduleSlot | null; next: ScheduleSlot | null } {
    if (!schedule?.slots?.length) return { current: null, next: null };
    const now = new Date();
    const cur = now.getHours() * 60 + now.getMinutes();
    for (let i = schedule.slots.length - 1; i >= 0; i--) {
        const [h, m] = schedule.slots[i].startTime.split(':').map(Number);
        if (cur >= h * 60 + m) {
            return { current: schedule.slots[i], next: schedule.slots[i + 1] || null };
        }
    }
    return { current: null, next: schedule.slots[0] };
}

const WEEKDAYS = ['SUN', 'MON', 'TUE', 'WED', 'THU', 'FRI', 'SAT'];

/** 星光点缀（纯装饰） */
const Sparkle: React.FC<{ className?: string }> = ({ className = '' }) => (
    <span className={`pointer-events-none select-none text-[#b9a8e8] ${className}`}>✦</span>
);

interface RoomDashboardProps {
    char: CharacterProfile;
    items: RoomItem[];
    wallStyle: string;
    floorStyle: string;
    actorImage?: string;
    schedule: DailySchedule | null;
    /** 今日已生成时的欢迎语（savedRoomState.welcomeMessage） */
    welcomeMessage?: string;
    recentMessages: Message[];
    /** 与全屏小屋共用的交互状态/handler：LIVE 窗内点家具/戳小人 = 小屋同一套交互 */
    interaction: StageInteraction;
    /** 点家具后的观察文本（与全屏共用同一份 state） */
    observationText: string;
    onDismissObservation: () => void;
    onBack: () => void;
    onEnterRoom: () => void;
    onOpenChat: () => void;
    onOpenFragments: () => void;
    onOpenSettings: () => void;
}

const RoomDashboard: React.FC<RoomDashboardProps> = ({
    char, items, wallStyle, floorStyle, actorImage, schedule, welcomeMessage,
    recentMessages, interaction, observationText, onDismissObservation,
    onBack, onEnterRoom, onOpenChat, onOpenFragments, onOpenSettings,
}) => {
    const [now, setNow] = useState(new Date());
    useEffect(() => {
        const t = setInterval(() => setNow(new Date()), 30_000);
        return () => clearInterval(t);
    }, []);

    const timeStr = `${String(now.getHours()).padStart(2, '0')}:${String(now.getMinutes()).padStart(2, '0')}`;
    const dateStr = `${String(now.getMonth() + 1).padStart(2, '0')} / ${String(now.getDate()).padStart(2, '0')}`;
    const weekday = WEEKDAYS[now.getDay()];

    const { current: curSlot, next: nextSlot } = findCurrentSlot(schedule);

    // 一句心声：情绪评估的 innerState → 日程意识流兜底 → 占位
    const innerState = getLastInnerState(char.id)
        || schedule?.flowNarrative?.[getFlowNarrativeKey(now.getHours())]
        || '';
    const heartLine = innerState || '新的一天。';

    const greeting = welcomeMessage
        || (curSlot ? `${curSlot.emoji ? curSlot.emoji + ' ' : ''}正在${curSlot.activity}${curSlot.location ? `（${curSlot.location}）` : ''}` : '')
        || '今天也要加油哦～';

    // 只挑可读的文本消息做预览
    const previewMsgs = recentMessages
        .filter(m => (m.role === 'user' || m.role === 'assistant') && typeof m.content === 'string' && (!m.type || m.type === 'text'))
        .slice(-3);

    const cardCls = 'relative rounded-3xl border border-[#d9cdf0]/70 bg-white/80 backdrop-blur-sm shadow-[0_6px_20px_rgba(150,130,200,0.15)]';
    const headingCls = 'text-[13px] font-bold text-[#5b4b7a] font-serif tracking-wide flex items-center gap-1';

    return (
        <div className="h-full w-full flex flex-col relative overflow-hidden font-sans select-none" style={{ background: 'linear-gradient(175deg,#c9c0e8 0%,#ddd5f0 34%,#efeaf8 100%)' }}>
            {/* 顶部栏 */}
            <div className="shrink-0 px-4 pb-2 flex items-end justify-between" style={{ paddingTop: 'max(2.6rem, var(--safe-top))' }}>
                <div className="leading-none">
                    <div className="text-[26px] font-bold text-[#5b4b7a] font-serif tracking-wider">{timeStr}</div>
                    <div className="text-[10px] text-[#8a7ab0] font-bold tracking-[0.2em] mt-1">{dateStr}　{weekday}</div>
                </div>
                <div className="text-center pb-1">
                    <span className="text-[11px] font-bold tracking-[0.35em] text-[#7c6ba6] font-serif uppercase">
                        {char.name}·GOTCHI
                    </span>
                    <Sparkle className="ml-1 text-[9px]" />
                </div>
                <button onClick={onBack} className="pb-0.5 p-2 -mr-2 text-[#8a7ab0] active:scale-90 transition-transform" aria-label="返回">
                    <svg xmlns="http://www.w3.org/2000/svg" fill="none" viewBox="0 0 24 24" strokeWidth={2.4} stroke="currentColor" className="w-5 h-5"><path strokeLinecap="round" strokeLinejoin="round" d="M6 18 18 6M6 6l12 12" /></svg>
                </button>
            </div>

            <div className="flex-1 overflow-y-auto no-scrollbar px-4 pb-3 space-y-3">
                {/* 角色状态头卡 */}
                <div className={`${cardCls} p-3 flex items-center gap-3`}>
                    <Sparkle className="absolute top-1.5 left-2.5 text-[9px] opacity-70" />
                    <div className="w-14 h-14 rounded-full overflow-hidden border-2 border-[#d9cdf0] bg-[#efeaf8] shrink-0">
                        <TokenImg value={char.avatar} className="w-full h-full object-cover" />
                    </div>
                    <div className="flex-1 min-w-0">
                        <div className="flex items-center gap-1.5">
                            <span className="text-lg font-bold text-[#4a3f63] font-serif truncate">{char.name}</span>
                            <span className="text-[9px] px-1.5 py-0.5 rounded-full bg-[#efeaf8] text-[#8a7ab0] border border-[#d9cdf0] font-bold shrink-0">🐾 {curSlot?.emoji || '✦'}</span>
                        </div>
                        <p className="text-[11px] text-[#8a7ab0] truncate mt-0.5">{greeting}</p>
                    </div>
                    <div className="shrink-0 text-center px-2 py-1.5 rounded-2xl bg-[#efeaf8]/80 border border-[#d9cdf0]/70">
                        <div className="text-[15px] font-bold text-[#5b4b7a] font-serif leading-none">{weekday}</div>
                        <div className="text-[8px] text-[#8a7ab0] font-bold tracking-widest mt-1">{dateStr}</div>
                    </div>
                </div>

                {/* LIVE 小屋窗：不是缩略图入口，本身就是小屋——点家具/戳小人与全屏同一套交互。
                    全屏（装修/更新这一天等重操作）走右上角展开键或底部导航 LIVE。 */}
                <div className={`${cardCls} w-full overflow-hidden p-0`}>
                    <div className="absolute top-2.5 left-3 z-10 flex items-center gap-1.5 px-2 py-1 rounded-full bg-white/85 border border-[#d9cdf0]/80 shadow-sm pointer-events-none">
                        <span className="w-1.5 h-1.5 rounded-full bg-rose-400 animate-pulse"></span>
                        <span className="text-[9px] font-bold tracking-[0.2em] text-[#7c6ba6]">LIVE</span>
                    </div>
                    <div className="absolute top-2.5 right-3 z-10 flex items-center gap-1.5">
                        <span className="px-2 py-1 rounded-full bg-white/85 border border-[#d9cdf0]/80 shadow-sm text-[9px] font-bold text-[#8a7ab0] pointer-events-none">☁ {timeStr}</span>
                        <button onClick={onEnterRoom} aria-label="全屏小屋" className="p-1.5 rounded-full bg-white/85 border border-[#d9cdf0]/80 shadow-sm text-[#8a7ab0] active:scale-90 transition-transform">
                            <svg xmlns="http://www.w3.org/2000/svg" fill="none" viewBox="0 0 24 24" strokeWidth={2.2} stroke="currentColor" className="w-3 h-3"><path strokeLinecap="round" strokeLinejoin="round" d="M3.75 3.75v4.5m0-4.5h4.5m-4.5 0L9 9M3.75 20.25v-4.5m0 4.5h4.5m-4.5 0L9 15M20.25 3.75h-4.5m4.5 0v4.5m0-4.5L15 9m5.25 11.25h-4.5m4.5 0v-4.5m0 4.5L15 15" /></svg>
                        </button>
                    </div>
                    <MiniRoomStage items={items} wallStyle={wallStyle} floorStyle={floorStyle} actorImage={actorImage} interaction={interaction} />
                    {/* 观察卡：点家具后的旁白（与全屏共用同一份 state） */}
                    {observationText && (
                        <div className="relative border-t border-[#d9cdf0]/50 bg-white/75 px-3 py-2.5">
                            <div className="flex justify-between items-start">
                                <span className="text-[8px] font-bold text-[#8a7ab0] uppercase tracking-[0.25em]">Observation</span>
                                <button onClick={onDismissObservation} className="text-[#b0a3d4] -mt-0.5 px-1">×</button>
                            </div>
                            <p className="text-[11px] text-[#4a3f63] leading-relaxed mt-0.5">{observationText}</p>
                        </div>
                    )}
                </div>

                {/* 当前日程 */}
                <div className={`${cardCls} p-3.5`}>
                    <div className="flex items-center justify-between mb-2">
                        <span className={headingCls}>当前日程 <Sparkle className="text-[9px]" /></span>
                        <span className="text-[13px] font-bold text-[#7c6ba6] font-serif">{curSlot?.startTime || '--:--'}</span>
                    </div>
                    {curSlot ? (
                        <>
                            <p className="text-sm text-[#4a3f63] leading-relaxed">
                                {curSlot.emoji ? `${curSlot.emoji} ` : ''}{curSlot.activity}
                                {curSlot.location ? <span className="text-[#8a7ab0]">（{curSlot.location}）</span> : null}
                            </p>
                            {curSlot.description && <p className="text-[11px] text-[#8a7ab0] mt-1 leading-relaxed">{curSlot.description}</p>}
                            {nextSlot && (
                                <p className="text-[10px] text-[#b0a3d4] mt-2">之后 · {nextSlot.startTime} {nextSlot.activity}</p>
                            )}
                        </>
                    ) : (
                        <p className="text-[11px] text-[#8a7ab0] leading-relaxed">
                            {schedule ? `今天还没开始活动，稍后先${nextSlot?.activity || '…'}（${nextSlot?.startTime || ''}）` : '今天的日程还没生成，去聊两句就有了～'}
                        </p>
                    )}
                    {/* 进度点（装饰化的日程推进） */}
                    {schedule?.slots?.length ? (
                        <div className="flex items-center gap-1.5 mt-3">
                            {schedule.slots.map((s, i) => {
                                const passed = curSlot && s.startTime <= curSlot.startTime;
                                return <span key={i} className={`rounded-full ${passed ? 'w-2 h-2 bg-[#8a7ab0]' : 'w-1.5 h-1.5 bg-[#d9cdf0]'}`}></span>;
                            })}
                        </div>
                    ) : null}
                </div>

                {/* 一句心声 */}
                <div className={`${cardCls} p-3.5`}>
                    <div className="flex items-center justify-between mb-2">
                        <span className={headingCls}>一句心声 <Sparkle className="text-[9px]" /></span>
                        <span className="text-sm text-[#b9a8e8]">🪶</span>
                    </div>
                    <p className="text-[12px] text-[#5b4b7a] leading-[1.8] line-clamp-3">{heartLine}</p>
                </div>

                {/* 消息（预览 + 回复条：点了直接进聊天） */}
                <div className={`${cardCls} p-3.5`}>
                    <div className="flex items-center justify-between mb-2">
                        <span className={headingCls}>消息 <Sparkle className="text-[9px]" /></span>
                        <button onClick={onOpenChat} className="text-[10px] font-bold text-[#8a7ab0] active:scale-95">全部 ›</button>
                    </div>
                    {previewMsgs.length > 0 ? (
                        <div className="space-y-2 mb-3">
                            {previewMsgs.map(m => (
                                <div key={m.id} className={`flex ${m.role === 'user' ? 'justify-end' : 'justify-start'}`}>
                                    <div className={`max-w-[80%] px-3 py-1.5 rounded-2xl text-[11px] leading-relaxed ${
                                        m.role === 'user'
                                            ? 'bg-[#8a7ab0] text-white rounded-br-md'
                                            : 'bg-[#efeaf8] text-[#4a3f63] border border-[#d9cdf0]/60 rounded-bl-md'
                                    }`}>
                                        {String(m.content).length > 60 ? String(m.content).slice(0, 60) + '…' : String(m.content)}
                                    </div>
                                </div>
                            ))}
                        </div>
                    ) : (
                        <p className="text-[11px] text-[#8a7ab0] mb-3">还没聊过天，说点什么吧。</p>
                    )}
                    {/* 回复条：视觉上是输入框，点击无缝跳到聊天 App 接着打 */}
                    <button onClick={onOpenChat} className="w-full flex items-center gap-2 px-3 py-2.5 rounded-2xl bg-[#f5f1fb] border border-[#d9cdf0]/70 active:scale-[0.99] transition-transform">
                        <span className="flex-1 text-left text-[11px] text-[#b0a3d4]">回点什么…</span>
                        <span className="w-6 h-6 rounded-full bg-[#8a7ab0] text-white flex items-center justify-center shrink-0">
                            <svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" fill="currentColor" className="w-3 h-3"><path d="M3.478 2.404a.75.75 0 0 0-.926.941l2.432 7.905H13.5a.75.75 0 0 1 0 1.5H4.984l-2.432 7.905a.75.75 0 0 0 .926.94 60.519 60.519 0 0 0 18.445-8.986.75.75 0 0 0 0-1.218A60.517 60.517 0 0 0 3.478 2.404Z" /></svg>
                        </span>
                    </button>
                </div>
            </div>

            {/* 底部导航 */}
            <div className="shrink-0 mx-4 mb-3 px-2 py-2 rounded-3xl border border-[#d9cdf0]/70 bg-white/85 backdrop-blur-sm shadow-[0_6px_20px_rgba(150,130,200,0.2)] flex items-center" style={{ marginBottom: 'max(0.75rem, var(--safe-bottom, 0.75rem))' }}>
                {[
                    { key: 'live', label: 'LIVE', icon: '🏠', onClick: onEnterRoom },
                    { key: 'talk', label: 'TALK', icon: '💬', onClick: onOpenChat },
                    { key: 'home', label: 'HOME', icon: '✦', onClick: undefined, active: true },
                    { key: 'frag', label: '碎片', icon: '📔', onClick: onOpenFragments },
                    { key: 'set', label: '装修', icon: '⚙', onClick: onOpenSettings },
                ].map(t => (
                    <button
                        key={t.key}
                        onClick={t.onClick}
                        disabled={!t.onClick}
                        className={`flex-1 flex flex-col items-center gap-0.5 py-1.5 rounded-2xl transition-colors ${t.active ? 'bg-[#efeaf8] text-[#5b4b7a]' : 'text-[#a294c8] active:bg-[#f5f1fb]'}`}
                    >
                        <span className="text-[15px] leading-none">{t.icon}</span>
                        <span className="text-[8px] font-bold tracking-[0.15em]">{t.label}</span>
                    </button>
                ))}
            </div>
        </div>
    );
};

export default RoomDashboard;
