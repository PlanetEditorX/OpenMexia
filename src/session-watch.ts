/**
 * 会话锁屏 / 解锁状态监听（供「锁屏联动」使用）。
 *
 * 与 MiHome-Windows 那份 Python 实现同构，但通道换成了 Electron 原生的：
 *
 * 1. **powerMonitor 会话事件**（主通道，事件驱动、零延迟）
 *    `powerMonitor.on('lock-screen' / 'unlock-screen')` 底层就是 Windows 的
 *    WTS 会话通知（WM_WTSSESSION_CHANGE 的 WTS_SESSION_LOCK / UNLOCK），
 *    由 Chromium 的浏览器进程替我们注册，无需自己建隐藏窗口、写原生事件
 *    过滤器——比 Python 版那套 ctypes + QAbstractNativeEventFilter 干净得多。
 *
 * 2. **LogonUI 轮询**（兜底通道，仅 Windows）
 *    锁屏界面由 LogonUI.exe 承载，用 `tasklist` 查一下进程在不在即可判定。
 *    存在的意义：休眠唤醒后会话通知可能丢失，以及个别远程 / 多会话场景下
 *    事件通道不投递——这时轮询能把状态补回来。
 *
 *    轮询间隔取 10 秒而不是 Python 版的 2 秒：那边是进程内 Toolhelp 快照
 *    （<1ms），这边每次都要起一个 tasklist 子进程（约 20–40ms），2 秒一次
 *    的常驻开销没有必要。锁屏联动不是安全联锁，十秒级延迟用户无感。
 *
 * 3. **resume 后立刻补判一次**：睡眠期间的状态变化是最容易丢的，唤醒时
 *    主动探一次，不用等轮询到点。
 *
 * 两路都汇入同一个状态机 `setLocked`：只有状态**发生变化**才发事件，重复
 * 通知天然去重；初始启动只取基线不发射，避免「启动时正好锁屏」被当成一次
 * 解锁事件。
 */
import { EventEmitter } from 'events';
import { execFile } from 'child_process';
import { powerMonitor } from 'electron';

/** 兜底轮询间隔（毫秒）。见文件头：比 Python 版的 2s 放宽，代价是子进程。 */
const POLL_INTERVAL_MS = 10_000;

/** tasklist 查询超时（毫秒）：卡死时最多延迟一次轮询。 */
const TASKLIST_TIMEOUT_MS = 4000;

/** 锁屏界面进程名 */
const LOGON_UI = 'LogonUI.exe';

/**
 * 枚举进程判断锁屏界面是否在场（仅 Windows 有意义）。
 *
 * true = 锁屏中；false = 已解锁；null = 判定失败（调用方应保持原状态）。
 * 用 tasklist 而不是 Node 的进程列表：Node 没有原生「列所有进程名」的
 * 接口，而 tasklist 是系统自带的、不需要额外依赖。
 */
export function logonUiRunning(): Promise<boolean | null> {
  if (process.platform !== 'win32') return Promise.resolve(null);
  return new Promise((resolve) => {
    execFile(
      'tasklist',
      ['/FI', `IMAGENAME eq ${LOGON_UI}`, '/NH', '/FO', 'CSV'],
      { timeout: TASKLIST_TIMEOUT_MS, windowsHide: true, encoding: 'utf8' },
      (err, stdout) => {
        if (err) { resolve(null); return; }
        const text = String(stdout || '');
        // 命中时输出形如 "LogonUI.exe","1234","Console","1","12,345 K"
        // 未命中时是一句本地化提示（中文系统：「信息: 没有运行的任务…」）
        const running = text.toLowerCase().includes(LOGON_UI.toLowerCase());
        resolve(running);
      },
    );
  });
}

export declare interface SessionWatch {
  on(event: 'lock' | 'unlock', listener: () => void): this;
  emit(event: 'lock' | 'unlock'): boolean;
}

export class SessionWatch extends EventEmitter {
  private locked: boolean | null = null;
  private started = false;
  /** 是否已取过基线：第一次判定的结果只记录不发射 */
  private seeded = false;
  private timer: NodeJS.Timeout | null = null;
  private probing = false;
  private readonly onLockScreen = () => { this.setLocked(true); };
  private readonly onUnlockScreen = () => { this.setLocked(false); };
  private readonly onResume = () => { void this.probe(); };

  /** 当前是否锁屏；null = 尚未取得基线（未启动或探测失败）。 */
  get isLocked(): boolean | null {
    return this.locked;
  }

  /** 取得基线并开始监听。已启动时重复调用无副作用。 */
  start(): void {
    if (this.started) return;
    this.started = true;
    // 基线：只记录不发射，避免启动瞬间「正好锁屏」被当成一次事件
    void this.probe();
    powerMonitor.on('lock-screen', this.onLockScreen);
    powerMonitor.on('unlock-screen', this.onUnlockScreen);
    // 睡眠唤醒后会话通知很可能丢在睡眠里：醒来看一眼真实状态
    powerMonitor.on('resume', this.onResume);
    if (process.platform === 'win32') {
      this.timer = setInterval(() => { void this.probe(); }, POLL_INTERVAL_MS);
      // 常驻计时器不该拖住进程退出
      this.timer.unref?.();
    }
  }

  /** 停止监听并复位状态。 */
  stop(): void {
    if (!this.started) return;
    this.started = false;
    if (this.timer) { clearInterval(this.timer); this.timer = null; }
    try {
      powerMonitor.removeListener('lock-screen', this.onLockScreen);
      powerMonitor.removeListener('unlock-screen', this.onUnlockScreen);
      powerMonitor.removeListener('resume', this.onResume);
    } catch { /* 应用退出途中 powerMonitor 可能已不可用 */ }
    this.locked = null;
    this.seeded = false;
  }

  /** 主动探一次真实状态（启动基线 / 唤醒 / 轮询共用）。 */
  async probe(): Promise<void> {
    if (this.probing) return;      // 上一次 tasklist 还没回来，别叠着起子进程
    this.probing = true;
    try {
      const state = await logonUiRunning();
      if (state === null) return;  // 判定失败：保持原状态，下一轮再试
      this.setLocked(state);
    } finally {
      this.probing = false;
    }
  }

  /** 唯一的状态入口：变化才发事件，重复通知天然去重。 */
  private setLocked(locked: boolean): void {
    // 基线：启动瞬间的真实状态只记录、不发射——「启动时正好锁屏」不该被
    // 当成一次刚发生的锁屏事件（那会让启动瞬间莫名关一次灯）。
    // 事件通道比基线探测先到（极少见）时同样按基线处理。
    if (!this.seeded) {
      this.seeded = true;
      this.locked = locked;
      return;
    }
    if (locked === this.locked) return;
    this.locked = locked;
    this.emit(locked ? 'lock' : 'unlock');
  }
}
