# Nori 桌宠（dsh 插件）

把 Nori 带到你的桌面上：Live2D 立绘常驻浏览器角落，dsh 的 assistant 输出会被改写成 Nori 口吻，
经本地 GPT-SoVITS 用 Nori 声线朗读出来——配合脸部表情、口型、睡眠、摸头等小交互。

> ⚠ **仅支持 Windows**（依赖 PowerShell 5.1+ / NTFS junction），暂无 Linux/macOS 安装路径。
> 前置：Node.js + npm、一个可用的 dsh 环境（默认使用 `web` profile）。

---

## ✨ 效果预览

![nori 桌宠效果演示](README/nori演示.gif)

安装完长这样：浏览器右下角一只白发少女，回话时张嘴、眨眼、跟着情绪换表情。

---

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
**留空 = 走默认约定**（探测仓库内资产）；改了之后重跑 `.\install.ps1` 生效。

| 键 | 默认 | 说明 |
|---|---|---|
| `assetsDir` / `coreFile` | 空（探测 `Nori_web/`、`cubism_sdk/Core`） | 模型目录 / core 文件，绝对或相对仓库根 |
| `ttsUrl` | `http://127.0.0.1:9880/tts` | GPT-SoVITS 地址（api_v2 端点） |
| `refAudio` / `refPrompt` | 空 / `你好,初次见面,我的名字是Nori` | 声线 wav 路径与其转写文本 |
| `gsvBase` / `venvPy` | 空（探测 `GPT-SoVITS/`） | 守护拉起 api_v2 用的目录与 venv python |
| `personaPrompt` / `personaReframe` | 空（探测 `persona/`） | 人设文件路径覆盖 |
| `maxSentence` / `ttsTemperature` / `ttsTopK` / `ttsSpeedFactor` | 140 / 0.65 / 5 / 1.0 | 断句与合成参数，多数无需改动 |
| `ttsWatch` / `ttsWatchIntervalMs` | true / 30000 | 9880 掉线守护：30s 内自动拉起 api_v2 |
| `allowedOrigins` | 空数组 | 非本机来源访问 WS/API 时的放行主机名（见[安全边界](#安全边界本地服务)） |

### 改写层（Nori 口吻）

默认开启：把 assistant 输出改写成 Nori 的说话方式再朗读。

- **API**：优先直连 **DeepSeek 官方 API**。设置环境变量 `DEEPSEEK_NORI_API_KEY` 即启用（无需改配置）；
  没有 key 时自动回退到 dsh 内置 llm 服务（`deepseek-official` / `deepseek-chat`）。
- **人设**：system 提示来自 `persona/prompt.txt`（授权文本，用户放置）+ `persona/reframe.txt`（改写任务指令，随仓库提供）；
  授权文本缺失时改写层自动关闭，直接朗读原文。
- 进阶参数（`reframe` 总开关 / 超时 / 输入截断 / 追踪日志）见 `nori.config.example.json` 或 `src/index.ts` 的 Config 注释。

---

<a id="gpt-sovits可选"></a>
## 🔊 GPT-SoVITS（可选）

install **不会自动安装** GPT-SoVITS——没部署时一切照常，只是没有语音。

```powershell
.\install-sovits.ps1                      # 一键部署（clone + venv + 依赖）
.\install-sovits.ps1 -DownloadModels      # 同时下载推理必需权重（约 1GB+，闭源、仅本机）
# 已有部署？填 nori.config.json 的 gsvBase/venvPy 后重跑 .\install.ps1
```

需要 Python **3.9~3.11**（仅用于跑推理服务）；部署完成后 api_v2（9880）由 ttsWatch 自动拉起，冷启动较慢属正常。

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
| 语音 503 `tts offline` | 9880 不可达：`Test-NetConnection 127.0.0.1 -Port 9880`；ttsWatch 会在 30s 内自动拉起 |
| 睡眠睁眼 / 头每 3 秒回正 | 已适配原版模型解决（睡眠动作在 Idle 组，配 `setIsLoop(true)` 稳住）；换成别的模型会睡眠退化 |
| 日志 | 错误：`~/.dsh/logs/nori-pet/nori-pet-error.log`；改写追踪：`~/.dsh/logs/nori-pet/nori-pet-trace*.log` |

---

## ✅ 发布守卫

- `git config core.hooksPath .githooks`：每次 commit 前自动扫描（人设文本 / 机器路径 / 密钥 / 资产文件，命中即拒绝）
- `npm run guard`：手动全树扫描；CI（`.github/workflows/guard.yml`）在 push/PR 自动执行 guard + typecheck
- 分发形态 = 公开 GitHub 仓库（克隆 → 放资产 → install.ps1）；Release 只发源码 zip；npm 发布暂不考虑

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

**装配链路**：`install.ps1` 先把仓库 stage 到无空格 junction（`%LOCALAPPDATA%\dsh-links\dsh-nori-pet`，规避 cmd.exe 转发 pnpm 时把含空格路径拆断的问题），执行官方 `dsh plugin add link:<junction>`；插件行由 bundle 层（`dsh.bundle.patch` → `cordis.patch.yml`）装配；运行配置作为 **Loader PatchOptions 条目**（顶层 `- id:` + `config:`）写入 profile 的 `cordis.patch.yml`，**config 是整块替换**——手动改字段须 restate 全部字段。patch 由 dsh 热应用（watchUserPatches），几秒内生效。

**数据流**：dsh 会话事件（`assistant/chunk`、`assistant/message`、`turn/end`…）→ 按句断句（中英标点）→ 改写层（LLM 改写成 Nori 口吻，批处理 + 串行队列防 OOM）→ WS 推给 widget；同时 `/api/speak` 把文本代理给本地 GPT-SoVITS 合成为 WAV，widget 逐句解码播放，用音量实时驱动 `ParamMouthOpenY` 口型。

**睡眠适配**：pixi-live2d-display 不消费 motion3 的 `Loop` 字段（睡眠动作播完会回落 Idle 睁眼）；且**只适配原版 Nori 模型**——其睡眠动作 `00_Sleep` 位于 **Idle 组**（idle 池一员），通过 `setIsLoop(true)` + `setIsLoopFadeIn(false)` 让闭眼动作稳定循环；入睡用 FORCE 优先级绕过库的同级覆盖守卫。

**WebSocket 协议**（`{prefix}/ws`）：客户端连上先发 `{type:'hello', sessionId}`；服务端推送 `assistant`（含情绪标签的逐句文本）/ `approval`（权限申请提醒）/ `user` / `tool` / `turn-end` / `emote`；ACK 随意，仅计数。