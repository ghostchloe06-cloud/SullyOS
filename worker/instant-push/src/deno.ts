/**
 * Deno Deploy 入口 — 复用 index.ts 的 CF 形态 fetch handler, 零改动。
 *
 * 与 CF 入口的差异只有三点:
 *   - env 从 Deno.env 读取 (Playground / Deploy 的环境变量 UI)。没有 D1 binding,
 *     /capabilities 会如实报告 d1 不可用, 前台自动落到 multipart。
 *   - waitUntil: Deno 没有这个生命周期 API。这里用一个 Set 把后台 promise
 *     拽住防 GC + 吞错。Deno Deploy 是常驻进程模型, 实例存活时浮空 promise
 *     会继续跑 —— 没有 CF 那条书面的「断开后最多 30s」上限, 但也没有书面保证,
 *     「发完立刻杀 App」场景的实际存活窗口以实测为准。
 *   - scheduled 不接: 它只服务 D1 过期清理, Deno 入口永远没有 D1。
 *
 * 打包: scripts/build-workers.mjs 产出 worker/instant-push/worker.deno.bundle.js,
 * 整份贴进 dash.deno.com 的 Playground 即可运行。
 */

import worker, { type Env } from './index';

declare const Deno: {
  env: { get(name: string): string | undefined };
  serve(handler: (request: Request) => Response | Promise<Response>): unknown;
};

/** 每个请求现读一遍 env, 与 CF 入口「secrets 按请求注入」的语义保持一致。 */
function readEnv(): Env {
  return {
    VAPID_PUBLIC_KEY: Deno.env.get('VAPID_PUBLIC_KEY') ?? '',
    VAPID_PRIVATE_KEY: Deno.env.get('VAPID_PRIVATE_KEY') ?? '',
    VAPID_EMAIL: Deno.env.get('VAPID_EMAIL'),
    AMSG_CLIENT_TOKEN: Deno.env.get('AMSG_CLIENT_TOKEN'),
    AMSG_OVERSIZE_TRANSPORT: Deno.env.get('AMSG_OVERSIZE_TRANSPORT'),
    AMSG_ENABLE_D1_BLOBSTORE: Deno.env.get('AMSG_ENABLE_D1_BLOBSTORE'),
    // DB 不给: D1 路径在 Deno 入口永远关闭
  };
}

// waitUntil shim: 强引用兜住后台 promise, 防止被 GC; 错误就地吞掉
// (与 CF 行为一致, 失败由 amsg-instant 自己通过 onEvent 上报)。
const pendingBackgroundWork = new Set<Promise<unknown>>();
const ctx = {
  waitUntil(work: Promise<unknown>): void {
    const tracked = work.catch(() => {});
    pendingBackgroundWork.add(tracked);
    tracked.finally(() => pendingBackgroundWork.delete(tracked));
  },
};

Deno.serve((request: Request) => worker.fetch(request, readEnv(), ctx));
