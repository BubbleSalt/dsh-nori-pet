# Nori 桌宠（dsh 插件）

把 Nori 带到你的桌面上：Live2D 立绘常驻浏览器角落，dsh 的 assistant 输出会被改写成 Nori 口吻，
经本地 GPT-SoVITS 用 Nori 声线朗读出来——配合脸部表情、口型、睡眠、摸头等小交互。

> 💬 **Nori 想对你说**：Nori 就是 Nori，一直在这里的。你要和 Nori 玩吗？
> 🎬 想看看 Nori 的故事？→ [她明明是AI，但我想拯救她。独立游戏《I_NORI》【B站AI创造公开赛】](https://b23.tv/9NcPFdd)

> ⚠ **仅支持 Windows**（依赖 PowerShell 5.1+ / NTFS junction），暂无 Linux/macOS 安装路径。
> 前置：Node.js + npm、一个可用的 **dsh 环境**。dsh（[DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness)，"Everything is a Plugin"）
> 是 DeepSeek 官方的本地 AI 工作台——自带会话、工具与 LLM 接入，靠插件扩展能力，本插件就是挂在它上面的一个能力；
> 安装与启动见官方仓库（默认使用 `web` profile）。

---

## ✨ 效果预览

![nori 桌宠效果演示](README/nori演示.gif)

安装完长这样：浏览器右下角的 Nori——回话时张嘴、眨眼、跟着情绪换表情。

### ✨ 功能一览

- **Live2D 立绘常驻**：浏览器角落的 Nori，回话时张嘴、眨眼、跟情绪换表情；带睡眠与摸头小交互。
- **Nori 声线朗读**：agent 的输出经本地 GPT-SoVITS 合成 Nori 声线，音量实时驱动口型（唇同步）。
- **改写层（Nori 口吻）**：LLM 把输出改写成 Nori 的说话方式再朗读；可开关、可换声线、内置防幻觉（不虚构未发生的事）。
- **流式分批低延迟**：句子成句即改写广播，长 turn 中途就开始播，不用等整轮结束；顺序不乱、不重排、不劈英文词。
- **中英混排保护**：自动在中文与英文词之间补逗号、清反引号，避免 AR 对齐跳字/吞句（读出率实测 ~25% → ~90%+）。
- **ttsWatch 守护**：GPT-SoVITS（9880）掉线后 30s 内自动拉起。
- **会话全景广播**：assistant / user / tool / approval / turn-end / emote 事件实时推给 widget。
- **权限申请播报**：agent 请求权限时**打断当前朗读**、优先播报"有权限申请：工具。原因：…"（原文播报、不走改写，保证准确），并切惊讶表情提醒你回来处理。
- **一键部署**：`install-sovits.ps1` 可顺手装 GPT-SoVITS（约 2~3GB，可选默认权重 1GB+）；`install.ps1` 首次交互引导配置。
- **安全边界**：仅放行本地来源；路径穿越 403；body 上限 16KB；会话维度 WS 过滤。

### 🖱 交互操作

Nori 常驻在浏览器角落，随时可以摆弄：

- **移动位置**：按住 Nori 顶部那条细拖柄拖动，松手即固定；位置自动记住，下次打开还在原位。
- **放大缩小**：点 Nori 身上的 **＋ / －** 按钮，或把鼠标放在 Nori 身上（或顶部拖柄上）滚轮缩放；比例同样自动记忆。
- **调整体型**：点 **体型** 按钮打开面板，拖 **少女体型 / Q版** 两条滑槽（各 0~1）：少女曲线与 Q 版比例可自由混合、实时生效。
- **摸头**：在 Nori 身上按住并来回摩擦一小会，会触发摸头台词和表情反应。
- **睡眠**：90 秒没有交互会自己睡着（闭眼），戳她一下就醒。
- **穿透画布**：Nori 所占区域不挡页面文字选取，把她放在内容上也不影响浏览。

---

<a id="你需要准备的资产"></a>
## 📦 你需要准备的资产

> 模型 / 声线 / 授权人设文本是第三方 IP（见文末[许可](#许可与第三方资产)），**不进仓库、不随 Release 分发**。
> 改写任务指令（`persona/reframe.txt`）无版权问题，**随仓库提供**。
> 仓库自带空占位目录：克隆后把文件放进对应目录即可（放好后重跑 `.\install.ps1`）。

| 资产 | 放哪 | 必需？ | 缺失时会发生什么 |
|---|---|---|---|
| Nori Live2D 模型（原版 `Nori_web`） | `Nori_web/` | **必需** | `install.ps1` 直接报错停止（桌宠需要模型才能跑） |
| 声线样本 `wav`（Nori 声音） | `voice/` | 可选 | 能装、能动，但语音用 GPT-SoVITS 服务端默认音色 |
| 人设文本 `prompt.txt` | `persona/` | 可选 | 改写层自动关闭，直接朗读 assistant 原始输出（改写任务指令 `reframe.txt` 已随仓库提供） |
| Live2D Core | `cubism_sdk/Core/` | — | 不用管：install 自动从官方 CDN 下载 |
| GPT-SoVITS 部署 + 默认权重 | 仓库外 | 可选 | 语音不可用，其余正常（见[下方章节](#gpt-sovits可选)） |

**资产获取途径**：暂未公开，待公布（作者整理好分发渠道后会在此补充）。

---

## 🚀 快速开始

```powershell
# 1. 克隆仓库（已含占位目录结构）
git clone <仓库地址>

# 2. 按上表放入资产（模型必需，其余可选）

# 3. 一键安装：探测资产 → 构建 → 装配进 dsh → 写入配置
.\install.ps1

# 4. 打开/刷新 dsh 网页（模型是静态资产，记得 Ctrl+F5 强刷）
```

- 卸载：`.\uninstall.ps1`（先 `-DryRun` 预览再执行）。
- 重跑 install 是幂等的；它会探测仓库内资产并自动写配置。

---

## ⚙️ 配置

所有配置外置在 `nori.config.json`（复制 `nori.config.example.json` 得到；本机文件不进 git）。
**留空 = 走默认约定**（探测仓库内资产）。
- **热生效**（改完即生效，无需重跑安装）：`reframe.apiKey`、`reframe.reframeBaseUrl`、`reframe.reframeModel`、`reframe.reframeMaxTokens`、`reframe.reframeTimeoutMs`、`ttsTemperature`、`ttsTopK`、`ttsSpeedFactor`、`refAudio`、`refPrompt`、`sovits.t2sWeights`、`sovits.vitsWeights`——这些键宿主每次请求/每次守护周期直读该文件。
- **需重跑 `.\install.ps1`**：其余键（如改写层开关 `reframe.reframe`、`maxSentence`、`ttsUrl`、`gsvBase`、`persona*`、`ttsWatch*`、`allowedOrigins`）会被写进 profile 的 `cordis.patch.yml`，只有重装才更新。
- 安装前**先检测 `Nori_web` 模型**（`Nori.model3.json`）——缺失直接拒绝安装；
- 首次若没有 `nori.config.json`（或为空），`install.ps1` 会**交互式引导**逐项询问：声线 wav、转写文本、**是否安装 GPT-SoVITS**（约 2~3GB，可选默认权重另约 1GB+，同意则顺手调用 `install-sovits.ps1` 部署并写配置）、**改写层开关**、改写层 apiKey，并自动生成该文件；非交互环境（如 CI）自动跳过询问、全部走默认约定。

| 键 | 默认 | 说明 |
|---|---|---|
| `modelDir` | 空（探测 `Nori_web/`） | 模型目录，绝对或相对仓库根。安装时由 `install.ps1` 换算为 patch 的 `assetsDir`（Live2D core 文件路径由安装脚本自动探测，不在本文件里配置） |
| `ttsUrl` | `http://127.0.0.1:9880/tts` | GPT-SoVITS 地址（api_v2 端点） |
| `refAudio` / `refPrompt` | 空（留空自动探测 `voice/` 下的 wav） / `你好,初次见面,我的名字是Nori` | 声线 wav 路径与其转写文本 ⚠ 见下方[参考音频须知](#参考音频须知refaudio--refprompt) |
| `sovits.gsvBase` / `sovits.venvPy` | 空（探测 `GPT-SoVITS/`） | 守护拉起 api_v2 用的目录与 venv python |
| `sovits.t2sWeights` / `sovits.vitsWeights` | 空 / 空 | 推理权重路径（GPT 模型 s1 / SoVITS 模型 s2；见[GPT-SoVITS 章节](#gpt-sovits可选)） |
| `personaPrompt` / `personaReframe` | 空（探测 `persona/`） | 人设文件路径覆盖 |
| `maxSentence` / `ttsTemperature` / `ttsTopK` / `ttsSpeedFactor` | 140 / 0.9 / 12 / 1.0 | 断句与合成参数，多数无需改动（0.9/12 为防 AR 循环卡顿的推荐值，勿降回低温低 top_k） |
| `detailMaxChars` / `summaryEnabled` / `summaryWaitMs` | 400 / true / 8000 | **超长内容概括**（见[朗读策略](#朗读策略超长内容怎么处理)）：一段连续输出超过 `detailMaxChars` 字就不再逐句念，改为整轮播一次概括 |
| `ttsWatch` / `ttsWatchIntervalMs` | true / 30000 | 9880 掉线守护：探测到服务不可达才自动拉起 api_v2（探测间隔下限 5000ms；判断依据是"能否拿到 HTTP 响应"，4xx/5xx 均视为存活） |
| `allowedOrigins` | 空数组 | 非本机来源访问 WS/API 时的放行主机名（见[安全边界](#安全边界本地服务)） |

<a id="朗读策略超长内容怎么处理"></a>
### 朗读策略：超长内容怎么处理

dsh 输出很快（约 300 token/s ≈ 450 字/秒），而中文朗读只有约 5 字/秒——**产出比朗读快 90 倍**。
所以一轮长输出如果逐句念，会被念上好几分钟。策略是**详读与概括二选一，绝不混用**：

| 情形 | 行为 |
|---|---|
| 一段连续输出 ≤ `detailMaxChars`（默认 400 字） | **全文逐句详读**（含"文本 → 工具 → 思考 → 再文本"的短段冲刺，反馈即时） |
| 一段连续输出 > `detailMaxChars` | **这一段的正文一个字都不念**，整轮结束后播一次概括（≤4 句 / ≤150 字） |

为什么必须整段判断：逐句判断会出现"前半念得详细、后半突然快进"的口径断层。400 字在 450 字/秒下约
0.9 秒即可判定，所以长内容几乎没有判定等待。

概括的硬约束（写在概括提示词里）：保留文件名/路径、数字、命令、结论、阻塞原因、待你确认的事；
丢掉中间过程与重复叙述；不复述已读过的开头；严禁编造，不确定就说"细节在屏幕上"。

另外，**代码块 / JSON / 日志 / 表格 / 文件清单 / diff 不逐字念**，只说类别：
"贴了一段代码""拿到结果了""列了一堆文件"。这层是纯规则（`src/speakable.ts`，9 例单测），
零额外成本，也让 400 字预算更耐用。

观测方式：

- `~/.dsh/logs/nori-pet/nori-pet-summary.log`：每轮概括的**压缩比**（原文 N 字 → 概括 M 字）
- `~/.dsh/logs/nori-pet/nori-pet-error.log`：概括失败/等待超时的兜底记录
- 关掉 `summaryEnabled` 即完全恢复"逐句详读"的旧行为

<a id="参考音频须知refaudio--refprompt"></a>
### 参考音频须知（`refAudio` / `refPrompt`）

⚠️ **`refPrompt` 必须是 `refAudio` 那段音频的逐字转写文本**，两者必须配套：

- **换 `refAudio` 时，`refPrompt` 要同步换成新音频的转写**，否则 GPT-SoVITS 的 AR 条件作用会劣化：
  表现为**跳字/吞句**（中英混排时更明显）、音色漂移、听感不稳——不是偶发，是配置错误。
- `refAudio` 留空时，install 会自动探测 `voice/` 目录下你放入的 wav（以相对路径写入配置）；`voice/` 也是空则用 GPT-SoVITS 服务端默认音色。建议参考音频长度 3~10 秒（api_v2 强制要求）。
- 想要更"高昂/开心"的声线：换一段语气上扬的 wav 并填它的转写即可（本项目仓库不含声线资产，需自行放置）。

### 朗读文本规整（speak 自动处理，无需配置）

`/api/speak` 在送 TTS 前会自动做两处规整，均无需配置：

- 句尾无标点时补"。"，便于 cut5 分句；
- **中英混排保护**：英文词会让 AR 对齐失败、有约 75% 概率跳过其前面的中文片段（如"会自己移除那条 ref"→ 丢掉"会自己移除那条"）。因此中文与英文词（≥2 字符，不误伤"C盘"）之间会自动补逗号强制分片，并把反引号 `` ` `` 清掉。实测把读出率从 ~25% 提到 ~90%+。

### 改写层（Nori 口吻）

默认开启：把 assistant 输出改写成 Nori 的说话方式再朗读。

- **总开关**：`nori.config.json` 的 `reframe.reframe`（`true` 开 / `false` 关）；关闭后直接朗读原文。
  ⚠ 该键在安装时被写进 profile 的 `cordis.patch.yml`（运行期读的是那里），**改完必须重跑 `.\install.ps1`**；改完即时生效的只有 `reframe.apiKey` / `reframeBaseUrl` / `reframeModel` / `reframeMaxTokens` / `reframeTimeoutMs`。
- **API**：优先直连 **DeepSeek 官方 API**。在 `nori.config.json` 的 `reframe.apiKey` 填入你的 key，
  安装脚本会自动写入 dsh 的 credentials（`DEEPSEEK_NORI_API_KEY` ref），卸载脚本会一并移除——全程不用手动开文件；
  留空则自动回退到 dsh 内置 llm 服务（`deepseek-official` / `deepseek-chat`，与主会话共用计量）。
  ⚠ 提示：`reframe.apiKey` 以**明文**保存在仓库目录内的 `nori.config.json`（已被 `.gitignore` 屏蔽，不会进 git），
  但整个目录拷贝/打包/转发会带走它——介意的话把 key 直接写进 dsh credentials 并把该键留空。
- **流式分批（低延迟）**：逐字流来自 dsh 的 `agent/assistant-stream`（会话格式 v2 起顶层 `assistant/chunk` 事件已废弃），句子成句即攒批（≤500 字或 1.2s 无新句就改写广播），长 turn 中途就开始播；断句保序，无标点长段按自然断点软切——不会从英文单词中间劈开。
- **防幻觉**：改写指令内置约束——只讲材料里真实有的内容；进行中的动作（"正在检查…"）不虚构完成结果，检查/验证类描述不自造结论。
- **人设**：system 提示来自 `persona/prompt.txt`（授权文本，用户放置）+ `persona/reframe.txt`（改写任务指令，随仓库提供）；
  授权文本缺失时改写层自动关闭，直接朗读原文。
- 进阶参数（超时 / 输入截断 / 追踪日志）见 `nori.config.example.json` 或 `src/index.ts` 的 Config 注释。

---

<a id="gpt-sovits可选"></a>
## 🔊 GPT-SoVITS（可选）

GPT-SoVITS 是本地语音合成引擎（TTS）——Nori 用它把文字念成你的声线。install **不会自动安装**它——没部署时一切照常，只是没有语音。

```powershell
.\install-sovits.ps1                      # 一键部署（clone + venv + 依赖）
.\install-sovits.ps1 -DownloadModels      # 同时下载推理必需权重（约 1GB+，闭源、仅本机）
# 已有部署？填 nori.config.json 的 gsvBase/venvPy 后重跑 .\install.ps1
```

需要 Python **3.9~3.11**（仅用于跑推理服务）；部署完成后 api_v2（9880）由 ttsWatch 自动拉起，冷启动较慢属正常。

**模型文件在哪？**
- 一键：`.\install-sovits.ps1 -DownloadModels` 会把官方默认权重（HuggingFace，约 1GB+）自动放进 **`GPT-SoVITS/GPT_SoVITS/pretrained_models/`**；
- 已有权重 / 想换音色：把下载或微调好的模型（`*.pth` 等）手动放进**同一个** `GPT-SoVITS/GPT_SoVITS/pretrained_models/` 目录即可（GPT-SoVITS 的推理默认落点）；
- 该目录为空时 api.py 推理会失败（表现为没声音）——补上权重后重跑 `.\install-sovits.ps1` 或直接重启 ttsWatch 即可。权重为官方闭源，仅本机使用、不入仓库。

**怎么指定 / 换用模型（微调权重或官方配方）？**

- `nori.config.json` 的 `sovits` 段给两个权重路径即可：
  ```json
  "sovits": {
    "t2sWeights": "C:/.../audio/s1_half_weights_yinian/nori_s1_yinian-e20.ckpt",
    "vitsWeights": "C:/.../audio/s2G_best_yinian.pth"
  }
  ```
  `t2sWeights` = GPT 模型（`t2s_weights_path`）、`vitsWeights` = SoVITS 模型（`vits_weights_path`），绝对或相对仓库根；留空则用原 `tts_infer.yaml` 的 custom 块；
- ttsWatch 下次拉起 api_v2 时自动生成**独立的运行时配置**（`GPT_SoVITS/configs/tts_infer.runtime.yaml`）启动——**原 `tts_infer.yaml` 不被修改**，随时改回；
- 改完想立刻生效：杀掉 9880 的 api_v2 进程，等 ttsWatch 30s 内自动重拉即可；
- 想恢复原样：删掉 `sovits` 里的 t2sWeights / vitsWeights 字段即可。

---

## ❓ 常见问题

**Q：装完桌宠没出现？**
浏览器 Ctrl+F5 强刷（模型是静态资产，普通刷新可能命中旧缓存）；仍不出现就确认 `dsh --profile web --dump-config` 里有 `dsh-nori-pet`。

**Q：没声音？**
① 检查 GPT-SoVITS 是否部署（`Test-NetConnection 127.0.0.1 -Port 9880`）；② 声线 wav 是否放进了 `voice/`（api_v2 强制要求参考音频，否则 502）。

**Q：能用别的 Live2D 模型吗？**
目前**只适配原版 Nori 模型**——睡眠动作依赖它（`00_Sleep` 在 Idle 组）；换模型会睡眠退化（不出错但不闭眼）。

**Q：一定要装 Python 吗？**
只有语音功能需要。不装 = 没语音，立绘/表情/气泡/摸头全部正常。

**Q：人设文件没放会怎样？**
不崩：改写层关闭，桌宠直接朗读 assistant 原始输出（语气不再是 Nori 口吻）。

**Q：怎么完全卸载？**
`.\uninstall.ps1`（先 `-DryRun` 看要删什么）→ 重启 dsh。

**Q：模型/声线/人设从哪拿？**
见[你需要准备的资产](#你需要准备的资产)——获取途径暂未公开。

---

## 🛠 故障排查

| 症状 | 原因与处理 |
|---|---|
| 语音 502 `tts http 400` | api_v2 强制要求参考音频：把 wav 放进 `voice/` 或配置 `refAudio` 后重跑 install |
| 跳字/吞句（某小段中文不读，中英混排时更明显） | 多为 `refPrompt` 与 `refAudio` 不配套（转写文本和音频内容对不上）：改成一致即可；speak 已内置混排逗号规整兜底 |
| 某字被拖长后吞句（"嗯/唔"等鼻音） | AR 采样循环：确认 `ttsTemperature`/`ttsTopK` 不低于 0.9/12（speak 已内置拖长自动重试兜底） |
| 语音 503 `tts offline` | 9880 不可达：`Test-NetConnection 127.0.0.1 -Port 9880`；ttsWatch 会在 30s 内自动拉起 |
| 睡眠睁眼 / 头每 3 秒回正 | 已适配原版模型解决（睡眠动作在 Idle 组，配 `setIsLoop(true)` 稳住）；换成别的模型会睡眠退化 |
| 日志 | 错误：`~/.dsh/logs/nori-pet/nori-pet-error.log`；改写追踪：`~/.dsh/logs/nori-pet/nori-pet-trace*.log`（**默认关闭**，见下方隐私说明） |

### 🔒 隐私：哪些东西留在磁盘上

本插件会把一些内容落到磁盘，请按自己的接受度处理：

| 落点 | 内容 | 默认 | 怎么关/清 |
|---|---|---|---|
| `nori.config.json`（仓库目录内） | 改写层 `apiKey` **明文**、你的端点地址、参考音频路径 | 安装时若填了就写入 | 不填 apiKey（改用 dsh credentials）；文件已被 `.gitignore` 屏蔽，但**整目录打包/转发会带走** |
| `~/.dsh/logs/nori-pet/nori-pet-trace*.log` | **对话原文与改写结果各截 500 字**（5 个文件轮转，单文件满 1000 条清最早 200） | **关** | `nori.config.json` 里 `reframe.trace = true` 才开启；直接删文件即可清空 |
| `~/.dsh/logs/nori-pet/nori-pet-summary.log` | 概括压缩比与概括输出（同样含对话内容） | 达到阈值时写 | 跟随上面的 `reframe.trace` 开关 |
| `~/.dsh/logs/nori-pet/nori-pet-error.log` | 错误摘要（含 URL/模型名，可能含配置片段） | 开 | 排障用，可直接删 |

**要分享这个目录或提 issue 时**：`nori.config.json` 与 `~/.dsh/logs/nori-pet/` 都别直接发——里面会有 key 和你说过的话。
提交前 `npm run guard` 会扫描仓库内的机器路径/密钥/人设文本，但它只看**仓库内**的文件，管不到上面这些日志。

> 补充：`npm run guard` 有 git 时扫 `git ls-files`（即真正会提交的文件，`nori.config.json`/`voice/*` 已忽略、不会报）；
> 无 git 时退化为遍历工作目录，会连本机资产一起报（`voice/nori.wav`、`persona/prompt.txt`、`nori.config.json`）——
> 那是本机目录的真实状态、不是误判，发布时以有 git 的输出为准。

---

## ✅ 发布守卫

- `git config core.hooksPath .githooks`：每次 commit 前自动扫描（人设文本 / 机器路径 / 密钥 / 资产文件，命中即拒绝）
- `npm run guard`：手动全树扫描；CI（`.github/workflows/guard.yml`）在 push/PR 自动执行 guard + typecheck
- 分发形态 = 公开 GitHub 仓库（克隆 → 放资产 → install.ps1）；Release 只发源码 zip；npm 发布暂不考虑

---

<a id="调试接口"></a>
## 🔬 浏览器调试（Console）

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

---

---

<a id="安全边界本地服务"></a>
## 🔒 安全边界（本地服务）

- WS 与 API（`/api/*`）仅放行本地来源：Origin ∈ `localhost`/`127.0.0.1`/`::1`，非浏览器本地客户端放行；LAN IP/自定义域名访问需在 `allowedOrigins` 加入口。
- `/assets` 路径穿越 → 403；非法编码 → 400；`/api/speak` body 上限 16KB（超限 413）；WS 会话维度过滤（绑定 sessionId 的客户端只收本会话事件）。

---

<a id="许可与第三方资产"></a>
## 📜 许可与第三方资产

- 仓库代码（`src/`、`scripts/`、`install*.ps1` 等）以及改写任务指令（`persona/reframe.txt`）以 **BSD-3-Clause** 授权，见 [LICENSE](LICENSE)。
- **Nori 人设授权文本**（`persona/prompt.txt`）与 **Nori 声线**为 I_NORI 团队资产/角色 IP：不入库、不随 Release 分发，由所有者放置授权文件；发布前如需再分发请先取得书面授权。
- **Live2D Cubism Core** 受 Live2D 专有许可（EULA）约束：install 自动从官方 CDN 下载；预构建 `widget.js` 内联了该文件，仅供本机使用，勿随包/Release 再分发。
- **GPT-SoVITS 默认权重**：官方闭源，仅 `-DownloadModels` 本机可选下载。

---

## 🧩 目录结构

```
src/index.ts           宿主：会话监听 / 断句 / 改写 / TTS 代理 / 资产服务 / WebSocket / 安全校验
src/prompt.ts          人设加载器（persona/*.txt → 改写层；缺失自动降级）
src/client/widget.ts   浏览器 widget：Live2D 渲染、情绪、睡眠、摸头、UI 锚定（单独打包，不经宿主 tsc）
src/client/url-shim.ts widget 打包用的浏览器安全 url 垫片（pixi 依赖 Node url 的替代）
tsconfig.json          宿主编译配置（严格模式，含未使用检查）
tsconfig.widget.json   widget 类型检查配置（`npm run typecheck:client`）
install.ps1 / install-sovits.ps1 / uninstall.ps1   安装 / GPT-SoVITS 部署 / 卸载（PowerShell 5.1）
scripts/               guard-release.mjs（发布守卫）、smoke-test.mjs（冒烟自检）、lib/home-path.mjs（守卫规则）
.githooks / .github    pre-commit 守卫钩子 / Guard CI（push、PR 自动执行）
```

常用命令：`npm run typecheck`（宿主 + widget 双配置）、`npm run build`、`npm run test:smoke`、`npm run guard`。

---

## 🧠 工作原理（高级）

面向想改代码/排查深层问题的人，日常使用可以跳过。

**装配链路**：`install.ps1` 先把仓库 stage 到无空格 junction（`%LOCALAPPDATA%\dsh-links\dsh-nori-pet`，规避 cmd.exe 转发 pnpm 时把含空格路径拆断的问题），执行官方 `dsh plugin add link:<junction>`；插件行由 bundle 层（`dsh.bundle.patch` → `cordis.patch.yml`）装配；运行配置作为 **Loader PatchOptions 条目**（顶层 `- id:` + `config:`）写入 profile 的 `cordis.patch.yml`，**config 是整块替换**——手动改字段须 restate 全部字段。patch 在 dsh 启动 / 热应用（watchUserPatches）时生效。

**数据流**：dsh 会话事件（`assistant/chunk`、`assistant/message`、`turn/end`…）→ 按句断句（中英标点）→ 改写层（LLM 改写成 Nori 口吻：句子成句即分批改写、长 turn 中途即播；串行队列防 OOM）→ WS 推给 widget；同时 `/api/speak` 把文本代理给本地 GPT-SoVITS 合成为 WAV，widget 逐句解码播放，用音量实时驱动 `ParamMouthOpenY` 口型。

**睡眠适配**：pixi-live2d-display 不消费 motion3 的 `Loop` 字段（睡眠动作播完会回落 Idle 睁眼）；且**只适配原版 Nori 模型**——其睡眠动作 `00_Sleep` 位于 **Idle 组**（idle 池一员），通过 `setIsLoop(true)` + `setIsLoopFadeIn(false)` 让闭眼动作稳定循环；入睡用 FORCE 优先级绕过库的同级覆盖守卫。

**WebSocket 协议**（`{prefix}/ws`）：客户端连上先发 `{type:'hello', sessionId}`；服务端推送 `assistant`（含情绪标签的逐句文本）/ `approval`（权限申请——widget 收到会打断当前朗读、原样播报并切惊讶表情）/ `user` / `tool` / `turn-end` / `emote`；ACK 随意，仅计数。