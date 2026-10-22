/**
 * 插件配置（schemastery schema）+ 由 schema 推导出的 TS 类型。
 *
 * 为什么不再手写 interface：原先 schema（29 字段）与 `export interface Config`（29 行）是两份
 * 人肉同步的真相，加字段忘了补 interface 不会被任何门禁拦住（dsh 侧读的是 schema，TS 侧读的是
 * interface，漂移只在运行时暴露）。现在 `Config` 类型 = `z.infer<typeof schema>`，只有一处。
 *
 * 字段注释即运维文档：`nori.config.json` 的运行时覆盖开关、踩过的坑、实测数值都在这里。
 */
import z from 'schemastery'

const schema = z.object({
  enabled: z.boolean().default(true),
  /** Nori Live2D 模型目录（含 Nori.model3.json）；留空自动探测仓库内 Nori_web */
  assetsDir: z.string().default(''),
  /** live2dcubismcore.js 绝对路径；留空自动探测仓库内 cubism_sdk/Core */
  coreFile: z.string().default(''),
  /** 本地 GPT-SoVITS 服务地址（api_v2 的 /tts 端点） */
  ttsUrl: z.string().default('http://127.0.0.1:9880/tts'),
  /** 零样本参考音频（Nori 声线 wav，绝对或相对仓库根；留空自动回退插件自带 voice/nori.wav）。建议 3~10 秒（api_v2 强制要求）。 */
  refAudio: z.string().default(''),
  /** 参考音频的逐字转写文本（prompt text）。⚠ 必须与 refAudio 的音频内容完全一致：
   *  换 refAudio 时必须同步换 refPrompt，否则 AR 条件作用劣化 → 跳字/吞句（中英混排时更明显）、音色漂移。 */
  refPrompt: z.string().default('你好,初次见面,我的名字是Nori'),
  /** 单句推送的最大长度（超出强制截断） */
  maxSentence: z.number().min(1).default(140),
  /**
   * 超长内容的"详读预算"（字）。一段连续输出 ≤ 此字数 → 全文逐句详读（保持原有即时反馈）；
   * 超过 → 这一段一个字都不详读，整轮只播一次概括 —— 两者互斥，避免"前半详细、中间快进"的口径不一。
   * 输出速度约 300 token/s 时，400 字约 0.9 秒即可判定，所以长内容判定几乎不产生等待。
   */
  detailMaxChars: z.number().min(20).default(400),
  /** 超长内容概括总开关（关闭 = 完全保持逐句详读的旧行为） */
  summaryEnabled: z.boolean().default(true),
  /** 概括等待上限（毫秒）：超过则先播一句提示，避免长静默（LLM 慢/超时兜底） */
  summaryWaitMs: z.number().min(1000).default(8000),
  /**
   * TTS 推理参数。低温度更稳更收敛（避免采样噪声导致电音感），但温度过低 + top_k 过小
   * 会让 AR 模型在"嗯/唔"等鼻音叹词上进入采样循环：某个字无限拖长、随后吞掉句尾一小段。
   * 实测 0.65/5 约 1/6 卡顿；0.9/12 基本消除，且 speak 路径内置"拖长自动热参数重试"兜底。
   */
  ttsTemperature: z.number().default(0.9),
  ttsTopK: z.number().default(12),
  ttsSpeedFactor: z.number().default(1.0),
  /** Nori 人设改写层：agent 输出先经 LLM 改写为 Nori 口吻再朗读 */
  reframe: z.boolean().default(true),
  /** 改写 LLM 的 provider（dsh-llm 注册名） */
  reframeProvider: z.string().default('deepseek-official'),
  /** 改写 LLM 的模型 */
  reframeModel: z.string().default('deepseek-chat'),
  /** 改写单次调用的超时（毫秒）。实测真实负载（11.9K 人设 system + 材料）约 10s，
   * 网关波动时易撞线 → 放宽到 60s；失败仅降级原文，无副作用。可在 nori.config.json reframe.reframeTimeoutMs 运行时覆盖。 */
  reframeTimeoutMs: z.number().min(1000).default(60000),
  /** 改写输入的最大字符数（超出截断）。只作用于材料（user），不含 system 里的预设人设。
   *  调大后超长文本可一次喂更大块，改写请求次数更少、输出更精炼（配合 splitBlocks/BATCH_MAX）。 */
  reframeMaxInput: z.number().min(1).default(4000),
  /**
   * 改写单次调用的最大输出 token。推理型模型（DeepSeek-V4-Flash 等）思维链会先吃满
   * tokens 再出 content——512 常被 reasoning 占光导致 content 空、判 EMPTY 降级原文。
   * 非推理模型（deepseek-chat 等）512 足够，此处按需调大（如 2048）。
   */
  reframeMaxTokens: z.number().min(1).default(2048),
  /**
   * Nori 专用 API key 的 credentials ref（如 DEEPSEEK_NORI_API_KEY）。
   * 设置后改写层直连 DeepSeek 官方 API（独立计量，不走主会话）；留空则走 dsh 内置 llm 服务。
   */
  reframeApiKeyRef: z.string().default('DEEPSEEK_NORI_API_KEY'),
  /** 专用 key 直连的 API 地址（OpenAI 兼容 /chat/completions） */
  reframeBaseUrl: z.string().default('https://api.deepseek.com/v1'),
  /**
   * 改写层输入/输出追踪日志（排障用，**默认开启**）。
   *
   * 内容与落点：每轮对话的原文与改写结果各截 500 字，写进
   * `~/.dsh/logs/nori-pet/nori-pet-trace.log`。**自带长度上限**：超过 1MB 就从最旧删到约 512KB
   *（约留最近 500 轮），整个日志目录超 8MB 时再删最旧的文件（见 enforceLogBudget）。
   * 所以长期开着也不会无限增长——需要翻"刚才那句为什么这么念"时，历史就在手边。
   * 不想要这些内容落盘就设 false（nori.config.json 的 `reframe.trace` 支持热改）。
   */
  reframeTrace: z.boolean().default(true),
  /** api_v2 守护：定时探测 9880，掉了自动拉起（桌面朗读保底） */
  ttsWatch: z.boolean().default(true),
  /** 守护探测间隔（毫秒）。下限 5s：填 0 会让 setInterval 退化成定时器风暴 + 反复 spawn */
  ttsWatchIntervalMs: z.number().min(5000).default(30000),
  /**
   * GPT-SoVITS 安装根目录（api_v2.py 所在，守护拉起时作为 cwd）。
   * 留空自动探测仓库内 GPT-SoVITS；不在此处的机器用 -GsvBase 指定。
   */
  gsvBase: z.string().default(''),
  /** GPT-SoVITS venv 的 python 路径（守护拉起用）。留空默认 <gsvBase>/.venv/Scripts/python.exe */
  venvPy: z.string().default(''),
  /** 人设 system prompt 文件（绝对/相对仓库根；留空探测 persona/prompt.txt） */
  personaPrompt: z.string().default(''),
  /** 改写任务补充指令文件（绝对/相对仓库根；留空探测 persona/reframe.txt） */
  personaReframe: z.string().default(''),
  /** 概括任务规则文件（绝对/相对仓库根；留空探测 persona/summary.txt；缺失则用内置默认规则） */
  personaSummary: z.string().default(''),
  /** WS/API 额外放行的 Origin 主机名（缺省仅 localhost/127.0.0.1；浏览器跨站请求一律拒绝） */
  allowedOrigins: z.array(z.string()).default([]),
})

export const Config = schema

/**
 * 注入配置类型 = schema 的**归一化输出**（`Schema<S, T>` 的调用签名 `(data?: S | null) => T`，
 * 故 `ReturnType` 就是补过默认值之后的形状，字段不会是 undefined）。
 * schemastery 没有 `z.infer` 那种命名空间助手（`infer` 是 zod 的），`ReturnType` 等价且更直接。
 */
export type Config = ReturnType<typeof schema>
