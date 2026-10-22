# 运维与排障

> **适用版本**：v0.4.0　｜　**最后更新**：2026-10-23
> **唯一真相**：`src/logs.ts`（日志）、`scripts/*` 里的回归脚本　—— 本文只做解释，数值与字段以代码/配置为准；若两者冲突，以代码为准并提 issue。

### 🛠 故障排查

| 症状 | 原因与处理 |
|---|---|
| 语音 502 `tts http 400` | api_v2 强制要求参考音频：把 wav 放进 `voice/` 或配置 `refAudio` 后重跑 install |
| 跳字/吞句（某小段中文不读，中英混排时更明显） | 多为 `refPrompt` 与 `refAudio` 不配套（转写文本和音频内容对不上）：改成一致即可；speak 已内置混排逗号规整兜底 |
| 某字被拖长后吞句（"嗯/唔"等鼻音） | AR 采样循环：确认 `ttsTemperature`/`ttsTopK` 不低于 0.9/12（speak 已内置拖长自动重试兜底）；**纯语气词句子现在会直接跳过不合成**（实测合成必然出怪音） |
| 语音 503 `tts offline` | 9880 不可达：`Test-NetConnection 127.0.0.1 -Port 9880`；ttsWatch 会在 30s 内自动拉起 |
| 念出听不懂的"外星文" | 文本层问题（URL/路径/命令/符号被前端剥光后 AR 自由发挥）：`src/speakText.ts` 已内置清理；新增可疑句式请用 `node scripts/test-tts-quality.mjs` 回归 |
| 气泡结尾两个句号（"。。"） | 权限提醒是**拼接**文案，`reason` 由 dsh 拼成 `escalate sandbox to <mode>: <理由>` 且理由通常自带句号，无条件补的句号就叠成 `。。`。现统一由 `endWithPeriod()` 收口（只补一个、折叠连续标点、悬空逗号换句号），并把英文技术前缀换成中文说法。**声音听不出问题**（朗读侧本来就折叠重复标点），只能看界面 |
| 同一句被念两遍 / "连续改写两次" | 上游把同一块内容投喂了两次（`block-end` 是整块全文快照，provider 重试 / 与 `text-delta` 重叠 / 帧重复处理都会重复送）。现由**块水位**（`src/streamFeed.ts`）保证幂等：只播"还没播过的那截"。观测口：`/api/status` 的 `dupFeed` 计数 + 日志 `dup feed suppressed` |
| 睡眠睁眼 / 头每 3 秒回正 | 已适配原版模型解决（睡眠动作在 Idle 组，配 `setIsLoop(true)` 稳住）；换成别的模型会睡眠退化 |
| 日志 | 错误：`~/.dsh/logs/nori-pet/nori-pet-error.log`；改写追踪：`~/.dsh/logs/nori-pet/nori-pet-trace*.log`（**默认关闭**，见下方隐私说明） |

#### 🔒 隐私：哪些东西留在磁盘上

本插件会把一些内容落到磁盘，请按自己的接受度处理：

| 落点 | 内容 | 默认 | 上限（自动裁剪，无需手动清） |
|---|---|---|---|
| `nori.config.json`（仓库目录内） | 改写层 `apiKey` **明文**、你的端点地址、参考音频路径 | 安装时若填了就写入 | 不适用；不填 apiKey 可改用 dsh credentials。已被 `.gitignore` 屏蔽，**用 git 发布/分享不会带出去**（整目录打包才会） |
| `~/.dsh/logs/nori-pet/nori-pet-trace.log` | **对话原文与改写结果各截 500 字**，用来复盘"刚才那句为什么这么念" | 开 | 超 **1MB** 就从最旧删到约 **512KB**（约留最近 500 轮） |
| `~/.dsh/logs/nori-pet/nori-pet-summary.log` | 概括压缩比与概括样本（同样含对话内容） | 开 | 超 **256KB** 删到约 **128KB**；跟随 `reframe.trace` 开关 |
| `~/.dsh/logs/nori-pet/nori-pet-error.log` | 错误摘要（含 URL/模型名/堆栈片段） | 开 | 超 **512KB** 删到约 **256KB** |

三套日志共用一个目录，**目录总量再有 8MB 兜底**：超了按修改时间删最旧的文件。
所有上限都**按字节判定**（每次写入 stat 一下即可），因此不依赖任何内存计数器——
早先按"满 N 条"判，计数器随热重载归零，实测 trace 涨到 1MB、error 涨到 677 条都没被裁掉。

想彻底不留对话原文：设 `nori.config.json` 的 `reframe.trace = false`（热改生效，无需重装），或直接删文件。

**分享时**：走 git（clone / 仓库链接）是安全的——上面这些都在 `.gitignore` 里；
只有「把整个文件夹打包发人」才会把 `nori.config.json`（明文 key）与日志一起带走。
提交前 `npm run guard` 会扫描仓库内的机器路径/密钥/私有端点，但它只看**仓库内**的文件，管不到这些日志。

> 补充：`npm run guard` 有 git 时扫 `git ls-files`（即真正会提交的文件，`nori.config.json`/`voice/*` 已忽略、不会报）；
> 无 git 时退化为遍历工作目录，会连本机资产一起报（`voice/nori.wav`、`persona/prompt.txt`、`nori.config.json`）——
> 那是本机目录的真实状态、不是误判，发布时以有 git 的输出为准。

---

### 🔬 浏览器调试（Console）

Nori 打开时会往页面挂一个全局对象 **`__noriPetWidget`**——按 **F12**（或 `Ctrl+Shift+I`）打开开发者工具，切到 **Console** 标签，输入下面任一指令回车即可（Tab 有自动补全），**不需要装任何命令行工具**：

| 指令 | 作用 |
|---|---|
| `__noriPetWidget.sayTag('happy', '今天天气真好')` | 用指定情绪说一句话，完整走朗读 + 情绪链路 |
| `__noriPetWidget.say('【think】嗯…我想想\n【default】就这样吧')` | 整段多标签文本，逐行播报 |
| `__noriPetWidget.motion()` | 查看当前动作 / 表情 / 是否在说话 / 体型滑槽值 |
| `__noriPetWidget.diag()` | 看连接状态、最近消息、静音、缩放与位置 |
| `__noriPetWidget.showBubble('你好')` | 只显示气泡、不朗读 |

`sayTag` 的情绪标签（13 种）：`happy / excited / angry / sad / doubt / troubled / shy / surprised / dizzy / serious / speechless / think / default`

> 服务端也保留 HTTP 接口（`/api/status`、`/api/speak` 等）供程序化调用；日常调试用上面的 Console 指令就够。
> `GET /api/status` 里 `recentSpeaks` 是**最近 10 次送进合成的文本**（`{ts,len,head,budget,units,lines}`）——用来定位"切分发生在哪一层"：`budget`=当时的长度预算（34）、`units`=这条占的长度、`lines`=真机渲染行数（>2 就说明预算偏大）：
> 同一句被拆成两条请求 = 客户端切的；只有一条完整请求却出现两个气泡 = 宿主广播粒度造成的。

---

---

<a id="安全边界本地服务"></a>

### 🔒 安全边界（本地服务）

- WS 与 API（`/api/*`）仅放行本地来源：Origin ∈ `localhost`/`127.0.0.1`/`::1`，非浏览器本地客户端放行；LAN IP/自定义域名访问需在 `allowedOrigins` 加入口。
- `/assets` 路径穿越 → 403；非法编码 → 400；`/api/speak` body 上限 16KB（超限 413）；WS 会话维度过滤（绑定 sessionId 的客户端只收本会话事件）。

---

<a id="许可与第三方资产"></a>

### ✅ 发布守卫

- `git config core.hooksPath .githooks`：每次 commit 前自动扫描（人设文本 / 机器路径 / 密钥 / 资产文件，命中即拒绝）
- `npm run guard`：手动全树扫描；CI（`.github/workflows/guard.yml`）在 push/PR 自动执行 guard + typecheck
- 分发形态 = 公开 GitHub 仓库（克隆 → 放资产 → install.ps1）；Release 只发源码 zip；npm 发布暂不考虑

---

<a id="调试接口"></a>
