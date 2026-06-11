import { describe, it, expect, vi } from 'vitest';
import { applyAssistantPostProcessing, PostProcessCtx, XhsCaches } from './applyAssistantPostProcessing';
import { DB } from './db';

// 锁住 renderAndPersist normal path 的引用顺延修复:
// 模型把 [[QUOTE:]] 单独写一行 (典型形态: 标签后紧跟 [[SEND_EMOJI:]] / 换行 + 正文),
// chunkText 按换行拆分后引用标签独占一个 chunk — 剥标签后没有正文不落库,
// 修复前解析出的引用目标随这个空 chunk 一起被丢弃, 表现为"引用被后处理吞掉"。
// 修复后引用目标顺延挂到下一条真正落库的文字气泡。

const makeCtx = (charId: string, contextMsgs: any[]): PostProcessCtx => {
    const xhsCaches: XhsCaches = {
        xsecTokenCache: new Map(),
        noteTitleCache: new Map(),
        commentUserIdCache: new Map(),
        commentAuthorNameCache: new Map(),
        commentParentIdCache: new Map(),
    };
    return {
        char: { id: charId, name: '测试角色' } as any,
        userProfile: { name: '我' } as any,
        emojis: [],
        contextMsgs,
        fullMessages: [],
        initialData: {},
        historyMsgCount: 0,
        xhsCaches,
        api: {
            baseUrl: 'http://localhost:0',
            headers: {},
            effectiveApi: { baseUrl: 'http://localhost:0', apiKey: '', model: 'test' },
        },
        hooks: {
            setMessages: vi.fn(),
            addToast: vi.fn(),
        },
    };
};

const quotedUserMsg = {
    id: 101,
    charId: 'c-quote',
    role: 'user' as const,
    type: 'text' as const,
    content: '引用我说的话，还有后面一长串内容',
    timestamp: Date.now() - 1000,
};

describe('renderAndPersist 引用解析', () => {
    it('[[QUOTE:]] 单独成行 (后跟 SEND_EMOJI + 正文) 时引用顺延到第一条文字气泡', async () => {
        const charId = `c-quote-${Date.now()}`;
        const raw = '[[QUOTE: 引用我说的话]]\n[[SEND_EMOJI: 有点生气]]\n消失了整整三十六个小时';

        await applyAssistantPostProcessing(raw, makeCtx(charId, [{ ...quotedUserMsg, charId }]));

        const msgs = await DB.getRecentMessagesByCharId(charId, 50);
        const texts = msgs.filter(m => m.role === 'assistant' && m.type === 'text');
        expect(texts.length).toBe(1);
        expect(texts[0].content).toBe('消失了整整三十六个小时');
        // 修复前: replyTo 为 undefined (引用目标随空 chunk 丢失)
        expect(texts[0].replyTo).toBeTruthy();
        expect(texts[0].replyTo!.id).toBe(101);
        expect(texts[0].replyTo!.name).toBe('我');
    }, 20000);

    it('[[QUOTE:]] 与正文同一行时引用仍挂在该气泡 (既有行为不回归)', async () => {
        const charId = `c-quote-inline-${Date.now()}`;
        const raw = '[[QUOTE: 引用我说的话]]你干嘛去了';

        await applyAssistantPostProcessing(raw, makeCtx(charId, [{ ...quotedUserMsg, charId }]));

        const msgs = await DB.getRecentMessagesByCharId(charId, 50);
        const texts = msgs.filter(m => m.role === 'assistant' && m.type === 'text');
        expect(texts.length).toBe(1);
        expect(texts[0].content).toBe('你干嘛去了');
        expect(texts[0].replyTo?.id).toBe(101);
    }, 20000);

    it('引用只挂一次: 顺延目标落到首条气泡后, 后续气泡不带 replyTo', async () => {
        const charId = `c-quote-once-${Date.now()}`;
        const raw = '[[QUOTE: 引用我说的话]]\n第一句话\n第二句话';

        await applyAssistantPostProcessing(raw, makeCtx(charId, [{ ...quotedUserMsg, charId }]));

        const msgs = await DB.getRecentMessagesByCharId(charId, 50);
        const texts = msgs.filter(m => m.role === 'assistant' && m.type === 'text');
        expect(texts.map(m => m.content)).toEqual(['第一句话', '第二句话']);
        expect(texts[0].replyTo?.id).toBe(101);
        expect(texts[1].replyTo).toBeFalsy();
    }, 20000);
});
