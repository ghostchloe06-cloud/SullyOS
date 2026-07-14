import { describe, it, expect, vi, afterEach } from 'vitest';
import { safeFetchJson } from './safeApi';

// 锁住流式读取路径 (readBodyWithStreaming) 与整包路径的行为一致性：
//  - SSE 增量正文触发 onDelta，最终拼出与非流式相同结构的 completion 对象
//  - tool_calls 分片按 index 合并（工具模式开 stream 不丢调用）
//  - 代理无视 stream:true 返回整包 JSON 时静默退化，onDelta 不触发

const sseBody = (events: string[]) => new ReadableStream<Uint8Array>({
    start(controller) {
        const enc = new TextEncoder();
        for (const e of events) controller.enqueue(enc.encode(e));
        controller.close();
    },
});

const sseResponse = (events: string[]) => new Response(sseBody(events), {
    status: 200,
    headers: { 'Content-Type': 'text/event-stream' },
});

afterEach(() => vi.restoreAllMocks());

describe('safeFetchJson streaming', () => {
    it('SSE 增量触发 onDelta 且最终 completion 与整包解析一致', async () => {
        const events = [
            'data: {"id":"x","choices":[{"delta":{"role":"assistant","content":"你好"}}]}\n\n',
            'data: {"choices":[{"delta":{"content":"呀\\n在干嘛"}}]}\n\n',
            'data: {"choices":[{"delta":{},"finish_reason":"stop"}],"usage":{"total_tokens":42,"prompt_tokens":30,"completion_tokens":12}}\n\n',
            'data: [DONE]\n',
        ];
        vi.stubGlobal('fetch', vi.fn(async () => sseResponse(events)));

        const deltas: string[] = [];
        let lastFull = '';
        const data = await safeFetchJson('https://api.test/v1/chat/completions', { method: 'POST', body: '{}' }, 0, 0, undefined, {
            onDelta: (d, full) => { deltas.push(d); lastFull = full; },
        });

        expect(deltas.join('')).toBe('你好呀\n在干嘛');
        expect(lastFull).toBe('你好呀\n在干嘛');
        expect(data.choices[0].message.content).toBe('你好呀\n在干嘛');
        expect(data.choices[0].finish_reason).toBe('stop');
        expect(data.usage.total_tokens).toBe(42);
    });

    it('tool_calls 分片按 index 合并，不因流式丢失', async () => {
        const events = [
            'data: {"choices":[{"delta":{"tool_calls":[{"index":0,"id":"call_1","type":"function","function":{"name":"propose_cart_items","arguments":"{\\"items\\""}}]}}]}\n\n',
            'data: {"choices":[{"delta":{"tool_calls":[{"index":0,"function":{"arguments":":[]}"}}]}}]}\n\n',
            'data: [DONE]\n',
        ];
        vi.stubGlobal('fetch', vi.fn(async () => sseResponse(events)));

        const data = await safeFetchJson('https://api.test/v1/chat/completions', { method: 'POST', body: '{}' }, 0, 0, undefined, { onDelta: () => {} });
        const tc = data.choices[0].message.tool_calls;
        expect(tc).toHaveLength(1);
        expect(tc[0].id).toBe('call_1');
        expect(tc[0].function.name).toBe('propose_cart_items');
        expect(tc[0].function.arguments).toBe('{"items":[]}');
    });

    it('代理返回整包 JSON（无视 stream）时退化解析，onDelta 不触发', async () => {
        const json = { choices: [{ message: { role: 'assistant', content: '整包回复' }, finish_reason: 'stop' }] };
        vi.stubGlobal('fetch', vi.fn(async () => new Response(JSON.stringify(json), {
            status: 200, headers: { 'Content-Type': 'application/json' },
        })));

        const deltas: string[] = [];
        const data = await safeFetchJson('https://api.test/v1/chat/completions', { method: 'POST', body: '{}' }, 0, 0, undefined, {
            onDelta: (d) => { deltas.push(d); },
        });
        expect(deltas).toEqual([]);
        expect(data.choices[0].message.content).toBe('整包回复');
    });

    it('不传 streamHooks 时对 SSE 响应仍走整包拼接（旧行为不变）', async () => {
        const events = [
            'data: {"choices":[{"delta":{"content":"a"}}]}\n\n',
            'data: {"choices":[{"delta":{"content":"b"}}]}\n\n',
            'data: [DONE]\n',
        ];
        vi.stubGlobal('fetch', vi.fn(async () => sseResponse(events)));
        const data = await safeFetchJson('https://api.test/v1/chat/completions', { method: 'POST', body: '{}' }, 0, 0);
        expect(data.choices[0].message.content).toBe('ab');
    });
});
