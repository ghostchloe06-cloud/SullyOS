import React, { useEffect, useMemo, useState, useRef, useCallback } from 'react';
import { useOS } from '../../context/OSContext';
import { INSTALLED_APPS } from '../../constants';
import { AppID, CharacterProfile, RoomItem, DailySchedule, ScheduleSlot } from '../../types';
import { DB } from '../../utils/db';
import { getLastInnerState } from '../../utils/emotionApply';
import { getFlowNarrativeKey } from '../../utils/scheduleGenerator';
import AppIcon from './AppIcon';
import TokenImg from './TokenImg';
import { useBlobRefUrl } from '../../utils/blobRef';
import { FURNITURE_ICONS } from '../../utils/furnitureIcons';
import { isDevDebugAvailable, subscribeDevDebugAvailability } from '../../utils/devDebug';

// ===== 电子宠物主题（tamagotchi skin）=====
// 桌面不再是「放图标的手机」，而是一台华丽丽的二次元养成机：屏幕主体是角色
// **真实的小屋**（小小窝里用户亲手装修的那间，家具/地毯/墙地面/立绘原样搬入，只读舞台），
// 角色在里面呼吸、游荡、被戳会念聊天里说过的话；底部 CARE/TALK/HOME/ALBUM/SETTINGS 五键 dock。
// 视觉基调：梦幻手游风——渐变描边、四角宝石、满屏星芒、发光经验条、扁平手绘贴纸键。
//
// 主色调可换：整套配色由一个色相 hue 推导（CSS 变量，见 makeVars），右上 🎨 面板
// 可选预设色，或从小窝的墙纸/地板/立绘里自动提取主色（canvas 采样色相直方图）。
//
// 性能红线（此文件的宪法）：
//   · 零常驻 JS 动画 —— 循环动效全部 CSS keyframes 且只碰 transform/opacity；
//     JS 只用 ≥15s 的一次性 setTimeout 换游荡坐标。
//   · 禁 backdrop-filter / blur；星芒云朵全是静态 span 与渐变；每元素阴影 ≤2 层。
//   · 渲染隔离 —— 舞台/状态卡拆 memo 子组件，分钟跳动不触达家具层 reconcile；
//     换主色只改根节点 CSS 变量，子组件零 reconcile。
//   · 图片全走 TokenImg / useBlobRefUrl（blobref 令牌自动解析回收）+ lazy。

// —— 调色板：全部指向 CSS 变量（根节点按 hue 生成），cream/gold/night 为固定锚色 ——
const PAL = {
    frame: 'var(--tg-frame)',
    frameSoft: 'var(--tg-frame-soft)',
    cream: '#fdf9f2',
    ink: 'var(--tg-ink)',
    grape: 'var(--tg-grape)',
    fade: 'var(--tg-fade)',
    pink: 'var(--tg-pink)',
    hot: 'var(--tg-hot)',
    peri: 'var(--tg-peri)',
    gold: '#f7d180',
    heart: 'var(--tg-heart)',
    heartDeep: 'var(--tg-heart-deep)',
    night: '#3a3560',
};
// 渐变描边（华丽框的灵魂）：伴色 → 邻色 → 主色浅调
const RIM = `linear-gradient(135deg, ${PAL.pink}, ${PAL.peri} 55%, var(--tg-rim3))`;
const FONT_PX = `'Courier Prime', monospace`;                   // 像素/LCD 字
const FONT_CN = `'ZCOOL KuaiLe', 'Noto Sans SC', sans-serif`;   // 中文圆润
const FONT_NUM = `'DM Serif Display', serif`;                   // 大数字（时间 / Lv）

// hue → 整套 CSS 变量。主色系（框/文字/底）+ 伴色系（hue+75，粉色位：强调/爱心）
// + 邻色系（hue-31，蓝紫位）。各角色的 S/L 定死，只转色相，保证任何 hue 都和谐。
const hsl = (h: number, s: number, l: number, a?: number) => {
    const hh = ((h % 360) + 360) % 360;
    return a === undefined ? `hsl(${hh}, ${s}%, ${l}%)` : `hsla(${hh}, ${s}%, ${l}%, ${a})`;
};
const makeVars = (h: number): React.CSSProperties => ({
    '--tg-frame': hsl(h, 49, 76),
    '--tg-frame-soft': hsl(h, 49, 76, 0.45),
    '--tg-frame-a30': hsl(h, 49, 76, 0.3),
    '--tg-frame-a22': hsl(h, 49, 76, 0.22),
    '--tg-ink': hsl(h, 35, 57),
    '--tg-grape': hsl(h, 27, 49),
    '--tg-fade': hsl(h, 40, 72),
    '--tg-pink': hsl(h + 75, 78, 80),
    '--tg-hot': hsl(h + 75, 73, 66),
    '--tg-peri': hsl(h - 31, 59, 78),
    '--tg-rim3': hsl(h, 42, 84),
    '--tg-heart': hsl(h + 75, 71, 80),
    '--tg-heart-deep': hsl(h + 75, 66, 72),
    '--tg-gem': hsl(h + 75, 70, 72, 0.75),
    '--tg-cloud-shadow': hsl(h, 52, 85),
    '--tg-glow16': hsl(h, 42, 60, 0.16),
    '--tg-glow25': hsl(h, 45, 62, 0.25),
    '--tg-glow35': hsl(h, 48, 64, 0.35),
    '--tg-hotglow45': hsl(h + 75, 66, 66, 0.45),
    '--tg-hotglow60': hsl(h + 75, 66, 66, 0.6),
    '--tg-bg-top': hsl(h, 57, 91),
    '--tg-bg-mid': hsl(h, 54, 88),
    '--tg-bg-bot': hsl(h, 52, 85),
    '--tg-drawer': hsl(h, 40, 95, 0.97),
} as React.CSSProperties);

const DEFAULT_HUE = 258; // 薰衣草
const HUE_KEY = 'tama_accent_hue';
const HUE_PRESETS: { h: number; name: string }[] = [
    { h: 258, name: '薰衣草' },
    { h: 340, name: '樱花' },
    { h: 210, name: '天空' },
    { h: 160, name: '薄荷' },
    { h: 28, name: '蜜桃' },
    { h: 48, name: '柠檬' },
];

const FLOOR_HORIZON = 65; // 与 RoomApp 一致：地平线 65%

// —— 兜底家具（角色从没装修过小屋时）——
// 注意：不能 import RoomApp（它是 lazy chunk，引了会把整个小屋 App 拽进主包），
// 这里放一份轻量镜像：通用默认 = RoomApp.DEFAULT_FURNITURE；Sully = SULLY_FURNITURE 的
// 摆位副本（去掉了舞台用不到的 descriptionPrompt）。Sully 首次进过小小窝后 roomConfig
// 会自动落库，此副本只服务于「装完还没进过屋」的新档。
const FALLBACK_DEFAULT: RoomItem[] = [
    { id: 'desk', name: '书桌', type: 'furniture', image: FURNITURE_ICONS.sofa, x: 20, y: 55, scale: 1.2, rotation: 0, isInteractive: true },
    { id: 'plant', name: '盆栽', type: 'decor', image: FURNITURE_ICONS.plant, x: 85, y: 40, scale: 0.8, rotation: 0, isInteractive: true },
];
const FALLBACK_SULLY: RoomItem[] = [
    { id: 'item-1768927221380', name: 'Sully床', type: 'furniture', image: 'https://sharkpan.xyz/f/A3XeUZ/BED.png', x: 78.46, y: 97.39, scale: 2.4, rotation: 0, isInteractive: true },
    { id: 'item-1768927255102', name: 'Sully电脑桌', type: 'furniture', image: 'https://sharkpan.xyz/f/G5n3Ul/DNZ.png', x: 28.85, y: 69.94, scale: 2.4, rotation: 0, isInteractive: true },
    { id: 'item-1768927271632', name: 'Sully垃圾桶', type: 'furniture', image: 'https://sharkpan.xyz/f/75Nvsj/LJT.png', x: 10.28, y: 80.5, scale: 0.9, rotation: 0, isInteractive: true },
    { id: 'item-1768927286526', name: 'Sully洞洞板', type: 'furniture', image: 'https://sharkpan.xyz/f/85K5ij/DDB.png', x: 32.61, y: 48.72, scale: 2.6, rotation: 0, isInteractive: true },
    { id: 'item-1768927303472', name: 'Sully书柜', type: 'furniture', image: 'https://sharkpan.xyz/f/zlpWS5/SG.png', x: 79.84, y: 68.94, scale: 2, rotation: 0, isInteractive: true },
];
const FALLBACK_WALL = 'radial-gradient(circle at 50% 50%, #fdfbf7 0%, #e2e8f0 100%)';
const FALLBACK_FLOOR = 'repeating-linear-gradient(90deg, #e7e5e4 0px, #e7e5e4 20px, #d6d3d1 21px)';

// 与 RoomApp.getBgStyle 同口径：url 类走 background 简写（含缩放/平铺），渐变串原样返回
const getBgStyle = (img: string | undefined, scale: number | undefined, repeat: boolean | undefined, fallback: string): string => {
    if (!img) return fallback;
    const isUrl = img.startsWith('http') || img.startsWith('data') || img.startsWith('blob:');
    if (!isUrl) return img;
    const size = scale && scale > 0 ? `${scale}%` : 'cover';
    return `url(${img}) center center / ${size} ${repeat ? 'repeat' : 'no-repeat'}`;
};

// 与 RoomApp 一致的图层法则：地毯压进 [1,11] 底层区间，家具按 y 排 z，角色 y+20 必然在最上
const itemZ = (item: RoomItem) => item.type === 'rug' ? 1 + Math.floor(item.y / 10) : Math.floor(item.y);

const isNightHour = (h: number) => h < 6 || h >= 23;

// 戳一戳兜底短语（角色还没说过话时用）
const POKE_FALLBACK = ['嗯？', '干嘛啦…', '我在呢！', '(被戳了一下)', '別戳了别戳了', '✦?', '在想事情…', '要陪我玩吗！'];

// 等级口径与 MobileGameHome 完全一致：每条消息 10 exp，三角曲线升级
const deriveStats = (msgCount: number) => {
    const totalExp = msgCount * 10;
    const base = 150;
    const level = Math.max(1, Math.floor((1 + Math.sqrt(1 + (8 * totalExp) / base)) / 2));
    const need = (base * level * (level - 1)) / 2;
    const exp = Math.max(0, Math.round(totalExp - need));
    const expMax = base * level;
    return { level, exp, expMax };
};

// ─── 主色提取（🎨「提取小窝主色」）──────────────────────────────
const rgbToHsl = (r: number, g: number, b: number): [number, number, number] => {
    r /= 255; g /= 255; b /= 255;
    const max = Math.max(r, g, b), min = Math.min(r, g, b);
    const l = (max + min) / 2;
    if (max === min) return [0, 0, l];
    const d = max - min;
    const s = l > 0.5 ? d / (2 - max - min) : d / (max + min);
    let h = 0;
    if (max === r) h = ((g - b) / d + (g < b ? 6 : 0));
    else if (max === g) h = (b - r) / d + 2;
    else h = (r - g) / d + 4;
    return [h * 60, s, l];
};

// 色相直方图（15° 一桶，饱和度×中亮度加权），忽略近灰/近黑白的像素
const dominantHueOfPixels = (data: Uint8ClampedArray): number | null => {
    const BINS = 24;
    const weight = new Array(BINS).fill(0);
    const hueSum = new Array(BINS).fill(0);
    for (let i = 0; i < data.length; i += 4) {
        if (data[i + 3] < 128) continue; // 透明像素
        const [h, s, l] = rgbToHsl(data[i], data[i + 1], data[i + 2]);
        if (s < 0.14 || l < 0.1 || l > 0.92) continue;
        const w = s * (1 - Math.abs(l - 0.55));
        const bin = Math.floor(h / (360 / BINS)) % BINS;
        weight[bin] += w;
        hueSum[bin] += h * w;
    }
    let best = 0;
    for (let i = 1; i < BINS; i++) if (weight[i] > weight[best]) best = i;
    if (weight[best] <= 0) return null;
    return hueSum[best] / weight[best];
};

// 图片 url → 主色相（24×24 缩略采样；跨域画布被污染时返回 null，交给下一个候选）
const hueFromImage = (url: string): Promise<number | null> => new Promise(resolve => {
    const img = new Image();
    img.crossOrigin = 'anonymous';
    img.onload = () => {
        try {
            const cv = document.createElement('canvas');
            cv.width = 24; cv.height = 24;
            const ctx = cv.getContext('2d');
            if (!ctx) return resolve(null);
            ctx.drawImage(img, 0, 0, 24, 24);
            resolve(dominantHueOfPixels(ctx.getImageData(0, 0, 24, 24).data));
        } catch { resolve(null); }
    };
    img.onerror = () => resolve(null);
    img.src = url;
});

// CSS 渐变串 → 主色相（抓 #hex 色值取饱和度加权平均）
const hueFromGradient = (s: string): number | null => {
    const hexes = s.match(/#[0-9a-fA-F]{6}\b|#[0-9a-fA-F]{3}\b/g);
    if (!hexes || hexes.length === 0) return null;
    let wSum = 0, hSum = 0;
    for (const hex of hexes) {
        const full = hex.length === 4 ? `#${hex[1]}${hex[1]}${hex[2]}${hex[2]}${hex[3]}${hex[3]}` : hex;
        const r = parseInt(full.slice(1, 3), 16), g = parseInt(full.slice(3, 5), 16), b = parseInt(full.slice(5, 7), 16);
        const [h, sat, l] = rgbToHsl(r, g, b);
        if (sat < 0.1 || l < 0.08 || l > 0.95) continue;
        const w = sat * (1 - Math.abs(l - 0.55));
        wSum += w; hSum += h * w;
    }
    return wSum > 0 ? hSum / wSum : null;
};

// ─── 装饰小件（全静态，零成本）───────────────────────────────
// 星芒 ✦ 散布：按 [x%, y%, 字号px, 颜色, 透明度, 是否闪烁]
type Sp = [number, number, number, string, number, boolean?];
const Sparkles = React.memo<{ items: Sp[] }>(({ items }) => (
    <>
        {items.map(([x, y, s, c, o, tw], i) => (
            <span key={i} className="absolute pointer-events-none select-none leading-none"
                style={{
                    left: `${x}%`, top: `${y}%`, fontSize: s, color: c, opacity: o,
                    transform: 'translate(-50%,-50%)',
                    animation: tw ? `tama-twinkle ${2.4 + (i % 3) * 0.7}s ease-in-out ${(i % 4) * 0.6}s infinite` : undefined,
                }}>✦</span>
        ))}
    </>
));

// 手绘蓬蓬云：多泡泡剪影 + 主色底影（group opacity 整体合成，重叠处不会加深起缝）
const Cloud = React.memo<{ style?: React.CSSProperties; className?: string; alpha?: number }>(({ style, className, alpha = 0.95 }) => (
    <svg viewBox="0 0 120 64" className={className} style={style} aria-hidden>
        {/* 底影（主色浅调，整体下移一点，画出手绘的厚度） */}
        <g fill="var(--tg-cloud-shadow)" opacity={alpha * 0.4} transform="translate(0 3.5)">
            <ellipse cx="34" cy="46" rx="26" ry="14" />
            <circle cx="52" cy="30" r="20" />
            <circle cx="78" cy="36" r="16" />
            <ellipse cx="88" cy="47" rx="21" ry="12" />
            <circle cx="24" cy="35" r="13" />
        </g>
        {/* 云本体（白，泡泡拼出蓬蓬轮廓） */}
        <g fill="#ffffff" opacity={alpha}>
            <ellipse cx="34" cy="46" rx="26" ry="14" />
            <circle cx="52" cy="30" r="20" />
            <circle cx="78" cy="36" r="16" />
            <ellipse cx="88" cy="47" rx="21" ry="12" />
            <circle cx="24" cy="35" r="13" />
        </g>
    </svg>
));

// 四角宝石（rotate-45 小方块，华丽卡片标配）
const GemCorners = React.memo<{ color?: string; inset?: number }>(({ color = 'var(--tg-gem)', inset = 8 }) => (
    <>
        {[[0, 0], [1, 0], [0, 1], [1, 1]].map(([r, b], i) => (
            <span key={i} className="absolute w-1.5 h-1.5 rotate-45 pointer-events-none"
                style={{ [r ? 'right' : 'left']: inset, [b ? 'bottom' : 'top']: inset, background: color } as React.CSSProperties} />
        ))}
    </>
));

// 页面氛围层：主色底渐变 + 静态星野（多重 radial-gradient 星点）+ 顶部柔光
const BackDecor = React.memo(() => (
    <div className="absolute inset-0 pointer-events-none">
        <div className="absolute inset-0" style={{ background: 'linear-gradient(180deg, var(--tg-bg-top) 0%, var(--tg-bg-mid) 55%, var(--tg-bg-bot) 100%)' }} />
        <div className="absolute inset-0 opacity-80" style={{
            backgroundImage:
                'radial-gradient(1.5px 1.5px at 12% 8%, rgba(255,255,255,0.9), transparent), radial-gradient(1px 1px at 78% 5%, rgba(255,220,240,0.8), transparent), radial-gradient(1.5px 1.5px at 40% 15%, rgba(255,255,255,0.7), transparent), radial-gradient(1px 1px at 90% 22%, rgba(220,225,255,0.7), transparent), radial-gradient(1px 1px at 6% 38%, rgba(255,255,255,0.6), transparent), radial-gradient(1.5px 1.5px at 95% 55%, rgba(255,230,250,0.6), transparent), radial-gradient(1px 1px at 4% 72%, rgba(255,255,255,0.55), transparent), radial-gradient(1px 1px at 92% 88%, rgba(230,220,255,0.6), transparent)',
        }} />
        <div className="absolute inset-x-0 top-0 h-40" style={{ background: 'radial-gradient(70% 100% at 50% 0%, rgba(255,255,255,0.5), transparent 70%)' }} />
        <Sparkles items={[
            [7, 12, 13, '#fff', 0.9, true], [93, 9, 11, PAL.gold, 0.85, true],
            [85, 30, 9, '#fff', 0.7], [4, 55, 10, PAL.pink, 0.6, true],
            [96, 68, 9, '#fff', 0.6], [8, 88, 11, PAL.gold, 0.7, true],
        ]} />
    </div>
));

// ─── 状态卡（渐变环头像 + Lv 徽章 + 大数字时间 + 发光爱心经验条）───
const StatusCard = React.memo<{ hh: string; mm: string; level: number; exp: number; expMax: number; charName: string; avatar?: string; multiChar: boolean; onSwitch: () => void }>(
    ({ hh, mm, level, exp, expMax, charName, avatar, multiChar, onSwitch }) => {
        const expPct = Math.min(100, Math.round((exp / expMax) * 100));
        return (
            <div className="relative rounded-[1.4rem] px-3.5 py-3 mt-2.5 flex items-center gap-3.5 overflow-hidden"
                style={{ background: 'rgba(255,255,255,0.72)', border: `1.5px solid ${PAL.frameSoft}`, boxShadow: '0 5px 16px var(--tg-glow25)' }}>
                {/* 内描金细框 + 四角宝石 + 卡内星芒 */}
                <div className="absolute inset-[5px] rounded-[1.1rem] pointer-events-none" style={{ border: '1px solid var(--tg-frame-a30)' }} />
                <GemCorners inset={9} />
                <Sparkles items={[[88, 20, 9, PAL.pink, 0.8, true], [64, 78, 8, PAL.peri, 0.7], [95, 62, 8, PAL.gold, 0.75, true]]} />

                {/* 头像：渐变环 + Lv 徽章 */}
                <button onClick={onSwitch} className={`relative shrink-0 ${multiChar ? 'active:scale-95 transition-transform' : ''}`}>
                    <div className="w-[62px] h-[62px] rounded-full p-[2.5px]"
                        style={{ background: RIM, boxShadow: '0 4px 12px var(--tg-glow35)' }}>
                        <div className="w-full h-full rounded-full overflow-hidden" style={{ border: '2px solid #fff', background: '#fff' }}>
                            {avatar ? <img src={avatar} className="w-full h-full object-cover" alt="" loading="lazy" draggable={false} /> : <div className="w-full h-full flex items-center justify-center text-lg" style={{ color: PAL.fade }}>✦</div>}
                        </div>
                    </div>
                    <div className="absolute -bottom-1 left-1/2 -translate-x-1/2 px-2 py-[1px] rounded-md text-[10px] whitespace-nowrap"
                        style={{ background: `linear-gradient(135deg, ${PAL.grape}, ${PAL.ink})`, color: '#fff', fontFamily: FONT_NUM, boxShadow: '0 2px 6px rgba(80,70,120,0.4)', border: '1px solid rgba(255,255,255,0.5)' }}>
                        Lv.{level}
                    </div>
                    {multiChar && <span className="absolute -top-1 -right-1 w-[18px] h-[18px] rounded-full flex items-center justify-center text-[9px]" style={{ background: '#fff', border: `1.5px solid ${PAL.frame}`, color: PAL.ink, boxShadow: '0 1px 4px var(--tg-glow25)' }}>⇄</span>}
                </button>

                <div className="flex-1 min-w-0 relative">
                    <div className="flex items-baseline justify-between gap-2">
                        <span className="text-[26px] leading-none tabular-nums" style={{ fontFamily: FONT_NUM, color: PAL.grape, textShadow: '0 2px 0 rgba(255,255,255,0.9), 0 3px 10px var(--tg-glow35)' }}>{hh}:{mm}</span>
                        <span className="flex items-center gap-1 text-[8px] font-bold tracking-[0.14em] shrink-0" style={{ color: PAL.fade }}>
                            <span className="w-1.5 h-1.5 rounded-full" style={{ background: '#7cd992', boxShadow: '0 0 5px #7cd992' }} />LIVE·ON
                        </span>
                    </div>
                    <div className="text-[14px] truncate mt-1" style={{ fontFamily: FONT_CN, color: PAL.ink }}>{charName}</div>
                    {/* 发光爱心经验条 */}
                    <div className="flex items-center gap-1.5 mt-1.5">
                        <span className="text-[12px] leading-none" style={{ color: PAL.hot, textShadow: '0 0 6px var(--tg-hotglow60)' }}>♥</span>
                        <div className="flex-1 h-[8px] rounded-full overflow-hidden" style={{ background: 'var(--tg-frame-a22)', boxShadow: 'inset 0 1px 2px rgba(100,90,140,0.22)' }}>
                            <div className="h-full rounded-full" style={{ width: `${expPct}%`, background: `linear-gradient(90deg, ${PAL.peri}, ${PAL.pink}, ${PAL.hot})`, boxShadow: '0 0 8px var(--tg-hotglow60)' }} />
                        </div>
                        <span className="text-[9px] tabular-nums shrink-0 font-bold" style={{ fontFamily: FONT_PX, color: PAL.fade }}>{exp}/{expMax}</span>
                    </div>
                </div>
            </div>
        );
    }
);

// ─── 舞台家具（贴纸，逐件 memo；可点击 = 小屋同款就地交互）─────────
const StageItem = React.memo<{ item: RoomItem; onTap: (item: RoomItem) => void }>(({ item, onTap }) => (
    <div className="absolute select-none cursor-pointer active:opacity-90"
        onClick={(e) => { e.stopPropagation(); onTap(item); }}
        style={{
            left: `${item.x}%`, top: `${item.y}%`,
            width: `${80 * item.scale}px`,
            transform: `translate(-50%, -100%) rotate(${item.rotation}deg)`,
            zIndex: itemZ(item),
        }}>
        <TokenImg value={item.image} className="w-full h-auto object-contain pointer-events-none" draggable={false} loading="lazy" alt="" />
    </div>
));

// ─── 天窗挂饰（舞台顶部小窗 + 流星 + 悬星，纯静态 CSS；随昼夜换天）────
const StageWindow = React.memo<{ night: boolean }>(({ night }) => (
    <div className="absolute top-[4%] left-[5%] right-[5%] h-[13%] pointer-events-none" style={{ zIndex: 0 }}>
        <div className="absolute inset-0 rounded-xl overflow-hidden" style={{
            border: '3px solid rgba(255,255,255,0.9)',
            background: night
                ? 'linear-gradient(180deg, #2c2851 0%, #453e73 60%, #57508a 100%)'
                : 'linear-gradient(180deg, #bfe0f7 0%, #dff0fc 70%, #f0f8fe 100%)',
            boxShadow: '0 3px 10px var(--tg-glow25)',
        }}>
            {/* 手绘蓬蓬云（SVG 泡泡剪影 + 底影），慢速飘移；夜里变成淡淡的夜云 */}
            <Cloud className="absolute" alpha={night ? 0.16 : 0.95}
                style={{ left: '6%', top: '16%', width: '36%', animation: 'tama-drift 9s ease-in-out infinite alternate' }} />
            <Cloud className="absolute" alpha={night ? 0.12 : 0.8}
                style={{ right: '8%', top: '34%', width: '30%', animation: 'tama-drift 13s ease-in-out infinite alternate-reverse' }} />
            <Cloud className="absolute" alpha={night ? 0.1 : 0.6}
                style={{ left: '38%', top: '52%', width: '20%', animation: 'tama-drift 11s ease-in-out 1.5s infinite alternate' }} />
            {/* 夜空专属：一轮弯月 + 满窗星星 */}
            {night && (
                <>
                    <span className="absolute top-[14%] left-[10%] text-[14px] leading-none" style={{ textShadow: '0 0 10px rgba(247,209,128,0.8)' }}>🌙</span>
                    <span className="absolute top-[52%] left-[30%] text-[6px]" style={{ color: '#efe8b8', animation: 'tama-twinkle 3.1s ease-in-out 0.8s infinite' }}>✦</span>
                    <span className="absolute top-[26%] left-[58%] text-[7px]" style={{ color: '#fff', animation: 'tama-twinkle 2.4s ease-in-out 1.4s infinite' }}>✦</span>
                    <span className="absolute top-[60%] right-[10%] text-[6px]" style={{ color: '#cdc6f0' }}>✦</span>
                </>
            )}
            {/* 流星 */}
            <div className="absolute top-[24%] left-[42%] w-[18%] h-[2px] rotate-[24deg] origin-left rounded-full" style={{ background: 'linear-gradient(90deg, transparent, rgba(255,255,255,0.95))' }} />
            <span className="absolute top-[12%] right-[36%] text-[9px]" style={{ color: '#fff', animation: 'tama-twinkle 2.8s ease-in-out infinite' }}>✦</span>
            <span className="absolute bottom-[16%] left-[38%] text-[7px]" style={{ color: 'rgba(255,255,255,0.9)' }}>✦</span>
        </div>
        {/* 悬挂的小星星 / 月亮 */}
        {[
            { x: '18%', drop: 14, char: '⭐', size: 11 },
            { x: '46%', drop: 22, char: '✦', size: 10 },
            { x: '64%', drop: 12, char: '💫', size: 10 },
            { x: '86%', drop: 26, char: '🌙', size: 12 },
        ].map((s, i) => (
            <div key={i} className="absolute top-full flex flex-col items-center" style={{ left: s.x }}>
                <span style={{ width: 1, height: s.drop, background: PAL.frameSoft }} />
                <span className="leading-none select-none" style={{ fontSize: s.size, color: PAL.fade }}>{s.char}</span>
            </div>
        ))}
    </div>
));

// ─── 角色（呼吸 / 游荡 / 戳一戳念聊天台词 / 夜间飘 Zzz），自治状态不外溢 ─
// nudge/say：家具就地交互的外部指令（走到家具旁 + 念缓存的反应台词），seq 变化才生效——
// 事件驱动的一次性 set，不引入任何常驻动画/interval，不破性能宪法。
const Actor = React.memo<{
    actorImg: string | undefined; night: boolean; pokeLines: string[]; unread: number; onChat: () => void;
    nudge?: { x: number; y: number; seq: number }; say?: { text: string; seq: number };
}>(
    ({ actorImg, night, pokeLines, unread, onChat, nudge, say }) => {
        const [pos, setPos] = useState({ x: 48, y: 80 });
        const [bounce, setBounce] = useState(false);
        const [pokeText, setPokeText] = useState('');
        const pokeIdx = useRef(0); // 台词按顺序循环（最新一条开始往回念）

        // 游荡：≥18s 一次性的 setTimeout 链（无 rAF / 无短 interval），夜里停下休息
        useEffect(() => {
            if (night) return;
            let t: ReturnType<typeof setTimeout>;
            const wander = () => {
                setPos({ x: 22 + Math.random() * 56, y: 70 + Math.random() * 22 });
                t = setTimeout(wander, 18000 + Math.random() * 22000);
            };
            t = setTimeout(wander, 15000);
            return () => clearTimeout(t);
        }, [night]);

        // 家具交互指令：走过去 + 念一句（气泡复用 pokeText 通道，优先级一致）
        useEffect(() => {
            if (nudge && nudge.seq > 0) setPos({ x: nudge.x, y: nudge.y });
        }, [nudge?.seq]);
        useEffect(() => {
            if (say && say.seq > 0 && say.text) {
                setPokeText(say.text);
                const t = setTimeout(() => setPokeText(''), 4200);
                return () => clearTimeout(t);
            }
        }, [say?.seq]);

        const poke = (e: React.MouseEvent) => {
            e.stopPropagation();
            setBounce(true);
            setTimeout(() => setBounce(false), 450);
            // 从聊天里 ta 最近的回复按顺序循环取一条；一条没有就用兜底短语
            const lines = pokeLines.length > 0 ? pokeLines : POKE_FALLBACK;
            setPokeText(lines[pokeIdx.current % lines.length]);
            pokeIdx.current += 1;
            setTimeout(() => setPokeText(''), 3200);
        };

        // 气泡优先级：戳一戳台词 > 未读提醒
        const bubble = pokeText || (unread > 0 ? `♥ ${unread} 条新消息!` : '');
        const bubbleIsChat = !pokeText && unread > 0;

        return (
            <div onClick={poke}
                className="absolute cursor-pointer"
                style={{
                    left: `${pos.x}%`, top: `${pos.y}%`, width: '104px',
                    transform: 'translate(-50%, -100%)',
                    zIndex: Math.floor(pos.y) + 20,
                    transition: 'left 1.4s ease-in-out, top 1.4s ease-in-out',
                }}>
                <img src={actorImg} alt="" draggable={false} loading="lazy"
                    className="w-full h-auto object-contain select-none"
                    style={{
                        animation: bounce ? 'tama-bounce 0.45s ease-out' : (night ? 'none' : 'tama-breathe 3.2s ease-in-out infinite'),
                        willChange: 'transform',
                    }} />
                {night && (
                    <span className="absolute -top-4 right-0 text-[13px] font-bold select-none" style={{ fontFamily: FONT_PX, color: PAL.ink, animation: 'tama-zzz 2.6s ease-in-out infinite' }}>Zzz</span>
                )}
                {bubble && (
                    <div onClick={(e) => { if (bubbleIsChat) { e.stopPropagation(); onChat(); } }}
                        className="absolute bottom-[102%] left-1/2 -translate-x-1/2 px-3 py-1.5 rounded-xl rounded-bl-none max-w-[180px] animate-pop-in"
                        style={{ background: PAL.cream, border: `2px solid ${PAL.frame}`, boxShadow: '0 3px 10px var(--tg-glow25)', zIndex: 60 }}>
                        <p className="text-[10px] font-bold leading-snug break-words" style={{ fontFamily: FONT_PX, color: PAL.ink }}>{bubble}</p>
                    </div>
                )}
            </div>
        );
    }
);

// ─── 右上角小电子钟：白天=天空底，夜里=星空底 +「夜深啦！」──────────
const StageClock = React.memo<{ hh: string; mm: string; night: boolean }>(({ hh, mm, night }) => (
    <div className="absolute top-2 right-2 z-[72] rounded-xl px-2.5 py-1.5 pointer-events-none select-none"
        style={{
            border: '2px solid rgba(255,255,255,0.9)',
            boxShadow: '0 3px 10px var(--tg-glow25)',
            background: night
                ? `linear-gradient(160deg, ${PAL.night} 0%, #575083 100%)`
                : 'linear-gradient(160deg, #bfe0f7 0%, #e8f5fd 100%)',
        }}>
        {night && (
            <>
                <span className="absolute top-[3px] left-[7px] text-[6px]" style={{ color: '#efe8b8', animation: 'tama-twinkle 2.2s ease-in-out infinite' }}>✦</span>
                <span className="absolute bottom-[4px] right-[8px] text-[5px]" style={{ color: '#cdc6f0' }}>✦</span>
            </>
        )}
        <div className="flex items-center gap-1.5" style={{ fontFamily: FONT_PX }}>
            <span className="text-[11px] leading-none">{night ? '🌙' : '☁️'}</span>
            <div className="leading-none">
                <div className="text-[12px] font-bold tabular-nums tracking-[0.06em]" style={{ color: night ? '#f5f2ff' : PAL.ink }}>{hh}:{mm}</div>
                {night && <div className="text-[8px] mt-[2px] tracking-wide" style={{ color: '#cdc6f0', fontFamily: FONT_CN }}>夜深啦！</div>}
            </div>
        </div>
    </div>
));

// ─── 小屋舞台：渐变描边华丽框；props 全为原始值/memo 引用 ────────────
// 等比例缩放（用户点名修的）：家具/小人是「位置百分比 + 尺寸固定像素」，直接放小容器里
// 会"位置缩了、东西不缩"。这里按固定 390 宽虚拟画布原样渲染，再整体 transform:scale ——
// 墙/地板/家具/小人一起缩，与小屋 App 全屏视图比例完全一致。
// 交互（用户点名要的）：舞台不再是「点一下去小屋 App」的跳转封面——点家具就地看
// （念缓存的反应 + 走过去），戳小人念台词；去小屋 App 改走右下角 ⌂ 小钮 / dock HOME。
const STAGE_W = 390;
const STAGE_H = 330;
const RoomStage = React.memo<{
    items: RoomItem[]; wallStyle: string; floorStyle: string;
    actorImg: string | undefined; night: boolean; pokeLines: string[]; unread: number;
    hh: string; mm: string;
    nudge?: { x: number; y: number; seq: number }; say?: { text: string; seq: number };
    onItemTap: (item: RoomItem) => void;
    onVisit: () => void; onChat: () => void;
}>(({ items, wallStyle, floorStyle, actorImg, night, pokeLines, unread, hh, mm, nudge, say, onItemTap, onVisit, onChat }) => {
    const boxRef = useRef<HTMLDivElement>(null);
    const [scale, setScale] = useState(0);
    useEffect(() => {
        const el = boxRef.current;
        if (!el) return;
        const update = () => setScale(el.clientWidth / STAGE_W);
        update();
        const ro = new ResizeObserver(update);
        ro.observe(el);
        return () => ro.disconnect();
    }, []);
    return (
        /* 外层：渐变描边圈（伴色→邻色→主色浅调）+ 主色柔影 */
        <div className="relative shrink-0 rounded-[2rem] p-[3px]"
            style={{ background: RIM, boxShadow: '0 8px 24px var(--tg-glow35)' }}>
            {/* 框上四角小白钻 */}
            {[[0, 0], [1, 0], [0, 1], [1, 1]].map(([r, b], i) => (
                <span key={i} className="absolute w-2 h-2 rotate-45 pointer-events-none z-[80]"
                    style={{ [r ? 'right' : 'left']: -3, [b ? 'bottom' : 'top']: -3, background: '#fff', boxShadow: `0 0 6px ${PAL.pink}` } as React.CSSProperties} />
            ))}
            <div ref={boxRef}
                className="relative w-full rounded-[1.85rem] overflow-hidden"
                style={{ border: '2px solid rgba(255,255,255,0.9)', contain: 'layout paint', aspectRatio: `${STAGE_W}/${STAGE_H}` }}>
                {/* 虚拟画布：390 宽设计稿整体缩放，人/家具/背景等比例 */}
                {scale > 0 && (
                    <div className="absolute top-0 left-0" style={{ width: STAGE_W, height: STAGE_H, transform: `scale(${scale})`, transformOrigin: 'top left' }}>
                        {/* 墙 / 地板（与 RoomApp 同分割线） */}
                        <div className="absolute top-0 left-0 w-full h-[65%] z-0" style={{ background: wallStyle }} />
                        <div className="absolute bottom-0 left-0 w-full h-[35%] z-0" style={{ background: floorStyle }} />
                        <div className="absolute top-[65%] w-full h-6 bg-gradient-to-b from-black/10 to-transparent pointer-events-none z-0" />
                        <StageWindow night={night} />

                        {items.map(item => <StageItem key={item.id} item={item} onTap={onItemTap} />)}

                        <Actor actorImg={actorImg} night={night} pokeLines={pokeLines} unread={unread} onChat={onChat} nudge={nudge} say={say} />
                    </div>
                )}

                {/* 徽标/钟/⌂ 挂在容器层（不进缩放画布，任何屏宽都保持原生清晰度） */}
                <div className="absolute top-2 left-2 z-[72] rounded-full px-2.5 py-[4px] pointer-events-none select-none flex items-center gap-1.5"
                    style={{ background: `linear-gradient(135deg, ${PAL.pink}, ${PAL.hot})`, border: '1.5px solid rgba(255,255,255,0.85)', boxShadow: '0 3px 8px var(--tg-hotglow45)' }}>
                    <span className="w-1.5 h-1.5 rounded-full bg-white" style={{ animation: 'tama-twinkle 1.6s ease-in-out infinite' }} />
                    <span className="text-[9px] font-bold tracking-[0.16em] text-white" style={{ fontFamily: FONT_PX }}>LIVE</span>
                </div>
                <StageClock hh={hh} mm={mm} night={night} />
                {/* ⌂ 进小屋 App（装修/更新这一天等重操作） */}
                <button onClick={onVisit} aria-label="进小屋"
                    className="absolute bottom-2 right-2 z-[72] w-8 h-8 rounded-xl flex items-center justify-center active:scale-90 transition-transform"
                    style={{ background: 'rgba(255,255,255,0.9)', border: `2px solid ${PAL.frame}`, boxShadow: '0 2px 6px var(--tg-glow25)', color: PAL.grape }}>
                    <div className="w-4 h-4">{DOCK_GLYPHS.home}</div>
                </button>
            </div>
        </div>
    );
});

// ─── 底部五键 dock（CARE / TALK / HOME / ALBUM / SETTINGS）──────────
// 图标一律 currentColor：扁平手绘风里图标用描边同色，不用白色
const DOCK_GLYPHS: Record<string, React.ReactNode> = {
    heart: <svg viewBox="0 0 24 24" className="w-full h-full" fill="currentColor"><path d="M12 21s-7.5-4.9-9.8-9.2C.7 8.9 2.4 5.4 5.7 5.1c1.9-.2 3.7.8 4.7 2.4h3.2c1-1.6 2.8-2.6 4.7-2.4 3.3.3 5 3.8 3.5 6.7C19.5 16.1 12 21 12 21z" transform="scale(0.92) translate(1,1)" /></svg>,
    talk: <svg viewBox="0 0 24 24" className="w-full h-full" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round"><path d="M21 11.5a8.4 8.4 0 0 1-8.5 8.3c-1.4 0-2.8-.3-4-.9L3 20l1.2-4.3a8 8 0 0 1-1.2-4.2A8.4 8.4 0 0 1 11.5 3.2 8.4 8.4 0 0 1 21 11.5z" /><circle cx="8.5" cy="11.5" r="0.6" fill="currentColor" /><circle cx="12" cy="11.5" r="0.6" fill="currentColor" /><circle cx="15.5" cy="11.5" r="0.6" fill="currentColor" /></svg>,
    home: <svg viewBox="0 0 24 24" className="w-full h-full" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><path d="M3 11.5 12 4l9 7.5" /><path d="M5.5 10v9h13v-9" /><path d="M10 19v-5h4v5" /></svg>,
    album: <svg viewBox="0 0 24 24" className="w-full h-full" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><rect x="4" y="3.5" width="16" height="17" rx="2.5" /><path d="M8 3.5v17" /><path d="M14.2 8.4l.9 1.9 2 .3-1.5 1.4.4 2-1.8-1-1.8 1 .4-2-1.5-1.4 2-.3z" fill="currentColor" stroke="none" /></svg>,
    gear: <svg viewBox="0 0 24 24" className="w-full h-full" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><circle cx="12" cy="12" r="3" /><path d="M19 12a7 7 0 0 0-.1-1.2l2-1.5-2-3.4-2.3 1a7 7 0 0 0-2-1.2L14.2 3h-4l-.4 2.5a7 7 0 0 0-2 1.2l-2.3-1-2 3.4 2 1.5a7 7 0 0 0 0 2.4l-2 1.5 2 3.4 2.3-1a7 7 0 0 0 2 1.2l.4 2.5h4l.4-2.5a7 7 0 0 0 2-1.2l2.3 1 2-3.4-2-1.5c.1-.4.1-.8.1-1.2z" /></svg>,
};

// 扁平手绘贴纸键：浅色平涂底 + 同色系描边 + 图标同描边色 + 极淡平面投影
// （不要渐变鼓凸 / 高光帽 / 彩色辉光——那套显廉价，参考 MobileGameHome 的扁平手绘卡）
const DockKey: React.FC<{ glyph: string; label: string; fill: string; line: string; badge?: number; onClick: () => void }> = ({ glyph, label, fill, line, badge = 0, onClick }) => (
    <button onClick={onClick} className="flex flex-col items-center gap-1 group active:scale-90 transition-transform">
        <div className="relative w-11 h-11 rounded-[1rem] flex items-center justify-center"
            style={{ background: fill, border: `2px solid ${line}`, boxShadow: '0 2px 5px var(--tg-glow16)', color: line }}>
            <span className="absolute top-[3px] right-[5px] text-[7px] pointer-events-none" style={{ color: line, opacity: 0.55 }}>✦</span>
            <div className="w-5 h-5">{DOCK_GLYPHS[glyph]}</div>
            {badge > 0 && (
                <span className="absolute -top-1.5 -right-1.5 min-w-[17px] h-[17px] px-1 rounded-full flex items-center justify-center text-[9px] font-bold text-white"
                    style={{ background: PAL.hot, border: '1.5px solid #fff' }}>{badge > 99 ? '99+' : badge}</span>
            )}
        </div>
        <span className="text-[9px] font-bold tracking-[0.1em]" style={{ fontFamily: FONT_PX, color: PAL.ink }}>{label}</span>
    </button>
);

// ─── 信息卡（当前日程 / 一句心声 / 消息）───────────────────────────
// 与 StatusCard 同一套卡面语言：白玉底 + 描金内框 + 四角宝石 + 星芒。
// 全部 memo + 原始值 props：分钟跳动/主色切换不触达它们 reconcile。
const PanelCard: React.FC<{ title: string; right?: React.ReactNode; children: React.ReactNode }> = ({ title, right, children }) => (
    <div className="relative rounded-[1.4rem] px-3.5 py-3 overflow-hidden"
        style={{ background: 'rgba(255,255,255,0.72)', border: `1.5px solid ${PAL.frameSoft}`, boxShadow: '0 5px 16px var(--tg-glow25)' }}>
        <div className="absolute inset-[5px] rounded-[1.1rem] pointer-events-none" style={{ border: '1px solid var(--tg-frame-a30)' }} />
        <GemCorners inset={9} />
        <div className="relative flex items-center justify-between mb-1.5">
            <span className="flex items-center gap-1.5 text-[12px] font-bold tracking-wide" style={{ fontFamily: FONT_CN, color: PAL.grape }}>
                {title}<span className="text-[8px]" style={{ color: PAL.gold }}>✦</span>
            </span>
            {right}
        </div>
        <div className="relative">{children}</div>
    </div>
);

// 当前日程：当前时段 + 之后安排 + 进度点；没日程给引导占位
const SchedulePanel = React.memo<{ curText: string; curTime: string; nextText: string; dots: string; onOpen: () => void }>(
    ({ curText, curTime, nextText, dots, onOpen }) => (
        <PanelCard title="当前日程" right={<span className="text-[13px] tabular-nums" style={{ fontFamily: FONT_NUM, color: PAL.grape }}>{curTime}</span>}>
            <button onClick={onOpen} className="w-full text-left active:opacity-80">
                <p className="text-[13px] leading-relaxed" style={{ fontFamily: FONT_CN, color: PAL.ink }}>{curText}</p>
                {nextText && <p className="text-[10px] mt-1" style={{ color: PAL.fade, fontFamily: FONT_CN }}>{nextText}</p>}
                {dots && (
                    <div className="flex items-center gap-1.5 mt-2">
                        {dots.split('').map((d, i) => (
                            <span key={i} className="rounded-full" style={d === '1'
                                ? { width: 8, height: 8, background: 'var(--tg-ink)' }
                                : { width: 6, height: 6, background: 'var(--tg-frame-a30)' }} />
                        ))}
                    </div>
                )}
            </button>
        </PanelCard>
    )
);

// 一句心声：情绪评估的 innerState → 日程意识流 → 「新的一天。」占位
const HeartPanel = React.memo<{ text: string }>(({ text }) => (
    <PanelCard title="一句心声" right={<span className="text-[12px]" style={{ color: PAL.fade }}>🪶</span>}>
        <p className="text-[12px] leading-[1.8]" style={{ fontFamily: FONT_CN, color: PAL.grape, display: '-webkit-box', WebkitLineClamp: 3, WebkitBoxOrient: 'vertical', overflow: 'hidden' }}>{text}</p>
    </PanelCard>
));

// 消息：最近几条对话气泡 + 「回点什么…」回复条（点击无缝跳聊天）
const MessagesPanel = React.memo<{ msgs: { id: number; mine: boolean; text: string }[]; unread: number; onChat: () => void }>(
    ({ msgs, unread, onChat }) => (
        <PanelCard title="消息" right={
            <button onClick={onChat} className="text-[10px] font-bold active:scale-95 flex items-center gap-1" style={{ color: PAL.fade, fontFamily: FONT_CN }}>
                {unread > 0 && <span className="min-w-[16px] h-[16px] px-1 rounded-full flex items-center justify-center text-[9px] font-bold text-white" style={{ background: PAL.hot }}>{unread > 99 ? '99+' : unread}</span>}
                全部 ›
            </button>
        }>
            {msgs.length > 0 ? (
                <div className="space-y-1.5 mb-2.5">
                    {msgs.map(m => (
                        <div key={m.id} className={`flex ${m.mine ? 'justify-end' : 'justify-start'}`}>
                            <div className="max-w-[82%] px-2.5 py-1.5 rounded-2xl text-[11px] leading-relaxed"
                                style={m.mine
                                    ? { background: `linear-gradient(135deg, ${PAL.peri}, ${PAL.pink})`, color: '#fff', borderBottomRightRadius: 6, fontFamily: FONT_CN, textShadow: '0 1px 2px rgba(90,70,130,0.25)' }
                                    : { background: PAL.cream, color: PAL.ink, border: `1.5px solid ${PAL.frameSoft}`, borderBottomLeftRadius: 6, fontFamily: FONT_CN }}>
                                {m.text}
                            </div>
                        </div>
                    ))}
                </div>
            ) : (
                <p className="text-[11px] mb-2.5" style={{ color: PAL.fade, fontFamily: FONT_CN }}>还没聊过天，说点什么吧。</p>
            )}
            <button onClick={onChat} className="w-full flex items-center gap-2 px-3 py-2 rounded-2xl active:scale-[0.99] transition-transform"
                style={{ background: PAL.cream, border: `2px solid ${PAL.frameSoft}` }}>
                <span className="flex-1 text-left text-[11px]" style={{ color: PAL.fade, fontFamily: FONT_CN }}>回点什么…</span>
                <span className="w-6 h-6 rounded-full flex items-center justify-center shrink-0"
                    style={{ background: `linear-gradient(135deg, ${PAL.pink}, ${PAL.hot})`, boxShadow: '0 2px 6px var(--tg-hotglow45)' }}>
                    <svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" fill="#fff" className="w-3 h-3"><path d="M3.478 2.404a.75.75 0 0 0-.926.941l2.432 7.905H13.5a.75.75 0 0 1 0 1.5H4.984l-2.432 7.905a.75.75 0 0 0 .926.94 60.519 60.519 0 0 0 18.445-8.986.75.75 0 0 0 0-1.218A60.517 60.517 0 0 0 3.478 2.404Z" /></svg>
                </span>
            </button>
        </PanelCard>
    )
);

/** 与 context.ts buildScheduleInjection 同款分钟数比较：从后往前找第一个已开始的 slot。 */
const findCurrentSlot = (schedule: DailySchedule | null): { cur: ScheduleSlot | null; next: ScheduleSlot | null } => {
    if (!schedule?.slots?.length) return { cur: null, next: null };
    const now = new Date();
    const m = now.getHours() * 60 + now.getMinutes();
    for (let i = schedule.slots.length - 1; i >= 0; i--) {
        const [h, mi] = schedule.slots[i].startTime.split(':').map(Number);
        if (m >= h * 60 + mi) return { cur: schedule.slots[i], next: schedule.slots[i + 1] || null };
    }
    return { cur: null, next: schedule.slots[0] };
};

// ─── 主组件 ───────────────────────────────────────────────────
const TamagotchiHome: React.FC = () => {
    const { openApp, characters, activeCharacterId, setActiveCharacterId, virtualTime, unreadMessages, isDataLoaded, lastMsgTimestamp, addToast } = useOS();

    const [stat, setStat] = useState<{ msgCount: number; pokeLines: string[]; recent: { id: number; mine: boolean; text: string }[] }>({ msgCount: 0, pokeLines: [], recent: [] });
    const [drawerOpen, setDrawerOpen] = useState(false);
    // 今日日程（当前日程卡 + 心声兜底）：一天一份，进屏取一次
    const [schedule, setSchedule] = useState<DailySchedule | null>(null);
    // 一句心声：localStorage 读取放进 state，避免 virtualTime 每秒 re-render 都同步读盘
    const [heartLine, setHeartLine] = useState('');
    // 家具就地交互：走过去(nudge) + 念反应(say) + 观察旁白（seq 事件驱动，无常驻动画）
    const [nudge, setNudge] = useState<{ x: number; y: number; seq: number }>({ x: 48, y: 80, seq: 0 });
    const [say, setSay] = useState<{ text: string; seq: number }>({ text: '', seq: 0 });
    const [observation, setObservation] = useState('');
    const [devDebugVisible, setDevDebugVisible] = useState(() => isDevDebugAvailable());
    useEffect(() => subscribeDevDebugAvailability(setDevDebugVisible), []);

    // 主色调：localStorage 持久化（皮肤内偏好，不动 OS theme）
    const [accentHue, setAccentHue] = useState<number>(() => {
        const v = localStorage.getItem(HUE_KEY);
        const n = v === null ? NaN : parseInt(v, 10);
        return Number.isFinite(n) ? ((n % 360) + 360) % 360 : DEFAULT_HUE;
    });
    const [paletteOpen, setPaletteOpen] = useState(false);
    const [extracting, setExtracting] = useState(false);
    const setAccent = useCallback((h: number) => {
        const hh = ((Math.round(h) % 360) + 360) % 360;
        setAccentHue(hh);
        try { localStorage.setItem(HUE_KEY, String(hh)); } catch { /* 私密模式等场景失败无妨 */ }
    }, []);
    const rootVars = useMemo(() => makeVars(accentHue), [accentHue]);

    const char: CharacterProfile | null = useMemo(
        () => characters.find(c => c.id === activeCharacterId) || characters[0] || null,
        [characters, activeCharacterId]
    );

    // 取数：消息数（Lv/经验条）+ ta 最近 30 条文字回复（戳一戳台词，最新在前按顺序循环）
    // + 消息卡的最近 3 条文本气泡预览（同一次查询顺手带出，不多读一次库）
    useEffect(() => {
        if (!isDataLoaded || !char) { setStat({ msgCount: 0, pokeLines: [], recent: [] }); return; }
        DB.getMessagesByCharId(char.id).then(msgs => {
            const visible = msgs.filter(m => m.role !== 'system');
            const lines = visible
                .filter(m => m.role === 'assistant')
                .map(m => m.content.replace(/\[.*?\]/g, '').trim())
                .filter(t => t.length > 0)
                .slice(-30)
                .reverse()
                .map(t => t.length > 42 ? t.slice(0, 42) + '…' : t);
            const recent = visible
                .filter(m => (m.role === 'user' || m.role === 'assistant') && (!m.type || m.type === 'text') && typeof m.content === 'string' && m.content.trim())
                .slice(-3)
                .map(m => ({
                    id: m.id,
                    mine: m.role === 'user',
                    text: m.content.length > 56 ? m.content.slice(0, 56) + '…' : m.content,
                }));
            setStat({ msgCount: visible.length, pokeLines: lines, recent });
        }).catch(() => {});
    }, [char?.id, lastMsgTimestamp, isDataLoaded]);

    // 今日日程：换角色 / 有新消息（聊天会触发生成）时刷一次
    useEffect(() => {
        if (!char) { setSchedule(null); return; }
        const today = new Date().toISOString().split('T')[0];
        DB.getDailySchedule(char.id, today).then(s => setSchedule(s || null)).catch(() => setSchedule(null));
    }, [char?.id, lastMsgTimestamp]);

    // 一句心声：innerState（情绪评估落的）→ 日程意识流 → 占位
    useEffect(() => {
        if (!char) { setHeartLine('新的一天。'); return; }
        const inner = getLastInnerState(char.id);
        const flow = schedule?.flowNarrative?.[getFlowNarrativeKey(new Date().getHours())] || '';
        setHeartLine(inner || flow || '新的一天。');
    }, [char?.id, lastMsgTimestamp, schedule]);

    // 家具就地交互：小屋 App 同款（读 savedRoomState.items 的缓存反应，零 LLM 调用），
    // 走过去 + 念一句 + 观察旁白；这段互动照样落一条系统消息进聊天（带最近 50 条去重），
    // 让角色记得「刚才一起看过这件东西」。
    const onItemTap = useCallback((item: RoomItem) => {
        if (!char) return;
        const saved = (char.savedRoomState?.items || {}) as Record<string, { description?: string; reaction?: string }>;
        const cached = saved[item.id] || saved[item.name];
        const reaction = cached?.reaction || '(盯…)';
        const desc = cached?.description || `${item.name}静静地摆在那里。`;
        setNudge(p => ({ x: item.x, y: Math.min(92, Math.max(FLOOR_HORIZON + 5, item.y + 5)), seq: p.seq + 1 }));
        setSay(p => ({ text: reaction.length > 42 ? reaction.slice(0, 42) + '…' : reaction, seq: p.seq + 1 }));
        setObservation(desc);
        if (cached?.description) {
            const content = `[${char.name}的小屋]（在主屏幕看了看${item.name}）${desc}。${char.name}表示：${cached.reaction || ''}`;
            DB.getMessagesByCharId(char.id).then(msgs => {
                const dup = msgs.slice(-50).some(m => m.role === 'system' && m.content === content);
                if (!dup) DB.saveMessage({ charId: char.id, role: 'system', type: 'text', content }).catch(() => {});
            }).catch(() => {});
        }
    }, [char]);

    // 小屋数据：优先角色 roomConfig，兜底镜像样板房（见文件头注释）
    const isSully = char?.id === 'preset-sully-v2' || char?.name === 'Sully';
    const items = useMemo<RoomItem[]>(() => {
        const saved = char?.roomConfig?.items;
        if (saved && saved.length > 0) return saved;
        return isSully ? FALLBACK_SULLY : FALLBACK_DEFAULT;
    }, [char?.roomConfig?.items, isSully]);

    // blobref 令牌 → 可渲染 url（hook 需无条件顶层调用）
    const wallImg = useBlobRefUrl(char?.roomConfig?.wallImage);
    const floorImg = useBlobRefUrl(char?.roomConfig?.floorImage);
    const actorImg = useBlobRefUrl(char?.sprites?.['chibi'] || char?.avatar);
    const wallStyle = getBgStyle(wallImg, char?.roomConfig?.wallScale, char?.roomConfig?.wallRepeat, FALLBACK_WALL);
    const floorStyle = getBgStyle(floorImg, char?.roomConfig?.floorScale, char?.roomConfig?.floorRepeat, FALLBACK_FLOOR);

    // 「提取小窝主色」：依次尝试 墙纸→地板→立绘（图片走 canvas 采样，渐变串直接解析色值）
    const extractRoomHue = useCallback(async () => {
        if (extracting) return;
        setExtracting(true);
        try {
            for (const cand of [wallImg, floorImg, actorImg]) {
                if (!cand) continue;
                const isUrl = cand.startsWith('http') || cand.startsWith('data') || cand.startsWith('blob:');
                const h = isUrl ? await hueFromImage(cand) : hueFromGradient(cand);
                if (h !== null) {
                    setAccent(h);
                    addToast('已提取小窝主色 ✦', 'success');
                    return;
                }
            }
            addToast('没提取到明显的主色，试试手动选一个', 'info');
        } finally {
            setExtracting(false);
        }
    }, [wallImg, floorImg, actorImg, extracting, setAccent, addToast]);

    const night = isNightHour(virtualTime.hours);
    const hh = virtualTime.hours.toString().padStart(2, '0');
    const mm = virtualTime.minutes.toString().padStart(2, '0');
    const { level, exp, expMax } = deriveStats(stat.msgCount);

    // 当前日程卡的展示串（纯字符串 props → memo 卡片只在内容真变时 reconcile）
    const { cur: curSlot, next: nextSlot } = findCurrentSlot(schedule);
    const slotCurTime = curSlot?.startTime || '--:--';
    const slotCurText = curSlot
        ? `${curSlot.emoji ? curSlot.emoji + ' ' : ''}${curSlot.activity}${curSlot.location ? `（${curSlot.location}）` : ''}`
        : (schedule ? `今天还没开始活动${nextSlot ? `，稍后先${nextSlot.activity}（${nextSlot.startTime}）` : ''}` : '今天的日程还没生成，去聊两句就有了～');
    const slotNextText = curSlot && nextSlot ? `之后 · ${nextSlot.startTime} ${nextSlot.activity}` : '';
    const slotDots = schedule?.slots?.length
        ? schedule.slots.map(s => (curSlot && s.startTime <= curSlot.startTime) ? '1' : '0').join('')
        : '';
    const totalUnread = useMemo(() => Object.values(unreadMessages).reduce((a, b) => a + b, 0), [unreadMessages]);
    const charUnread = char ? (unreadMessages[char.id] || 0) : 0;

    const openRoom = useCallback(() => openApp(AppID.Room), [openApp]);
    const openChat = useCallback(() => openApp(AppID.Chat), [openApp]);
    const switchChar = useCallback(() => {
        if (characters.length < 2 || !char) return;
        const idx = characters.findIndex(c => c.id === char.id);
        setActiveCharacterId(characters[(idx + 1) % characters.length].id);
    }, [characters, char, setActiveCharacterId]);

    const drawerApps = useMemo(
        () => INSTALLED_APPS.filter(a => a.id !== AppID.CharCreatorDev || devDebugVisible),
        [devDebugVisible]
    );

    return (
        <div className="h-full w-full relative z-10 overflow-hidden select-none flex flex-col px-4"
            style={{ ...rootVars, color: PAL.ink, fontFamily: FONT_CN, paddingTop: 'calc(var(--safe-top, 0px) + 0.75rem)', paddingBottom: 'calc(var(--safe-bottom, 0px) + 0.9rem)' }}>
            {/* 本皮肤专用 keyframes（只碰 transform/opacity） */}
            <style>{`
                @keyframes tama-breathe { 0%,100% { transform: translateY(0); } 50% { transform: translateY(-3px); } }
                @keyframes tama-bounce { 0% { transform: scale(1); } 35% { transform: scale(1.12, 0.9); } 70% { transform: scale(0.95, 1.06); } 100% { transform: scale(1); } }
                @keyframes tama-zzz { 0%,100% { opacity: 0.35; transform: translateY(0); } 50% { opacity: 1; transform: translateY(-4px); } }
                @keyframes tama-twinkle { 0%,100% { opacity: 0.25; transform: scale(0.8); } 50% { opacity: 1; transform: scale(1.1); } }
                @keyframes tama-drift { 0% { transform: translateX(-4%); } 100% { transform: translateX(5%); } }
            `}</style>

            <BackDecor />

            {/* ===== 报头（小头像 + 品牌字 + 🎨 + ⋯）===== */}
            <div className="relative flex items-center justify-between shrink-0">
                <div className="flex items-center gap-2 min-w-0">
                    {char && (
                        <div className="w-8 h-8 rounded-full p-[2px] shrink-0" style={{ background: RIM }}>
                            <div className="w-full h-full rounded-full overflow-hidden" style={{ border: '1.5px solid #fff', background: '#fff' }}>
                                <img src={char.avatar} className="w-full h-full object-cover" alt="" loading="lazy" draggable={false} />
                            </div>
                        </div>
                    )}
                    <span className="text-[10px]" style={{ color: PAL.hot }}>✦</span>
                    <span className="text-[13px] font-bold tracking-[0.26em] truncate" style={{ fontFamily: FONT_PX, color: PAL.grape, textShadow: '0 1px 0 rgba(255,255,255,0.9), 0 2px 10px var(--tg-glow35)' }}>SULLY·GOTCHI</span>
                    <span className="text-[9px] shrink-0" style={{ color: PAL.gold, animation: 'tama-twinkle 2.6s ease-in-out infinite' }}>✦</span>
                </div>
                <div className="flex items-center gap-1.5 shrink-0">
                    {/* 🎨 主色调 */}
                    <button onClick={() => setPaletteOpen(v => !v)} aria-label="主色调"
                        className="w-9 h-9 rounded-xl flex items-center justify-center active:scale-90 transition-transform"
                        style={{ background: PAL.cream, border: `2px solid ${PAL.frame}`, boxShadow: '0 2px 5px var(--tg-glow16)' }}>
                        <span className="text-[14px] leading-none">🎨</span>
                    </button>
                    <button onClick={() => setDrawerOpen(true)} aria-label="全部应用"
                        className="w-10 h-9 rounded-xl flex items-center justify-center active:scale-90 transition-transform"
                        style={{ background: PAL.cream, border: `2px solid ${PAL.frame}`, boxShadow: '0 2px 5px var(--tg-glow16)' }}>
                        <span className="text-[15px] font-bold leading-none tracking-widest" style={{ fontFamily: FONT_PX, color: PAL.ink }}>⋯</span>
                    </button>
                </div>
            </div>

            {/* ===== 🎨 主色调面板（扁平手绘小卡，点外面关闭）===== */}
            {paletteOpen && (
                <>
                    <div className="absolute inset-0 z-[45]" onClick={() => setPaletteOpen(false)} />
                    <div className="absolute right-4 z-50 w-[15.5rem] rounded-2xl p-3.5 animate-pop-in"
                        style={{ top: 'calc(var(--safe-top, 0px) + 3.4rem)', background: PAL.cream, border: `2px solid ${PAL.frame}`, boxShadow: '0 8px 22px var(--tg-glow35)' }}>
                        <div className="flex items-center gap-1.5 mb-2.5">
                            <span className="text-[12px]">🎨</span>
                            <span className="text-[12px] font-bold tracking-wide" style={{ fontFamily: FONT_CN, color: PAL.grape }}>主色调</span>
                            <span className="text-[8px]" style={{ color: PAL.gold }}>✦</span>
                        </div>
                        <div className="grid grid-cols-6 gap-2 mb-3">
                            {HUE_PRESETS.map(p => {
                                const active = accentHue === p.h;
                                return (
                                    <button key={p.h} onClick={() => setAccent(p.h)} title={p.name}
                                        className="flex flex-col items-center gap-1 active:scale-90 transition-transform">
                                        <span className="w-7 h-7 rounded-full flex items-center justify-center"
                                            style={{ background: hsl(p.h, 55, 75), border: active ? '2px solid #fff' : '2px solid rgba(255,255,255,0.6)', boxShadow: active ? `0 0 0 2px ${hsl(p.h, 45, 58)}, 0 2px 6px ${hsl(p.h, 50, 60, 0.5)}` : '0 1px 4px rgba(120,110,150,0.25)' }}>
                                            {active && <span className="text-[9px] text-white">✦</span>}
                                        </span>
                                        <span className="text-[8px]" style={{ fontFamily: FONT_CN, color: PAL.fade }}>{p.name}</span>
                                    </button>
                                );
                            })}
                        </div>
                        <button onClick={extractRoomHue} disabled={extracting}
                            className="w-full py-2 rounded-xl text-[11px] font-bold active:scale-95 transition-transform disabled:opacity-60 flex items-center justify-center gap-1.5"
                            style={{ background: `linear-gradient(135deg, ${PAL.pink}, ${PAL.peri})`, border: '2px solid rgba(255,255,255,0.85)', color: '#fff', fontFamily: FONT_CN, textShadow: '0 1px 2px rgba(90,70,130,0.35)' }}>
                            <span>🏠</span>{extracting ? '正在打量小窝…' : '提取小窝主色'}
                        </button>
                        <p className="text-[8.5px] leading-relaxed mt-2 text-center" style={{ color: PAL.fade, fontFamily: FONT_CN }}>
                            从 ta 的墙纸 / 地板 / 立绘里找主色，整台机子跟着换装
                        </p>
                    </div>
                </>
            )}

            {char ? (
                <>
                    <StatusCard hh={hh} mm={mm} level={level} exp={exp} expMax={expMax} charName={char.name} avatar={char.avatar} multiChar={characters.length > 1} onSwitch={switchChar} />

                    {/* ===== 中段（可滚动）：小屋舞台 + 观察旁白 + 三张信息卡 ===== */}
                    <div className="relative flex-1 min-h-0 overflow-y-auto no-scrollbar mt-3.5 pb-1.5">
                        <RoomStage
                            items={items} wallStyle={wallStyle} floorStyle={floorStyle}
                            actorImg={actorImg} night={night} pokeLines={stat.pokeLines} unread={charUnread}
                            hh={hh} mm={mm}
                            nudge={nudge} say={say} onItemTap={onItemTap}
                            onVisit={openRoom} onChat={openChat}
                        />
                        {/* 观察旁白（点家具后出现）/ 平时是华丽分节丝带 */}
                        {observation ? (
                            <div className="relative mt-2 px-3.5 py-2.5 rounded-2xl"
                                style={{ background: 'rgba(255,255,255,0.72)', border: `1.5px solid ${PAL.frameSoft}`, boxShadow: '0 4px 12px var(--tg-glow16)' }}>
                                <div className="flex justify-between items-start">
                                    <span className="text-[8px] font-bold tracking-[0.28em]" style={{ fontFamily: FONT_PX, color: PAL.fade }}>OBSERVATION ✦</span>
                                    <button onClick={() => setObservation('')} className="px-1 -mt-0.5" style={{ color: PAL.fade }}>×</button>
                                </div>
                                <p className="text-[11px] leading-relaxed mt-0.5" style={{ fontFamily: FONT_CN, color: PAL.grape }}>{observation}</p>
                            </div>
                        ) : (
                            <div className="flex items-center gap-2 mt-2 px-2">
                                <div className="flex-1 h-px" style={{ background: `linear-gradient(90deg, transparent, ${PAL.frame})`, opacity: 0.6 }} />
                                <span className="text-[8px]" style={{ color: PAL.hot }}>✦</span>
                                <span className="text-[9px] tracking-[0.3em] font-bold" style={{ fontFamily: FONT_PX, color: PAL.fade }}>TAP FURNITURE · POKE TA</span>
                                <span className="text-[8px]" style={{ color: PAL.hot }}>✦</span>
                                <div className="flex-1 h-px" style={{ background: `linear-gradient(270deg, transparent, ${PAL.frame})`, opacity: 0.6 }} />
                            </div>
                        )}

                        {/* 三张信息卡：当前日程 / 一句心声 / 消息 */}
                        <div className="mt-2.5 space-y-2.5">
                            <SchedulePanel curText={slotCurText} curTime={slotCurTime} nextText={slotNextText} dots={slotDots} onOpen={openChat} />
                            <HeartPanel text={heartLine} />
                            <MessagesPanel msgs={stat.recent} unread={charUnread} onChat={openChat} />
                        </div>
                    </div>

                    {/* ===== 五键 dock：渐变描边条 + 扁平贴纸键 ===== */}
                    <div className="shrink-0 rounded-[1.5rem] p-[2.5px] mt-1.5" style={{ background: RIM, boxShadow: '0 6px 18px var(--tg-glow35)' }}>
                        <div className="relative rounded-[1.35rem] px-3 pt-2 pb-1.5 flex items-end justify-between"
                            style={{ background: 'rgba(255,255,255,0.88)', boxShadow: 'inset 0 1px 0 rgba(255,255,255,0.95)' }}>
                            <Sparkles items={[[6, 18, 8, PAL.pink, 0.7], [94, 22, 8, PAL.peri, 0.7], [50, 6, 7, PAL.gold, 0.8, true]]} />
                            <DockKey glyph="heart" label="CARE" fill="#fcd6de" line="#e0748f" onClick={() => openApp(AppID.Date)} />
                            <DockKey glyph="talk" label="TALK" fill="#cdeede" line="#58ab84" badge={totalUnread} onClick={openChat} />
                            {/* 中央 HOME：扁平贴纸悬浮（同样不鼓凸） */}
                            <button onClick={openRoom} className="relative flex flex-col items-center gap-1 -mt-6 active:scale-95 transition-transform">
                                <div className="relative w-[3.6rem] h-[3.6rem] rounded-[1.2rem] flex items-center justify-center"
                                    style={{ background: '#fffdf8', border: `2px solid ${PAL.frame}`, boxShadow: '0 3px 8px var(--tg-glow25)', color: PAL.grape }}>
                                    <div className="w-7 h-7">{DOCK_GLYPHS.home}</div>
                                    <span className="absolute -top-1 -right-1 text-[10px]" style={{ color: PAL.gold, animation: 'tama-twinkle 2s ease-in-out infinite' }}>✦</span>
                                </div>
                                <span className="text-[9px] font-bold tracking-[0.1em]" style={{ fontFamily: FONT_PX, color: PAL.ink }}>HOME</span>
                            </button>
                            <DockKey glyph="album" label="ALBUM" fill="#e4dbf8" line="#9678d8" onClick={() => openApp(AppID.MemoryPalace)} />
                            <DockKey glyph="gear" label="SETTINGS" fill="#d9def5" line="#7f8fd0" onClick={() => openApp(AppID.Settings)} />
                        </div>
                    </div>
                </>
            ) : (
                /* 零角色兜底：像素小蛋 */
                <div className="relative flex-1 flex flex-col items-center justify-center gap-4">
                    <Sparkles items={[[30, 30, 12, PAL.pink, 0.8, true], [70, 26, 10, PAL.gold, 0.8, true], [24, 62, 9, PAL.peri, 0.7], [76, 66, 11, '#fff', 0.8, true]]} />
                    <div className="w-24 h-28 rounded-[50%_50%_46%_46%/58%_58%_42%_42%]"
                        style={{ background: `linear-gradient(180deg, ${PAL.cream}, var(--tg-rim3))`, border: `2.5px solid ${PAL.frame}`, boxShadow: '0 8px 20px var(--tg-glow35)', animation: 'tama-breathe 2.4s ease-in-out infinite' }} />
                    <p className="text-[12px] text-center leading-relaxed" style={{ fontFamily: FONT_PX, color: PAL.fade }}>EMPTY EGG…</p>
                    <button onClick={() => openApp(AppID.Character)} className="px-5 py-2.5 rounded-2xl text-[13px] font-bold text-white active:scale-95 transition-transform"
                        style={{ background: `linear-gradient(135deg, ${PAL.pink}, ${PAL.hot})`, border: '2px solid rgba(255,255,255,0.8)', boxShadow: '0 5px 14px var(--tg-hotglow45)', fontFamily: FONT_CN }}>
                        去神经链接领养一只
                    </button>
                </div>
            )}

            {/* ===== 全部应用抽屉（逃生舱口：外观 / 全部 App 都在这） ===== */}
            {drawerOpen && (
                <div className="absolute inset-0 z-40 flex flex-col animate-fade-in" style={{ background: 'var(--tg-drawer)' }} onClick={() => setDrawerOpen(false)}>
                    <div className="flex items-center justify-between px-6" style={{ paddingTop: 'calc(var(--safe-top, 0px) + 1.25rem)', paddingBottom: '0.5rem' }}>
                        <h2 className="text-lg tracking-wide" style={{ fontFamily: FONT_CN, color: PAL.ink }}>全部应用</h2>
                        <button onClick={(e) => { e.stopPropagation(); setDrawerOpen(false); }} aria-label="关闭"
                            className="w-9 h-9 rounded-xl flex items-center justify-center active:scale-90 transition-transform"
                            style={{ background: '#fff', border: `2px solid ${PAL.frame}` }}>
                            <svg viewBox="0 0 24 24" className="w-5 h-5" fill="none" stroke="currentColor" strokeWidth="2.5" style={{ color: PAL.ink }}><path strokeLinecap="round" d="M6 6l12 12M18 6L6 18" /></svg>
                        </button>
                    </div>
                    <div className="flex-1 overflow-y-auto no-scrollbar px-5 pb-8" onClick={(e) => e.stopPropagation()}>
                        <div className="grid grid-cols-4 gap-y-5 gap-x-2 place-items-center">
                            {drawerApps.map(app => (
                                <AppIcon key={app.id} app={app} size="md" onClick={() => { setDrawerOpen(false); openApp(app.id); }} />
                            ))}
                        </div>
                    </div>
                </div>
            )}
        </div>
    );
};

export default TamagotchiHome;
