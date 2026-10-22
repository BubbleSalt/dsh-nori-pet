/**
 * 小工具：跨模块重复出现的三种惯用法，各自只留一份。
 *
 * 从 index.ts/widget.ts 收敛而来（原先散落 8~11 处）：
 *  · `errMsg`        —— `String(e?.message ?? e)` 抄了 5 遍，漏了 `as Error` 还会让 TS 报错；
 *  · `evictOldest`   —— "有界 Map/Set，超 N 就删最旧 key" 手写了 8 遍，
 *                       每处都要判断 `!== undefined && !== 刚写入的 key`，漏一处就是"刚写进去就被删"；
 *  · `addBounded`    —— 上面那条的 Set 便捷形态；
 *  · `dropByPrefix`  —— turn 回收时"按前缀批量删 Map"抄了 5 遍（且必须先展开 keys 再删）。
 */

/** 错误对象 → 一行可读消息（非 Error 的抛出物原样转字符串） */
export function errMsg(e: unknown): string {
  if (e instanceof Error) return e.message
  return String(e)
}

interface Bounded<K> {
  readonly size: number
  keys(): IterableIterator<K>
  delete(k: K): unknown
}

/**
 * 有界集合：超上限时淘汰**最旧**的 key（Map/Set 的插入顺序即 LRU 近似）。
 * @param skip 刚写入的 key：优先淘汰别人（否则"写入时正好超限"会把自己删掉）；
 *             但没有别人可淘汰时仍以**上限优先**（宁可删 skip，也不留个无界容器）。
 */
export function evictOldest<K>(c: Bounded<K>, max: number, skip?: K): void {
  if (c.size <= max) return
  let fallback: K | undefined
  let hasFallback = false
  for (const k of c.keys()) {
    if (skip !== undefined && k === skip) { fallback = k; hasFallback = true; continue }
    c.delete(k)
    return
  }
  if (hasFallback) c.delete(fallback as K)
}

/** `set.add(k)` + 有界淘汰 */
export function addBounded<K>(s: Set<K>, k: K, max: number): Set<K> {
  s.add(k)
  evictOldest(s, max, k)
  return s
}

/** 按 key 前缀批量删除（Map/Set 通用，返回删除条数）；先快照 keys，避免边迭代边删 */
export function dropByPrefix<K extends string>(
  c: { keys(): IterableIterator<K>; delete(k: K): unknown },
  prefix: string,
): number {
  let n = 0
  for (const k of [...c.keys()]) {
    if (k.startsWith(prefix)) { c.delete(k); n += 1 }
  }
  return n
}


/** djb2 文本指纹（base36）。宿主广播指纹与 widget 重复朗读检测共用一种算法 ——
 *  以前两侧各写一遍同样的 5381 循环，改一处就会让两边的"重复"判定口径不一致。 */
export function hashText(s: string): string {
  let h = 5381
  for (let i = 0; i < s.length; i++) h = ((h << 5) + h + s.charCodeAt(i)) >>> 0
  return h.toString(36)
}