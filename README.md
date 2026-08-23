# @dsh-external/dsh-nori-pet — Nori 桌宠

Live2D 立绘 + 情绪/动作联动 + GPT-SoVITS 语音（Nori 声线）+ 人设改写层。
宿主观察 dsh 会话的 assistant 输出，按句改写为 Nori 口吻并经本地 GPT-SoVITS 朗读；浏览器内嵌 widget 显示立绘、口型、情绪表情与睡眠/摸头交互。

> 模型资产（Nori_web）、Live2D Core、训练语音（refAudio wav）、**Nori 人设文本（persona/）**
> **均不入仓库**：仅经路径引用/探测写入本机配置，公开仓库只含代码与占位结构（.gitkeep）。

## 前置依赖

> **资产约定：全部在仓库内（占位）**——克隆即得空占位目录（`Nori_web/`、`cubism_sdk/`、
> `voice/`、`persona/`、`GPT-SoVITS/`、`audio/`、`ffmpeg/`），把对应资产（含已授权的人设文本）
> 放进目录即可用；资产与授权文件不进 git、不随 Release 分发。

| 依赖 | 位置 |
|---|---|
| Node.js + npm | PATH（构建用） |
| dsh 环境 + profile（默认 `web`） | `~/.dsh/profiles/<Profile>` |
| Nori Live2D 模型 | 缺省探测仓库内 `Nori_web/`（含 Nori.model3.json），或配置 `modelDir`。**只适配原版**：睡眠动作 `00_Sleep` 在 Idle 组（idle 池一员），install 校验其存在 |
| Live2D Core | **install 自动下载**官方 CDN（`cubism.live2d.com/sdk-web/cubismcore/`，所有用户同一官方文件；需网络，失败可手动放入 `cubism_sdk/Core/` 后重跑） |
| GPT-SoVITS api_v2 | 默认 `http://127.0.0.1:9880/tts`（`ttsUrl`）。**不自动安装**——未配置时安装照常完成，末尾提示语音不可用；部署见 `install-sovits.ps1` |
| Nori 声线 wav（可选） | 缺省探测仓库内 `voice/` 目录第一个 wav，或配置 `refAudio`（语音资产不入库） |
| GPT-SoVITS 守护（可选，ttsWatch 拉起） | 配置 `sovits.gsvBase` / `sovits.venvPy`（GPT-SoVITS 目录与其 `.venv` 的 python；仅本机配置，不入库） |
| Python 3.9~3.11（可选） | 仅用于 GPT-SoVITS（跑 `api.py` 9880 + ttsWatch 拉起）；缺省探测 `python`/`py -3`，见 `install-sovits.ps1` |
| Nori 人设文件（可选） | 缺省探测仓库内 `persona/prompt.txt` + `persona/reframe.txt`（授权文本，源出人设原文档）；缺失时改写层关闭、直接朗读原始输出；install 末尾有提示 |

## 一键安装

```powershell
# 无参安装：探测仓库内模型/核心/voice/；core 自动下载
.\install.ps1
```

> **配置全部外置**在 `nori.config.json`（模板 `nori.config.example.json`，本机文件含机器路径、不进 git）。
> 缺省全部走约定（探测仓库内）；要自定义（模型换位/指定声线/GPT-SoVITS 路径）就编辑它再跑：
>
> ```json
> {
>   "modelDir": "D:\\models\\Nori_web",
>   "refAudio": "D:\\voice\\nori.wav",
>   "refPrompt": "你好,初次见面,我的名字是Nori",
>   "ttsUrl": "http://127.0.0.1:9880/tts",
>   "sovits": { "gsvBase": "D:\\gptsovits\\GPT-SoVITS", "venvPy": "D:\\gptsovits\\.venv\\Scripts\\python.exe" }
> }
> ```

> 语音默认目录约定：把 `nori.wav` 放进仓库内 `voice/` 文件夹，无参安装即自动以
> 相对路径（`voice\nori.wav`）写入配置——**卸载重装不丢语音**，克隆到任意位置放好资产即可用。

## GPT-SoVITS（可选，语音功能）

install **不自动装** GPT-SoVITS：未配置 `sovits` 时安装正常完成，末尾会提示
`语音功能无法使用`。接入方式二选一：

```powershell
# 方式 A：一键部署（clone + venv + 依赖；权重默认不下载）
.\install-sovits.ps1
# 需要默认权重（推理必需，约 1GB+，官方闭源、仅本机、不入库/不发布）：
.\install-sovits.ps1 -DownloadModels

# 方式 B：已有部署 → 编辑 nori.config.json 的 sovits 段，然后重跑 .\install.ps1
```

- Python 要求 **3.9~3.11**（`install-sovits.ps1` 自动检测；用途仅此一个：跑 `api.py` 推理服务 + ttsWatch 拉起）
- 部署完成后 `.\install.ps1` 把路径接入插件；`api.py`（9880）由 ttsWatch 自动拉起，冷启动较慢属正常

脚本动作（幂等，可重复跑）：① 构建 host + client（`-SkipBuild` 跳过）② **官方 API** 装配——
把仓库 stage 到无空格 junction（`%LOCALAPPDATA%\dsh-links\dsh-nori-pet`）后执行
`dsh plugin --profile <Profile> add link:<junction>`（dsh 官方插件管理：安装依赖并自动同步
`dsh.profile.bundles`；插件行由 bundle 层 `dsh.bundle.patch` 装配，**仅一行**）③ 把运行配置
作为 **Loader PatchOptions 条目**（顶层 `- id:` + `config:`，config **整块替换**，须 restate 全部字段）写入
**profile 的 `cordis.patch.yml`**（不动 `cordis.yml` 主文件），
并用 dsh 同款 js-yaml 校验结构。patch 由 dsh 热应用（watchUserPatches），写入后约几秒即生效；重启同样生效。

> 为什么用无空格 junction：`dsh plugin` 在 Windows 上经 cmd.exe 转发给 pnpm，
> 含空格的绝对路径（如 `Tencent Files`）会被拆断成多个参数（曾写入坏依赖键）。
> 仓库源码不搬移，junction 只是路径代理。

## 一键卸载

```powershell
.\uninstall.ps1 -DryRun   # 只报告将移除内容
.\uninstall.ps1           # 官方 dsh plugin remove + 清 overlay 条目 + 删 staging junction；不删仓库
```

## 配置项（Config schema，`src/index.ts`）

| 键 | 默认 | 说明 |
|---|---|---|
| `assetsDir` | 空（探测仓库内 `Nori_web`） | Nori 模型目录；相对路径以仓库根为基准（如 `Nori_web`） |
| `coreFile` | 空（探测仓库内 `cubism_sdk/Core`） | live2dcubismcore.js；同上，相对仓库根 |
| `ttsUrl` | `http://127.0.0.1:9880/tts` | GPT-SoVITS api_v2 |
| `refAudio` | 空（服务端默认音色） | Nori 声线 wav，**外部资产，只经配置引用**；相对/绝对均可（相对以仓库根解析后发给 api_v2） |
| `refPrompt` | `你好,初次见面,我的名字是Nori` | 参考音频转写 |
| `gsvBase` / `venvPy` | 空（探测仓库内 `GPT-SoVITS` 与其 `.venv`） | 守护拉起 api_v2 用的 GPT-SoVITS 目录与 venv python（相对仓库根或绝对） |
| `personaPrompt` / `personaReframe` | 空（探测仓库内 `persona/`） | 人设 system prompt 与改写任务文件（绝对/相对仓库根）；缺失 → 改写层关闭 |
| `maxSentence` / `ttsTemperature` / `ttsTopK` / `ttsSpeedFactor` | 140 / 0.65 / 5 / 1.0 | 断句与 TTS 推理参数 |
| `reframe` / `reframeProvider` / `reframeModel` | true / `deepseek-official` / `deepseek-chat` | 人设改写层 |
| `reframeTimeoutMs` / `reframeMaxInput` | 15000 / 1500 | 改写超时与输入截断 |
| `reframeApiKeyRef` / `reframeBaseUrl` | `DEEPSEEK_NORI_API_KEY` / api.deepseek.com | 专用 key 直连（留空走 dsh llm） |
| `reframeTrace` | true | 改写输入/输出追踪（`nori-pet-trace*.log`：5 文件轮转，每文件满 1000 条删最早 200，slot 标记在 `nori-pet-trace.slot`） |
| `ttsWatch` / `ttsWatchIntervalMs` | true / 30000 | 9880 守护：掉了自动拉起 api_v2 |
| `allowedOrigins` | （空数组） | WS/API 额外放行的 Origin 主机名；缺省仅 `localhost`/`127.0.0.1`/`::1`（跨站一律拒绝；LAN IP/自定义域名访问时在此加入口） |

> **资产与分发**：install.ps1 缺省探测命中时写入**相对仓库根**的路径（`Nori_web`、`cubism_sdk\...`、`voice\...`、`persona\...`），
> 插件端统一按包目录解析。分发形态 = **公开 GitHub 仓库**（克隆 → 放资产 → install.ps1）：
> 仓库内只有代码 + 占位目录，模型/声线/人设/Core 由使用者放置或 install 自动下载，
> **任何第三方/闭源资产不进 git、不随 Release 分发**。`nori.config.json` 里配绝对路径（模型/声线/sovits）则原样写入。
> （npm 分发暂不支持：包结构与资产约定按仓库克隆设计。）

## 开发

```powershell
# 宿主类型检查 + 编译
node node_modules\typescript\lib\tsc.js -p tsconfig.json

# widget 打包（core 内联 banner；自动取仓库内 cubism_sdk/Core/live2dcubismcore.js：
# install 自动下载官方 CDN，缺失时先跑 install.ps1；内联产物仅本机使用，勿随包再分发）
npm run build:client

# 热更新：dev_reload_package dsh-nori-pet，然后浏览器 Ctrl+F5（模型为静态资产，需强刷）
```

发布守卫（可选启用）：`git config core.hooksPath .githooks` 后在每次 commit 前自动扫描
（人设文本/机器路径/密钥/资产文件，命中即拒绝提交）；`npm run guard` 手动全树扫描，
CI（`.github/workflows/guard.yml`）在 push/PR 时自动执行 guard + typecheck。

## 故障排查

- **语音 502 `tts http 400`**：GPT-SoVITS api_v2 **强制要求 `ref_audio_path`**。
  空 `refAudio` 时后端 400 → 插件 502。把语音 wav 放入仓库 `voice/`（或 `nori.config.json` 配 `refAudio`）后重跑 install 即可（重启生效）。
- **语音 503 `tts offline`**：9880 不可达/超时——`Test-NetConnection 127.0.0.1 -Port 9880`；
  守护（ttsWatch）会在 30s 内自动拉起。
- **睡眠睁眼 / 每 3 秒头回正**：均为 pixi-live2d-display 不消费 motion3 `Loop` 字段导致
  （已用 `Sleep` 独立动作组 + `setIsLoop(true)` + `setIsLoopFadeIn(false)` 修复，勿回退）。
- **日志**：错误 `~/.dsh/super-injector/nori-pet-error.log`；改写追踪如上。

## 许可与第三方资产

- 本仓库代码（`src/`、`scripts/`、`install*.ps1` 等）以 **BSD-3-Clause** 授权，见 [LICENSE](LICENSE)。
- **Nori 人设文本**（`persona/prompt.txt`、`persona/reframe.txt`）与 **Nori 声线**（`voice/*.wav`）为 I_NORI 团队资产/角色 IP：不入库、不随 Release 分发，由所有者放置授权文件；缺失时改写层自动关闭（照常朗读原始输出）。发布前若需再分发人设/声线，请先取得书面授权。
- **Live2D Cubism Core**（`live2dcubismcore.js`）受 Live2D 专有许可（EULA）约束：install 自动从官方 CDN 下载；`widget.js` 构建时内联该文件属本机使用行为，请勿将预构建 widget.js 随包/Release 再分发。
- **GPT-SoVITS 默认权重**：官方闭源，仅 `install-sovits.ps1 -DownloadModels` 本机可选下载，不入库不发布。

## 安全边界（本地服务）

- WS（`…/ws`）与 API（`/api/status`、`/api/emote`、`/api/ws-test`、`/api/speak`）仅放行本地来源：
  Origin ∈ `localhost`/`127.0.0.1`/`::1`（`Sec-Fetch-Site: cross-site` 一律拒），非浏览器本地客户端放行；
  若从 LAN IP/自定义域名访问，把主机名加入配置 `allowedOrigins`。
- `/assets` 路径穿越 → 403；非法编码 → 400；`/api/speak` body 上限 16KB（超限 413）。
- 已知限制：安装链路仅支持 Windows（依赖 junction / dsh CLI / cmd.exe 转发 pnpm）。

## 目录结构

```
src/index.ts        宿主：会话监听 / 断句 / 改写 / TTS 代理 / 资产服务 / WS
src/prompt.ts       人设加载器（persona/*.txt → 改写层；缺失自动降级）
src/client/widget.ts  浏览器 widget：Live2D 渲染、情绪表、睡眠、摸头、UI 锚定
install.ps1 / uninstall.ps1  一键安装/卸载（PowerShell 5.1）
scripts/build.sh    （可选）脚手架生成的旧构建入口，宿主编译以 tsc 为准
```