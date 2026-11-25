/**
 * 锁屏联动的配置：默认值 + 收敛（normalize）。
 *
 * 配置落在主进程的 widget-state.json（键 `lockAutomation`）里，与窗口位置、
 * 主题等偏好同文件——它天然属于「本机偏好」，且只在主进程读写（锁屏事件
 * 由主进程接收），不经过渲染层本地存储。
 *
 * 收敛的意义：界面传上来的、磁盘上历史遗留的、用户手改 JSON 写坏的，都要
 * 被涂抹成结构合法的一份。执行链（lock-automation）因此可以无防御地直接
 * 读字段，不必在每个分支里判断 undefined。
 *
 * 目标结构：一条事件可以对多个目标各自指定动作，所以每个目标自带三个方向：
 *
 *     { kind: 'device' | 'automation', id, name, homeId,
 *       startup: 'on'|'off'|'none', unlock: ..., lock: ... }
 *
 * 字段名用 camelCase（与 TS 侧一致），但同时接受 Python 版留下的 snake_case
 * （time_enabled / net_names / home_id），保证从 MiHome-Windows 迁配置不用改。
 */
import type { LockAction, LockConfig, LockTarget, LockTargetKind } from '../shared/types';
import { formatHhmm, parseNetworkText } from './lock-conditions';

export const LOCK_KINDS: readonly LockTargetKind[] = ['device', 'automation'];
export const LOCK_EVENTS = ['startup', 'unlock', 'lock'] as const;
const LOCK_ACTIONS: readonly LockAction[] = ['on', 'off', 'none'];

/** 新目标默认沿用最经典的用法：解锁打开、锁屏关闭、启动时不操作。 */
export const LOCK_TARGET_DEFAULT_ACTIONS: Record<(typeof LOCK_EVENTS)[number], LockAction> = {
  startup: 'none',
  unlock: 'on',
  lock: 'off',
};

export const LOCK_DEFAULTS: LockConfig = {
  enabled: false,
  targets: [],
  timeEnabled: false,
  timeStart: '08:00',
  timeEnd: '23:00',
  netEnabled: false,
  netNames: [],
};

/** 一个批次里最多处理多少个目标：用户手滑配了几十条时，锁屏瞬间会连续打
 *  几十个云端写请求，既慢又容易触发米家限流。超出的截断（执行时再截一次）。 */
export const LOCK_MAX_TARGETS = 20;

function pick(raw: any, camel: string, snake: string): any {
  if (raw && raw[camel] !== undefined) return raw[camel];
  if (raw && raw[snake] !== undefined) return raw[snake];
  return undefined;
}

function normAction(value: unknown, fallback: LockAction): LockAction {
  return LOCK_ACTIONS.includes(value as LockAction) ? (value as LockAction) : fallback;
}

/** 单个联动目标收敛；无法识别时返回 null（整条丢弃）。 */
export function normalizeLockTarget(raw: any): LockTarget | null {
  if (!raw || typeof raw !== 'object') return null;
  let kind = String(raw.kind ?? '').trim().toLowerCase() as LockTargetKind;
  if (!LOCK_KINDS.includes(kind)) {
    // 更早的结构只有 did，没有 kind
    kind = typeof raw.did === 'string' ? 'device' : ('' as LockTargetKind);
  }
  if (!LOCK_KINDS.includes(kind)) return null;
  let id = raw.id;
  if (typeof id !== 'string') id = typeof raw.did === 'string' ? raw.did : '';
  id = id.trim();
  if (!id) return null;
  const name = String(raw.name ?? '').trim().slice(0, 64);
  // 三个方向：字段缺失 → 取该方向的默认动作（新目标即「解锁开、锁屏关」）；
  // 字段存在但值非法 → 一律 none（该方向不动作），不要偷偷换成别的动作
  const actionFor = (event: 'startup' | 'unlock' | 'lock'): LockAction => {
    const value = pick(raw, event, `${event}_action`);
    if (value === undefined) return LOCK_TARGET_DEFAULT_ACTIONS[event];
    return normAction(value, 'none');
  };
  const target: LockTarget = {
    kind,
    id,
    name,
    // homeId 只有自动化用得上（拨开关的请求要带家庭），设备留空
    homeId: kind === 'automation'
      ? String(pick(raw, 'homeId', 'home_id') ?? '').trim()
      : '',
    startup: actionFor('startup'),
    unlock: actionFor('unlock'),
    lock: actionFor('lock'),
  };
  return target;
}

/** 目标列表收敛 + 去重（同 kind 同 id 只保留第一条）。 */
export function normalizeLockTargets(raw: any): LockTarget[] {
  const items = raw && Array.isArray(raw.targets) ? raw.targets : [];
  const targets: LockTarget[] = [];
  const seen = new Set<string>();
  for (const item of items) {
    const target = normalizeLockTarget(item);
    if (!target) continue;
    const key = `${target.kind}:${target.id}`;
    if (seen.has(key)) continue;
    seen.add(key);
    targets.push(target);
  }
  return targets;
}

function normNetNames(value: unknown): string[] {
  if (Array.isArray(value)) {
    const out: string[] = [];
    for (const item of value) {
      if (typeof item !== 'string') continue;
      const name = item.trim();
      if (name && !out.includes(name)) out.push(name);
    }
    return out;
  }
  // 界面可能直接传一段逗号分隔的文本
  return typeof value === 'string' ? parseNetworkText(value) : [];
}

/** 把磁盘 / 界面传入的配置收敛成合法结构；非法字段回落默认值。 */
export function normalizeLockConfig(raw: any): LockConfig {
  const src = raw && typeof raw === 'object' ? raw : {};
  return {
    enabled: src.enabled === true,
    targets: normalizeLockTargets(src),
    timeEnabled: pick(src, 'timeEnabled', 'time_enabled') === true,
    timeStart: formatHhmm(pick(src, 'timeStart', 'time_start') ?? LOCK_DEFAULTS.timeStart),
    timeEnd: formatHhmm(pick(src, 'timeEnd', 'time_end') ?? LOCK_DEFAULTS.timeEnd),
    netEnabled: pick(src, 'netEnabled', 'net_enabled') === true,
    netNames: normNetNames(pick(src, 'netNames', 'net_names')),
  };
}
