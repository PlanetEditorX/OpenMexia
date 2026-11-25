/**
 * 锁屏联动的生效条件：生效时间段 + 生效网络。
 *
 * 两个维度都是「锦上添花」的约束，默认关闭；开启后锁屏 / 解锁事件要先过
 * 条件门才真正驱动设备：
 *
 *   - 生效时间：只在每天的某个时段内响应。支持跨午夜窗口（如 23:00–06:00，
 *     夜间锁屏不关灯、清晨解锁不开灯这类需求）。
 *   - 生效网络：只在电脑连接到指定网络时响应。典型场景是「只在家里 WiFi 下
 *     联动」——在公司、手机热点下锁屏 / 解锁不动作，避免误触家里的设备。
 *
 * 设计原则（与 MiHome-Windows 的实现保持一致）：
 *   - 时间判断是纯函数（可注入 now），无系统依赖、可单测；
 *   - 网络查询依赖 Windows（PowerShell NetConnectionProfile），查询失败返回
 *     null，由调用方保守处理（未配置名单 = 不限制，查询不到 = 不执行，
 *     宁可不动也不误动）；
 *   - 事件频率极低（每次锁屏 / 解锁各一次），网络查询用一次性子进程即可，
 *     无需常驻监听网络变化。
 */
import { execFile } from 'child_process';

/** 生效网络查询的子进程超时（毫秒）。PowerShell 冷启动通常 1 秒内，
 *  卡死时最多阻塞一次锁屏事件，不会拖垮整条联动链。 */
const NET_QUERY_TIMEOUT = 5000;

const HHMM_RE = /^\s*(\d{1,2}):(\d{1,2})\s*$/;

/** 网络查询仅 Windows 有意义（PowerShell 的 Get-NetConnectionProfile）。 */
export function isSupported(): boolean {
  return process.platform === 'win32';
}

/** 解析 "HH:MM"（宽松接受 "H:MM"），非法返回 null。 */
export function parseHhmm(text: unknown): [number, number] | null {
  const m = HHMM_RE.exec(String(text ?? ''));
  if (!m) return null;
  const hour = Number(m[1]);
  const minute = Number(m[2]);
  if (hour < 0 || hour > 23 || minute < 0 || minute > 59) return null;
  return [hour, minute];
}

/** 把 "HH:MM" 规格化成两位补零形式；非法回落 "08:00"。 */
export function formatHhmm(value: unknown): string {
  const parsed = parseHhmm(value);
  if (!parsed) return '08:00';
  return `${pad2(parsed[0])}:${pad2(parsed[1])}`;
}

function pad2(n: number): string {
  return n < 10 ? `0${n}` : String(n);
}

/**
 * 判断 now 是否落在 [start, end) 每日时段内。
 *
 *   - start === end：视为 24 小时全天（= 关闭该约束的等价语义）；
 *   - start <  end：普通窗口，如 08:00–23:00；
 *   - start >  end：跨午夜窗口，如 23:00–06:00；
 *   - 任一端非法：视为不限制（返回 true）——配置在 lock-config 层已收敛，
 *     这里只是防御。
 *
 * 边界取左闭右开：end 时刻整已不在窗口内。
 */
export function inTimeWindow(start: unknown, end: unknown, now: Date = new Date()): boolean {
  const s = parseHhmm(start);
  const e = parseHhmm(end);
  if (!s || !e) return true;
  const t = now.getHours() * 60 + now.getMinutes();
  const smin = s[0] * 60 + s[1];
  const emin = e[0] * 60 + e[1];
  if (smin === emin) return true;
  if (smin < emin) return smin <= t && t < emin;
  // 跨午夜：晚于起点或早于终点
  return t >= smin || t < emin;
}

/**
 * 当前已连接的网络名称列表（WiFi 下通常即 SSID）。
 *
 * null = 无法判断（非 Windows / 查询失败 / 超时），调用方应保守处理。
 * 不会返回空数组——PowerShell 无输出时同样返回 null。
 */
export function currentNetworkNames(): Promise<string[] | null> {
  if (!isSupported()) return Promise.resolve(null);
  return new Promise((resolve) => {
    execFile(
      'powershell',
      ['-NoProfile', '-NonInteractive', '-Command',
        'Get-NetConnectionProfile | ForEach-Object { $_.Name }'],
      { timeout: NET_QUERY_TIMEOUT, windowsHide: true, encoding: 'utf8' },
      (err, stdout) => {
        if (err) { resolve(null); return; }
        const names = String(stdout || '')
          .split(/\r?\n/)
          .map((line) => line.trim())
          .filter(Boolean);
        resolve(names.length ? names : null);
      },
    );
  });
}

/**
 * 当前网络是否命中用户配置的生效网络名单。
 *
 *   - wanted 为空 / 未配置：不限制，返回 true；
 *   - names 为 null（查询失败）或空（未连接）：保守返回 false；
 *   - 匹配语义：大小写不敏感的「包含」（名单写 "CMCC" 可命中 "CMCC-8f3a"，
 *     写全名即全等）。
 */
export function matchNetwork(names: string[] | null, wanted: unknown): boolean {
  const list = Array.isArray(wanted)
    ? wanted.map((w) => String(w ?? '').trim()).filter(Boolean)
    : [];
  if (!list.length) return true;
  if (!names || !names.length) return false;
  const current = names.map((n) => n.toLowerCase());
  return list.some((w) => {
    const wl = w.toLowerCase();
    return current.some((c) => c.includes(wl));
  });
}

/** 把设置界面的网络名输入（逗号 / 分号 / 换行分隔）解析成去重名单。 */
export function parseNetworkText(text: unknown): string[] {
  const parts = String(text ?? '').split(/[,;，；\n]/);
  const seen: string[] = [];
  for (const part of parts) {
    const name = part.trim();
    if (name && !seen.includes(name)) seen.push(name);
  }
  return seen;
}
