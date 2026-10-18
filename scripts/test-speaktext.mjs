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
import { toSpeakable, speakableLength, MIN_SPEAKABLE_CHARS } from '../lib/speakText.js'

const clean = (s) => toSpeakable(s).text
const dropped = (s) => toSpeakable(s).dropped

test('URL/路径/命令：换成可朗读说法（实机曾念成"秒每每.米每每毫秒减减"）', () => {
  assert.equal(clean('详见 https://github.com/BubbleSalt/dsh-nori-pet 这个地址。'), '详见 某个链接 这个地址。')
  assert.equal(clean('路径是 D:/models/nori/voice.wav 这里。'), '路径是 某个路径 这里。')
  assert.equal(clean('执行 npm run build 就行了。'), '执行 那句命令 就行了。')
  assert.equal(clean('我把配置写进 nori.config.json 了。'), '我把配置写进 那个文件 了。')
  // 裸域名（无协议）也要认出来
  assert.equal(clean('去 example.com/a 看看。'), '去 某个链接 看看。')
  // 可配置：不朗读 URL 时直接删掉
  assert.equal(toSpeakable('详见 https://example.com/a 这个地址。', { readUrls: false }).text, '详见 这个地址。')
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