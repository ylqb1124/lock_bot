// server-time.js - 用服务器时间纠正客户端本机时钟偏移
// 客户端系统时钟可能不准，若直接用 `new Date()` 计算“最近 N 天”等查询范围，
// 会导致不同设备算出不同的绝对时间窗口。这里在页面加载时同步一次服务器时间，
// 计算出与本机时间的偏移量，后续用 now() 取“纠偏后的当前时间”。

let offsetMs = 0;

/**
 * 请求服务器时间，计算并缓存与本机时钟的偏移量。
 * 失败时静默保留偏移量为 0（等价于回退到本机时间），不阻塞调用方。
 */
export async function syncServerTimeOffset() {
  const requestStartedAt = Date.now();
  try {
    const resp = await fetch('/api/server-time');
    if (!resp.ok) return;
    const { now: serverNow } = await resp.json();
    if (!Number.isFinite(serverNow)) return;
    const requestEndedAt = Date.now();
    const roundTripMs = requestEndedAt - requestStartedAt;
    offsetMs = serverNow + roundTripMs / 2 - requestEndedAt;
  } catch {
    // 网络异常时保留现有偏移量（默认 0），不影响页面可用性
  }
}

/**
 * 返回纠偏后的当前时间，替代直接使用 `new Date()`
 */
export function now() {
  return new Date(Date.now() + offsetMs);
}

export function currentOffsetMs() {
  return offsetMs;
}
