/**
 * 领域模型契约 —— 主进程 / preload / 渲染层共用的数据结构。
 *
 * 本文件是纯声明（.d.ts）：不参与编译、不改任何运行时行为。
 * 主进程与 preload 的 JS 通过 JSDoc `import('./types').Xxx` 直接消费这些类型；
 * 后续把文件逐个转成 .ts 时，同样可直接 import。
 */

/** 设备品类（由 miot-spec 的 analyze() 按规格推断） */
export type DeviceType =
  | 'sensor'
  | 'plug'
  | 'light'
  | 'fan'
  | 'aircon'
  | 'purifier'
  | 'router'
  | 'gateway'
  | 'other';

/** 规格里的枚举项（滑杆档位等） */
export interface PropertyItem {
  value: number | string;
  description: string;
}

/** 规格解析出的「可读写属性」绑定 */
export interface DeviceProperty {
  siid: number;
  piid: number;
  /** 读写标记，含 'r' / 'w' */
  rw: string;
  range: number[] | null;
  list: PropertyItem[] | null;
}

/** 规格解析出的动作绑定（如风扇手动上下左右） */
export interface DeviceAction {
  siid: number;
  aiid: number;
}

/** 多键开关里的一个附加按键（双开的右键、三开的中键 / 右键等） */
export interface ExtraSwitch {
  /** 合成的读写字端（如 switch2On），复用同一套 siid/piid 读写路径 */
  field: string;
  /** 展示名：右键 / 中键 / 按键 N */
  label: string;
  on: boolean;
}

/** miot-spec.analyze() 的返回结构 */
export interface SpecAnalysis {
  type: DeviceType;
  props: Record<string, DeviceProperty>;
  reads: { siid: number; piid: number }[];
  actions: Record<string, DeviceAction>;
  /** 多键开关的附加按键（单键设备为空数组） */
  switches: { field: string; label: string }[];
}

/** 渲染层使用的设备对象（devices.js 构建，轮询过程中持续更新） */
export interface Device {
  id: string;
  type: DeviceType;
  name: string;
  model: string;
  /** 房间归属（来自云端 gethome / homelist 的 roomlist），供按房间分类展示 */
  roomId: string;
  roomName: string;
  online: boolean;
  on: boolean;
  /**
   * 是否可开关：由 miot-spec 里是否存在 on 属性决定。
   * 设备品类（type）只是按规格猜的近似标签——空调常被推测成 other、摄像机被当成
   * plug——所以「能不能开/关」必须看这个字段，不能只看 type。
   * 缺省（老数据 / 演示源）为 undefined，调用方回退到品类判断。
   */
  switchable?: boolean;
  /** 多键开关的附加按键（单键设备为空数组），每个按键独立开关 */
  extraSwitches: ExtraSwitch[];

  brightness: number;
  colorTemperature: number;
  colorTempRange: [number, number] | null;
  colorTempList: PropertyItem[] | null;

  speed: number;
  speedRange: [number, number] | null;
  speedList: PropertyItem[] | null;
  speedStepless: number;
  speedSteplessRange: [number, number] | null;
  speedSteplessList: PropertyItem[] | null;

  power: number;
  /** 今日用电（kWh）；为 null 表示该设备规格里没有电量属性，界面不显示这一栏 */
  todayKwh: number | null;
  temperature: number | null;
  humidity: number | null;
  battery: number | null;

  // 空调 / 风扇
  mode: string | number | null;
  modeList: PropertyItem[] | null;
  targetTemperature: number | null;
  targetTempRange: [number, number] | null;
  horizontalSwing: boolean | null;
  horizontalSwingAngle: number | null;
  horizontalSwingAngleList: PropertyItem[] | null;
  verticalSwing: boolean | null;
  verticalSwingAngle: number | null;
  verticalSwingAngleList: PropertyItem[] | null;
  manualDir: boolean;

  // 净饮机
  iceMakerOn: boolean | null;
  iceMakerStatus: number | null;
  iceMakerStatusList: PropertyItem[] | null;
  status: number | null;
  statusList: PropertyItem[] | null;
  fault: number | null;
  faultList: PropertyItem[] | null;
  faultLabel: string;
  noWater: boolean;
  filterLife: number | null;
  /** 第二支滤芯寿命（部分净饮机有两支滤芯，如米家台式净饮机） */
  filterLife2: number | null;
  tdsIn: number | null;
  tdsOut: number | null;

  // 路由器 / 网关（只读指标）
  connectedDeviceNumber: number | null;
  downloadSpeed: number | null;
  uploadSpeed: number | null;
  hasNetMetrics: boolean;

  /** 规格里是否有可读属性；无则渲染层只显示在线/离线 */
  hasReads: boolean;
}

/** 应用设置（主进程内存态，落盘于 widget-state.json） */
export interface Settings {
  alwaysOnTop: boolean;
  launchAtLogin: boolean;
  /** 开机启动（托盘）：只在小组件模式下可用，与 launchAtLogin 互斥。 */
  launchInTray: boolean;
}

/** 家庭 */
export interface Home {
  id: string;
  name: string;
}

/** 登录状态汇总（mijia-login.status() 返回） */
export interface LoginStatus {
  hasDevices: boolean;
  deviceCount: number;
  cloudAuth: boolean;
  passwordSession: boolean;
  homes: Home[];
}

/** 对渲染层广播的登录状态（在 LoginStatus 上追加运行时字段） */
export interface LoginState extends LoginStatus {
  isMock: boolean;
  currentHomeId?: string;
}

/** 设备清单里的一条记录（mijia-login 归一化后落盘） */
export interface DeviceRecord {
  id: string;
  name: string;
  model: string;
  did?: string;
  ip?: string;
  token?: string;
  parentId?: string;
  homeId?: string;
  roomId?: string;
  roomName?: string;
  online?: boolean;
  [k: string]: unknown;
}

/** 二维码就绪信息 */
export interface QRInfo {
  qrImageUrl?: string;
  loginUrl?: string;
  /** 由主进程用 loginUrl 本地生成的 dataURL 兜底 */
  dataUrl?: string;
}

/** 密码登录续步：需要图形验证码 */
export interface LoginNeedCaptcha {
  ok: false;
  needCaptcha: true;
  sessionId: string;
  captcha: string;
}
/** 密码登录续步：需要二次安全验证码 */
export interface LoginNeedCode {
  ok: false;
  needCode: true;
  sessionId: string;
  method: string;
  hint: string;
}
/** 登录成功（密码 / 二维码） */
export interface LoginSuccess {
  ok: true;
  source: 'password' | 'qr';
  count: number;
  devices: DeviceRecord[];
}
export type LoginResponse = LoginNeedCaptcha | LoginNeedCode | LoginSuccess;

/** 全屏模式：null 未全屏；'normal' 任务栏可见；'cover' 盖住任务栏 */
export type FullscreenMode = 'normal' | 'cover' | null;

/** 主题 */
export type Theme = 'light' | 'dark';

/** 窗口模式：'window' 正常窗口（任务栏可见、无托盘）；'widget' 小组件（工具窗口 + 托盘） */
export type WindowMode = 'window' | 'widget';

/** widget:init 的返回值 */
export interface InitPayload {
  devices: Device[];
  settings: Settings;
  isMock: boolean;
  login: LoginStatus;
  currentHomeId: string;
  hasCustomSize: boolean;
  fullscreen: FullscreenMode;
  theme: Theme;
  windowMode: WindowMode;
  version: string;
}

/** widget:check-update 的返回值 */
export interface UpdateResult {
  hasUpdate?: boolean;
  version?: string;
  url?: string;
  [k: string]: unknown;
}

/* ---------------- 锁屏联动 ---------------- */

/**
 * 单个触发方向上的动作。
 *   on   → 设备打开 / 自动化启用
 *   off  → 设备关闭 / 自动化停用
 *   none → 该方向不动作
 */
export type LockAction = 'on' | 'off' | 'none';

/** 联动目标类型：device 设备；automation 米家自动化（云端总开关） */
export type LockTargetKind = 'device' | 'automation';

/**
 * 一个联动目标：设备或自动化，各自持有三个方向的动作。
 *
 * homeId 只有 automation 需要（拨开关的请求要带家庭），设备留空。
 * name 只用于提示文案，云端改名后下次打开设置页会按 id 重新取到新名字。
 */
export interface LockTarget {
  kind: LockTargetKind;
  id: string;
  name: string;
  homeId: string;
  startup: LockAction;
  unlock: LockAction;
  lock: LockAction;
}

/** 锁屏联动配置（store 层已收敛，字段必齐全） */
export interface LockConfig {
  /** 总开关：关闭时不响应任何会话事件 */
  enabled: boolean;
  targets: LockTarget[];
  /** 生效时间段（每日，支持跨午夜）；关闭 = 不限制时段 */
  timeEnabled: boolean;
  /** HH:MM（含） */
  timeStart: string;
  /** HH:MM（不含）；起 > 止 = 跨午夜 */
  timeEnd: string;
  /** 生效网络（Wi-Fi 名 / 以太网名，包含匹配）；关闭或名单为空 = 不限制 */
  netEnabled: boolean;
  netNames: string[];
}

/** 设置面板拉到的一份联动配置 + 能力标记 */
export interface LockConfigPayload {
  config: LockConfig;
  /** 当前平台是否支持锁屏事件监听（Web 版为 false） */
  supported: boolean;
  /** 是否已接入米家自动化控制（决定「目标」下拉里有没有自动化） */
  automation: boolean;
}

/** 米家自动化（智能）条目 */
export interface AutomationItem {
  id: string;
  name: string;
  homeId: string;
  enabled: boolean;
}

/** 主进程推给渲染层的联动结果提示（合成一条，避免刷屏） */
export interface LockNotice {
  /** applied 成功 / failed 失败 / skipped 条件未满足 / hint 一次性引导 */
  kind: 'applied' | 'failed' | 'skipped' | 'hint';
  text: string;
}

