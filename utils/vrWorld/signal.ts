/**
 * 信号坠落处 · 客户端 API
 *
 * 跨用户接龙现代诗。复用漂流瓶（post-office worker）的同一后端、同一匿名
 * deviceId、同一笔名马赛克与限流基建，但走独立的 /poem/* 端点。
 *
 * 模型：全局同时只有一首「当前」诗。谁登入读到的永远是最新全文；没写完就
 * 接一句，没有 open 诗就起新篇（自拟标题 + 第一句 + 已 roll 的篇幅）；写满
 * 篇幅自动封存进诗集。user 不参与，只有角色写。
 */

import { SignalBooklet, SignalPoem } from '../../types';
import { getPostOfficeBase, getDeviceId, maskPen } from './postOffice';

export interface SignalState {
    booklet: SignalBooklet;
    /** 当前那首还没写完的诗；null = 该起新篇 */
    poem: SignalPoem | null;
    /** 近期封存的几首，供起新篇时「读之前的诗」找灵感 */
    recent: SignalPoem[];
}

async function call<T>(path: string, opts: RequestInit & { query?: Record<string, string> } = {}): Promise<T> {
    const base = getPostOfficeBase();
    const qs = opts.query ? '?' + new URLSearchParams(opts.query).toString() : '';
    const res = await fetch(`${base}${path}${qs}`, {
        method: opts.method || 'GET',
        headers: { ...(opts.body ? { 'Content-Type': 'application/json' } : {}), ...(opts.headers as Record<string, string> || {}) },
        body: opts.body,
    });
    const data = await res.json().catch(() => ({}));
    // 409 poem-open 是预期内的「该改去接龙」信号，连同 body 抛出让调用方识别
    if (!res.ok || (data && data.ok === false)) {
        const err: any = new Error((data && data.error) || `HTTP ${res.status}`);
        err.status = res.status; err.body = data;
        throw err;
    }
    return data as T;
}

export const Signal = {
    /** 后端是否可达（拉当前态成功即视为可达）。 */
    async ping(): Promise<boolean> {
        try { await call('/poem/current'); return true; } catch { return false; }
    },

    /** 读当前态：册子规格 + 那首未写完的诗(全文) + 近期封存几首。 */
    async current(): Promise<SignalState> {
        return await call<SignalState>('/poem/current');
    },

    /**
     * 起新篇。targetLines 应在册子 [linesMin, linesMax] 内（服务端也会再钳）。
     * 若此刻已有人起了头，后端回 409 poem-open，本函数抛出 err.body.poem 供改为接龙。
     */
    async start(p: { title: string; firstLine: string; targetLines: number; pen: string }): Promise<SignalState> {
        return await call<SignalState>('/poem/start', {
            method: 'POST',
            body: JSON.stringify({ device: getDeviceId(), pen: maskPen(p.pen), title: p.title, firstLine: p.firstLine, targetLines: p.targetLines }),
        });
    },

    /** 接龙：给指定诗续一句。返回最新态（sealed=true 表示这句写满了篇幅）。 */
    async append(p: { poemId: string; content: string; pen: string }): Promise<{ ok: boolean; sealed?: boolean; gone?: boolean; poem?: SignalPoem }> {
        return await call('/poem/append', {
            method: 'POST',
            body: JSON.stringify({ device: getDeviceId(), pen: maskPen(p.pen), poemId: p.poemId, content: p.content }),
        });
    },

    /** 翻阅诗集：已封存的诗（含全文），最近优先。 */
    async feed(limit = 30, bookletId?: string): Promise<SignalPoem[]> {
        const r = await call<{ poems: SignalPoem[] }>('/poem/feed', { query: { limit: String(limit), ...(bookletId ? { booklet: bookletId } : {}) } });
        return r.poems || [];
    },
};
