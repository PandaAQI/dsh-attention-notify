import { test } from "node:test";
import assert from "node:assert/strict";

import { createNotifier, describeApproval, describeQuestion, oneLine } from "../lib/notify.js";
import { DEFAULTS, install, normalizeConfig } from "../lib/index.js";

const config = () => normalizeConfig({ ...DEFAULTS, cooldownMs: 0 });

/** Fake spawn that records calls and returns a child with `on`/`unref`. */
function fakeSpawn(behaviour = "ok") {
	const calls = [];
	const spawn = (command, args) => {
		calls.push({ command, args });
		const handlers = {};
		return {
			on(event, handler) {
				handlers[event] = handler;
				if (behaviour === "error" && event === "error") handler(new Error("ENOENT"));
				return this;
			},
			unref() {},
		};
	};
	return { spawn, calls };
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

test("notifier plays the sound file when enabled", () => {
	const { spawn, calls } = fakeSpawn();
	createNotifier({ config: config(), spawn }).notify("t", "b");
	assert.equal(calls.length, 2);
	assert.equal(calls[1].command, "paplay");
	assert.equal(calls[1].args[0], DEFAULTS.soundFile);
});

test("notifier skips the sound when disabled or fileless", () => {
	const { spawn, calls } = fakeSpawn();
	createNotifier({ config: normalizeConfig({ sound: false }), spawn }).notify("t", "b");
	assert.equal(calls.length, 1);

	const second = fakeSpawn();
	createNotifier({ config: normalizeConfig({ soundFile: "" }), spawn: second.spawn }).notify("t", "b");
	assert.equal(second.calls.length, 1);
});

test("notifier does nothing when disabled", () => {
	const { spawn, calls } = fakeSpawn();
	assert.equal(createNotifier({ config: normalizeConfig({ enabled: false }), spawn }).notify("t", "b"), false);
	assert.deepEqual(calls, []);
});

test("cooldown suppresses the same title and keeps other titles", () => {
	const { spawn, calls } = fakeSpawn();
	const notifier = createNotifier({ config: normalizeConfig({ cooldownMs: 60_000 }), spawn });
	notifier.notify("审批", "one");
	notifier.notify("审批", "two");
	notifier.notify("提问", "three");
	assert.deepEqual(calls.filter((call) => call.command === "notify-send").map((call) => call.args[4]), ["审批", "提问"]);
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
	assert.equal(normalizeConfig({}).maxBodyChars, DEFAULTS.maxBodyChars);
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
	install(harness.ctx, {}, { spawn });
	harness.fire("session/event", {}, { type: "agent/message", data: {} });
	assert.equal(calls.length, 0);
	harness.fire("session/event", {}, { type: "approval/asked", data: { toolName: "bash", reason: "写工作区外" } });
	assert.equal(calls.length, 2);
	assert.deepEqual(calls[0].args.slice(4), ["需要你审批", "bash: 写工作区外"]);
});

test("the question listener always continues the waterfall", () => {
	const harness = fakeCtx();
	const { calls, spawn } = fakeSpawn();
	install(harness.ctx, {}, { spawn });
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
