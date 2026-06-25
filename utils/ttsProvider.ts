/**
 * 全局 TTS 服务商选择（MiniMax ↔ 鱼声 Fish Audio）。
 *
 * 大多数语音合成入口都能拿到 apiConfig，直接用 `resolveTtsProvider(apiConfig)` 即可。
 * 但少数地方（如 chatPrompts.buildSystemPrompt 拼语音格式指导时）拿不到 apiConfig，
 * 所以这里额外维护一个模块级单例：OSContext 在 apiConfig.ttsProvider 变化时
 * 调 setTtsProvider() 同步，prompt 侧用 getTtsProvider() 读最新值。
 * （与 minimaxEndpoint 里的 region 单例同一套思路。）
 */
import type { APIConfig, TtsProvider } from '../types';

export const normalizeTtsProvider = (raw: unknown): TtsProvider =>
  raw === 'fishaudio' ? 'fishaudio' : 'minimax';

let currentProvider: TtsProvider = 'minimax';

export function setTtsProvider(provider: TtsProvider | string | undefined | null): void {
  currentProvider = normalizeTtsProvider(provider);
}

export function getTtsProvider(): TtsProvider {
  return currentProvider;
}

/** 从 apiConfig 解析当前 TTS 服务商（缺省 → minimax）。 */
export const resolveTtsProvider = (apiConfig?: Pick<APIConfig, 'ttsProvider'> | null): TtsProvider =>
  normalizeTtsProvider(apiConfig?.ttsProvider);
