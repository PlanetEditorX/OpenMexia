/**
 * 锁屏联动：锁屏 / 解锁 / 启动时，按配置控制一组设备（以及自动化）。
 *
 * 典型配置（也是默认语义）：**解锁 → 开灯，锁屏 → 关灯**。用户带着电脑
 * 离开时锁屏即关灯，回来解锁即亮灯，无需任何手动操作。
 *
 * 目标是一组而不是一台：每个目标各自持有三个方向的状态，所以一条事件可以
 * 同时做多件事，例如：
 *
 *     解锁 → 打开台灯、停用「无人自动关灯」
 *     锁屏 → 关闭台灯、启用「无人自动关灯」
 *
 * 目标分两类：
 *   - `device`：开 / 关（provider.setPower，严格模式见 applyPower）
 *   - `automation`：启用 / 停用（米家自动化，需要 AutomationController；
 *     未注入时这类目标会被跳过并记日志——OpenMexia 目前还没有场景 API）
 *
 * 第三个方向「**启动时**」（默认不操作）：应用随系统自启动后主动执行一次，
 * 用来覆盖「开机时灯是灭的」这种冷启动场景——此时既没有解锁事件（本来就
 * 没锁），也没有人手动触发。由主进程在设备源就绪后显式调用 runStartup()。
 *
 * 执行链：
 *   - 状态变化只提交一个异步任务，不占界面线程；
 *   - 一个批次内的多个目标**串行执行、单个失败不影响其余**，最后统一回传：
 *     成功的发 `applied` 给界面同步卡片，失败的汇总成一条 `failed` 说明；
 *   - 防抖与守卫：`pending` 单飞行标志（解锁后 2 秒内又锁屏只执行最后一次，
 *     不会把队列塞满，米家云端对高频写入会限流）、未登录静默跳过、配置关闭
 *     或该方向全部为「不操作」时直接跳过；
 *   - 生效时间段 / 生效网络在任务内判定：网络查询是同步子进程（最长 5s），
 *     放这里不会冻结界面；条件不满足发 `skipped` 说明原因，不消耗任何控制；
 *   - 「启动时」动作带重试：随系统自启时 Wi-Fi 常未连上、令牌还在刷新，
 *     第一次几乎必然落空（见 STARTUP_RETRY_MS）。
 */
import { EventEmitter } from 'events';
import type { Device, LockConfig, LockTarget } from '../shared/types';
import type { Provider } from '../shared/ipc';
import {
  currentNetworkNames, inTimeWindow, isSupported as networkQuerySupported, matchNetwork,
} from './lock-conditions';
import { LOCK_MAX_TARGETS } from './lock-config';

/** 「启动时」动作的重试节奏。开机自启的真实情况是：进程先起来了，Wi-Fi 还没
 *  连上、米家令牌还在刷新，第一枪大概率落空。只打一枪等于「开机开灯」这个
 *  需求根本不会生效，所以按 20 秒一轮重试，9 轮约 3 分钟——足够覆盖开机后
 *  网络就绪的窗口，又不会无限重试。 */
const STARTUP_RETRY_MS = 20_000;
const STARTUP_MAX_TRIES = 9;

export type LockEvent = 'startup' | 'unlock' | 'lock';

/** 一批成功项：[{ kind, id, name, on }]，供界面合成一条提示 */
export interface LockAppliedItem {
  kind: LockTarget['kind'];
  id: string;
  name: string;
  on: boolean;
}

/** 自动化控制能力：OpenMexia 当前没有场景 API，主进程可注入实现以启用 */
export interface AutomationController {
  setEnabled(target: LockTarget, enable: boolean): Promise<void>;
}

export interface LockAutomationDeps {
  /** 读当前配置（每次事件都读，保证设置保存后立即生效） */
  getConfig: () => LockConfig;
  /** 当前设备源；未就绪返回 null */
  getProvider: () => Provider | null;
  /** 是否已登录（有可用云端会话）。未登录时控制必然失败，直接跳过更安静 */
  isLoggedIn: () => Promise<boolean>;
  /** 可选的自动化控制实现 */
  automation?: AutomationController;
  /** 日志出口（默认 console） */
  log?: (msg: string, ...rest: unknown[]) => void;
}

/** 目标显示名：优先用配置里存的名称，缺失时退化成 id 尾号。 */
function targetName(target: LockTarget): string {
  const name = String(target.name ?? '').trim();
  if (name) return name;
  const id = String(target.id ?? '');
  return id.length > 6 ? `…${id.slice(-6)}` : (id || '未命名目标');
}

export declare interface LockAutomation {
  on(event: 'applied', listener: (items: LockAppliedItem[]) => void): this;
  on(event: 'failed' | 'skipped', listener: (message: string) => void): this;
  emit(event: 'applied', items: LockAppliedItem[]): boolean;
  emit(event: 'failed' | 'skipped', message: string): boolean;
}

export class LockAutomation extends EventEmitter {
  private readonly deps: LockAutomationDeps;
  private readonly log: (msg: string, ...rest: unknown[]) => void;
  /** 单飞行：一次控制批次在途时忽略后续事件（下一次状态变化再执行） */
  private pending = false;
  /** 「启动时」已重试次数（每次 runStartup 重置） */
  private startupTries = 0;
  private retryTimer: NodeJS.Timeout | null = null;

  constructor(deps: LockAutomationDeps) {
    super();
    this.deps = deps;
    this.log = deps.log ?? ((msg, ...rest) => console.log(msg, ...rest));
  }

  /** 设置保存后不需要额外动作：每次事件都会重新读配置 */
  reloadConfig(): void { /* 配置即时生效，保留此方法以便调用方语义清晰 */ }

  /* ---------------- 事件入口 ---------------- */

  /** 锁屏事件 */
  handleLock(): void {
    this.run('lock');
  }

  /** 解锁事件 */
  handleUnlock(): void {
    this.run('unlock');
  }

  /**
   * 应用启动（设备源就绪）时按配置执行一次动作。
   *
   * 与锁屏 / 解锁不同，这条路径的触发时机是被动的：随系统自启动时网络往往
   * 还没就绪，所以落空后按 STARTUP_RETRY_MS 继续重试，最多 STARTUP_MAX_TRIES
   * 轮。配置被关掉（或该方向全为「不操作」）时不会重试。
   */
  runStartup(): void {
    const cfg = this.deps.getConfig();
    if (!cfg.enabled) return;
    const entries = this.entries('startup', cfg);
    if (!entries.length) return;
    this.startupTries = 0;
    void this.dispatch(entries, '启动', true);
  }

  /** 退出前清理待重试的定时器 */
  dispose(): void {
    if (this.retryTimer) { clearTimeout(this.retryTimer); this.retryTimer = null; }
  }

  private run(event: LockEvent): void {
    const cfg = this.deps.getConfig();
    if (!cfg.enabled) return;
    const entries = this.entries(event, cfg);
    if (!entries.length) return;
    void this.dispatch(entries, event === 'lock' ? '锁屏' : '解锁', false);
  }

  /**
   * 取出该事件真正要执行的目标：[[target, turnOn]]。
   *
   * 「不操作」的目标在提交任务前就过滤掉——空批次连任务都不该提交，否则每次
   * 锁屏都白占一个队列位置。自动化目标在缺少 AutomationController 时也一并
   * 过滤（记一次日志），不让它变成一条假的「执行失败」。
   */
  private entries(event: LockEvent, cfg: LockConfig): Array<[LockTarget, boolean]> {
    let targets = cfg.targets;
    if (targets.length > LOCK_MAX_TARGETS) {
      this.log(`[lock] 联动目标过多（${targets.length} 个），只执行前 ${LOCK_MAX_TARGETS} 个`);
      targets = targets.slice(0, LOCK_MAX_TARGETS);
    }
    const out: Array<[LockTarget, boolean]> = [];
    let skippedAutomation = 0;
    for (const target of targets) {
      const action = target[event];
      if (action !== 'on' && action !== 'off') continue;
      if (target.kind === 'automation' && !this.deps.automation) { skippedAutomation++; continue; }
      out.push([target, action === 'on']);
    }
    if (skippedAutomation) {
      this.log(`[lock] 跳过 ${skippedAutomation} 个自动化目标：主进程未注入自动化控制能力`);
    }
    return out;
  }

  /* ---------------- 执行 ---------------- */

  /**
   * 执行一批目标；label 只用于日志文案。
   *
   * retry=true 表示这是「启动时」路径：服务未就绪不报错而是排重试；失败也
   * 不弹提示，交由重试兜到成功为止。
   */
  private async dispatch(
    entries: Array<[LockTarget, boolean]>, label: string, retry: boolean,
  ): Promise<void> {
    if (this.pending) {
      this.log(`[lock] 控制在途，跳过本次${label}事件`);
      if (retry) {
        // 开机瞬间可能正好撞上一条在途控制：不能把这一枪算作已尝试，
        // 否则竞争会把重试预算白白耗光
        this.scheduleRetry(STARTUP_RETRY_MS, false);
      }
      return;
    }
    this.log(`[lock] ${label} → ` + entries
      .map(([t, on]) => {
        if (t.kind === 'automation') return `${on ? '启用' : '停用'}「${targetName(t)}」`;
        return `${on ? '打开' : '关闭'}「${targetName(t)}」`;
      }).join('、'));
    this.pending = true;
    try {
      const cfg = this.deps.getConfig();
      const gate = await this.gate(cfg, retry);
      if (gate.retry) { this.scheduleRetry(STARTUP_RETRY_MS, true); return; }
      if (gate.silent) { this.log('[lock] 未登录，跳过本次联动'); return; }
      if (gate.skip) {
        this.log(`[lock] 跳过：${gate.skip}`);
        this.emit('skipped', gate.skip);
        return;
      }
      const done: Array<[LockTarget, boolean]> = [];
      const errors: Array<[LockTarget, string]> = [];
      for (const [target, on] of entries) {
        try {
          await this.applyTarget(target, on);
          done.push([target, on]);
        } catch (e: any) {
          // 单项失败不拖累整批
          const reason = (e && e.message) || String(e) || '未知错误';
          this.log(`[lock] 目标失败 ${target.kind}/${target.id}: ${reason}`);
          errors.push([target, reason]);
        }
      }
      if (done.length) {
        this.emit('applied', done.map(([t, on]) => ({
          kind: t.kind, id: t.id, name: targetName(t), on,
        })));
      }
      if (errors.length) this.emit('failed', failureText(errors));
    } catch (e: any) {
      const msg = (e && e.message) || String(e);
      this.log(`[lock] 执行失败: ${msg}`);
      if (retry) { this.scheduleRetry(STARTUP_RETRY_MS, true); return; }
      this.emit('failed', msg);
    } finally {
      this.pending = false;
    }
  }

  /**
   * 条件门。
   *
   *   放行      → {};
   *   跳过      → { skip: 原因文案 }（界面提示用）；
   *   静默跳过  → { silent: true }（未登录的锁屏 / 解锁：控制必然失败，
   *              安静跳过比每次弹提示更合适）；
   *   待重试    → { retry: true }（仅启动方向：服务未就绪不是错误）。
   */
  private async gate(
    cfg: LockConfig, allowRetry: boolean,
  ): Promise<{ retry?: boolean; skip?: string; silent?: boolean }> {
    if (cfg.timeEnabled && !inTimeWindow(cfg.timeStart, cfg.timeEnd)) {
      return { skip: `不在生效时段（${cfg.timeStart}–${cfg.timeEnd}）` };
    }
    if (cfg.netEnabled && cfg.netNames.length) {
      if (!networkQuerySupported()) {
        // 网络名查询只有 Windows 有（PowerShell）。其它平台上不把这条约束
        // 当成不满足——否则用户开了这个开关就再也联动不了，且完全无声。
        this.log('[lock] 当前平台不支持网络名判定，忽略「生效网络」条件');
      } else {
        const names = await currentNetworkNames();
        if (!matchNetwork(names, cfg.netNames)) {
          return {
            skip: names && names.length
              ? `当前网络（${names[0]}）不在生效网络列表`
              : '当前网络不可知，生效网络条件未满足',
          };
        }
      }
    }
    // 未登录时凭据无效，控制必然失败。锁屏 / 解锁方向静默跳过更安静；
    // 启动方向则要重试——开机早期网络 / 令牌未就绪是常态，不是错误
    let loggedIn = false;
    try {
      loggedIn = await this.deps.isLoggedIn();
    } catch {
      loggedIn = false;
    }
    if (!loggedIn) return allowRetry ? { retry: true } : { silent: true };
    return {};
  }

  /** 把单个目标写成目标状态；失败抛出异常由调用方收集。 */
  private async applyTarget(target: LockTarget, on: boolean): Promise<void> {
    if (target.kind === 'automation') {
      if (!this.deps.automation) throw new Error('当前版本不支持启停米家自动化');
      await this.deps.automation.setEnabled(target, on);
      return;
    }
    const provider = this.deps.getProvider();
    if (!provider) throw new Error('设备源尚未就绪');
    const devices: Device[] = provider.snapshot();
    const dev = devices.find((d) => String(d.id) === target.id);
    if (!dev) throw new Error('设备不在当前家庭或已被移除');
    if (typeof provider.applyPower === 'function') {
      // 严格模式：把「设备离线 / 不支持开关 / 云端拒绝」变成可上报的错误
      await provider.applyPower(target.id, on);
    } else {
      provider.setPower(target.id, on);
    }
  }

  /* ---------------- 启动方向的重试 ---------------- */

  /** 排下一轮启动重试；预算耗尽后发一次 skipped 说明并放弃。 */
  private scheduleRetry(delay: number, count: boolean): void {
    if (this.retryTimer) { clearTimeout(this.retryTimer); this.retryTimer = null; }
    if (count) {
      if (this.startupTries >= STARTUP_MAX_TRIES) {
        this.log(`[lock] 启动联动重试 ${this.startupTries} 轮仍未成功，放弃`);
        this.emit('skipped',
          `启动联动未生效：${STARTUP_MAX_TRIES} 轮重试内网络或登录状态未就绪`);
        return;
      }
      this.startupTries += 1;
      this.log(`[lock] 启动联动将在 ${Math.round(delay / 1000)} 秒后重试`
        + `（第 ${this.startupTries}/${STARTUP_MAX_TRIES} 轮）`);
    }
    this.retryTimer = setTimeout(() => {
      this.retryTimer = null;
      this.retryStartup();
    }, delay);
    this.retryTimer.unref?.();
  }

  /** 到点重试一次启动动作；配置已被改动（关掉 / 目标清空）则放弃。 */
  private retryStartup(): void {
    const cfg = this.deps.getConfig();
    if (!cfg.enabled) { this.log('[lock] 启动联动配置已变更，停止重试'); return; }
    const entries = this.entries('startup', cfg);
    if (!entries.length) { this.log('[lock] 启动联动配置已变更，停止重试'); return; }
    void this.dispatch(entries, '启动', true);
  }
}

/**
 * 把失败目标汇总成一句用户能看懂的话。
 *
 * 单个失败说清是谁 + 原因；多个失败只列名字与首条原因——米家同一次网络故障
 * 会让每个目标报同一句话，重复 5 遍没人看。
 */
function failureText(errors: Array<[LockTarget, string]>): string {
  const names = errors.map(([t]) => `「${targetName(t)}」`).join('、');
  const reason = errors[0][1];
  if (errors.length === 1) return `${names}未成功：${reason}`;
  return `${errors.length} 个目标未成功：${names}（${reason}）`;
}
