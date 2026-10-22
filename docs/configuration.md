# 配置说明

> **适用版本**：v0.4.0　｜　**最后更新**：2026-10-23
> **唯一真相**：`src/config.ts` 的 schema（设置面板与 `GET /api/config/schema` 都由它生成）　—— 本文只做解释，数值与字段以代码/配置为准；若两者冲突，以代码为准并提 issue。

### ⚙️ 配置

所有配置外置在 `nori.config.json`（复制 `nori.config.example.json` 得到；本机文件不进 git）。

**不想改文件？** 点桌宠浮动工具栏的 ⚙ 打开设置面板：字段由 schema 自动生成（一项不漏）、
每项带说明与默认值、支持模型与情绪映射的可视化编辑；保存即写回 `nori.config.json`（原子写 + `.bak` 备份，密钥不回传明文）。
**留空 = 走默认约定**（探测仓库内资产）。
- **热生效**（改完即生效，无需重跑安装）：`reframe.apiKey`、`reframe.baseUrl`、`reframe.model`、`reframe.maxTokens`、`reframe.timeoutMs`、`reframe.trace`、`reframeEnabled`，以及朗读策略相关键（`detailMaxChars`、`summaryWaitMs`、`reframeDelayMs` 等）
- **需重跑 `.\install.ps1`**：其余键（如 `maxSentence`、`ttsUrl`、`gsvBase`、`persona*`、`ttsWatch*`、`allowedOrigins`）—— 它们写在 profile 的 `cordis.patch.yml` 里，运行期读那份
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
| `detailMaxChars` / `summaryEnabled` / `summaryWaitMs` / `reframeDelayMs` | 120 / true / 8000 / 800 | **超长内容概括**（见[朗读策略](#朗读策略超长内容怎么处理)）：一段连续输出超过 `detailMaxChars` 字就不再逐句念，改为整轮播一次概括 |
| `ttsWatch` / `ttsWatchIntervalMs` | true / 30000 | 9880 掉线守护：探测到服务不可达才自动拉起 api_v2（探测间隔下限 5000ms；判断依据是"能否拿到 HTTP 响应"，4xx/5xx 均视为存活） |
| `allowedOrigins` | 空数组 | 非本机来源访问 WS/API 时的放行主机名（见[安全边界](#安全边界本地服务)） |

<a id="朗读策略超长内容怎么处理"></a>

#### 参考音频须知（`refAudio` / `refPrompt`）

⚠️ **`refPrompt` 必须是 `refAudio` 那段音频的逐字转写文本**，两者必须配套：

- **换 `refAudio` 时，`refPrompt` 要同步换成新音频的转写**，否则 GPT-SoVITS 的 AR 条件作用会劣化：
  表现为**跳字/吞句**（中英混排时更明显）、音色漂移、听感不稳——不是偶发，是配置错误。
- `refAudio` 留空时，install 会自动探测 `voice/` 目录下你放入的 wav（以相对路径写入配置）；`voice/` 也是空则用 GPT-SoVITS 服务端默认音色。建议参考音频长度 3~10 秒（api_v2 强制要求）。
- 想要更"高昂/开心"的声线：换一段语气上扬的 wav 并填它的转写即可（本项目仓库不含声线资产，需自行放置）。

#### 改写层（Nori 口吻）

默认开启：把 assistant 输出改写成 Nori 的说话方式再朗读。

- **总开关**：`reframeEnabled`（`true` 开 / `false` 关）；关闭后直接朗读原文。
  ⚠ 该键在安装时被写进 profile 的 `cordis.patch.yml`（运行期读的是那里），**改完必须重跑 `.\install.ps1`**；改完即时生效的只有 `reframe.apiKey` / `reframeBaseUrl` / `reframeModel` / `reframeMaxTokens` / `reframeTimeoutMs`。
- **API**：优先直连 **DeepSeek 官方 API**。在 `nori.config.json` 的 `reframe.apiKey` 填入你的 key，
  安装脚本会自动写入 dsh 的 credentials（`DEEPSEEK_NORI_API_KEY` ref），卸载脚本会一并移除——全程不用手动开文件；
  留空则自动回退到 dsh 内置 llm 服务（与主会话共用计量）。**模型名不内置默认值**：`reframe.model` 留空即由 provider 决定，避免写死一个迟早废弃的型号。
  ⚠ 提示：`reframe.apiKey` 以**明文**保存在仓库目录内的 `nori.config.json`（已被 `.gitignore` 屏蔽，不会进 git），
  但整个目录拷贝/打包/转发会带走它——介意的话把 key 直接写进 dsh credentials 并把该键留空。
- **流式分批（低延迟）**：逐字流来自 dsh 的 `agent/assistant-stream`（会话格式 v2 起顶层 `assistant/chunk` 事件已废弃），句子成句即攒批（≤150 字或 1.2s 无新句就改写广播），长 turn 中途就开始播；断句保序，无标点长段按自然断点软切——不会从英文单词中间劈开。
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
