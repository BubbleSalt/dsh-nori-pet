/**
 * 配置面板。
 *
 * 表单**由 schema 生成**，不手写字段清单：
 *   宿主 GET /api/config/schema 递归导出 config.ts（schemastery）里的每个叶子项，
 *   GET /api/config 给出当前生效值。两路一合，界面就能一个不漏地列出全部配置项，
 *   并且把默认值直接填进控件（用户看得见"现在到底是什么值"）。
 *
 * 特例：`model`（type=any）不生成普通控件，走专门的情绪映射表 —— 那是有结构的资源映射，
 * 不是一行文本能表达的东西。
 */
import { MAX_SCALE, MIN_SCALE } from '../clientLayout.js'

interface Field { path: string; type: string; default: unknown; description?: string }
interface Snapshot { config: Record<string, unknown>; secrets: { apiKeyConfigured: boolean }; file: string }
interface ProbeResult { ok: boolean; expressions?: string[]; motionGroups?: Record<string, number>; lipSyncId?: string | null; error?: string }

/** 情绪键（与宿主 Emotion 一致；顺序即表情优先级） */
const EMOTIONS = [
  'happy', 'excited', 'angry', 'refuse', 'sad', 'doubt', 'troubled',
  'shy', 'surprised', 'dizzy', 'serious', 'speechless', 'think', 'default',
] as const

const TABS = ['模型', '声音', '播报', '高级'] as const
type Tab = (typeof TABS)[number]

const el = <K extends keyof HTMLElementTagNameMap>(tag: K, cls?: string, text?: string): HTMLElementTagNameMap[K] => {
  const n = document.createElement(tag)
  if (cls) n.className = cls
  if (text !== undefined) n.textContent = text
  return n
}

const getPath = (obj: unknown, path: string): unknown => {
  let cur: unknown = obj
  for (const seg of path.split('.')) {
    if (!cur || typeof cur !== 'object') return undefined
    cur = (cur as Record<string, unknown>)[seg]
  }
  return cur
}

/** 扁平 path → 嵌套对象（保存时用） */
const nest = (flat: Record<string, unknown>): Record<string, unknown> => {
  const out: Record<string, unknown> = {}
  for (const [path, value] of Object.entries(flat)) {
    const segs = path.split('.')
    let cur = out
    for (const seg of segs.slice(0, -1)) {
      if (typeof cur[seg] !== 'object' || cur[seg] === null) cur[seg] = {}
      cur = cur[seg] as Record<string, unknown>
    }
    cur[segs[segs.length - 1]] = value
  }
  return out
}

const fmt = (v: unknown): string => {
  if (v === undefined || v === null) return ''
  if (typeof v === 'string') return v
  if (typeof v === 'number' || typeof v === 'boolean') return String(v)
  return JSON.stringify(v)
}

export function createConfigPanel(prefix: string): { open(): void; close(): void; toggle(): void } {
  // ── 主题变量（跟随系统深浅色）──
  const style = document.createElement('style')
  style.textContent = `
  .nori-cfg-root {
    --cfg-bg:#1e1f24; --cfg-bg-2:#22242a; --cfg-bg-3:#17181c;
    --cfg-fg:#e8e8ea; --cfg-fg-dim:#9aa0ab; --cfg-fg-strong:#cfd3da;
    --cfg-border:#33363d; --cfg-border-2:#2c2f36; --cfg-border-3:#3a3e46;
    --cfg-accent:#3b6fd4; --cfg-accent-2:#6ea8fe; --cfg-shadow:0 24px 60px rgba(0,0,0,.55);
    --cfg-overlay:rgba(0,0,0,.45); --cfg-tab-on:#2a2d34;
  }
  @media (prefers-color-scheme: light) {
    .nori-cfg-root {
      --cfg-bg:#fbfbfd; --cfg-bg-2:#f2f3f6; --cfg-bg-3:#ffffff;
      --cfg-fg:#1c1d21; --cfg-fg-dim:#6b7280; --cfg-fg-strong:#3f4450;
      --cfg-border:#d7dae0; --cfg-border-2:#e6e8ec; --cfg-border-3:#cfd3da;
      --cfg-accent:#2563eb; --cfg-accent-2:#3b82f6; --cfg-shadow:0 18px 48px rgba(0,0,0,.18);
      --cfg-overlay:rgba(0,0,0,.28); --cfg-tab-on:#e8eaee;
    }
  }
  .nori-cfg-root input[type=text], .nori-cfg-root input[type=number],
  .nori-cfg-root input[type=password], .nori-cfg-root textarea, .nori-cfg-root select {
    padding:5px 8px; border-radius:6px; border:1px solid var(--cfg-border-3);
    background:var(--cfg-bg-3); color:var(--cfg-fg); font-size:13px; width:100%; box-sizing:border-box;
  }
  `
  document.head.append(style)

  const root = el('div', 'nori-cfg-root')
  root.style.cssText = 'position:fixed;inset:0;z-index:2147483000;display:none;background:var(--cfg-overlay);font:13px/1.5 system-ui,sans-serif;color:var(--cfg-fg)'

  const panel = el('div')
  panel.style.cssText = 'position:absolute;left:50%;top:50%;transform:translate(-50%,-50%);width:min(820px,94vw);max-height:88vh;display:flex;flex-direction:column;background:var(--cfg-bg);border:1px solid var(--cfg-border);border-radius:10px;box-shadow:var(--cfg-shadow);overflow:hidden'

  const head = el('div')
  head.style.cssText = 'display:flex;align-items:center;gap:8px;padding:10px 14px;border-bottom:1px solid var(--cfg-border-2);cursor:move;user-select:none'
  head.append(el('strong', '', '桌宠设置'))
  const fileHint = el('span')
  fileHint.style.cssText = 'color:var(--cfg-fg-dim);font-size:11px;margin-left:auto'
  const closeBtn = el('button', '', '✕')
  closeBtn.style.cssText = 'all:unset;cursor:pointer;padding:2px 6px;color:var(--cfg-fg-dim)'
  head.append(fileHint, closeBtn)

  // ── 常驻：体型三滑杆（纯预览，只落 localStorage）──
  const quick = el('div')
  quick.style.cssText = 'display:flex;flex-wrap:wrap;gap:16px;padding:10px 14px;border-bottom:1px solid var(--cfg-border-2);background:var(--cfg-bg-2)'

  const tabBar = el('div')
  tabBar.style.cssText = 'display:flex;gap:2px;padding:8px 14px 0;border-bottom:1px solid var(--cfg-border-2)'
  const body = el('div')
  body.style.cssText = 'padding:14px;overflow:auto;flex:1;display:flex;flex-direction:column;gap:12px'

  const foot = el('div')
  foot.style.cssText = 'display:flex;align-items:center;gap:8px;padding:10px 14px;border-top:1px solid var(--cfg-border-2);background:var(--cfg-bg-2)'
  const status = el('span')
  status.style.cssText = 'color:var(--cfg-fg-dim);font-size:12px'
  const resetBtn = el('button', '', '恢复默认')
  const cancelBtn = el('button', '', '取消')
  const saveBtn = el('button', '', '保存')
  for (const b of [resetBtn, cancelBtn]) b.style.cssText = 'all:unset;cursor:pointer;padding:6px 12px;border:1px solid var(--cfg-border-3);border-radius:6px;color:var(--cfg-fg-strong)'
  saveBtn.style.cssText = 'all:unset;cursor:pointer;padding:6px 16px;border-radius:6px;background:var(--cfg-accent);color:#fff;font-weight:600;margin-left:auto'
  foot.append(resetBtn, cancelBtn, status, saveBtn)

  panel.append(head, quick, tabBar, body, foot)
  root.append(panel)
  document.body.append(root)

  // ── 状态 ──
  let snapshot: Snapshot | null = null
  let fields: Field[] = []
  let pending: Record<string, unknown> = {}
  let dirtyFlag = false
  let currentTab: Tab = '模型'
  let draftExpressions: string[] = []
  let initView = { scale: 1, girl: 0, chibi: 0 }

  const renderFoot = (): void => {
    saveBtn.disabled = !dirtyFlag
    saveBtn.style.opacity = dirtyFlag ? '1' : '.45'
    saveBtn.textContent = dirtyFlag ? `保存（${Object.keys(pending).length} 项）` : '保存'
  }
  const dirty = (): void => { dirtyFlag = true; renderFoot() }

  // ── 控件工厂 ──
  const row = (label: string, hint?: string): HTMLDivElement => {
    const r = el('div')
    r.style.cssText = 'display:flex;flex-direction:column;gap:3px'
    const l = el('span', '', label)
    l.style.cssText = 'color:var(--cfg-fg-strong);font-weight:600'
    r.append(l)
    if (hint) { const h = el('span', '', hint); h.style.cssText = 'color:var(--cfg-fg-dim);font-size:11px'; r.append(h) }
    return r
  }

  /** 单个配置项控件：默认值直接填进 value，改动才进 pending */
  const fieldControl = (f: Field): HTMLElement => {
    const cur = getPath(snapshot?.config, f.path)
    const defTxt = fmt(f.default)
    const desc = f.description
    if (f.type === 'boolean') {
      const r = el('label')
      r.style.cssText = 'display:flex;gap:8px;align-items:center'
      const cb = el('input')
      cb.type = 'checkbox'
      cb.checked = typeof cur === 'boolean' ? cur : Boolean(f.default)
      cb.addEventListener('change', () => { pending[f.path] = cb.checked; dirty() })
      const t = el('span', '', f.path)
      t.style.cssText = 'color:var(--cfg-fg-strong)'
      const d = el('span', '', [desc, `默认 ${defTxt}`].filter(Boolean).join(' · '))
      d.style.cssText = 'color:var(--cfg-fg-dim);font-size:11px'
      r.append(cb, t, d)
      return r
    }
    if (f.type === 'number') {
      const r = row(f.path, [desc, defTxt ? `默认 ${defTxt}` : ''].filter(Boolean).join(' · '))
      const inp = el('input')
      inp.type = 'number'
      inp.value = cur === undefined || cur === null ? defTxt : String(cur)
      const mark = el('span', '')
      mark.style.cssText = 'font-size:11px;color:var(--cfg-fg-dim)'
      mark.textContent = inp.value === defTxt ? '（当前为默认值）' : '（已修改）'
      inp.addEventListener('input', () => {
        const v = Number(inp.value)
        if (!Number.isFinite(v)) return
        pending[f.path] = v
        mark.textContent = String(v) === defTxt ? '（当前为默认值）' : '（已修改）'
        dirty()
      })
      r.append(inp, mark)
      return r
    }
    if (f.type === 'array') {
      const r = row(f.path, [desc, '每行一项；留空表示不使用'].filter(Boolean).join(' · '))
      const ta = el('textarea')
      ta.rows = 3
      const arr = Array.isArray(cur) ? (cur as unknown[]) : Array.isArray(f.default) ? (f.default as unknown[]) : []
      ta.value = arr.map(String).join('\n')
      ta.addEventListener('input', () => {
        pending[f.path] = ta.value.split('\n').map((x) => x.trim()).filter(Boolean)
        dirty()
      })
      r.append(ta)
      return r
    }
    const r = row(f.path, [desc, f.default === '' ? '默认空' : defTxt ? `默认 ${defTxt}` : ''].filter(Boolean).join(' · '))
    const inp = el('input')
    inp.type = 'text'
    inp.value = cur === undefined || cur === null ? fmt(f.default) : fmt(cur)
    inp.placeholder = defTxt || '（空）'
    inp.addEventListener('input', () => { pending[f.path] = inp.value; dirty() })
    r.append(inp)
    return r
  }

  // ── 模型分区（特殊展现：情绪映射表）──
  const modelSection = (): HTMLElement => {
    const wrap = el('div')
    wrap.style.cssText = 'display:flex;flex-direction:column;gap:12px'
    const model = (getPath(snapshot?.config, 'model') ?? {}) as Record<string, unknown>

    const fileRow = row('模型文件', '相对 assets 目录，例如 assets/haru/Haru.model3.json')
    const fileInp = el('input')
    fileInp.type = 'text'
    fileInp.value = typeof model.file === 'string' ? model.file : ''
    fileInp.addEventListener('input', () => { pending['model.file'] = fileInp.value; dirty() })
    fileRow.append(fileInp)

    const probeBtn = el('button', '', '从模型读取表情')
    probeBtn.style.cssText = 'all:unset;cursor:pointer;padding:5px 12px;border:1px solid var(--cfg-accent);border-radius:6px;color:var(--cfg-accent-2);align-self:flex-start'
    const probeOut = el('div')
    probeOut.style.cssText = 'color:var(--cfg-fg-dim);font-size:12px;white-space:pre-wrap'
    probeBtn.addEventListener('click', async () => {
      probeOut.textContent = '读取中…'
      try {
        const r = await fetch(`${prefix}/api/model/probe`, {
          method: 'POST', headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ file: fileInp.value.trim() }),
        })
        const j = (await r.json()) as ProbeResult
        if (!j.ok) { probeOut.textContent = '失败：' + (j.error ?? '未知错误'); return }
        draftExpressions = j.expressions ?? []
        if (j.lipSyncId) { pending['model.mouthParam'] = j.lipSyncId; dirty() }
        const groups = Object.entries(j.motionGroups ?? {}).map(([k, v]) => `${k}(${v})`).join(' ') || '无'
        probeOut.textContent = `读到 ${draftExpressions.length} 个表情；动作组：${groups}。表情下拉已更新。`
        renderTab()
      } catch (err) { probeOut.textContent = '请求失败：' + String(err) }
    })
    wrap.append(fileRow, probeBtn, probeOut)

    for (const key of ['mouthParam', 'idleGroup'] as const) {
      const r = row(`model.${key}`)
      const inp = el('input')
      inp.type = 'text'
      const v = model[key]
      inp.value = typeof v === 'string' ? v : ''
      inp.addEventListener('input', () => { pending[`model.${key}`] = inp.value; dirty() })
      r.append(inp)
      wrap.append(r)
    }

    // 情绪映射表：14 行，表情下拉 + 动作下标
    const table = el('div')
    table.style.cssText = 'display:grid;grid-template-columns:110px 1fr 90px;gap:6px 10px;align-items:center'
    const hdr = (t: string): HTMLElement => { const s = el('span', '', t); s.style.cssText = 'color:var(--cfg-fg-dim);font-size:11px'; return s }
    table.append(hdr('情绪'), hdr('表情'), hdr('动作下标'))
    const emotions = (model.emotions ?? {}) as Record<string, { expr?: string; reaction?: number }>
    const options = Array.from(new Set([
      ...draftExpressions,
      ...(Object.values(emotions).map((v) => v?.expr).filter(Boolean) as string[]),
    ]))
    for (const emo of EMOTIONS) {
      const cur = emotions[emo] ?? {}
      const name = el('span', '', emo)
      name.style.cssText = 'color:var(--cfg-fg-strong)'
      const sel = el('select')
      sel.append(new Option('—（不用）', ''))
      for (const o of options) sel.append(new Option(o, o))
      sel.value = cur.expr ?? ''
      sel.addEventListener('change', () => {
        if (sel.value) pending[`model.emotions.${emo}.expr`] = sel.value
        else pending[`model.emotions.${emo}`] = null
        dirty()
      })
      const react = el('input')
      react.type = 'number'
      react.value = typeof cur.reaction === 'number' ? String(cur.reaction) : ''
      react.placeholder = '—'
      react.addEventListener('input', () => {
        const v = Number(react.value)
        if (Number.isFinite(v) && react.value !== '') { pending[`model.emotions.${emo}.reaction`] = v; dirty() }
      })
      table.append(name, sel, react)
    }
    // 反查：哪些表情还没被任何情绪占用（避免"读到了但不知道用没用"）
    const used = new Set(Object.values(emotions).map((v) => v?.expr).filter(Boolean) as string[])
    const unused = options.filter((o) => !used.has(o))
    const reverse = el('div')
    reverse.style.cssText = 'font-size:11px;color:var(--cfg-fg-dim);white-space:pre-wrap'
    reverse.textContent = options.length
      ? `已用 ${used.size}/${options.length} 个表情。未被任何情绪使用的：${unused.join(', ') || '（无）'}`
      : '尚未读取模型表情，点上方「从模型读取表情」'
    wrap.append(table, reverse)
    return wrap
  }

  // ── 其余分区：按 path 前缀自动归组 ──
  const groupOf = (path: string): Tab => {
    if (path === 'model' || path.startsWith('model.')) return '模型'
    if (/^(tts|gsv|venvPy|refAudio|refPrompt|persona)/.test(path)) return '声音'
    if (/^(maxSentence|detailMaxChars|summary|reframe)/.test(path)) return '播报'
    return '高级'
  }

  const genericSection = (tab: Tab): HTMLElement => {
    const wrap = el('div')
    wrap.style.cssText = 'display:flex;flex-direction:column;gap:12px'
    for (const f of fields) {
      if (groupOf(f.path) !== tab) continue
      wrap.append(fieldControl(f))
    }
    if (!wrap.childElementCount) wrap.append(el('span', '', '（本区无配置项）'))
    return wrap
  }

  const renderTab = (): void => {
    tabBar.replaceChildren()
    for (const t of TABS) {
      const b = el('button', '', t)
      b.style.cssText = 'all:unset;cursor:pointer;padding:6px 14px;border-radius:6px 6px 0 0;' +
        (t === currentTab ? 'background:var(--cfg-tab-on);color:var(--cfg-fg)' : 'color:var(--cfg-fg-dim)')
      b.addEventListener('click', () => { currentTab = t; renderTab() })
      tabBar.append(b)
    }
    body.replaceChildren(currentTab === '模型' ? modelSection() : genericSection(currentTab))
  }

  // ── 体型滑杆（预览） ──
  const slider = (label: string, min: number, max: number, step: number, onInput: (v: number) => void) => {
    const w = el('label')
    w.style.cssText = 'display:flex;align-items:center;gap:8px;flex:1;min-width:200px'
    const n = el('span', '', label)
    n.style.cssText = 'color:var(--cfg-fg-dim);white-space:nowrap'
    const inp = el('input')
    inp.type = 'range'
    inp.min = String(min); inp.max = String(max); inp.step = String(step)
    inp.style.cssText = 'flex:1;accent-color:var(--cfg-accent-2)'
    const val = el('span', '')
    val.style.cssText = 'width:52px;text-align:right;color:var(--cfg-fg-strong);font-variant-numeric:tabular-nums'
    inp.addEventListener('input', () => { const v = Number(inp.value); val.textContent = v.toFixed(2) + '×'; onInput(v) })
    w.append(n, inp, val)
    return { w, inp, val }
  }

  const wApi = window as unknown as {
    __noriPetWidget?: {
      getScale?: () => number; setScale?: (f: number) => void
      getFigure?: () => { girl: number; chibi: number }; setFigure?: (k: 'girl' | 'chibi', v: number) => void
    }
  }
  const scaleS = slider('体型', MIN_SCALE, MAX_SCALE, 0.05, (v) => wApi.__noriPetWidget?.setScale?.(v))
  const girlS = slider('少女', 0, 1, 0.05, (v) => {
    wApi.__noriPetWidget?.setFigure?.('girl', v)
    try { localStorage.setItem('nori-figure-girl', String(v)) } catch { /* 存不了不影响预览 */ }
  })
  const chibiS = slider('Q版', 0, 1, 0.05, (v) => {
    wApi.__noriPetWidget?.setFigure?.('chibi', v)
    try { localStorage.setItem('nori-figure-chibi', String(v)) } catch { /* 同上 */ }
  })
  quick.append(scaleS.w, girlS.w, chibiS.w)

  window.addEventListener('nori-scale', (e) => {
    const v = Number((e as CustomEvent).detail)
    if (!Number.isFinite(v)) return
    scaleS.inp.value = String(v)
    scaleS.val.textContent = v.toFixed(2) + '×'
  })

  // ── 读取 / 保存 ──
  const load = async (): Promise<void> => {
    status.textContent = '读取中…'
    try {
      const [cfgRes, schemaRes] = await Promise.all([fetch(`${prefix}/api/config`), fetch(`${prefix}/api/config/schema`)])
      snapshot = (await cfgRes.json()) as Snapshot
      fields = ((await schemaRes.json()) as { fields: Field[] }).fields
      fileHint.textContent = snapshot.file
      pending = {}
      dirtyFlag = false
      const scale = wApi.__noriPetWidget?.getScale?.() ?? (typeof snapshot.config.scale === 'number' ? snapshot.config.scale : 1)
      const fig = wApi.__noriPetWidget?.getFigure?.() ?? { girl: 0, chibi: 0 }
      initView = { scale, girl: fig.girl, chibi: fig.chibi }
      scaleS.inp.value = String(scale); scaleS.val.textContent = scale.toFixed(2) + '×'
      girlS.inp.value = String(fig.girl); girlS.val.textContent = fig.girl.toFixed(2) + '×'
      chibiS.inp.value = String(fig.chibi); chibiS.val.textContent = fig.chibi.toFixed(2) + '×'
      renderTab()
      renderFoot()
      status.textContent = ''
    } catch (err) {
      status.textContent = '读取失败：' + String(err)
    }
  }

  const close = (): void => { root.style.display = 'none' }
  const open = (): void => { root.style.display = 'block'; void load() }

  closeBtn.addEventListener('click', () => close())
  root.addEventListener('click', (e) => { if (e.target === root) close() })
  document.addEventListener('keydown', (e) => { if (e.key === 'Escape' && root.style.display === 'block') close() })

  cancelBtn.addEventListener('click', () => {
    if (dirtyFlag && !confirm('丢弃未保存的改动？')) return
    // 预览即时生效过，取消必须回档
    wApi.__noriPetWidget?.setScale?.(initView.scale)
    wApi.__noriPetWidget?.setFigure?.('girl', initView.girl)
    wApi.__noriPetWidget?.setFigure?.('chibi', initView.chibi)
    close()
  })

  resetBtn.addEventListener('click', () => {
    if (!confirm('把体型恢复默认？')) return
    scaleS.inp.value = '1'; scaleS.inp.dispatchEvent(new Event('input'))
    girlS.inp.value = '0'; girlS.inp.dispatchEvent(new Event('input'))
    chibiS.inp.value = '0'; chibiS.inp.dispatchEvent(new Event('input'))
  })

  saveBtn.addEventListener('click', async () => {
    status.textContent = '保存中…'
    try {
      const r = await fetch(`${prefix}/api/config`, {
        method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(nest(pending)),
      })
      const j = (await r.json()) as { ok: boolean; errors?: string[] }
      if (!j.ok) { status.textContent = '✕ ' + (j.errors ?? []).join('；'); return }
      await load()
      status.textContent = '✓ 已生效'
    } catch (err) { status.textContent = '保存失败：' + String(err) }
  })

  // ── 拖动（标题栏） ──
  const POS_KEY = 'nori-cfg-pos'
  const applyPos = (left: number, top: number): void => {
    panel.style.transform = 'none'
    panel.style.left = Math.max(0, Math.min(window.innerWidth - 160, left)) + 'px'
    panel.style.top = Math.max(0, Math.min(window.innerHeight - 60, top)) + 'px'
  }
  try {
    const saved = JSON.parse(localStorage.getItem(POS_KEY) ?? 'null') as { left?: number; top?: number } | null
    if (saved && typeof saved.left === 'number' && typeof saved.top === 'number') applyPos(saved.left, saved.top)
  } catch { /* 位置读不出来就保持居中 */ }
  let dragging = false
  let dx = 0
  let dy = 0
  head.addEventListener('pointerdown', (e) => {
    if ((e.target as HTMLElement).tagName === 'BUTTON') return
    dragging = true
    const r = panel.getBoundingClientRect()
    dx = e.clientX - r.left
    dy = e.clientY - r.top
    head.setPointerCapture(e.pointerId)
  })
  head.addEventListener('pointermove', (e) => { if (dragging) applyPos(e.clientX - dx, e.clientY - dy) })
  head.addEventListener('pointerup', () => {
    if (!dragging) return
    dragging = false
    try { localStorage.setItem(POS_KEY, JSON.stringify({ left: panel.offsetLeft, top: panel.offsetTop })) } catch { /* 存不了不影响功能 */ }
  })

  return { open, close, toggle: () => (root.style.display === 'block' ? close() : open()) }
}
