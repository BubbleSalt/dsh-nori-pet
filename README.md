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
> 改写任务指令（`persona/reframe.txt`）与概括规则（`persona/summary.txt`）无版权问题，**随仓库提供**。
> 仓库自带空占位目录：克隆后把文件放进对应目录即可（放好后重跑 `.\install.ps1`）。

| 资产 | 放哪 | 必需？ | 缺失时会发生什么 |
|---|---|---|---|
| Live2D 模型（任意 Cubism4，或原版 `Nori_web`） | `Nori_web/`，或配置 `model.file` | 可选 | **纸片人模式**：气泡 + 语音正常，表情/动作不可用（不再中断安装） |
| 声线样本 `wav`（Nori 声音） | `voice/` | 可选 | 能装、能动，但语音用 GPT-SoVITS 服务端默认音色 |
| 人设文本 `prompt.txt` | `persona/` | 可选 | 改写层自动关闭，直接朗读 assistant 原始输出（改写任务指令 `reframe.txt` 已随仓库提供） |
| Live2D Core | `cubism_sdk/Core/` | — | 不用管：install 自动从官方 CDN 下载 |
| GPT-SoVITS 部署 + 默认权重 | 仓库外 | 可选 | 语音不可用，其余正常（见[下方章节](#gpt-sovits可选)） |

**资产获取途径**：暂未公开，待公布（作者整理好分发渠道后会在此补充）。

### 🔌 换模型：模型契约

模型是第三方 IP，仓库不分发。任何 **Cubism4** 模型都能接上，只要在 `nori.config.json` 里写清映射
（不配置 = 用 Nori 原版值，本机行为不变）：

```json
{
  "model": {
    "file": "Nori_web/my.model3.json",
    "mouthParam": "ParamMouthOpenY",
    "idleGroup": "Idle",
    "emotions": {
      "happy":  { "expr": "Smile",  "reaction": 0 },
      "sad":    { "expr": "Tears" },
      "think":  { "expr": "Doubt",  "reaction": 3, "holdMs": 15000 }
    }
  }
}
```

- `expr` = 模型 `model3.json` 里 `Expressions` 的 `Name`；`reaction` = `Motions.Reactions` 组的下标
- **逐字段覆盖**：只写你想改的，其余沿用默认；14 种情绪不必全配
- **缺项不是错误**：某个情绪没配 → 该情绪只是没有表情，气泡和声音照常
- 缺哪几种情绪的可视资源，会在浏览器 console 和 `GET /api/model-map` 的 `gaps` 里报出来
- 模型加载失败 → 自动进入纸片人模式（`install.ps1` 也不再因此中断）

**不想手写映射？让工具猜一份草稿**（依据是表情文件的参数指纹，因为第三方模型的表情名常是 `F01`/`F02`）：

```bash
node scripts/model-map-from-model.mjs Nori_web/my.model3.json        # 报告 + 可粘贴 JSON
node scripts/model-map-from-model.mjs Nori_web/my.model3.json --write # 直接写进 nori.config.json
```

它会打印每个情绪认领了哪个表情、认不出的还剩哪些（只影响表情，不影响气泡和声音）。草稿需要人工核对。

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

**不想改文件？** 点桌宠浮动工具栏的 ⚙ 打开设置面板：字段由 schema 自动生成（一项不漏）、
每项带说明与默认值、支持模型与情绪映射的可视化编辑；保存即写回 `nori.config.json`（原子写 + `.bak` 备份，密钥不回传明文）。
**留空 = 走默认约定**（探测仓库内资产）。
- **热生效**（改完即生效，无需重跑安装）：`reframe.apiKey`、`reframe.baseUrl`、`reframe.model`、`reframe.maxTokens`、`reframe.reframeTimeoutMs`、`ttsTemperature`、`ttsTopK`、`ttsSpeedFactor`、`refAudio`、`refPrompt`、`sovits.t2sWeights`、`sovits.vitsWeights`——这些键宿主每次请求/每次守护周期直读该文件。
- **需重跑 `.\install.ps1`**：其余键（如改写层开关 `reframe.reframe`、`maxSentence`、`ttsUrl`、`gsvBase`、`persona*`、`ttsWatch*`、`allowedOrigins`）会被写进 profile 的 `cordis.patch.yml`，只有重装才更新。
- 安装前**检测 `Nori_web` 模型**（`Nori.model3.json`）——缺失只警告，装完进入**纸片人模式**（气泡+语音正常，表情/动作不可用）；
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
| `detailMaxChars` / `summaryEnabled` / `summaryWaitMs` / `reframeDelayMs` | 120 / true / 2000 / 800 | **超长内容概括**（见[朗读策略](#朗读策略超长内容怎么处理)）：一段连续输出超过 `detailMaxChars` 字就不再逐句念，改为整轮播一次概括 |
| `ttsWatch` / `ttsWatchIntervalMs` | true / 30000 | 9880 掉线守护：探测到服务不可达才自动拉起 api_v2（探测间隔下限 5000ms；判断依据是"能否拿到 HTTP 响应"，4xx/5xx 均视为存活） |
| `allowedOrigins` | 空数组 | 非本机来源访问 WS/API 时的放行主机名（见[安全边界](#安全边界本地服务)） |

<a id="朗读策略超长内容怎么处理"></a>
### 朗读策略：超长内容怎么处理

dsh 输出很快（约 300 token/s ≈ 450 字/秒），而中文朗读只有约 5 字/秒——**产出比朗读快 90 倍**。
所以一轮长输出如果逐句念，会被念上好几分钟。策略是**详读与概括二选一，绝不混用**：

| 情形 | 行为 |
|---|---|
| 一段连续输出 ≤ `detailMaxChars`（默认 120 字，约两句） | **逐句详读**（含"文本 → 工具 → 思考 → 再文本"的短段冲刺，反馈即时） |
| 一段连续输出 > `detailMaxChars` | 读到这个长度就**停止逐句**，把剩下的积压文本攒起来，静默 `summaryWaitMs`（默认 2 秒）后播一次概括 |

也就是**接力**而不是二选一：先读两句，剩下的压成结论。概括的输入只包含**还没读的部分**，所以不会把开头再讲一遍。

两处配套机制：

- 切概括时会取消尚未发出的改写请求（`reframeDelayMs`，默认 800ms；首块不延时，保证开场响应），避免"请求刚发出就被作废"
- 这一轮的概括帧走 `append`，接在已读内容之后，不打断正在念的那句

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

`/api/speak` 在送 TTS 前会自动规整文本，均无需配置。分为**两段**：

**一、可朗读性清理**（`src/speakText.ts`）——解决"偶尔念出听不懂的外星文"。

根因不在采样参数，而在 **GPT-SoVITS 中文前端会把非汉字字符整段删掉**：删完残句太短，
AR 就开始自由发挥。实机取证（合成 → 用 faster-whisper 回转成汉字 → 比相似度）：

| 文本 | 模型实际念出的 | 相似度 |
| --- | --- | --- |
| `https://github.com/BubbleSalt/dsh-nori-pet` | 想尽太刺激哈,坎坷不受DSHNORI PATCH的抵制 | 0.20 |
| `npm run build` | 施行三批耳门斗都行啦 | 0.12 |
| `C:/…/AppData/Roaming/npm` | 路径是CU325update 互联攀片这里 | 0.33 |
| `嗯……唔……那个……` | 嗯~~~n-n-n-n-n-n-n-n | 0.11 |

对应处理（顺序有讲究）：

- **URL / 命令行 / 代码块** → 换成可朗读说法（"某个链接""那句命令"）或直接删；
  代码块整段丢弃——逐字符念代码必然怪音，内容价值也低。
- **路径只留文件名**：目录、盘符、家目录前缀整段去掉（`~\.dsh\storages\workspace.json` → `workspace.json`），
  **不做**中文占位替换。曾经的两版都错过：只认文件名会剩半截路径被逐字符念成"波浪号 反斜杠 dsh 反斜杠…"；
  硬换成"那个文件/某个路径"在语音里没有先行词，听着莫名其妙。文件名是拉丁串，v2 前端本来就会丢非汉字部分，
  所以"路径不读"在听感上自然成立。
- **符号按读音替换**：`→`→"变成"、`≥`→"大于等于"、`|`→"或"、`==`→"等于"。
- **Markdown 只是格式**：`**` `#` `>` 反引号与列表序号（`1.` `- `）都剥掉。
- **数字/小数/版本号/百分号/`3~5` 一律不动**——交给前端 PaddleSpeech NSW，它做得更好
  （`0.9`→"零点九"、`90%`→"百分之九十"）。插件侧再转一次会变成"90百分之"，反而更差。
- **没有可朗读内容就静默跳过**（HTTP 204）：纯语气词（"嗯…唔…那个…"）、纯符号串
  （`****----====`）、纯 emoji。**宁可不出声，也不吐怪音**。

**二、中英混排保护**——英文词会让 AR 对齐失败，有约 75% 概率跳过其前面的中文片段
（如"会自己移除那条 ref"→ 丢掉"会自己移除那条"）。因此中文与英文词（≥2 字符，不误伤"C盘"）
之间会自动补逗号强制分片。实测把读出率从 ~25% 提到 ~90%+。

> 采样参数（`ttsTemperature` / `ttsTopK`）保持 0.9 / 12：**这已是防 AR 循环的推荐值，
> 不要降回低温低 top_k**。外星文问题在文本层，不在参数层。

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
- **朗读单元长度 = 气泡两行以内**：判据是"**长度**"，规则一句话能核对——汉字（含全角标点）算 1，连续字母/数字每个 0.5 且**整段向上取整**（3 个字母 = 2），空格 0.25。**一行正好 17 长度**（用户实测：17 个汉字填满一行），所以两行 = `SPEAK_MAX` = **34**。按长度而不是按字数累计：纯中文 34 字，含英文/数字的混排会自动多装字，一样填满两行（早先按字数硬算，混排只填半行，看着"断句偏短"）。这条规则对拉丁段是向上取整的，只会偏保守，不会超限。
- **切点质量**：句读之后**加分**（优先断在逗号/句号处），ICU 词边界之后再加分（中文没有空格，不加会切出"在受|限沙箱"这种断词）；开引号后、闭引号前、助词（的/了/着/过/吗/呢/吧/啊/呀/嘛）之前都不切。另有两道收尾规则：**单元不许以句读开头**（否则气泡像断掉的句子），**尾巴不许过短**（避免"与 v0.2.9 tag。"这种碎尾单独占一个气泡）。
- **代码块内容不读**：围栏代码块（```` ``` ```` / `~~~`）在 `spokenUnits` 入口整段丢弃——既不进气泡、也不进朗读文本。未闭合的围栏（流式截断）同样丢弃到文末，宁可丢尾巴也不把代码念出来（代码逐字符读必然怪音）；行内 `反引号` 不算代码块，内容照常保留。概括层另有自己的口径：代码块替换成"（贴了一段代码）"，让概括知道"这里贴了东西"。
- **前端不用猜宽度**：气泡宽度与字宽由浏览器决定，任何"写死 px"都靠不住（踩过：按 13px 估算，真机渲染成 2.5 行）。所以判据里不再出现像素；`widget.js` 只在每次合成时把"这条占了几行"报给宿主，`/api/status` 的 `recentSpeaks` 里能对照 `budget`（=34）、`units`（这条实际占的长度）、`lines`（真机渲染行数）。
- **widget 版本戳**：注入的 `<script>` 带 `?v=<widget.js mtime>`，重建后普通 F5 就能拿到新 bundle（否则浏览器可能一直用缓存里的旧前端，改完代码看不到效果）。
- **模型偶发的 HTML 片段会被剥掉**：实测 447 段改写里 16 处 `<br>` 夹在情绪标签之间，气泡是 textContent 直出，不处理就会原样显示。`spokenUnits` 入口与 `cleanSpeech` 各剥一次（只认已知标签，不误伤 `a<b`）。
- **防幻觉**：改写指令内置约束——只讲材料里真实有的内容；进行中的动作（"正在检查…"）不虚构完成结果，检查/验证类描述不自造结论。
- **篇幅跟着内容走（不注水）**：之所以专门立这条规则，是因为原指令写着"内容少时 2~4 句"，反而把模型推向**注水**——
  材料只有一条信息时，它只能靠"报进度 / 反问用户 / 感叹 / 重复动作"去够句数。真实 trace 证据：材料 `中文测试OK`（6 字）
  被讲成 3 句、`CACHED`（6 字）被讲成 3 句还回问"你是不是想说什么呀"。
  现规则为**一条信息一句话**，并给出"短材料正例 / 反例"；实测（`npm run test:reframe`，9 条短材料 A/B）：
  平均句数 **3.00 → 1.22**、平均字数膨胀 **5.71× → 1.88×**、注水句 **1 → 0**；
  同时反向回归（多要点材料）确认要点覆盖 **4/4 无丢失**——不是靠"一律变短"换来的。
- **人设**：system 提示来自 `persona/prompt.txt`（授权文本，用户放置）+ `persona/reframe.txt`（改写任务指令，随仓库提供）；
  授权文本缺失时改写层自动关闭，直接朗读原文。
- **调风格不用重载**：`persona/reframe.txt` 每次改写请求**热读**——嫌啰嗦 / 嫌太短 / 语气不对，改这个文件存盘即生效，
  不必重载插件（`persona/prompt.txt` 较大且不常改，仍在启动时读一次）。
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
| 某字被拖长后吞句（"嗯/唔"等鼻音） | AR 采样循环：确认 `ttsTemperature`/`ttsTopK` 不低于 0.9/12（speak 已内置拖长自动重试兜底）；**纯语气词句子现在会直接跳过不合成**（实测合成必然出怪音） |
| 语音 503 `tts offline` | 9880 不可达：`Test-NetConnection 127.0.0.1 -Port 9880`；ttsWatch 会在 30s 内自动拉起 |
| 念出听不懂的"外星文" | 文本层问题（URL/路径/命令/符号被前端剥光后 AR 自由发挥）：`src/speakText.ts` 已内置清理；新增可疑句式请用 `node scripts/test-tts-quality.mjs` 回归 |
| 气泡结尾两个句号（"。。"） | 权限提醒是**拼接**文案，`reason` 由 dsh 拼成 `escalate sandbox to <mode>: <理由>` 且理由通常自带句号，无条件补的句号就叠成 `。。`。现统一由 `endWithPeriod()` 收口（只补一个、折叠连续标点、悬空逗号换句号），并把英文技术前缀换成中文说法。**声音听不出问题**（朗读侧本来就折叠重复标点），只能看界面 |
| 同一句被念两遍 / "连续改写两次" | 上游把同一块内容投喂了两次（`block-end` 是整块全文快照，provider 重试 / 与 `text-delta` 重叠 / 帧重复处理都会重复送）。现由**块水位**（`src/streamFeed.ts`）保证幂等：只播"还没播过的那截"。观测口：`/api/status` 的 `dupFeed` 计数 + 日志 `dup feed suppressed` |
| 睡眠睁眼 / 头每 3 秒回正 | 已适配原版模型解决（睡眠动作在 Idle 组，配 `setIsLoop(true)` 稳住）；换成别的模型会睡眠退化 |
| 日志 | 错误：`~/.dsh/logs/nori-pet/nori-pet-error.log`；改写追踪：`~/.dsh/logs/nori-pet/nori-pet-trace*.log`（**默认关闭**，见下方隐私说明） |

### 🔊 声音引擎回归工具（排障用）

合成质量是**可测量**的，不靠耳朵猜：

```powershell
# 1) 单句探针：合成 + 波形分析（时长/语速/峰值/最长连续有声）
node scripts/tts-probe.mjs --text "要试的句子"

# 2) 金句集回归：18 条典型句式批量合成 + 波形指标
node scripts/test-tts-quality.mjs

# 3) 文本清理 A/B 对照（现状 vs toSpeakable），对照表直接打在屏幕上
node scripts/test-speaktext-ab.mjs

# 4) 改写层注水回归（需真实 LLM）：短材料会被撑成几句？
node scripts/test-reframe-brevity.mjs            # 短材料：判定 ≤2 句、无注水句
node scripts/test-reframe-brevity.mjs --long     # 反向回归：多要点材料要点不能丢

# 5) 投喂幂等回归：同一块内容被送两次时是否只播一遍
node scripts/test-stream-feed-dedup.mjs
```

想验证"到底念对了没有"，再跑一趟 **ASR 回转**（用本地 faster-whisper 把合成音频转回汉字，
与原文比编辑距离相似度——这是发现"外星文"的判据）：

```powershell
# 用部署 GPT-SoVITS 时那个 venv 的 python（见 nori.config.json 的 venvPy），例如：
$py = '<你的 GPT-SoVITS 目录>\.venv\Scripts\python.exe'
& $py ..\audio\asr_batch.py scripts\.tts-quality scripts\.tts-quality\cases.json scripts\.tts-quality\asr.json
& $py ..\audio\asr_report.py scripts\.tts-quality\asr.json scripts\.tts-quality\report.txt
```

报告里相似度 **< 0.6 基本可判"念的不是这句话"**。纯波形指标（语速骤降）可以作为旁证，
但**不要只凭波形下结论**——本次就是 ASR 回转才定位到 URL 被拆成"秒每每.米每每毫秒减减"。
（`audio/` 脚本属本机工具，不入库。）

### 🔒 隐私：哪些东西留在磁盘上

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
> `GET /api/status` 里 `recentSpeaks` 是**最近 10 次送进合成的文本**（`{ts,len,head,budget,units,lines}`）——用来定位"切分发生在哪一层"：`budget`=当时的长度预算（34）、`units`=这条占的长度、`lines`=真机渲染行数（>2 就说明预算偏大）：
> 同一句被拆成两条请求 = 客户端切的；只有一条完整请求却出现两个气泡 = 宿主广播粒度造成的。

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

## 🧠 工作原理（高级）

面向想改代码/排查深层问题的人，日常使用可以跳过。

**装配链路**：`install.ps1` 先把仓库 stage 到无空格 junction（`%LOCALAPPDATA%\dsh-links\dsh-nori-pet`，规避 cmd.exe 转发 pnpm 时把含空格路径拆断的问题），执行官方 `dsh plugin add link:<junction>`；插件行由 bundle 层（`dsh.bundle.patch` → `cordis.patch.yml`）装配；运行配置作为 **Loader PatchOptions 条目**（顶层 `- id:` + `config:`）写入 profile 的 `cordis.patch.yml`，**config 是整块替换**——手动改字段须 restate 全部字段。patch 在 dsh 启动 / 热应用（watchUserPatches）时生效。

**数据流**：dsh 会话事件（`agent/assistant-stream` 的 start/chunk、`assistant/message`、`turn/end`…；顶层的 `assistant/chunk` 在会话格式 v2 起已废弃）→ 按句断句（中英标点）→ 改写层（`src/reframe.ts`：句子成句即分批改写、长 turn 中途即播；串行队列防 OOM）→ WS 推给 widget；同时 `/api/speak` 把文本代理给本地 GPT-SoVITS 合成为 WAV，widget 逐句解码播放，用音量实时驱动 `ParamMouthOpenY` 口型。

**睡眠适配**：pixi-live2d-display 不消费 motion3 的 `Loop` 字段（睡眠动作播完会回落 Idle 睁眼）；且**只适配原版 Nori 模型**——其睡眠动作 `00_Sleep` 位于 **Idle 组**（idle 池一员），通过 `setIsLoop(true)` + `setIsLoopFadeIn(false)` 让闭眼动作稳定循环；入睡用 FORCE 优先级绕过库的同级覆盖守卫。

**WebSocket 协议**（`{prefix}/ws`）：客户端连上先发 `{type:'hello', sessionId}`；服务端推送 `assistant`（含情绪标签的逐句文本）/ `approval`（权限申请——widget 收到会打断当前朗读、原样播报并切惊讶表情）/ `user` / `tool` / `turn-end` / `emote`；ACK 随意，仅计数。