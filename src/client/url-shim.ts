// url-shim for pixi-live2d-display / @pixi/utils (browser-safe URL string helpers).
// Aliased via tsdown `alias: { url, 'node:url' }` so the Node builtin never leaks into the bundle.
// Only `resolve` is exercised at runtime; parse/format are provided as browser-safe stubs.

function resolve(from: string, to: string): string {
  if (!from) return to
  // 目标已是绝对 URL（含 scheme）
  if (/^[a-z][a-z0-9+.-]*:/i.test(to)) return to
  // scheme-relative / 根相对
  if (to.startsWith('//')) {
    const m = from.match(/^[a-z][a-z0-9+.-]*:/i)
    return (m ? m[0] : 'https:') + to
  }
  if (to.startsWith('/')) {
    const m = from.match(/^[a-z][a-z0-9+.-]*:\/\/[^/]+/i)
    return (m ? m[0] : '') + to
  }
  // 去掉 from 的 query/hash，取目录部分
  const base = from.replace(/[?#].*$/, '')
  const parts = base.split('/')
  parts.pop() // 最后一段视为文件
  for (const s of to.split('/')) {
    if (s === '' || s === '.') continue
    if (s === '..') {
      if (parts.length > 1) parts.pop()
      continue
    }
    parts.push(s)
  }
  return parts.join('/')
}

function parse(input: string): Record<string, string> {
  try {
    const u = new URL(input, 'http://localhost')
    return {
      href: u.href,
      protocol: u.protocol,
      host: u.host,
      hostname: u.hostname,
      port: u.port,
      pathname: u.pathname,
      search: u.search,
      hash: u.hash,
    }
  } catch {
    return { href: input, pathname: input }
  }
}

function format(obj: any): string {
  let s = obj.protocol ?? 'http:'
  if (obj.host) s += '//' + obj.host
  else s += '//' + (obj.hostname || 'localhost') + (obj.port ? ':' + obj.port : '')
  s += obj.pathname ?? '/'
  if (obj.search) s += obj.search
  if (obj.hash) s += obj.hash
  return s
}

const url = { resolve, parse, format }
export default url
export { resolve, parse, format }