#!/usr/bin/env node
/**
 * Nori 桌宠冒烟测试（只读探测运行中的 dsh webServer，不发语音、不改状态）：
 *   1.  GET {prefix}/api/status            → 200 且含 prefix/ws 字段
 *   2.  GET {prefix}/assets/../package.json → 403（路径穿越防护）
 *   3.  WS 升级握手（裸 http + crypto）      → 101 且 Sec-WebSocket-Accept 正确
 *   4.  跨站 Origin 的 WS 升级               → 被拒（403 或连接销毁）
 * 任一失败 exit 1。用法：node scripts/smoke-test.mjs
 * 覆盖运行实例基址：$env:NORI_BASE = 'http://127.0.0.1:3080'（默认即此）。
 */
import { createHash, randomBytes } from 'node:crypto'
import http from 'node:http'

const BASE = (process.env.NORI_BASE || 'http://127.0.0.1:3080').replace(/\/+$/, '')
const PREFIX = '/@bubblesalt/dsh-nori-pet'
const WS_GUID = '258EAFA5-E914-47DA-95CA-C5AB0DC85B11'
let failed = 0

function check(name, cond, extra = '') {
  console.log((cond ? 'PASS' : 'FAIL') + '  ' + name + (extra ? '  (' + extra + ')' : ''))
  if (!cond) failed += 1
}

function get(path) {
  return new Promise((resolve) => {
    http.get(BASE + path, (res) => {
      let body = ''
      res.on('data', (d) => (body += d))
      res.on('end', () => resolve({ status: res.statusCode, headers: res.headers, body }))
    }).on('error', (e) => resolve({ error: e.message }))
  })
}

/** 裸 WS 升级：origin 传 'LOCAL' 用 BASE 自身，传其他字符串原样带上。
 *  bare=true 时不带 RFC6455 握手头（Upgrade/Connection）——用于验证宿主会拒掉这种伪升级。 */
function upgrade(origin, bare = false) {
  return new Promise((resolve) => {
    const url = new URL(BASE)
    const key = randomBytes(16).toString('base64')
    const headers = {
      'Sec-WebSocket-Key': key,
      'Sec-WebSocket-Version': '13',
      Origin: origin === 'LOCAL' ? BASE : origin,
    }
    if (!bare) Object.assign(headers, { Connection: 'Upgrade', Upgrade: 'websocket' })
    const req = http.request({
      hostname: url.hostname,
      port: url.port || 80,
      path: PREFIX + '/ws',
      headers,
    })
    req.on('upgrade', (res) => {
      const expect = createHash('sha1').update(key + WS_GUID).digest('base64')
      resolve({ upgraded: true, ok: res.headers['sec-websocket-accept'] === expect })
      req.destroy()
    })
    req.on('response', (res) => { req.destroy(); resolve({ upgraded: false, status: res.statusCode }) })
    req.on('error', () => resolve({ upgraded: false, destroyed: true }))
    req.end()
  })
}

try {
  const r = await get(PREFIX + '/api/status')
  check('GET /api/status 200', r.status === 200, 'status=' + r.status)
  if (r.status === 200) {
    const j = JSON.parse(r.body)
    check('/api/status 含 prefix/ws 字段', typeof j.prefix === 'string' && typeof j.ws === 'number')
  }

  const t = await get(PREFIX + '/assets/..%2f..%2fpackage.json')
  check('资产路径穿越（编码）→ 403', t.status === 403, 'status=' + t.status)

  const t2 = await get(PREFIX + '/assets/../../package.json')
  check('资产路径穿越（原始，路由层归一化）→ 非 200', t2.status !== 200 && t2.status >= 400, 'status=' + t2.status)

  const u = await get(PREFIX + '/assets/%zz')
  check('非法编码 → 400', u.status === 400, 'status=' + u.status)

  const ok = await upgrade('LOCAL')
  check('WS 升级握手 101 + Sec-WebSocket-Accept 正确', ok.upgraded && ok.ok,
    ok.upgraded ? '101' : ok.status !== undefined ? 'HTTP ' + ok.status : 'destroyed')

  const evil = await upgrade('http://evil.example.com')
  check('跨站 Origin WS 被拒', !evil.upgraded,
    evil.upgraded ? '意外升级成功' : evil.status !== undefined ? 'HTTP ' + evil.status : '连接销毁')

  // 只带 Sec-WebSocket-Key、不带 Upgrade/Connection 的伪升级必须被拒（旧版会直接 101 升格，
  // 留下一个永远不说话的半开 socket 常驻 clients 表）
  const bare = await upgrade('LOCAL', true)
  check('缺 Upgrade/Connection 头的伪升级被拒', !bare.upgraded,
    bare.upgraded ? '意外升级成功' : bare.status !== undefined ? 'HTTP ' + bare.status : '连接销毁')

  if (failed) {
    console.error(failed + ' check(s) failed')
    process.exit(1)
  }
  console.log('all smoke checks passed')
} catch (e) {
  console.error('smoke test crashed: ' + (e && e.message ? e.message : String(e)))
  console.error('（请确认 dsh 正在运行，且本机已装配 dsh-nori-pet；可用 NORI_BASE 指向其他实例）')
  process.exit(1)
}