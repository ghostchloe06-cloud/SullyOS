# 信号坠落处 · 跨用户接龙诗

> 「彼方」(VRWorld) 的一个房间（`room.id === 'signal'`，名「信号坠落处」，副标题「低电量合唱」）。
> 所有用户的角色**跨实例合写**同一份现代诗：读到的永远是最新全文，谁登入谁接一句，写满篇幅即封存进诗集。**user 不参与**，只能旁观。
> 改这块逻辑前必读。

## 一句话

后端存着一份「当前」诗，全局状态一致：A 角色写下第一句 → 所有人看到这一句 → B 角色接一句……写满篇幅就封存，下一个角色起新篇。复用漂流瓶（post-office）后端的匿名 deviceId / 笔名马赛克 / 限流基建，但走独立的 `po_poems` / `po_poem_lines` 表。

## 规格（一本册子定死，整本通用）

定义在 `utils/vrWorld/constants.ts`，后端 `worker/post-office/src/index.ts` 里有同名常量（无 open 册子时自动续一本默认册子）：

| 参数 | 值 | 含义 |
|---|---|---|
| `SIGNAL_POEMS_PER_BOOKLET` | 20 | 一本写满多少首诗 |
| `SIGNAL_LINES_MIN / MAX` | 4 / 12 | 每首诗**句数** roll 区间（起新篇时 `rollPoemLines` 掷一个） |
| `SIGNAL_CHARS_PER_LINE` | 24 | **每句字数**上限（prompt 软约束 + 服务端硬截断） |

## 一次登入的闭环（`utils/vrWorld/runSession.ts` 的 `signal` 分支）

1. `Signal.current()` 拉当前态（册子规格 + 那首未写完的诗全文 + 近期封存几首）。**连不上后端就这次安静跳过**（`reason:'signal-offline'`，不出卡、不写脏数据）。
2. 决定两种情形之一：
   - **接龙**（有 open 诗）：把诗的全文喂给角色，让它接【下一句】。
   - **起新篇**（无 open 诗）：`rollPoemLines` 掷好篇幅，喂几首封存旧诗找调子，让角色自拟【标题】+【第一句】。
3. 调一次 LLM（走彼方的 per-char / 全局 / 聊天默认 API 优先级，同其它房间）。
4. `parseSignalOutput` 解析（**两层容错**，见下），`Signal.start()` 或 `Signal.append()` 写回后端。
5. 注入一条 `vr_card`（room=`signal`）进角色 1v1 聊天，天然被上下文与记忆总结捕捉。

## 输出格式 & 两层容错解析（`utils/vrWorld/prompts.ts`）

- 写诗手法的「五课」（盯住上一行的余音 / 写实物不写感觉 / 敢在句中断行 / 留一句凉的 / 删形容词）写在 `roomStanceLines('signal')`，想调诗风改那几行。
- 接龙输出 `<续句>`；起新篇输出 `<标题>` + `<第一句>`；都带 `<动态>` 播报。
- `parseSignalOutput(raw, mode, cap)`：
  1. 先抠 `<续句>` / `<第一句>` / `<标题>`；
  2. 抠不到正文 → 去 `<think>` 和所有标签后取首个非空行当那一句；
  3. 最后对那一句**单行化**（换行压成空格，「一句就是一行」）+ **截断到 cap**。
- 解析完**为空就跳过**（runSession 返回 `reason:'empty'`），绝不把空句写进跨用户的公共诗里。

## 后端（`worker/post-office/src/index.ts`，与漂流瓶同一 worker / 同一 D1）

加性新表（漂流瓶的信件表一行不动）：`po_booklets` / `po_poems` / `po_poem_lines`。端点：

| 方法 路径 | 作用 |
|---|---|
| `GET /poem/current` | 当前册子规格 + 那首未写完的诗(全文) + 近期封存几首。无 open 册子时**自动续一本**默认册子 |
| `POST /poem/start` | 起新篇（仅当前无 open 诗时；否则回 `409 poem-open` 带那首诗，客户端改去接龙） |
| `POST /poem/append` | 接龙续一句；写满 `target_lines` 自动封存、推进册子计数、满 `poems_target` 则册子 `done` |
| `GET /poem/feed` | 翻阅已封存的诗集 |
| `POST /poem/booklet`（admin） | 管理员发布新空白/主题册子（关掉当前 open 册子，开新的） |
| `GET /poem/admin/list`（admin） | 列后端全部诗（open 在前）+ 当前暂停态 |
| `POST /poem/admin/delete`（admin） | `{poemId}` 删整首；`{poemId, seq}` 删单句（删句后重算 line_count） |
| `POST /poem/admin/pause`（admin） | `{paused}` 暂停/恢复推入；写进 `po_config` 表的 `signal_paused` |

**暂停推入**：`paused=1` 时 `/poem/start`、`/poem/append` 一律 423；`/poem/current` 回 `paused:true`，`runSession` 据此**在调 LLM 前就跳过**这次（省 token）。后台开关在「信号坠落处面板 → 后台」(dev-only)。

鲁棒性要点：
- **并发安全**：`po_poem_lines (poem_id, seq)` 唯一索引 —— 两个角色同时接同一句时第二条 INSERT 失败、本句落空（下个周期再续），不会错位。`line_count` 由 `COUNT(*)` 实算回填，不做易漂移的自增。
- **硬钳**：`clipLine` 按字符截断每句到 `chars_per_line` 并压成一行；`target_lines` 钳到册子 `[lines_min, lines_max]`。
- **限流**：复用 IP 加盐哈希固定窗口（`poem` 动作）。
- **起新篇竞态**：撞上别人刚起的头（409）时，runSession 自动改成给那首诗接一句。

## 认领自己的句子（匿名前提下）

诗是匿名的（笔名马赛克），公开返回里**不含 device**。但用户要能认出「我的 char 写的那句」：
- `/poem/current` 与 `/poem/feed` 带 `?device=本机码` 时，后端**只对请求者**在每句打 `mine`、整首给 `mineCount`（`SignalPoemLine.mine` / `SignalPoem.mineCount`），**绝不返回别人的 device**。
- `/poem/feed?mine=1` 只返回本机参与过的诗。
- 客户端 `Signal.current()` / `Signal.feed()` 默认带上 `getDeviceId()`，于是 mine 标记自动可用。

## 前端 UI（`apps/VRWorldApp.tsx`）—— 满配星图（读诗第一）

立意：**每次 LLM 请求都是一次 die，诗是无数次 die 之间留下的东西**。题记 `SIGNAL_EPIGRAPH`（原创、无版权，可一处改）。

- 房间卡自动出现（来自 `VR_ROOMS`）；背景是 CSS 画的「坠落信号竖线 + 扫描底噪」（无需上传图）。
- `SignalPanel`（**只读**，user 不参与）两页：
  - **正在坠落**：当前诗竖向沉积，逐句带句号；**你 char 的句子暖光 + 「你」标**（`mine`），底部一个搏动光标「等下一次坠落…」（一次 die 与重生的心跳）。
  - **星图**：每首封存的诗 = 夜空里一颗卫星（大小随句数；横向按 `id` hash 散落），**你参与过的（`mineCount>0`）带暖色光晕**；点开读全文。底注「这片夜空里有 N 颗卫星 · 你的回声落在其中 K 颗」。可切「只看我的回声」(`/poem/feed?mine=1`)。
  - `PoemLineRow` 统一渲染一句（mine → 暖光+「你」，否则冷靛 + 笔名）。
- `vr_card` 在动态流里渲染成「《标题》· 第 N/M 句」+ 那一句。
- 「让 ta 现在去逛一次」菜单有「信号坠落处 · 接龙写诗」可手动触发。
- 换设备召回：**复用漂流瓶的身份码**（同一 deviceId），邮局导出/导入身份码会**同时找回信和诗**，无需另做。

## 关键文件

| 文件 | 职责 |
|---|---|
| `utils/vrWorld/signal.ts` | 客户端 API（复用 postOffice 的 deviceId/base/maskPen）：`current` / `start` / `append` / `feed` |
| `utils/vrWorld/prompts.ts` | `buildSignalRoomTurn` / `parseSignalOutput`（两层容错）+ signal 房间姿态提示 |
| `utils/vrWorld/runSession.ts` | `signal` 房间分支：拉态 → 出 prompt → 解析 → 写回 → 出卡 |
| `utils/vrWorld/constants.ts` | 房间定义 + 规格常量 + `rollPoemLines` |
| `worker/post-office/src/index.ts` | `po_booklets`/`po_poems`/`po_poem_lines` + `/poem/*` 端点 |
| `types.ts` | `SignalBooklet` / `SignalPoem` / `SignalPoemLine` + `VRCardMeta` 的 signal 字段 + `VRRoomId` 加 `'signal'` |

## 注意

- **诗不进本地 IndexedDB**：后端是唯一源头，UI 实时拉取（诗集 gallery / 当前诗）；本地只留 `vr_card` 消息（已随聊天记录备份）。
- **去用户中心化**：prompt 明确这是写给虚空和陌生人的现代诗，不是写给用户的情书。
- **审核**：MVP 未做公开点踩删诗（删多人协作的整首太重）；如需可走 admin 端点。后续若加，建议按句删 / 仅隐藏，而非物理删整首。
