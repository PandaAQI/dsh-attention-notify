# dsh-attention-notify

Desktop notifications from DeepSeek Harness for the two moments that block a turn:
**tool approvals** and **user questions**.

DeepSeek Harness already notifies *task completion* in the terminal (OSC 99 on Kitty,
OSC 777 on Ghostty/WezTerm, OSC 9 on iTerm2, BEL elsewhere). Nothing fires when the agent is
waiting on *you* — which is exactly when you have walked away from the terminal. This plugin
mirrors those two seams to the desktop through `notify-send`.

```
┌──────────────────────┐   approval/asked    ┌───────────────────┐
│ permission layer     │────────────────────▶│ this plugin       │
│ user-questions seam  │  user-questions/... │  ↓ notify-send    │
└──────────────────────┘                     └────────┬──────────┘
                                                      ▼
                                             desktop notification
```

## Install

```bash
dsh plugin --profile <profile> add dsh-attention-notify
```

The bundle patch inserts one loader row; no host config is touched.

## Requirements

| | |
|---|---|
| Host | Linux with a D-Bus session (Wayland or X11) |
| `notify-send` | from `libnotify` (or `libnotify-bin` on Debian/Ubuntu) |
| `paplay` | optional, from `pulseaudio-utils`; only used when `sound: true` |

macOS users can point `command` at `terminal-notifier` and `soundCommand` at `afplay`;
Windows has no `notify-send`, so this plugin is Linux-targeted on purpose.

## What fires

| Session event | Title | Body |
|---|---|---|
| `approval/asked` | `需要你审批` | `toolName: reason`, one line, truncated |
| `user-questions/request` | `需要你回答` | first question's header/text, `(+N)` for the rest |

Task completion is deliberately **not** duplicated: the TUI's own
`taskNotifications` setting already covers it.

## Config

| Key | Default | Meaning |
|---|---|---|
| `enabled` | `true` | master switch |
| `approval` | `true` | notify on `approval/asked` |
| `question` | `true` | notify on `user-questions/request` |
| `approvalTitle` | `需要你审批` | title for approvals |
| `questionTitle` | `需要你回答` | title for questions |
| `command` | `notify-send` | any binary taking `-a -u <title> <body>` |
| `appName` | `dsh` | `notify-send -a` value |
| `urgency` | `normal` | `low` / `normal` / `critical` |
| `sound` | `true` | play `soundFile` after each notification |
| `soundCommand` | `paplay` | sound player |
| `soundFile` | `/usr/share/sounds/freedesktop/stereo/message.oga` | sound file; empty disables |
| `cooldownMs` | `1500` | drop repeats of the same title inside this window |
| `maxBodyChars` | `160` | body budget; longer text is cut with `…` |

## Design notes

- **Approvals** are observed on the `session/event` stream (`approval/asked`), a pure event:
  the plugin cannot influence the decision.
- **Questions** are a Cordis *waterfall* (`user-questions/request`). The listener therefore
  **always** calls `next()` — a listener that returns without it vetoes every answerer,
  including the terminal's, and the question would never be shown. Notifying happens as a
  side effect inside a `try`, so a broken notifier still cannot block the prompt.
- Delivery is best effort: `spawn` is detached and `stdio: "ignore"`, synchronous throws and
  asynchronous `ENOENT` are both swallowed into the logger. A machine without libnotify
  degrades to no notifications instead of a failing turn.
- The body is flattened to a single line and truncated before it reaches the notification
  daemon, because some daemons wrap long bodies into multi-screen popups.

## Verify

```bash
npm test          # 17 unit tests, no desktop required
```

Manual check on the real machine:

```bash
node -e '
import("./lib/index.js").then(async ({ install }) => {
  const listeners = new Map();
  const ctx = { logger: {}, on: (e, h) => (listeners.set(e, h), () => {}), effect: () => () => {} };
  install(ctx, {});
  listeners.get("session/event")({}, { type: "approval/asked", data: { toolName: "bash", reason: "测试通知" } });
});'
```

## Limitations

- **Linux only** as shipped. The command is configurable, but the defaults assume
  `notify-send` and a D-Bus session bus.
- **No focus detection.** The terminal protocol notifiers can stay quiet while the terminal
  is focused; a host-side plugin cannot see that state, so this one always notifies.
  `cooldownMs` is the only noise control.
- Notifications are raised when the *prompt* appears, not when it is answered; there is no
  "still waiting" reminder.

## License

MIT.
