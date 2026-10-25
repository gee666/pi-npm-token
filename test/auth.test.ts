import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { chmod, mkdir, mkdtemp, readFile, rm, stat, symlink, writeFile } from "node:fs/promises";
import path from "node:path";
import { test } from "node:test";
import { promisify } from "node:util";
import { createBashTool, type ExtensionAPI, type ExtensionContext } from "@earendil-works/pi-coding-agent";
import { loadSettings } from "../src/config.ts";
import { activateCredentials } from "../src/credentials.ts";
import extension from "../src/index.ts";

const exec = promisify(execFile);
const token = "npm_TEST_TOKEN_NOT_A_REAL_SECRET";
const keys = ["NPM_TOKEN", "npm_config_userconfig", "NPM_CONFIG_USERCONFIG", "PI_CODING_AGENT_DIR"];

async function fixture(run: (root: string, agent: string) => Promise<void>) {
	await mkdir("tmp", { recursive: true });
	const root = await mkdtemp(path.resolve("tmp/test-"));
	const agent = path.join(root, "agent");
	await mkdir(agent);
	await mkdir(path.join(root, ".pi"));
	const before = keys.map((key) => [key, process.env[key]] as const);
	for (const key of keys) delete process.env[key];
	process.env.PI_CODING_AGENT_DIR = agent;
	// Never read the developer's actual npm credentials in tests.
	process.env.NPM_CONFIG_USERCONFIG = path.join(root, "original.npmrc");
	try { await run(root, agent); }
	finally {
		for (const [key, value] of before) {
			if (value === undefined) delete process.env[key]; else process.env[key] = value;
		}
		await rm(root, { recursive: true, force: true });
	}
}

async function settings(file: string, value: unknown) {
	await writeFile(file, JSON.stringify(value), { mode: 0o600 });
}

test("settings precedence, project trust, and no configuration", async () => fixture(async (root, agent) => {
	assert.equal(await loadSettings(root, agent, true), undefined);
	await settings(path.join(agent, "npm-auth.json"), { token: "global" });
	assert.equal((await loadSettings(root, agent, true))?.token, "global");
	await settings(path.join(root, ".pi/npm-auth.json"), { token: "local" });
	assert.equal((await loadSettings(root, agent, true))?.token, "local");
	assert.equal((await loadSettings(root, agent, false))?.token, "global");
}));

test("invalid local settings never fall back and diagnostics never echo credentials", async () => fixture(async (root, agent) => {
	await settings(path.join(agent, "npm-auth.json"), { token: "global" });
	const local = path.join(root, ".pi/npm-auth.json");
	for (const value of [{ token: "secret\nregistry=evil" }, { token: "" }, { token: 12 }, [], null]) {
		await settings(local, value);
		await assert.rejects(loadSettings(root, agent, true), (error: unknown) => {
			assert.ok(error instanceof Error);
			assert.ok(!error.message.includes("secret"));
			return true;
		});
	}
	await writeFile(local, `{"token":"${token}", invalid}`, { mode: 0o600 });
	await assert.rejects(loadSettings(root, agent, true), { message: "npm-auth.json is not valid JSON." });
	await settings(local, { token });
	if (process.platform !== "win32") {
		await chmod(local, 0o644);
		await assert.rejects(loadSettings(root, agent, true), /chmod 600/);
	}
}));

test("oversized settings and non-files are rejected", async () => fixture(async (root, agent) => {
	const file = path.join(root, ".pi/npm-auth.json");
	await writeFile(file, "x".repeat(65_537), { mode: 0o600 });
	await assert.rejects(loadSettings(root, agent, true), /regular file smaller/);
	await rm(file);
	await mkdir(file);
	await assert.rejects(loadSettings(root, agent, true), /regular file smaller|Cannot open/);
}));

test("npm subprocess inherits auth without changing original config, cleanup restores environment", async () => fixture(async (root) => {
	const original = process.env.NPM_CONFIG_USERCONFIG!;
	await writeFile(original, "fetch-retries=0\n", { mode: 0o600 });
	process.env.NPM_TOKEN = "previous";
	const active = await activateCredentials(root, { token, source: "test" });
	const temporary = process.env.npm_config_userconfig!;
	try {
		assert.equal(process.env.NPM_TOKEN, token);
		assert.equal(process.env.NPM_CONFIG_USERCONFIG, temporary);
		const content = await readFile(temporary, "utf8");
		assert.match(content, /fetch-retries=0/);
		assert.match(content, /\/\/registry\.npmjs\.org\/:_authToken=\$\{NPM_TOKEN\}/);
		assert.ok(!content.includes(token));
		if (process.platform !== "win32") {
			assert.equal((await stat(temporary)).mode & 0o777, 0o600);
			assert.equal((await stat(path.dirname(temporary))).mode & 0o777, 0o700);
		}
		const result = await exec("npm", ["config", "get", "userconfig"], { cwd: root, timeout: 15_000 });
		assert.equal(result.stdout.trim(), temporary);
		const config = await exec("npm", ["config", "list"], { cwd: root, timeout: 15_000 });
		assert.match(config.stdout, /\/\/registry\.npmjs\.org\/:_authToken = \(protected\)/);
		assert.ok(!config.stdout.includes(token));
		if (process.platform !== "win32") {
			const bash = createBashTool(root);
			const result = await bash.execute("npm-auth-test", { command: "npm config list", timeout: 15 });
			const output = result.content.filter((part) => part.type === "text").map((part) => part.text).join("\n");
			assert.match(output, /\/\/registry\.npmjs\.org\/:_authToken = \(protected\)/);
			assert.ok(!output.includes(token));
		}
		const inherited = await exec(process.execPath, ["-e", "if (process.env.NPM_TOKEN !== 'npm_TEST_TOKEN_NOT_A_REAL_SECRET') process.exit(1)"], { cwd: root, timeout: 5000 });
		assert.equal(inherited.stdout, "");
		await settings(path.join(root, "package.json"), { scripts: { "auth-check": "node auth-check.cjs" } });
		await writeFile(path.join(root, "auth-check.cjs"), `
const assert = require('node:assert/strict');
assert.ok(process.env.NPM_TOKEN === 'npm_TEST_TOKEN_NOT_A_REAL_SECRET', 'lifecycle token missing');
assert.ok(require('node:fs').readFileSync(process.env.npm_config_userconfig, 'utf8').includes('_authToken'));
console.log('LIFECYCLE_AUTH_OK');
`);
		const lifecycle = await exec("npm", ["run", "--silent", "auth-check"], { cwd: root, timeout: 15_000 });
		assert.equal(lifecycle.stdout.trim(), "LIFECYCLE_AUTH_OK");
		assert.ok(!lifecycle.stdout.includes(token));
		assert.equal(await readFile(original, "utf8"), "fetch-retries=0\n");
	} finally { await active.dispose(); }
	await active.dispose();
	assert.equal(process.env.NPM_TOKEN, "previous");
	assert.equal(process.env.npm_config_userconfig, undefined);
	assert.equal(process.env.NPM_CONFIG_USERCONFIG, original);
	await assert.rejects(stat(temporary), { code: "ENOENT" });
}));

test("failed setup leaves environment unchanged and cleanup respects other extensions", async () => fixture(async (root) => {
	await writeFile(path.join(root, "tmp"), "not a directory");
	await assert.rejects(activateCredentials(root, { token, source: "test" }), /Cannot prepare npm authentication/);
	assert.equal(process.env.NPM_TOKEN, undefined);
	await rm(path.join(root, "tmp"));
	const active = await activateCredentials(root, { token, source: "test" });
	process.env.NPM_TOKEN = "other-extension";
	await active.dispose();
	assert.equal(process.env.NPM_TOKEN, "other-extension");
}));

test("overlapping activations including module copies are rejected without corrupting restoration", async () => fixture(async (root) => {
	const other: typeof import("../src/credentials.ts") = await import(new URL("../src/credentials.ts?second-copy", import.meta.url).href);
	const pending = activateCredentials(root, { token, source: "first" });
	await assert.rejects(other.activateCredentials(root, { token: "second", source: "second" }), /already managed/);
	const active = await pending;
	const generated = process.env.npm_config_userconfig!;
	await assert.rejects(activateCredentials(root, { token: "third", source: "third" }), /already managed/);
	assert.equal(process.env.NPM_TOKEN, token);
	assert.equal(process.env.npm_config_userconfig, generated);
	await Promise.all([active.dispose(), active.dispose()]);
	assert.equal(process.env.NPM_TOKEN, undefined);
	const next = await other.activateCredentials(root, { token: "next", source: "next" });
	await next.dispose();
	assert.equal(process.env.NPM_TOKEN, undefined);
}));

test("INI sections do not swallow the root npm authentication entry", async () => fixture(async (root) => {
	await writeFile(process.env.NPM_CONFIG_USERCONFIG!, "fetch-retries=0\n[example]\nsetting=value\n", { mode: 0o600 });
	const active = await activateCredentials(root, { token, source: "test" });
	try {
		const config = await exec("npm", ["config", "list"], { cwd: root, timeout: 15_000 });
		assert.match(config.stdout, /\/\/registry\.npmjs\.org\/:_authToken = \(protected\)/);
		const content = await readFile(process.env.npm_config_userconfig!, "utf8");
		assert.ok(content.indexOf("_authToken") < content.indexOf("[example]"));
		assert.match(content, /setting=value/);
	} finally { await active.dispose(); }
}));

test("project-selected userconfig is rejected explicitly without modifying the environment", async () => fixture(async (root) => {
	await writeFile(path.join(root, ".npmrc"), '"userconfig"=./custom.npmrc\n');
	await assert.rejects(activateCredentials(root, { token, source: "test" }), /userconfig settings are not supported/);
	assert.equal(process.env.NPM_TOKEN, undefined);
}));

test("symlinked or shared writable temp roots are rejected", async () => fixture(async (root) => {
	if (process.platform === "win32") return;
	const target = path.join(root, "outside");
	await mkdir(target);
	await symlink(target, path.join(root, "tmp"));
	await assert.rejects(activateCredentials(root, { token, source: "test" }), /not a symlink/);
	await rm(path.join(root, "tmp"));
	await mkdir(path.join(root, "tmp"));
	await chmod(path.join(root, "tmp"), 0o777);
	await assert.rejects(activateCredentials(root, { token, source: "test" }), /not writable by other users/);
	assert.equal(process.env.NPM_TOKEN, undefined);
}));

test("FIFO token and npmrc files are rejected without blocking", { timeout: 5000 }, async () => fixture(async (root, agent) => {
	if (process.platform === "win32") return;
	const fifo = path.join(agent, "npm-auth.json");
	await exec("mkfifo", [fifo], { timeout: 1000 });
	await assert.rejects(loadSettings(root, agent, true), /regular file/);
	await exec("mkfifo", [process.env.NPM_CONFIG_USERCONFIG!], { timeout: 1000 });
	await assert.rejects(activateCredentials(root, { token, source: "test" }), /regular file/);
	assert.equal(process.env.NPM_TOKEN, undefined);
}));

test("startup and reload are silent, errors notify once, and status line stays untouched", async () => fixture(async (root, agent) => {
	type Handler = (event: unknown, ctx: ExtensionContext) => unknown;
	const handlers = new Map<string, Handler>();
	let command: ((args: string, ctx: ExtensionContext) => Promise<void>) | undefined;
	const notices: { message: string; type: string | undefined }[] = [];
	const statuses: (string | undefined)[] = [];
	const pi = {
		on(name: string, handler: Handler) { handlers.set(name, handler); },
		registerCommand(_name: string, spec: { handler: typeof command }) { command = spec.handler; },
	} as unknown as ExtensionAPI;
	let releaseIdle: (() => void) | undefined;
	let idle = Promise.resolve();
	const ctx = {
		cwd: root, isProjectTrusted: () => true, waitForIdle: () => idle,
		ui: { notify(message: string, type?: string) { notices.push({ message, type }); }, setStatus(_key: string, text: string | undefined) { statuses.push(text); } },
	} as unknown as ExtensionContext;
	extension(pi);
	const config = path.join(agent, "npm-auth.json");
	await settings(config, { token });
	await handlers.get("session_start")!({}, ctx);
	const first = process.env.npm_config_userconfig!;
	assert.equal(process.env.NPM_TOKEN, token);
	await settings(config, { token: "replacement" });
	idle = new Promise<void>((resolve) => { releaseIdle = resolve; });
	const reloading = command!("", ctx);
	await new Promise<void>((resolve) => setImmediate(resolve));
	assert.equal(process.env.NPM_TOKEN, token, "reload must not change credentials until idle");
	assert.equal(process.env.npm_config_userconfig, first);
	releaseIdle!();
	await reloading;
	assert.equal(process.env.NPM_TOKEN, "replacement");
	await assert.rejects(stat(first), { code: "ENOENT" });
	assert.deepEqual(notices, []);
	assert.deepEqual(statuses, []);
	await writeFile(config, `{"token":"${token}", broken}`);
	await command!("", ctx);
	assert.equal(process.env.NPM_TOKEN, undefined);
	assert.deepEqual(notices, [{ message: "npm-auth.json is not valid JSON.", type: "error" }]);
	assert.deepEqual(statuses, []);
	await settings(config, { token: "recovered" });
	await command!("", ctx);
	assert.equal(process.env.NPM_TOKEN, "recovered", "invalid reload must not prevent recovery");
	await rm(config);
	await command!("", ctx);
	assert.equal(process.env.NPM_TOKEN, undefined, "removed settings must release active auth");
	assert.equal(process.env.NPM_CONFIG_USERCONFIG, path.join(root, "original.npmrc"));
	await handlers.get("session_shutdown")!({}, ctx);
	await handlers.get("session_shutdown")!({}, ctx);
}));
