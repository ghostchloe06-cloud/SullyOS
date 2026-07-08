# QQ捏人工坊（神经链接 · 手办柜）

统一管理一只角色在三处的 Q 版形象：**小小窝**房间立绘、**彼方**chibi、**特别时光** 520 大头贴。每处可以单独捏（互不影响），也可以挑一处形象「同步到全部」。入口在 神经链接 → 角色详情 → **「手办」tab**（独立分区：迷你三格展示柜预览 `ChibiShelfPanel` + 「进入手办柜」按钮），全屏工坊 UI 走手办展示柜风（三层展台 + 射灯 + 底座）。

## 三处形象的落库位置（工坊不新增渲染路径）

| 槽位 | 消费方 | 图片存放 | 格式 |
|------|--------|----------|------|
| `room` | 小小窝 RoomApp（房间立绘） | `char.sprites['chibi']` | **blobref 令牌**（与上传路径一致，`putImageBlob`） |
| `vr` | 彼方 VRWorldApp | `char.vrState.chibi.img`（scale/offsetY/flip 保留不动） | dataURL |
| `like520` | 特别时光 520 活动 | 已通关：`char.specialMomentRecords['like520_2026'].customData.charChibi`；未通关：`char.chibiStudio.like520.img` 兜底 | dataURL |

捏人器完整导出 state（选件 + 换色 + 翻转 + 眼型…）按槽位存 `char.chibiStudio.{room,vr,like520}.state`（`types.ts` 的 `ChibiStudioData`），再编辑时整套还原。`chibiStudio` 属运行时本地状态，已加入 `CARD_STRIPPED_FIELDS`（角色卡导出/导入双向剥离）。

## 关键文件

- `components/character/ChibiStudio.tsx` — 工坊本体（展示柜 + 单槽编辑 + 一键同步）。
- `apps/Character.tsx` — 入口按钮 + 全屏覆盖层。**注意**：详情页 `formData` 是整体 auto-save 的副本，工坊直接写库后，关闭回调里必须把最新角色数据 `setFormData` 拉回来，否则后续编辑会用旧副本盖掉工坊成果（新增外部写库的面板都要防这个）。
- `public/like520/character_creator.html` — 捏人器 iframe。`like520_init` 新增 `savedState` 字段：**草稿 > savedState > presets**（presets 只有 `selected`，savedState 连换色/翻转一起还原，见 `applyFullState`）。
- `components/Like520Event.tsx` — `CreatorIframe` 新增 `savedState` prop 透传；`isSullyChar`/`sullyPresets` 改为导出；520 活动 fresh 模式的角色捏人器会带上 `char.chibiStudio.like520.state`（工坊里捏好的造型开场直接穿上）。
- `apps/VRWorldApp.tsx` — 彼方两个 chibi 编辑器也改传 `savedState`（原来 presets 只回填选件，丢换色）。

## 草稿与 savedState 的关系

捏人器 iframe 用 `localStorage` 存未确认草稿（key 按 `draftKey` 隔离；工坊用 `studio_${charId}_${slot}`）。草稿优先于 savedState——用户上次捏一半退出，再进来先恢复 WIP；确认导出后草稿内容与已存 state 一致，行为无感。
