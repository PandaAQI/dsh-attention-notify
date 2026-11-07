/**
 * dsh-attention-notify — desktop notifications when the harness needs the user.
 *
 * DeepSeek Harness already notifies task completion in the terminal (OSC 99 on
 * Kitty, 777 on Ghostty/WezTerm, 9 on iTerm2, BEL elsewhere), but nothing fires
 * when a tool approval or a user question is waiting. Those are exactly the two
 * moments where the user has walked away, so this plugin mirrors them to the
 * desktop with `notify-send`.
 *
 * The question seam is a waterfall, so the listener must always call `next()`:
 * notifying is taken as a side effect, never as a veto.
 *
 * @module dsh-attention-notify
 */

import { createFocuser } from "./focus.js";
import { createNotifier, describeApproval, describeQuestion } from "./notify.js";

export const name = "attention-notify";

/** Defaults match a stock Linux desktop; every field is overridable in config. */
export const DEFAULTS = {
	enabled: true,
	approval: true,
	question: true,
	approvalTitle: "需要你审批",
	questionTitle: "需要你回答",
	command: "notify-send",
	appName: "dsh",
	urgency: "normal",
	sound: true,
	soundCommand: "paplay",
	soundFile: "/usr/share/sounds/freedesktop/stereo/message.oga",
	cooldownMs: 1500,
	maxBodyChars: 160,
	clickAction: true,
	actionLabel: "打开窗口",
	focus: true,
	windowsCommand: "niri msg windows",
	focusCommand: "niri msg action focus-window --id {windowId}",
	focusAppId: "kitty",
	focusPid: "",
	focusTimeoutMs: 2000,
};

const FLAGS = ["enabled", "approval", "question", "sound", "clickAction", "focus"];

/**
 * Validate and fill in the plugin config.
 *
 * @param raw - User config from `cordis.patch.yml`; may be undefined.
 * @returns A complete config object.
 * @throws When a string field is empty or a number is not a non-negative finite number.
 */
export function normalizeConfig(raw) {
	const config = { ...DEFAULTS, ...(raw ?? {}) };
	for (const flag of FLAGS) {
		if (typeof config[flag] !== "boolean") throw new TypeError(`attention-notify: \`${flag}\` must be a boolean`);
	}
	for (const key of ["approvalTitle", "questionTitle", "command", "appName", "soundCommand", "actionLabel", "focusAppId"]) {
		if (typeof config[key] !== "string" || config[key].length === 0) {
			throw new TypeError(`attention-notify: \`${key}\` must be a non-empty string`);
		}
	}
	if (config.soundFile !== "" && typeof config.soundFile !== "string") {
		throw new TypeError("attention-notify: `soundFile` must be a string");
	}
	for (const key of ["focusPid", "windowsCommand", "focusCommand"]) {
		if (typeof config[key] !== "string") throw new TypeError(`attention-notify: \`${key}\` must be a string`);
	}
	for (const key of ["cooldownMs", "maxBodyChars", "focusTimeoutMs"]) {
		const value = config[key];
		if (typeof value !== "number" || !Number.isFinite(value) || value < 0) {
			throw new TypeError(`attention-notify: \`${key}\` must be a non-negative number`);
		}
	}
	if (config.maxBodyChars < 1) throw new TypeError("attention-notify: `maxBodyChars` must be at least 1");
	if (!["low", "normal", "critical"].includes(config.urgency)) {
		throw new TypeError("attention-notify: `urgency` must be low, normal or critical");
	}
	return config;
}

/**
 * Wire the notifier into a plugin context.
 *
 * Exported separately from {@link apply} so tests can inject a fake `spawn`
 * without standing up a real Cordis context.
 *
 * @param ctx - Plugin context providing `on`, `effect` and `logger`.
 * @param rawConfig - Plugin config.
 * @param deps - Test seams: `{ spawn }`.
 * @returns The notifier and a manual dispose function.
 */
export function install(ctx, rawConfig, deps = {}) {
	const config = normalizeConfig(rawConfig);
	const focuser = createFocuser({ config, logger: ctx.logger, exec: deps.exec, env: deps.env });
	const notifier = createNotifier({
		config,
		logger: ctx.logger,
		spawn: deps.spawn,
		onActivate: deps.onActivate ?? (() => focuser.focus()),
	});
	const disposers = [];

	if (config.approval) {
		disposers.push(
			ctx.on("session/event", (session, event) => {
				if (event?.type !== "approval/asked") return;
				try {
					notifier.notify(config.approvalTitle, describeApproval(event.data, config.maxBodyChars));
				} catch (error) {
					ctx.logger?.warn?.(`attention-notify: approval notification failed: ${error?.message ?? error}`);
				}
			}),
		);
	}

	if (config.question) {
		disposers.push(
			ctx.on("user-questions/request", (request, next) => {
				try {
					notifier.notify(config.questionTitle, describeQuestion(request, config.maxBodyChars));
				} catch (error) {
					ctx.logger?.warn?.(`attention-notify: question notification failed: ${error?.message ?? error}`);
				}
				// Waterfall: not calling next() would veto every answerer, including
				// the terminal's, and the user would never see the question at all.
				return next();
			}),
		);
	}

	const dispose = () => {
		for (const release of disposers.splice(0)) {
			try {
				release?.();
			} catch (error) {
				ctx.logger?.debug?.(`attention-notify: dispose failed: ${error?.message ?? error}`);
			}
		}
	};
	ctx.effect(() => dispose, "attention-notify.dispose");
	ctx.logger?.info?.(
		`attention-notify: approval=${config.approval} question=${config.question} click=${config.clickAction} focus=${config.focus} via ${config.command}`,
	);
	return { notifier, focuser, dispose };
}

/**
 * Cordis entry point.
 *
 * @param ctx - Plugin context.
 * @param config - Plugin config.
 */
export function apply(ctx, config) {
	install(ctx, config);
}
