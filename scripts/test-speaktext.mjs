#!/usr/bin/env node
/**
 * 朗读文本清理测试：node scripts/test-speaktext.mjs
 *
 * 用例全部来自**实机 ASR 取证**（2026-10-18）：把面板真实会送的文本合成一遍、再转写回汉字，
 * 与原文比相似度。相似度难看的那几条就是这里的输入，改完必须变干净。
 *
 * 两组断言同等重要：
 *  · 该清理的必须清理（URL/路径/命令/Markdown/符号）；
 *  · **不该动的绝不能动**（数字、小数、版本号、`3~5`、`api_v2`、`3×4`）——
 *    GPT-SoVITS 前端 PaddleSpeech NSW 会把它们读对（`0.9`→"零点九"、`90%`→"百分之九十"），
 *    插件侧再转一次就成 `90百分之` 这种重复转换，反而更差。
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { endWithPeriod, friendlyApprovalReason, toSpeakable, speakableLength, MIN_SPEAKABLE_CHARS } from '../lib/speakText.js'

const clean = (s) => toSpeakable(s).text
const dropped = (s) => toSpeakable(s).dropped

test('URL/命令：换成可朗读说法（实机曾念成"秒每每.米每每毫秒减减"）', () => {
  assert.equal(clean('详见 https://github.com/BubbleSalt/dsh-nori-pet 这个地址。'), '详见 某个链接 这个地址。')
  assert.equal(clean('执行 npm run build 就行了。'), '执行 那句命令 就行了。')
  // 裸域名（无协议）也要认出来
  assert.equal(clean('去 example.com/a 看看。'), '去 某个链接 看看。')
  // 可配置：不朗读 URL 时直接删掉
  assert.equal(toSpeakable('详见 https://example.com/a 这个地址。', { readUrls: false }).text, '详见 这个地址。')
})

// ── 路径只留文件名（用户口径："把路径去掉只剩文件名就可以接受了"）──
// 曾经的两版都错：① 只认文件名 → 剩下半截路径被逐字符念成"波浪号 反斜杠 dsh 反斜杠…"；
// ② 硬换成"那个文件"/"某个路径" → 语音里没有先行词，听着莫名其妙。现在只留文件名，
// 拉丁文件名交给合成前端（v2 前端本来就会丢非汉字部分），不做任何中文占位替换。
test('★ 路径整段去掉、只留文件名（不许留半截，也不许硬换中文词）', () => {
  const bs = '\\'
  assert.equal(clean('注册在 `~' + bs + '.dsh' + bs + 'storages' + bs + 'workspace.json` 里。'), '注册在 workspace.json 里。')
  assert.equal(clean('改 `kernel/bpf/helpers_chimera.c` 那一行。'), '改 helpers_chimera.c 那一行。')
  assert.equal(clean('路径是 D:/models/nori/voice.wav 这里。'), '路径是 voice.wav 这里。')
  assert.equal(clean('留 `2026' + bs + '09' + bs + '12/` 那个目录。'), '留 12 那个目录。')
  // 带空格的路径：靠"先按行内代码识别"才能整段吃掉
  assert.equal(clean('改 `C:' + bs + 'a b' + bs + 'c' + bs + 'd.md` 那段。'), '改 d.md 那段。')
  // 中文名文件名照留
  assert.equal(clean('先读 `prefer-a100-交接说明.md` 再说。'), '先读 prefer-a100-交接说明.md 再说。')
  // 裸文件名本来就不动（没有路径要去）
  assert.equal(clean('先读 package.json 确认版本号。'), '先读 package.json 确认版本号。')
  // 已经不该再出现这些硬换词
  const out = clean('改 `C:' + bs + 'a' + bs + 'b.md` 和 D:/x/y.json。')
  assert.ok(!/那个文件|某个路径/.test(out), '不许再出现"那个文件/某个路径"：' + out)
  assert.ok(!/[A-Za-z]:|[\\/]/.test(out), '不许残留路径符号：' + out)
})

test('★ 反向：不是路径的别动（"和/或"、分数、版本号）', () => {
  assert.equal(clean('和/或 都行。'), '和/或 都行。')
  assert.equal(clean('差不多 1/2 的量。'), '差不多 1/2 的量。')
  assert.equal(clean('当前版本 0.2.4 已经发布。'), '当前版本 0.2.4 已经发布。')
  // 可配置：不朗读路径时整段删掉
  assert.equal(toSpeakable('路径是 C:/a/b 这里。', { readPaths: false }).text, '路径是 这里。')
})

test('符号读成字（→ ≥ == 曾把标点当音素念）', () => {
  assert.equal(clean('结果 → 成功。'), '结果 变成 成功。')
  assert.equal(clean('概率 ≥ 90%。'), '概率 大于等于 90%。')
  assert.equal(clean('用 a|b 表示。'), '用 a或b 表示。')
  assert.equal(clean('e==f 成立。'), 'e等于f 成立。')
})

test('Markdown 只是格式：星号/井号/引用号/列表序号都剥掉', () => {
  assert.equal(clean('**重点**：这里有颗星号。'), '重点：这里有颗星号。')
  assert.equal(clean('# 标题：看这里。'), '标题：看这里。')
  assert.equal(clean('> 引用内容。'), '引用内容。')
  assert.equal(clean('1. 列表项一，2. 列表项二。'), '列表项一，列表项二。')
  assert.equal(clean('- 第一件事\n- 第二件事'), '第一件事\n第二件事')
  // 代码块整段丢弃（换行与残留空格在朗读里没有意义）
  assert.equal(clean('看这段：\n```js\nconst a = 1\n```\n就这样。'), '看这段：就这样。')
  // 情绪标签：控制标记不是正文（cleanSpeech 的活，toSpeakable 一并兜住，便于单独使用）
  assert.equal(clean('【happy】真的吗？'), '真的吗？')
})

test('★ 不该动的绝不能动：数字/小数/版本号/区间交给前端 NSW', () => {
  assert.equal(clean('温度是 0.9，上限 3.5 秒。'), '温度是 0.9，上限 3.5 秒。')
  assert.equal(clean('当前版本 0.2.4 已经发布。'), '当前版本 0.2.4 已经发布。')
  assert.equal(clean('大概 3~5 分钟吧~'), '大概 3~5 分钟吧')
  assert.equal(clean('概率 90% 左右。'), '概率 90% 左右。')
  assert.equal(clean('结果是 3×4 等于 12。'), '结果是 3×4 等于 12。')
  assert.equal(clean('GPT-SoVITS v2 里 api_v2 是本地服务。'), 'GPT-SoVITS v2 里 api_v2 是本地服务。')
})

test('★ 没有可朗读内容时判 dropped（宁可不出声，也不吐怪音）', () => {
  assert.equal(dropped('嗯……唔……那个……'), true, '纯语气词')
  assert.equal(dropped('****----===='), true, '装饰符号串')
  assert.equal(dropped('--------'), true, '分隔线')
  assert.equal(dropped('【happy】'), true, '只剩情绪标签')
  assert.equal(dropped('😊😊'), true, '只剩 emoji')
  // 反向：有内容就不能误判
  assert.equal(dropped('好的。'), false)
  assert.equal(dropped('我今天特别开心哈哈哈'), false, '长句里的语气词不算纯语气词')
  assert.equal(dropped('哇……真的吗？！太好了！'), false, '感叹句有实词')
  assert.equal(dropped('他说（原话）「这样最稳」。'), false)
})

test('空白与重复标点整理（前端遇重复标点会制造怪停顿）', () => {
  assert.equal(clean('你好！！！'), '你好！')
  assert.equal(clean('好  ，  吧。'), '好，吧。')
  assert.equal(clean('  前后有空白  '), '前后有空白')
  assert.equal(speakableLength('今天天气不错'), 6)
  assert.ok(MIN_SPEAKABLE_CHARS >= 2)
})

// ── 结尾句号：只许一个（用户实测：气泡里"结尾出现两个句号"）──
// 根因是宿主**拼接**文案：`'有权限申请：' + tool + '。原因：' + reason + '。'`，
// 而 dsh 传进来的 reason 通常自带句号 → `。。`。朗读侧会把重复标点折叠掉，
// 所以只有界面文字露馅，光听声音发现不了。
test('★ 结尾句号只补一个，不叠加', () => {
  assert.equal(endWithPeriod('有权限申请：pwsh。原因：允许本次操作使用 danger-full-access 权限：推送 tag。'),
    '有权限申请：pwsh。原因：允许本次操作使用 danger-full-access 权限：推送 tag。')
  assert.equal(endWithPeriod('有权限申请：pwsh'), '有权限申请：pwsh。')
  assert.equal(endWithPeriod('好的。。'), '好的。', '连续句号要折叠')
  assert.equal(endWithPeriod('好的，，吧。'), '好的，吧。', '连续逗号同理')
  assert.equal(endWithPeriod('好的，'), '好的。', '悬空逗号换成句号，不能拼成"，。"')
  assert.equal(endWithPeriod('真的吗…'), '真的吗…')
  assert.equal(endWithPeriod('真的吗……'), '真的吗……', '中文省略号是有意的，不许压成一个')
  assert.equal(endWithPeriod('什么！？'), '什么！？', '感叹+疑问组合保留')
  assert.equal(endWithPeriod('   '), '')
})

test('DSH 技术文案翻成人话（英文前缀不该念给用户听）', () => {
  assert.equal(friendlyApprovalReason('escalate sandbox to danger-full-access: 需要推送 tag。'),
    '允许本次操作使用 danger-full-access 权限：需要推送 tag。')
  assert.equal(friendlyApprovalReason('用户拒绝了这次操作'), '用户拒绝了这次操作', '不认识的原样返回，绝不猜')
  assert.equal(friendlyApprovalReason(''), '')
})