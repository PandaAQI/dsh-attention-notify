/**
 * Desktop delivery for the attention plugin: one `notify-send` call and,
 * optionally, one short sound. Everything here is best effort — a machine
 * without libnotify must not break the turn that asked for attention.
 *
 * @module dsh-attention-notify/notify
 */

import { spawn as nodeSpawn } from "node:child_process";

/** Body text is one line; longer reasons are cut, not wrapped. */
const ELLIPSIS = "…";

/**
 * Flatten arbitrary text into a single short line for a notification body.
 *
 * @param value - Raw text; `null`/`undefined` become the empty string.
 * @param max - Maximum characters to keep, ellipsis included.
 * @returns One line, at most `max` characters.
 */
export function oneLine(value, max = Infinity) {
	const text = String(value ?? "").replace(/\s+/g, " ").trim();
	const limit = Number.isFinite(max) ? max : Infinity;
	if (text.length <= limit) return text;
	if (limit <= ELLIPSIS.length) return text.slice(0, limit);
	return text.slice(0, limit - ELLIPSIS.length) + ELLIPSIS;
}

/**
 * Describe an `approval/asked` payload for a notification body.
 *
 * @param data - The session event payload: `{ toolName, reason? }`.
 * @param max - Maximum characters of the whole body.
 * @returns `toolName`, plus the request reason when the permission layer gave one.
 */
export function describeApproval(data, max) {
	const tool = oneLine(data?.toolName ?? "tool", Math.min(max, 40));
	const reason = oneLine(data?.reason ?? "", Math.max(0, max - tool.length - 2));
	return reason ? `${tool}: ${reason}` : tool;
}

/**
 * Describe a `user-questions/request` payload for a notification body.
 *
 * @param request - `{ questions: [{ header?, question }, ...] }`.
 * @param max - Maximum characters of the whole body.
 * @returns The first question's header and text, plus a count of the rest.
 */
export function describeQuestion(request, max) {
	const questions = Array.isArray(request?.questions) ? request.questions : [];
	const first = questions[0] ?? {};
	const more = questions.length > 1 ? ` (+${questions.length - 1})` : "";
	const header = oneLine(first.header ?? "", 40);
	const body = oneLine(first.question ?? "", max);
	const head = header && !body.startsWith(header) ? `${header}: ${body}` : body;
	return oneLine((head || "question") + more, max);
}

/**
 * Build the notifier used by the plugin.
 *
 * @param options - Injection points; tests pass a fake `spawn`.
 * @param options.config - Normalized plugin config.
 * @param options.logger - Plugin logger; only `warn`/`debug` are used.
 * @param options.spawn - `child_process.spawn`-compatible function.
 * @returns An object with `notify(title, body)`.
 */
export function createNotifier({ config, logger, spawn = nodeSpawn }) {
	let lastTitle = "";
	let lastAt = 0;

	/** Run a detached command, swallowing spawn errors so nothing reaches the turn. */
	const run = (command, args) => {
		try {
			const child = spawn(command, args, { stdio: "ignore", detached: true });
			child.on?.("error", (error) => {
				logger?.debug?.(`attention-notify: ${command} failed: ${error?.message ?? error}`);
			});
			child.unref?.();
			return true;
		} catch (error) {
			logger?.warn?.(`attention-notify: ${command} failed: ${error?.message ?? error}`);
			return false;
		}
	};

	return {
		/**
		 * Deliver one notification.
		 *
		 * @param title - Notification title, also the cooldown key.
		 * @param body - One-line body; callers normally pass an already short string.
		 * @returns Whether anything was spawned.
		 */
		notify(title, body) {
			if (!config.enabled) return false;
			const now = Date.now();
			if (config.cooldownMs > 0 && title === lastTitle && now - lastAt < config.cooldownMs) return false;
			lastTitle = title;
			lastAt = now;
			const text = oneLine(body, config.maxBodyChars);
			const delivered = run(config.command, ["-a", config.appName, "-u", config.urgency, title, text]);
			if (config.sound && config.soundFile) run(config.soundCommand, [config.soundFile]);
			return delivered;
		},
	};
}
