# 安装与资产准备

> **适用版本**：v0.4.0　｜　**最后更新**：2026-10-23
> **唯一真相**：`install.ps1` 与 `nori.config.example.json`　—— 本文只做解释，数值与字段以代码/配置为准；若两者冲突，以代码为准并提 issue。

### 📦 你需要准备的资产

> 模型 / 声线 / 授权人设文本是第三方 IP（见文末[许可](#许可与第三方资产)），**不进仓库、不随 Release 分发**。
> 改写任务指令（`persona/reframe.txt`）与概括规则（`persona/summary.txt`）无版权问题，**随仓库提供**。
> 仓库自带空占位目录：克隆后把文件放进对应目录即可（放好后重跑 `.\install.ps1`）。

| 资产 | 放哪 | 是否必需 | 缺失时会发生什么 |
|---|---|---|---|
| Live2D 模型（任意 Cubism4，或原版 `Nori_web`） | `Nori_web/`，或配置 `model.file` | 可选 | **纸片人模式**：气泡 + 语音正常，表情/动作不可用（不再中断安装） |
| 声线样本 `wav`（Nori 声音） | `voice/` | 可选 | 能装、能动，但语音用 GPT-SoVITS 服务端默认音色 |
| 人设文本 `prompt.txt` | `persona/` | 可选 | 改写层自动关闭，直接朗读 assistant 原始输出（改写任务指令 `reframe.txt` 已随仓库提供） |
| Live2D Core | `cubism_sdk/Core/` | — | 不用管：install 自动从官方 CDN 下载 |
| GPT-SoVITS 部署 + 默认权重 | 仓库外 | 可选 | 语音不可用，其余正常（见[下方章节](#gpt-sovits可选)） |

**资产获取途径**：暂未公开，待公布（作者整理好分发渠道后会在此补充）。

### 🚀 快速开始

```powershell
# 1. 克隆仓库（已含占位目录结构）
git clone <仓库地址>

# 2. 按上表放入资产（都可以留空，缺什么降级什么）

# 3. 一键安装：探测资产 → 构建 → 装配进 dsh → 写入配置
.\install.ps1

# 4. 打开/刷新 dsh 网页（模型是静态资产，记得 Ctrl+F5 强刷）
```

- 卸载：`.\uninstall.ps1`（先 `-DryRun` 预览再执行）。
- 重跑 install 是幂等的；它会探测仓库内资产并自动写配置。

---

### 🔊 GPT-SoVITS（可选）

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

### ❓ 常见问题

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
