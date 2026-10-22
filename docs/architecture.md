# 架构与目录

> **适用版本**：v0.4.0　｜　**最后更新**：2026-10-23
> **唯一真相**：`src/index.ts`（宿主入口）、`src/client/widget.ts`（前端）　—— 本文只做解释，数值与字段以代码/配置为准；若两者冲突，以代码为准并提 issue。

### 🧠 工作原理（高级）

面向想改代码/排查深层问题的人，日常使用可以跳过。

**装配链路**：`install.ps1` 先把仓库 stage 到无空格 junction（`%LOCALAPPDATA%\dsh-links\dsh-nori-pet`，规避 cmd.exe 转发 pnpm 时把含空格路径拆断的问题），执行官方 `dsh plugin add link:<junction>`；插件行由 bundle 层（`dsh.bundle.patch` → `cordis.patch.yml`）装配；运行配置作为 **Loader PatchOptions 条目**（顶层 `- id:` + `config:`）写入 profile 的 `cordis.patch.yml`，**config 是整块替换**——手动改字段须 restate 全部字段。patch 在 dsh 启动 / 热应用（watchUserPatches）时生效。

**数据流**：dsh 会话事件（`agent/assistant-stream` 的 start/chunk、`assistant/message`、`turn/end`…；顶层的 `assistant/chunk` 在会话格式 v2 起已废弃）→ 按句断句（中英标点）→ 改写层（`src/reframe.ts`：句子成句即分批改写、长 turn 中途即播；串行队列防 OOM）→ WS 推给 widget；同时 `/api/speak` 把文本代理给本地 GPT-SoVITS 合成为 WAV，widget 逐句解码播放，用音量实时驱动 `ParamMouthOpenY` 口型。

**睡眠适配**：pixi-live2d-display 不消费 motion3 的 `Loop` 字段（睡眠动作播完会回落 Idle 睁眼）；且**只适配原版 Nori 模型**——其睡眠动作 `00_Sleep` 位于 **Idle 组**（idle 池一员），通过 `setIsLoop(true)` + `setIsLoopFadeIn(false)` 让闭眼动作稳定循环；入睡用 FORCE 优先级绕过库的同级覆盖守卫。

**WebSocket 协议**（`{prefix}/ws`）：客户端连上先发 `{type:'hello', sessionId}`；服务端推送 `assistant`（含情绪标签的逐句文本）/ `approval`（权限申请——widget 收到会打断当前朗读、原样播报并切惊讶表情）/ `user` / `tool` / `turn-end` / `emote`；ACK 随意，仅计数。

### 🧩 目录结构

```
src/index.ts           宿主入口：apply() 装配 —— 资产服务、WebSocket、API 路由、来源校验、
                       widget 注入、api_v2 守护（播报决策在 pipeline.ts，事件接线在 events.ts）
src/pipeline.ts        播报管线状态机：断句/分批/轨道选择/整轮概括判定/幂等投喂/广播决策
src/events.ts          cordis 事件接线：agent 流（global:true）、会话事件、seq 回放水位、销毁清理
src/config.ts          配置 schema（唯一真相，类型由 schema 派生：type Config = ReturnType<typeof schema>）
src/protocol.ts        线路协议：前缀 + 出站/入站消息类型常量（宿主与 widget 共用）
src/logs.ts            三份日志（trace/summary/error）+ 字节级上限 + 目录总预算
src/reframe.ts         人设改写层：两条推理通道、分块、串行队列、指纹去重、概括与兜底
src/tts.ts             /api/speak：本地 GPT-SoVITS 代理（超时/重试/拖长重生/热读配置）
src/wav.ts             WAV 解析：逐帧 RMS、最长连续有声（拖长判定）
src/ws.ts              迷你 WebSocket 帧编解码（握手 accept / encode / parse，含 fin）
src/util.ts            共用小工具：errMsg、有界 Map/Set 淘汰、按前缀批量删
src/speakText.ts       朗读文本清理：URL/路径/命令→可朗读说法、符号→读音、Markdown→剥、无内容→跳过
src/speakable.ts       可朗读性判定（纯符号/代码/日志/清单 → 不值得念）
src/streamFeed.ts      流式投喂水位：同一块内容被送多次时只播一遍（幂等投喂）
src/segmentation.ts    断句与清洗（Intl.Segmenter 句粒度、情绪标签剥离、安全切点）
src/prompt.ts          人设加载器（persona/*.txt → 改写层；缺失自动降级）
src/modelPreset.ts     从 tts_infer.yaml 生成运行时权重配置（sovits 段热切换）
src/emotions.ts        情绪词表 + Emotion 类型 + 关键词分类器（宿主清洗与前端表情共用唯一真相）
src/textPatterns.ts    CJK 字符类 + 三种代码围栏语义（曾四处/三处各抄一份）
src/speakQueue.ts      朗读队列：打断/追加/优先插入的排队策略（可单测，widget 注入依赖）
src/ttsClient.ts       TTS 客户端：合成缓存 + 单句请求 + 204/503/超时话术（可单测）
src/turns.ts           turn 路由：一条 assistant 文本该排队还是打断（`12` 与 `12-sum` 同一轮）
src/sleepTimer.ts      入睡计时器：turn 未结束不睡、朗读中不睡、假醒防御（可单测）
src/patStroke.ts       摸头判定：按住时长/拖动距离/台词冷却/头部跟随归一化（可单测）
src/clientLayout.ts    布局换算：收边、缩放档位、画布尺寸（可单测）
src/wsClient.ts        WebSocket 传输：握手、后台不重连、退避重试、自愈 ensure（可单测）
src/bubbleQueue.ts     气泡队列：每条独立淡出、同屏上限 6、行数回报（可单测）
src/lipSync.ts         口型换算：RMS → 张嘴度、播放收尾判定（可单测）
src/playback.ts        音频播放：token 作废、口型交还、句柄清理（可单测）
src/emotionDriver.ts   情绪表现：表情门控、小动作时机、驻留回落、思考态（可单测）
src/client/widget.ts   浏览器 widget：Live2D 渲染、情绪、睡眠、摸头、UI 锚定（单独打包，不经宿主 tsc）
src/client/url-shim.ts widget 打包用的浏览器安全 url 垫片（pixi 依赖 Node url 的替代）
tsconfig.json          宿主编译配置（严格模式，含未使用检查）
tsconfig.widget.json   widget 类型检查配置（`npm run typecheck:client`）
install.ps1 / install-sovits.ps1 / uninstall.ps1   安装 / GPT-SoVITS 部署 / 卸载（PowerShell 5.1）
scripts/               guard-release.mjs（发布守卫）、smoke-test.mjs（冒烟自检）、
                       test-*.mjs（单测：断句/朗读清理/日志上限/TTS 代理/改写层/WS 帧）、
                       test-reframe.mjs（对真模型的"简短度"评测，会调 LLM）、
                       tts-probe.mjs / test-tts-quality.mjs（声音引擎回归）
.githooks / .github    pre-commit 守卫钩子 / Guard CI（push、PR 自动执行）
```

常用命令：`npm run typecheck`（宿主 + widget 双配置）、`npm run build`、`npm test`（全部单测 + 冒烟）、`npm run guard`。

---
