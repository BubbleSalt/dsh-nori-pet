// 家目录形态正则：Windows 盘位（反斜杠与正斜杠两种写法）、macOS/Linux 家目录前缀。
// 刻意分片拼接：源码文本内不存在可被自身匹配的连续字面量（守卫自扫防误报）；
// 拼接结果与等价的原始正则字面量行为一致（由仓库外临时自检脚本验证）。
export function buildHomePath() {
  return new RegExp(
    '[A-Za-z]:' + '\\\\' + 'Users(' + '\\\\' + '|$)' +
    '|[A-Za-z]:/' + 'Users(' + '/|$)' +
    '|(/' + 'Users/' + '|/' + 'home/' + ')',
    'i'
  )
}