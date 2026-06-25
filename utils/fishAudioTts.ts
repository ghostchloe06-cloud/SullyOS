/**
 * 鱼声 Fish Audio TTS 工具 —— MiniMax 的平行实现，供聊天 / 约会 / 电话二选一复用。
 *
 * 与 MiniMax 的关键差异：
 *  1. 鱼声直接返回二进制音频（mp3），不是 JSON 里塞 hex；
 *  2. 选音色用 reference_id（voiceProfile.fishReferenceId），不是 MiniMax 的 voice_id；
 *  3. 模型走 `model` 请求头（s2.1-pro / s2-pro / s1）；
 *  4. 没有 MiniMax 的 <#秒#> 停顿标记 —— 那套标记鱼声不认、会被原样念出来，
 *     所以这里绝不 insertSpeechBreaks，还要把混进来的 <#x#> 清掉做兜底。
 *  5. 情绪用方括号 cue（[happy] 等），这里把上层传来的 emotion 前置成一个方括号标签。
 *
 * 文本清洗 / <语音> 标签解析仍复用 minimaxTts 的那套（与服务商无关）。
 */
import { CharacterProfile, APIConfig } from '../types';
import { Capacitor, CapacitorHttp } from '@capacitor/core';
import { hashTtsParams, getCachedTts, saveCachedTts } from './ttsCache';
import { normalizeApiKey } from './minimaxApiKey';
import type { TtsResult } from './minimaxTts';

const FISH_PROXY_PATH = '/api/fishaudio/tts';
const FISH_UPSTREAM = 'https://api.fish.audio/v1/tts';
const DEFAULT_FISH_MODEL = 's2.1-pro';

/**
 * 鱼声语音演出规范 —— 与 MiniMax 版同源（呼吸、句长、情绪节奏的原理一致），
 * 但用鱼声**原生**的表达机制：直接在台词里写自然语言方括号 cue（[happy]、
 * [warm and happy]、[whispering]、[laughing]、[break] 等），鱼声会演绎、不会念出来。
 * 不再借用 MiniMax 的 <#秒#> 停顿标记 / emotion 属性那一套。
 */
export const FISH_VOICE_ACTING_GUIDE = `### 让它听起来像活人在说话（重要）

**你现在是在「说话」，不是在「打字」。** 这条会被转成真实语音念给对方听，所以内容必须口语化、像嘴里自然说出来的话，不能是书面语。别用书面/正式措辞、长定语从句、文绉绉的连接词（"然而""与此同时""综上所述"这类一律不要）；该用"嗯""欸""那个……""反正"这些日常口头语就用。一句话读出来要顺口、像聊天，不像念稿。

你写的字会被鱼声原样念出来。目标不是"写一段通顺的话"，而是"写一段读出来有呼吸、有情绪起伏的对白"。读稿感、客服腔、新闻播报腔一旦出现就重写。

**1. 鱼声用方括号 cue 控制情绪和声音，直接写在台词里（用的是 S2.1-Pro，把 [方括号] 当自然语言理解）。**
- **cue 可以放在句子任意位置**，不止句首——放在你想让那个情绪/动作发生的那个字前面，就在那一刻触发。例：\`真不敢相信 [gasp] 你居然真做了 [laugh]\`。整句基调的情绪放句首最顺，精确的小情绪/声响就贴着那个点放。
- **鼓励用自然语言描述、可叠副词，不限固定词表**：\`[whispers sweetly]\`（甜甜地悄悄说）\`[laughing nervously]\`（紧张地笑）\`[warm and happy]\`\`[slightly sad]\`\`[very excited]\`\`[nervous and uncertain]\`。越贴当下心情越好，别永远只用 [happy]/[sad] 那几个干词。
- 常用基础 cue：\`[whisper]\`\`[laugh]\`\`[emphasis]\`（加重）\`[angry]\`\`[excited]\`\`[sad]\`\`[surprised]\`\`[shouting]\`。
- **轻声/气声这类"音量"效果，单写 \`[soft tone]\`/\`[whisper]\` 往往很弱、几乎听不出。想要真的轻下来，用更具体的自然语言描述**（S2.1 对描述越细越敏感）：\`[whispering very softly]\`、\`[almost whispering, breathy]\`、\`[speaking softly and gently]\`、\`[hushed, intimate tone]\`。配合内容也压低（短句、省略号、别用感叹号）效果才出得来。
- 真实声响：\`[laughing]\`\`[chuckling]\`\`[sighing]\`\`[sobbing]\`\`[gasping]\` —— 后面最好补一点拟声字，如 "[laughing] 哈哈哈"。
- 停顿：\`[break]\`（短停）\`[long-break]\`（长停）。换行/分段不用你手动加停顿，系统会自动在换行处插停顿。
这些方括号 cue 只是演出指令，**不会被念出来**，也不会显示给用户。
**⚠️ 格式硬性要求（写错会被原样念出来）：cue 一律用半角英文方括号 \`[like this]\`，括号里只写英文。** 绝对不要用：圆括号 \`(sighs)\`/\`(laughs)\`（那是别的引擎的写法，鱼声会把"sighs"念出来）、中文方括号 \`[轻声]\`/全角【】、或 \`<语音 emotion="…">\` 这种属性——鱼声只认上面的英文方括号 cue。

**2.〔铁律〕除了三五个字的小短句，每一句都要在句首带一个贴合那句情绪的 cue。**
一句一个、别堆、跟着情绪变。**一整段没几个 cue 就会被鱼声平平念完、像机器人念稿（人机）——这是最大的翻车。** 反过来，一句里塞 3 个以上、或短句还硬塞，会发飘发抖（鬼畜）。所以规则很简单：**每句一个，随情绪换。**
- 句首放主情绪 cue；句中那个具体的笑/叹/喘就贴着发生处再补一个（如 \`[laughing]\`）。
- 小短句（"好啦""嗯""喂？"三五个字）可以不放，靠标点。
- 别永远 \`[happy]\`：得意 \`[smug]\`、调侃 \`[teasing]\`、俏皮 \`[playful]\`、撒娇 \`[pleading]\`、好奇 \`[curious]\`、吐槽 \`[annoyed]\`、温柔 \`[gentle and warm]\`、害羞 \`[shy]\`……越贴那句的具体心情越好。

**完整范例（照着这个密度写——几乎每句句首都有一个、随情绪换）：**
原文（人机）：你终于回消息了。我还以为你今天不理我了呢。我今天上班差点迟到，地铁挤得像沙丁鱼罐头。对了，你上次推荐的那家店我去了，真的好吃。下次有空一起去吧。

改好（自然）：
\`[happy] 你终于回消息了！[teasing] 我还以为你今天不理我了呢。[tired] 我今天上班差点迟到，地铁挤得跟沙丁鱼罐头似的。[excited] 对了，你上次推荐的那家店我去了，是真的好吃！[hopeful] 下次有空一起去吧？\`

看到没——五句话，句句句首一个 cue，情绪一路从开心→调侃→疲惫→兴奋→期待地变。**这就是目标密度。**

看到没——六句话，句句句首一个 cue，情绪一路从调侃→笑→得意→温柔→好奇→俏皮地变。**这就是目标密度。**

**3. 段与段之间要换气，别无缝冲。** 换行或停顿后如果还是你在继续说，第二段开头加个语气词 / 一次叹气当缓冲，别一上来就冲进正题。
✅ 我知道你不是故意的……[sighing] 只是，我还是会有点难过。
❌ 我知道你不是故意的。只是我还是会有点难过。（两句贴死，像棒读）

**4. 句子长短交错。** 一连串等长的句子是棒读头号来源。短句砸下来，长句铺开。想强调就拆开念："我。没。拿。"

**5. 停顿也能靠标点和省略号。** 逗号轻顿、句号收住、破折号拉长、省略号"……"表欲言又止；需要明显沉默就用 \`[long-break]\` 或多个省略号。别写 MiniMax 的 \`<#0.5#>\` 这类标记——鱼声不认，会被原样念出来变杂音。

**6. 情绪不同，节奏不同（每句给它自己的主情绪 cue，别一个包到底；单句别堆超过 2–3 个）：**
- 温柔安抚：慢、稳、短句多。"[soft tone] 没事……先别急着吓自己。"
- 委屈撒娇：语气软、省略号多一点。"[slightly sad] 嗯……你刚刚是不是又不理我。"
- 别扭傲娇：前半句嘴硬后半句放软。"[sarcastic] 哈，你还真会折腾我。[soft tone] 算了，我帮你就是了。"
- 难过压抑：更慢、更多省略号。"[sad] ……我知道。只是有点难受。"
- 紧张犹豫：断裂感，短句多。"[nervous] 等等……我好像，有点不确定。"
- 吐槽轻松：别太慢。"[relaxed] 行吧。人类又发明了新的折磨方式。"

（朗读语种不是中文时，上面示例里的中文语气词换成该语言里自然的叹词 / 填充词即可，方括号 cue 写法不变，呼吸和节奏的原理也不变。）`;

// 鱼声方括号 cue：单层 [..]（区别于系统标记 [[..]]），内容 1–40 字符。情绪/语气/声响/停顿都走这个。
const FISH_BRACKET_CUE_RE = /\[[^\[\]]{1,40}\]/g;
// 鱼声 paralanguage 圆括号特效（V1.6）：(break)/(long-break)/(breath)/(laugh)/(cough)/(lip-smacking)/(sigh)
const FISH_PAREN_FX = new Set(['break', 'long-break', 'breath', 'laugh', 'cough', 'lip-smacking', 'sigh']);
// 模型常按 MiniMax 习惯写圆括号声音标签 (laughs)/(sighs)…。鱼声不认圆括号、会念出来，
// 但这些是真实情绪/动作，删了就变平（人机）。所以**转成**鱼声的方括号 cue，保住情绪。
const PAREN_SOUND_TO_BRACKET: Record<string, string> = {
  laughs: 'laughing', laugh: 'laughing', laughing: 'laughing',
  chuckle: 'chuckling', chuckles: 'chuckling', chuckling: 'chuckling',
  giggle: 'giggling', giggles: 'giggling', giggling: 'giggling',
  sighs: 'sighing', sigh: 'sighing', sighing: 'sighing',
  gasp: 'gasping', gasps: 'gasping', gasping: 'gasping',
  sob: 'sobbing', sobs: 'sobbing', sobbing: 'sobbing', crying: 'sobbing',
  groan: 'groaning', groans: 'groaning', groaning: 'groaning',
  pant: 'panting', pants: 'panting', panting: 'panting',
  whisper: 'whisper', whispers: 'whisper', whispering: 'whisper',
  cough: 'cough', coughs: 'cough', coughing: 'cough',
  yawn: 'yawning', yawns: 'yawning', yawning: 'yawning',
  snort: 'snorting', snorts: 'snorting',
};

/** 整条情绪兜底映射：仅当上层传了 emotion 属性、且正文没有任何方括号 cue 时，前置一个 cue。 */
const FISH_EMOTION_MAP: Record<string, string> = {
  happy: 'happy',
  sad: 'sad',
  angry: 'angry',
  fearful: 'scared',
  disgusted: 'disgusted',
  surprised: 'surprised',
  calm: 'calm',
};

const FISH_VOICE_TAG_RE = /<[语語]音[^>]*>([\s\S]*?)<\/[语語]音>/;

/**
 * 鱼声专用文本清洗（区别于 MiniMax 的 cleanTextForTts）：
 * 关键差异 —— **保留**英文方括号 cue（[happy]/[whispering]…）原样送进 API。
 * 但要清掉「会被鱼声念出来」的脏东西：
 *  - 系统标记 [[..]]、双语分隔、中文舞台指示（…）、MiniMax <#秒#>；
 *  - MiniMax 的圆括号声音标签 (laughs)/(sighs)/(chuckle)…（鱼声不认会念出来），
 *    只放行少数鱼声 paralanguage 特效（break/laugh/sigh 等）；
 *  - 含中文字符的方括号 cue（如 [开心]/[轻声]）—— 鱼声只认英文 cue，中文会被念出来。
 */
export const cleanTextForTtsFish = (raw: string): string => {
  if (!raw) return '';
  const tagMatch = raw.match(FISH_VOICE_TAG_RE);
  let text = tagMatch ? tagMatch[1] : raw;
  text = text
    .replace(/\[\[.*?\]\]/g, '')                 // [[系统标记]]（双层，先于单层 cue 处理）
    .replace(/%%BILINGUAL%%[\s\S]*/i, '')        // 双语分隔及之后
    .replace(/（[^）]{0,48}）/g, '')              // 中文舞台指示，一律删
    .replace(/<#\s*[\d.]+\s*#>/g, '')            // MiniMax 停顿标记，鱼声不认
    // 含中文的方括号 cue：鱼声只认英文 cue，中文写进去会被原样念出来 → 删
    .replace(/\[[^\[\]]*[一-鿿][^\[\]]*\]/g, '')
    // 圆括号：① 已知声音标签 (laughs)→[laughing] 转成鱼声 cue（保住情绪）；
    //         ② 鱼声原生 paralanguage 特效 (break) 等保留；③ 其余（舞台指示/未知）删掉。
    .replace(/\(([^)]{1,40})\)/g, (m, inner: string) => {
      const key = inner.trim().toLowerCase();
      if (PAREN_SOUND_TO_BRACKET[key]) return `[${PAREN_SOUND_TO_BRACKET[key]}]`;
      if (FISH_PAREN_FX.has(key)) return m;
      return '';
    })
    // 换行写死成停顿（不靠模型/指导）：段落空行 → 长停，普通换行 → 短停。
    .replace(/\n{2,}/g, ' [long-break] ')
    .replace(/\n+/g, ' [break] ')
    .replace(/\s+/g, ' ')
    .trim();
  return text;
};

/**
 * 把鱼声演出标记从「要显示给用户」的文本里清掉：方括号 cue + 鱼声圆括号特效。
 * 用于聊天气泡 / 转文字面板，免得用户看到一堆 [whispering]、(break)。
 */
export const stripFishMarkupForDisplay = (text?: string | null): string => {
  if (!text) return '';
  return text
    .replace(FISH_BRACKET_CUE_RE, '')
    .replace(/\(([^)]{1,20})\)/g, (m, inner: string) =>
      FISH_PAREN_FX.has(inner.trim().toLowerCase()) ? '' : m)
    .replace(/<#\s*[\d.]+\s*#>/g, '')
    .replace(/[ \t]{2,}/g, ' ')
    .replace(/[ \t]+([，。！？、；：,.!?…])/g, '$1')
    .trim();
};

/** 解析 apiConfig 里的鱼声 Key（独立 Key，不复用通用 apiKey —— 那是 LLM 的）。 */
export const resolveFishAudioApiKey = (apiConfig: APIConfig): string =>
  normalizeApiKey(apiConfig.fishAudioApiKey || '');

/**
 * 归一化鱼声音色 id（reference_id）。容忍用户直接粘 fish.audio 网页链接：
 *   https://fish.audio/app/text-to-speech/?modelId=98655a12fa944e26b274c535e5e03842
 * 也容忍只粘 id 本身。reference_id 是 32 位十六进制（UUID 去横线）。
 */
export const normalizeFishReferenceId = (raw?: string | null): string => {
  const s = (raw || '').trim();
  if (!s) return '';
  // 1) URL 里的 ?modelId=... / &modelId=...
  const byQuery = s.match(/[?&]modelId=([a-z0-9]+)/i);
  if (byQuery) return byQuery[1];
  // 2) 任意位置的 32 位十六进制串（覆盖纯 id 和路径形式）
  const byHex = s.match(/[a-f0-9]{32}/i);
  if (byHex) return byHex[0];
  // 3) 兜底：去掉可能的查询串/空白
  return s.split(/[?#\s]/)[0];
};

/** 该角色能否用鱼声合成（必须有 Key + reference_id）。 */
export const canSynthesizeFish = (char: CharacterProfile, apiConfig: APIConfig): boolean =>
  !!resolveFishAudioApiKey(apiConfig) && !!normalizeFishReferenceId(char.voiceProfile?.fishReferenceId);

const isNative = (): boolean => {
  try {
    return Capacitor.isNativePlatform();
  } catch {
    return false;
  }
};

const shouldBypassWebProxy = (): boolean => {
  if (typeof window === 'undefined') return false;
  const protocol = String(window.location.protocol || '').toLowerCase();
  if (protocol === 'file:') return true;
  const host = String(window.location.hostname || '').toLowerCase();
  return host === 'github.io' || host.endsWith('.github.io');
};

/** base64 → Blob（CapacitorHttp 二进制响应是 base64 字符串）。 */
const base64ToBlob = (b64: string, mime = 'audio/mpeg'): Blob => {
  const binary = atob(b64);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
  return new Blob([bytes], { type: mime });
};

/**
 * 调鱼声 /v1/tts，拿回音频 Blob。
 * web：默认走 /api/fishaudio/tts 代理；静态预览（github.io / file:）直连上游兜底。
 * native：CapacitorHttp 直连上游，responseType='blob' 绕过浏览器 CORS。
 */
const fishFetchAudio = async (
  payload: any,
  apiKey: string,
  model: string,
): Promise<Blob> => {
  const jsonHeaders = {
    'Content-Type': 'application/json',
    Authorization: `Bearer ${apiKey}`,
    model,
  };

  if (isNative()) {
    const response = await CapacitorHttp.request({
      url: FISH_UPSTREAM,
      method: 'POST',
      headers: jsonHeaders,
      data: payload,
      responseType: 'blob',
    });
    if (response.status < 200 || response.status >= 300) {
      throw new Error(`鱼声 TTS 失败 (HTTP ${response.status})`);
    }
    // CapacitorHttp blob 响应：data 是 base64 字符串
    return base64ToBlob(String(response.data || ''));
  }

  const url = shouldBypassWebProxy() ? FISH_UPSTREAM : FISH_PROXY_PATH;
  const res = await fetch(url, {
    method: 'POST',
    headers: jsonHeaders,
    body: JSON.stringify(payload),
  });
  if (!res.ok) {
    let detail = '';
    try { detail = (await res.text()).slice(0, 200); } catch { /* ignore */ }
    throw new Error(`鱼声 TTS 失败 (HTTP ${res.status})${detail ? `：${detail}` : ''}`);
  }
  const blob = await res.blob();
  if (!blob.size) throw new Error('鱼声 TTS 返回空音频');
  return blob;
};

/**
 * 调鱼声 TTS，返回可播放 URL + 原始 blob（可写 IndexedDB 持久化）。
 * 与 minimaxTts.synthesizeSpeechDetailed 同签名，方便 ttsRouter 透明切换。
 */
export async function synthesizeSpeechFishDetailed(
  text: string,
  char: CharacterProfile,
  apiConfig: APIConfig,
  options?: { languageBoost?: string; groupId?: string; emotion?: string },
): Promise<TtsResult> {
  const apiKey = resolveFishAudioApiKey(apiConfig);
  if (!apiKey) throw new Error('缺少鱼声 Fish Audio API Key');
  const vp = char.voiceProfile;
  const referenceId = normalizeFishReferenceId(vp?.fishReferenceId);
  if (!referenceId) throw new Error('角色未配置鱼声音色（reference_id）');

  const model = (vp?.fishModel || apiConfig.fishAudioModel || DEFAULT_FISH_MODEL).trim() || DEFAULT_FISH_MODEL;

  // Fish-aware 清洗：保留方括号 cue / 圆括号特效，只清系统标记和 MiniMax 残留。
  let spoken = cleanTextForTtsFish(text);
  // 兜底：上层传了整条 emotion 属性、且正文没有任何方括号 cue 时，前置一个 cue。
  // 正常情况下 LLM 已按鱼声指导在正文写了 inline cue，这里不会触发。
  // 兜底：上层传了整条 emotion 属性、且正文没有任何「情绪/语气」cue 时，前置一个 cue。
  // 注意只看情绪类 cue，[break]/[long-break] 这类停顿不算（否则换行插的停顿会顶掉兜底）。
  const emotionCues = (spoken.match(/\[([^\]]+)\]/g) || [])
    .filter(c => !/^\[(break|long-break)\]$/i.test(c.trim()));
  const hasInlineCue = emotionCues.length > 0;
  const fishEmotion = options?.emotion ? FISH_EMOTION_MAP[options.emotion.toLowerCase()] : undefined;
  if (fishEmotion && !hasInlineCue) spoken = `[${fishEmotion}] ${spoken}`;
  if (!spoken) throw new Error('鱼声 TTS 文本为空');

  // F12 调试：打印 LLM 带标签原文 + 实际送鱼声的文本，方便排查「标签被念出来」之类问题。
  console.log('[fishaudio] TTS', {
    model,
    reference_id: referenceId,
    emotion_attr: options?.emotion || '',
    raw_llm_text: text,        // LLM 输出的带标签原文
    sent_to_fish: spoken,      // 清洗后真正发给鱼声的文本
  });

  const payload: any = {
    text: spoken,
    reference_id: referenceId,
    format: 'mp3',
    // 展开数字/日期为自然读法，长文本更稳。
    normalize: true,
  };
  if (vp?.speed && vp.speed !== 1) {
    payload.prosody = { speed: Math.max(0.5, Math.min(2, vp.speed)) };
  }

  const cacheKey = hashTtsParams({
    kind: 'fishaudio-tts',
    text: payload.text,
    model,
    reference_id: payload.reference_id,
    format: payload.format,
    prosody: payload.prosody,
  });
  const cached = await getCachedTts(cacheKey);
  if (cached) {
    return { url: URL.createObjectURL(cached), blob: cached };
  }

  const blob = await fishFetchAudio(payload, apiKey, model);
  saveCachedTts(cacheKey, blob).catch(() => { /* ignore */ });
  return { url: URL.createObjectURL(blob), blob };
}

/** 薄封装：只要可播放 URL 时用。 */
export async function synthesizeSpeechFish(
  text: string,
  char: CharacterProfile,
  apiConfig: APIConfig,
  options?: { languageBoost?: string; groupId?: string; emotion?: string },
): Promise<string> {
  const { url } = await synthesizeSpeechFishDetailed(text, char, apiConfig, options);
  return url;
}
