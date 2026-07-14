import { describe, it, expect } from 'vitest';
import { computeStreamPreviewBubbles } from './streamPreview';

// 流式预览气泡的过滤策略：宁缺毋滥 —— 指令/语音/翻译/日记/HTML 块一律不预览，
// 半截行不上屏。预览只影响体感，最终渲染仍由 applyAssistantPostProcessing 负责。

describe('computeStreamPreviewBubbles', () => {
    it('半截行（无换行）不展示', () => {
        expect(computeStreamPreviewBubbles('今天天气真好')).toEqual([]);
    });

    it('已完成的行逐条成为气泡，最后的半截行被扣住', () => {
        const bubbles = computeStreamPreviewBubbles('今天天气真好\n要不要出去走走\n我在想');
        expect(bubbles).toEqual(['今天天气真好', '要不要出去走走']);
    });

    it('含 [[...]] 指令的行不预览（表情/动作/召回等）', () => {
        const text = '哼，看在你可怜的份上\n[[SEND_EMOJI: 傲娇]]\n[[RECALL: 2024-05]]\n明天见\n';
        expect(computeStreamPreviewBubbles(text)).toEqual(['哼，看在你可怜的份上', '明天见']);
    });

    it('定时消息指令行不预览', () => {
        const text = '晚安啦\n[schedule_message | 2026-07-15 08:00:00 | fixed | 早安！]\n';
        expect(computeStreamPreviewBubbles(text)).toEqual(['晚安啦']);
    });

    it('单行语音标签整行跳过', () => {
        const text = '先打个字\n<语音 emotion="happy">你猜猜我在干嘛？</语音>\n再打一行\n';
        expect(computeStreamPreviewBubbles(text)).toEqual(['先打个字', '再打一行']);
    });

    it('跨行语音块（未闭合时全部扣住，闭合后仍不预览块内容）', () => {
        const open = '好\n<语音 emotion="sad">I do not wanna\n';
        expect(computeStreamPreviewBubbles(open)).toEqual(['好']);
        const closed = open + 'move anymore</语音>\n<字幕>不想动了</字幕>\n但是没办法\n';
        expect(computeStreamPreviewBubbles(closed)).toEqual(['好', '但是没办法']);
    });

    it('日记多行块不泄漏为聊天气泡', () => {
        const text = '我写篇日记去\n[[DIARY_START: 今天 | 开心]]\n# 大标题\n正文絮絮叨叨\n[[DIARY_END]]\n写完了\n';
        expect(computeStreamPreviewBubbles(text)).toEqual(['我写篇日记去', '写完了']);
    });

    it('HTML 卡片块不泄漏', () => {
        const text = '给你做张卡\n[html]\n<div>card</div>\n[/html]\n好看吗\n';
        expect(computeStreamPreviewBubbles(text)).toEqual(['给你做张卡', '好看吗']);
    });

    it('think 块（content 内嵌形态）不泄漏', () => {
        const text = '<think>\n她这句话是什么意思…\n</think>\n没什么，随口一问\n';
        expect(computeStreamPreviewBubbles(text)).toEqual(['没什么，随口一问']);
    });

    it('双语翻译标签行不预览', () => {
        const text = '<翻译>\n<原文>こんにちは</原文>\n<译文>你好</译文>\n</翻译>\n';
        expect(computeStreamPreviewBubbles(text)).toEqual([]);
    });

    it('CJK 之间的空格按最终管线同样切成多个气泡', () => {
        const bubbles = computeStreamPreviewBubbles('你来了 坐吧\n');
        expect(bubbles).toEqual(['你来了', '坐吧']);
    });

    it('空文本 / 纯空行返回空数组', () => {
        expect(computeStreamPreviewBubbles('')).toEqual([]);
        expect(computeStreamPreviewBubbles('\n\n')).toEqual([]);
    });
});
