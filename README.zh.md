# dsh-attention-notify

DeepSeek Harness 里**真正卡住你**的两个时刻，推到桌面上弹通知：**工具审批**和**用户提问**。

Harness 自己只在**任务完成**时提醒（Kitty 走 OSC 99、Ghostty/WezTerm 走 OSC 777、iTerm2 走 OSC 9、
其他终端响铃）。轮到 agent 等你拍板时，反而一点动静都没有——而那恰恰是你已经离开终端的时候。
这个插件把这两个接缝镜像到桌面，用 `notify-send` 弹出来。

```
┌──────────────────────┐   approval/asked    ┌───────────────────┐
│ 权限层                │────────────────────▶│ 本插件             │
│ 问卷接缝              │  user-questions/... │  ↓ notify-send    │
└──────────────────────┘                     └────────┬──────────┘
                                                      ▼
                                                  桌面通知
```

## 安装

```bash
dsh plugin --profile <profile> add dsh-attention-notify
```

bundle patch 只插一行 loader，不改宿主配置。

## 依赖

| | |
|---|---|
| 宿主 | 带 D-Bus 会话的 Linux（Wayland / X11 都行） |
| `notify-send` | 来自 `libnotify`（Debian/Ubuntu 是 `libnotify-bin`） |
| `paplay` | 可选，来自 `pulseaudio-utils`；`sound: true` 时才用 |

macOS 可以把 `command` 换成 `terminal-notifier`、`soundCommand` 换成 `afplay`；
Windows 没有 `notify-send`，所以本插件只针对 Linux。

## 什么时候弹

| 会话事件 | 标题 | 正文 |
|---|---|---|
| `approval/asked` | `需要你审批` | `工具名: 原因`，压成一行、超长截断 |
| `user-questions/request` | `需要你回答` | 第一个问题的 header/正文，多问时补 `(+N)` |

**不重复**通知任务完成：TUI 自己的 `taskNotifications` 设置已经覆盖了。

## 配置

| 键 | 默认 | 说明 |
|---|---|---|
| `enabled` | `true` | 总开关 |
| `approval` | `true` | 审批时通知 |
| `question` | `true` | 提问时通知 |
| `approvalTitle` | `需要你审批` | 审批通知标题 |
| `questionTitle` | `需要你回答` | 提问通知标题 |
| `command` | `notify-send` | 任意接受 `-a -u <标题> <正文>` 的程序 |
| `appName` | `dsh` | `notify-send -a` 的取值 |
| `urgency` | `normal` | `low` / `normal` / `critical` |
| `sound` | `true` | 每次通知后播放 `soundFile` |
| `soundCommand` | `paplay` | 播放器 |
| `soundFile` | `/usr/share/sounds/freedesktop/stereo/message.oga` | 音效文件；留空则静音 |
| `cooldownMs` | `1500` | 同一标题在此窗口内只弹一次 |
| `maxBodyChars` | `160` | 正文预算，超出用 `…` 截断 |
| `clickAction` | `true` | 挂一个动作，点击才可被感知 |
| `actionLabel` | `打开窗口` | 动作按钮文字 |
| `focus` | `true` | 点击通知时把终端窗口提到前台 |
| `windowsCommand` | `niri msg windows` | 列窗口的命令 |
| `focusCommand` | `niri msg action focus-window --id {windowId}` | 聚焦命令模板 |
| `focusAppId` | `kitty` | 拿不到终端 pid 时的兜底匹配 |
| `focusPid` | `""` | 窗口属主 pid，默认取 `$KITTY_PID` |
| `focusTimeoutMs` | `2000` | 单条命令超时 |

## 点通知跳回终端

通知带了 `default` 动作，点正文就是触发它——通知守护进程会顺手把弹窗关掉，
`notify-send` 把选中的动作名打到标准输出，插件就在等这个信号（`-A default=…`）。

Wayland 不允许应用把别人的窗口提到前面，所以只能走合成器 IPC。niri 上是：

```
niri msg windows                  # 找 PID 等于 $KITTY_PID 的那个窗口
niri msg action focus-window --id <id>
```

换合成器只改 `windowsCommand` / `focusCommand` 两个模板即可，模板里支持
`{windowId}`、`{pid}`、`{appId}`；`focus: false` 可以整块关掉。

## 设计说明

- **审批**走 `session/event` 流（`approval/asked`），是纯事件：插件**不可能**影响审批结果。
- **提问**是 Cordis 的 *waterfall*（`user-questions/request`），监听器因此**一定**要调 `next()`。
  不调就等于否决后续所有回答器，包括终端自己那个——问题会彻底不显示。通知只是副作用，
  而且包在 `try` 里，就算通知炸了也拦不住提问。
- 投递是最佳努力：`spawn` 分离、`stdio: "ignore"`，同步异常和异步 `ENOENT` 都被吞进日志。
  没有 libnotify 的机器退化成「不通知」，而不是让这一回合失败。
- 正文在交给通知守护进程前就压成单行并截断，因为有些守护进程会把长正文折成好几屏。

## 验证

```bash
npm test          # 17 个单元测试，不需要桌面
```

真机上手动看一眼：

```bash
node -e '
import("./lib/index.js").then(async ({ install }) => {
  const listeners = new Map();
  const ctx = { logger: {}, on: (e, h) => (listeners.set(e, h), () => {}), effect: () => () => {} };
  install(ctx, {});
  listeners.get("session/event")({}, { type: "approval/asked", data: { toolName: "bash", reason: "测试通知" } });
});'
```

## 限制

- **只针对 Linux**。命令可换，但默认值假设有 `notify-send` 和 D-Bus 会话总线。
- **没有焦点检测**。终端协议通知器能在终端聚焦时保持安静，宿主侧插件看不到这个状态，
  所以这里一律通知；唯一的降噪手段是 `cooldownMs`。
- 通知在**提示出现时**发出，被回答后不会撤销，也没有「还在等你」的重复提醒。
- **点通知跳窗口是合成器相关的**。只实现了 niri 且只测过 niri。而且提上来的是**窗口**，
  不是 kitty 的具体**标签页**——切标签要开 kitty 远程控制（`allow_remote_control yes`），默认没开。
- 弹了没点的话，会留一个等待中的 `notify-send` 进程，直到弹窗被关闭、超时或被点掉。

## 许可证

MIT。
