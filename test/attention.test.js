import { test } from "node:test";
import assert from "node:assert/strict";

import { createNotifier, describeApproval, describeQuestion, oneLine } from "../lib/notify.js";
import {
	createFocuser,
	expandCommand,
	splitCommand,
	windowIdOfApp,
	windowIdOfPid,
} from "../lib/focus.js";
import { DEFAULTS, install, normalizeConfig } from "../lib/index.js";

/** Config with the click action off, so plain-delivery assertions stay readable. */
const config = (overrides = {}) => normalizeConfig({ ...DEFAULTS, cooldownMs: 0, clickAction: false, ...overrides });

/**
 * Fake spawn: records calls and hands back a child with `on`, `unref` and a
 * `stdout` stream the test can drive.
 */
function fakeSpawn(behaviour = "ok") {
	const calls = [];
	const children = [];
	const spawn = (command, args) => {
		calls.push({ command, args });
		const handlers = {};
		const child = {
			stdout: {
				on(event, handler) {
					handlers[`stdout:${event}`] = handler;
					return this;
				},
				emit(data) {
					handlers["stdout:data"]?.(Buffer.from(data));
				},
			},
			on(event, handler) {
				handlers[event] = handler;
				if (behaviour === "error" && event === "error") handler(new Error("ENOENT"));
				return this;
			},
			unref() {},
		};
		children.push(child);
		return child;
	};
	return { spawn, calls, children };
}

test("oneLine collapses whitespace and trims", () => {
	assert.equal(oneLine("  bash\n\twrite   ~/.dsh  "), "bash write ~/.dsh");
	assert.equal(oneLine(undefined), "");
});

test("oneLine truncates with an ellipsis at the budget", () => {
	const out = oneLine("abcdefghij", 5);
	assert.equal(out.length, 5);
	assert.equal(out, "abcd…");
});

test("describeApproval prefixes the tool and appends the reason", () => {
	assert.equal(describeApproval({ toolName: "bash", reason: "escalate sandbox" }, 80), "bash: escalate sandbox");
	assert.equal(describeApproval({ toolName: "edit" }, 80), "edit");
	assert.equal(describeApproval({}, 80), "tool");
});

test("describeQuestion uses the first question and counts the rest", () => {
	const body = describeQuestion({ questions: [{ question: "用哪个分支？" }, { question: "第二个" }] }, 120);
	assert.equal(body, "用哪个分支？ (+1)");
	assert.equal(describeQuestion({ questions: [] }, 120), "question");
});

test("notifier runs notify-send with app, urgency and one-line body", () => {
	const { spawn, calls } = fakeSpawn();
	const notifier = createNotifier({ config: config(), spawn });
	assert.equal(notifier.notify("需要你审批", "bash:  a\n b"), true);
	assert.deepEqual(calls[0], {
		command: "notify-send",
		args: ["-a", "dsh", "-u", "normal", "需要你审批", "bash: a b"],
	});
});

test("clickAction adds the default action so a click can be observed", () => {
	const { spawn, calls } = fakeSpawn();
	createNotifier({ config: config({ clickAction: true }), spawn }).notify("t", "b");
	assert.deepEqual(calls[0].args, ["-a", "dsh", "-u", "normal", "-A", "default=打开窗口", "t", "b"]);
});

test("a click on the notification runs the activate handler exactly once", () => {
	const { spawn, children } = fakeSpawn();
	let activations = 0;
	createNotifier({ config: config({ clickAction: true }), spawn, onActivate: () => (activations += 1) }).notify("t", "b");
	children[0].stdout.emit("default\n");
	children[0].stdout.emit("default\n");
	assert.equal(activations, 1);
});

test("a throwing activate handler does not escape notify", () => {
	const { spawn, children } = fakeSpawn();
	const warnings = [];
	createNotifier({
		config: config({ clickAction: true }),
		logger: { warn: (m) => warnings.push(m) },
		spawn,
		onActivate: () => {
			throw new Error("no compositor");
		},
	}).notify("t", "b");
	children[0].stdout.emit("default\n");
	assert.match(warnings[0], /no compositor/);
});

test("notifier plays the sound file when enabled", () => {
	const { spawn, calls } = fakeSpawn();
	createNotifier({ config: config(), spawn }).notify("t", "b");
	assert.equal(calls.length, 2);
	assert.equal(calls[1].command, "paplay");
	assert.equal(calls[1].args[0], DEFAULTS.soundFile);
});

test("notifier skips the sound when disabled or fileless", () => {
	const { spawn, calls } = fakeSpawn();
	createNotifier({ config: config({ sound: false }), spawn }).notify("t", "b");
	assert.equal(calls.length, 1);

	const second = fakeSpawn();
	createNotifier({ config: config({ soundFile: "" }), spawn: second.spawn }).notify("t", "b");
	assert.equal(second.calls.length, 1);
});

test("notifier does nothing when disabled", () => {
	const { spawn, calls } = fakeSpawn();
	assert.equal(createNotifier({ config: config({ enabled: false }), spawn }).notify("t", "b"), false);
	assert.deepEqual(calls, []);
});

test("cooldown suppresses the same title and keeps other titles", () => {
	const { spawn, calls } = fakeSpawn();
	const notifier = createNotifier({ config: config({ cooldownMs: 60_000 }), spawn });
	notifier.notify("审批", "one");
	notifier.notify("审批", "two");
	notifier.notify("提问", "three");
	assert.deepEqual(
		calls.filter((call) => call.command === "notify-send").map((call) => call.args[4]),
		["审批", "提问"],
	);
});

test("a failing spawn is reported, never thrown", () => {
	const warnings = [];
	const notifier = createNotifier({
		config: config(),
		logger: { warn: (message) => warnings.push(message) },
		spawn: () => {
			throw new Error("no display");
		},
	});
	assert.equal(notifier.notify("t", "b"), false);
	assert.match(warnings[0], /no display/);
});

test("an async ENOENT is swallowed by the error handler", () => {
	const debug = [];
	const { spawn } = fakeSpawn("error");
	createNotifier({ config: config(), logger: { debug: (m) => debug.push(m) }, spawn }).notify("t", "b");
	assert.match(debug[0], /ENOENT/);
});

test("normalizeConfig rejects bad shapes", () => {
	assert.throws(() => normalizeConfig({ enabled: "yes" }), /enabled/);
	assert.throws(() => normalizeConfig({ command: "" }), /command/);
	assert.throws(() => normalizeConfig({ cooldownMs: -1 }), /cooldownMs/);
	assert.throws(() => normalizeConfig({ maxBodyChars: 0 }), /maxBodyChars/);
	assert.throws(() => normalizeConfig({ urgency: "loud" }), /urgency/);
	assert.throws(() => normalizeConfig({ focusCommand: 5 }), /focusCommand/);
	assert.equal(normalizeConfig({}).maxBodyChars, DEFAULTS.maxBodyChars);
});

const NIRI_WINDOWS = `Window ID 58:
  Title: "Issues - Edge"
  App ID: "microsoft-edge"
  Is floating: no
  PID: 514899
  Workspace ID: 1

Window ID 87: (focused)
  Title: "⠂ 🐋 排查429"
  App ID: "kitty"
  Is floating: no
  PID: 588329
  Workspace ID: 1
`;

test("windowIdOfPid finds the block by owner pid", () => {
	assert.equal(windowIdOfPid(NIRI_WINDOWS, 588329), 87);
	assert.equal(windowIdOfPid(NIRI_WINDOWS, 514899), 58);
	assert.equal(windowIdOfPid(NIRI_WINDOWS, 1), undefined);
	assert.equal(windowIdOfPid(NIRI_WINDOWS, undefined), undefined);
});

test("windowIdOfApp falls back to the app id", () => {
	assert.equal(windowIdOfApp(NIRI_WINDOWS, "kitty"), 87);
	assert.equal(windowIdOfApp(NIRI_WINDOWS, "firefox"), undefined);
});

test("command templates expand and split", () => {
	assert.equal(expandCommand("x --id {windowId} --p {pid}", { windowId: 87, pid: 1 }), "x --id 87 --p 1");
	assert.deepEqual(splitCommand("niri  msg   action"), { file: "niri", args: ["msg", "action"] });
	assert.deepEqual(splitCommand(""), { file: "", args: [] });
});

/** Fake execFile: answers per command prefix and records every call. */
function fakeExec(answers) {
	const calls = [];
	const exec = (file, args, options, callback) => {
		const line = [file, ...args].join(" ");
		calls.push(line);
		const answer = answers.find(([match]) => line.includes(match));
		setTimeout(() => (answer ? callback(null, answer[1]) : callback(new Error(`no answer for ${line}`))), 0);
	};
	return { exec, calls };
}

test("focuser resolves the window by pid and focuses it", async () => {
	const { exec, calls } = fakeExec([
		["niri msg windows", NIRI_WINDOWS],
		["focus-window", ""],
	]);
	const focuser = createFocuser({ config: config(), exec, env: { KITTY_PID: "588329" } });
	focuser.focus();
	await new Promise((resolve) => setTimeout(resolve, 30));
	assert.deepEqual(calls, ["niri msg windows", "niri msg action focus-window --id 87"]);
});

test("focuser falls back to the app id when the pid is unknown", async () => {
	const { exec, calls } = fakeExec([
		["niri msg windows", NIRI_WINDOWS],
		["focus-window", ""],
	]);
	createFocuser({ config: config({ focusPid: "" }), exec, env: {} }).focus();
	await new Promise((resolve) => setTimeout(resolve, 30));
	assert.equal(calls[1], "niri msg action focus-window --id 87");
});

test("focuser stays quiet when no window matches", async () => {
	const { exec, calls } = fakeExec([["niri msg windows", "Window ID 1:\n  App ID: \"mpv\"\n  PID: 2\n"]]);
	createFocuser({ config: config({ focusPid: "" }), exec, env: {} }).focus();
	await new Promise((resolve) => setTimeout(resolve, 30));
	assert.deepEqual(calls, ["niri msg windows"]);
});

test("focuser is a no-op when focus is off or the compositor errors", async () => {
	const { exec, calls } = fakeExec([]);
	createFocuser({ config: config({ focus: false }), exec, env: {} }).focus();
	await new Promise((resolve) => setTimeout(resolve, 10));
	assert.deepEqual(calls, []);

	createFocuser({ config: config(), exec, env: { KITTY_PID: "1" } }).focus();
	await new Promise((resolve) => setTimeout(resolve, 30));
	assert.equal(calls.length, 1, "one attempt, failure swallowed");
});

/** Minimal ctx: records listeners so tests can fire them by name. */
function fakeCtx() {
	const listeners = new Map();
	const effects = [];
	const logs = [];
	return {
		listeners,
		effects,
		logs,
		ctx: {
			logger: { info: (m) => logs.push(m), warn: (m) => logs.push(m), debug: (m) => logs.push(m) },
			on(event, handler) {
				listeners.set(event, handler);
				return () => listeners.delete(event);
			},
			effect(factory) {
				effects.push(factory);
				return () => {};
			},
		},
		fire(event, ...args) {
			return listeners.get(event)?.(...args);
		},
	};
}

test("approval/asked turns into a notification", () => {
	const harness = fakeCtx();
	const { calls, spawn } = fakeSpawn();
	install(harness.ctx, { clickAction: false }, { spawn });
	harness.fire("session/event", {}, { type: "agent/message", data: {} });
	assert.equal(calls.length, 0);
	harness.fire("session/event", {}, { type: "approval/asked", data: { toolName: "bash", reason: "写工作区外" } });
	assert.equal(calls.length, 2);
	assert.deepEqual(calls[0].args.slice(4), ["需要你审批", "bash: 写工作区外"]);
});

test("the question listener always continues the waterfall", () => {
	const harness = fakeCtx();
	const { calls, spawn } = fakeSpawn();
	install(harness.ctx, { clickAction: false }, { spawn });
	let asked = 0;
	const outcome = harness.fire(
		"user-questions/request",
		{ questions: [{ question: "选哪个？" }] },
		() => {
			asked += 1;
			return Promise.resolve({ answered: true });
		},
	);
	assert.equal(asked, 1, "next() must run so the terminal can still ask");
	assert.ok(outcome instanceof Promise);
	assert.deepEqual(calls[0].args.slice(4), ["需要你回答", "选哪个？"]);
});

test("a throwing notifier still continues the waterfall", () => {
	const harness = fakeCtx();
	install(
		harness.ctx,
		{},
		{
			spawn: () => {
				throw new Error("boom");
			},
		},
	);
	let asked = 0;
	harness.fire("user-questions/request", { questions: [] }, () => {
		asked += 1;
		return Promise.resolve("ok");
	});
	assert.equal(asked, 1);
	assert.ok(harness.logs.some((line) => /boom/.test(line)));
});

test("config flags turn individual listeners off", () => {
	const harness = fakeCtx();
	const { spawn } = fakeSpawn();
	install(harness.ctx, { approval: false, question: false }, { spawn });
	assert.equal(harness.listeners.size, 0);
});

test("dispose releases every listener", () => {
	const harness = fakeCtx();
	const { spawn } = fakeSpawn();
	const { dispose } = install(harness.ctx, {}, { spawn });
	assert.equal(harness.listeners.size, 2);
	dispose();
	assert.equal(harness.listeners.size, 0);
	assert.equal(harness.effects.length, 1, "one effect registered for unload cleanup");
});
