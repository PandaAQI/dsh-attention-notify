/**
 * Bring the terminal that is blocked back to the front when the user clicks the
 * notification.
 *
 * Wayland gives an application no way to raise someone else's window, so this
 * goes through the compositor's own IPC. Niri is implemented here because it is
 * what the author runs; the command is configurable, so other compositors can be
 * wired with `focusCommand` / `windowsCommand` without patching the plugin.
 *
 * @module dsh-attention-notify/focus
 */

import { execFile as nodeExecFile } from "node:child_process";

/**
 * Pick the window id belonging to `pid` out of `niri msg windows` output.
 *
 * The output is block per window:
 *
 * ```
 * Window ID 87: (focused)
 *   Title: "⠂ 🐋 排查并内部解决429限流"
 *   App ID: "kitty"
 *   PID: 588329
 * ```
 *
 * @param text - Raw `niri msg windows` output.
 * @param pid - Process id to look for; the terminal's own pid, not the plugin's.
 * @returns The window id, or `undefined` when no block matches.
 */
export function windowIdOfPid(text, pid) {
	if (!pid) return undefined;
	const blocks = String(text ?? "").split(/^(?=Window ID )/m);
	for (const block of blocks) {
		const id = /^Window ID (\d+)/.exec(block);
		if (!id) continue;
		const owner = /^\s+PID: (\d+)\s*$/m.exec(block);
		if (owner && Number(owner[1]) === Number(pid)) return Number(id[1]);
	}
	return undefined;
}

/**
 * Pick the first window id whose `App ID:` matches.
 *
 * Used as the fallback when the terminal's pid is unknown (for example when dsh
 * was started from a multiplexer that orphaned the environment).
 *
 * @param text - Raw `niri msg windows` output.
 * @param appId - Exact `App ID` value, e.g. `kitty`.
 * @returns The window id, or `undefined`.
 */
export function windowIdOfApp(text, appId) {
	if (!appId) return undefined;
	const blocks = String(text ?? "").split(/^(?=Window ID )/m);
	for (const block of blocks) {
		const id = /^Window ID (\d+)/.exec(block);
		if (!id) continue;
		const app = /^\s+App ID: "(.*)"\s*$/m.exec(block);
		if (app && app[1] === appId) return Number(id[1]);
	}
	return undefined;
}

/**
 * Expand `{windowId}` / `{pid}` / `{appId}` in a command template.
 *
 * @param template - Command line, e.g. `niri msg action focus-window --id {windowId}`.
 * @param values - Substitutions.
 * @returns The expanded command line (split by the caller).
 */
export function expandCommand(template, values) {
	return String(template ?? "").replace(/\{(windowId|pid|appId)\}/g, (_, key) => String(values[key] ?? ""));
}

/**
 * Split a command line into executable and arguments.
 *
 * Only whitespace splitting is supported on purpose: the templates here are
 * fixed literals from config, not user data, and quoting rules differ per shell.
 *
 * @param line - Expanded command line.
 * @returns `{ file, args }`.
 */
export function splitCommand(line) {
	const parts = String(line ?? "").trim().split(/\s+/).filter(Boolean);
	return { file: parts[0] ?? "", args: parts.slice(1) };
}

/**
 * Build the click handler that focuses the blocking terminal.
 *
 * @param options - Injection points.
 * @param options.config - Normalized plugin config (`focusCommand`, `windowsCommand`, `focusPid`, `focusAppId`).
 * @param options.logger - Plugin logger.
 * @param options.exec - `child_process.execFile`-compatible function.
 * @param options.env - Environment to read `KITTY_PID` / `WEZTERM_PANE` from.
 * @returns A function that resolves and focuses the window; never throws.
 */
export function createFocuser({ config, logger, exec = nodeExecFile, env = process.env }) {
	const pid = Number(config.focusPid || env.KITTY_PID || 0) || undefined;
	const appId = config.focusAppId || "kitty";

	const run = (line, onDone) => {
		const { file, args } = splitCommand(line);
		if (!file) return;
		exec(file, args, { timeout: config.focusTimeoutMs, windowsHide: true }, (error, stdout) => {
			if (error) {
				logger?.debug?.(`attention-notify: ${file} failed: ${error?.message ?? error}`);
				onDone?.(undefined);
				return;
			}
			onDone?.(stdout);
		});
	};

	return {
		/**
		 * Focus the terminal window. Safe to call from an event handler: every
		 * failure is logged and swallowed.
		 */
		focus() {
			if (!config.focus) return;
			run(config.windowsCommand, (stdout) => {
				const windowId = windowIdOfPid(stdout, pid) ?? windowIdOfApp(stdout, appId);
				if (windowId === undefined) {
					logger?.debug?.("attention-notify: no terminal window found to focus");
					return;
				}
				run(expandCommand(config.focusCommand, { windowId, pid: pid ?? "", appId }), () => {
					logger?.debug?.(`attention-notify: focused window ${windowId}`);
				});
			});
		},
	};
}
