# 模型契约

> **适用版本**：v0.4.0　｜　**最后更新**：2026-10-23
> **唯一真相**：`src/modelMap.ts`、`scripts/model-map-from-model.mjs`　—— 本文只做解释，数值与字段以代码/配置为准；若两者冲突，以代码为准并提 issue。

#### 🔌 换模型：模型契约

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
