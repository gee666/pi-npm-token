import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { copyFile, chmod, mkdir, mkdtemp, readFile, readdir, rm, stat, writeFile } from "node:fs/promises";
import path from "node:path";
import { test } from "node:test";
import { getAgentDir } from "@earendil-works/pi-coding-agent";

const repo = process.cwd();
const tokens = ["npm_EVERGREEN_GLOBAL_SENTINEL", "npm_EVERGREEN_LOCAL_SENTINEL"];
const json = (file, value) => writeFile(file, JSON.stringify(value), { mode: 0o600 });
function noLeaks(value) {
	for (const token of tokens) assert.ok(!value.includes(token), "credential leaked into model payload, output or session");
}

// Real global CLI, real configured model, real bash and npm. No publishing or npm login.
test("global Pi gives local npm commands trusted auth without adding secrets to model context", { timeout: 900_000 }, async () => {
	assert.ok(process.env.EVERGREEN_E2E_MODEL, "EVERGREEN_E2E_MODEL must select the model used for e2e calls");
	await mkdir(path.join(repo, "tmp"), { recursive: true });
	const root = await mkdtemp(path.join(repo, "tmp/e2e-"));
	const agent = path.join(root, "agent");
	await mkdir(agent);
	await mkdir(path.join(root, ".pi"));
	try {
		// Isolate settings/resources while retaining the caller's model login, if present.
		try {
			await copyFile(path.join(getAgentDir(), "auth.json"), path.join(agent, "auth.json"));
			await chmod(path.join(agent, "auth.json"), 0o600);
		} catch (error) { if (error.code !== "ENOENT") throw error; }
		await json(path.join(agent, "npm-auth.json"), { token: tokens[0] });
		await json(path.join(root, ".pi/npm-auth.json"), { token: tokens[1] });
		const original = path.join(root, "original.npmrc");
		await writeFile(original, "fetch-retries=0\n", { mode: 0o600 });
		await writeFile(path.join(root, "probe.cjs"), `const fs = require('node:fs');
const {execFileSync} = require('node:child_process');
const expected = JSON.parse(fs.readFileSync('expected.json')).token;
function check(ok) { if (!ok) { console.error('AUTH_FAILED'); process.exit(1); } }
check(process.env.NPM_TOKEN === expected);
if (expected) {
 check(process.env.npm_config_userconfig === process.env.NPM_CONFIG_USERCONFIG);
 const config = fs.readFileSync(process.env.npm_config_userconfig, 'utf8');
 check(config.includes('//registry.npmjs.org/:_authToken=\$' + '{NPM_TOKEN}'));
 check(!config.includes(expected));
 check(/_authToken = \\(protected\\)/.test(execFileSync('npm', ['config', 'list'], {encoding:'utf8'})));
}
console.log('AUTH_OK');
`);
		for (const [index, trust, expected] of [[0, "--approve", tokens[1]], [1, "--no-approve", tokens[0]], [2, "--no-approve", undefined]]) {
			if (index === 2) await rm(path.join(agent, "npm-auth.json"));
			await json(path.join(root, "expected.json"), { token: expected });
			const sessionDir = path.join(root, `sessions-${index}`);
			const env = { ...process.env, HOME: root, PI_CODING_AGENT_DIR: agent,
				NPM_CONFIG_USERCONFIG: original, PI_OFFLINE: "1", PI_TELEMETRY: "0" };
			delete env.NPM_TOKEN;
			delete env.npm_config_userconfig;
			const child = spawn(process.env.EVERGREEN_PI_BIN || "pi", [
				"--print", "--mode", "json", "--offline", trust,
				"--no-extensions", "--no-skills", "--no-prompt-templates", "--no-themes", "--no-context-files", "--no-mcp",
				"--extension", path.join(repo, "src/index.ts"), "--extension", path.join(repo, "test/fixtures/lifecycle.ts"),
				"--model", process.env.EVERGREEN_E2E_MODEL, "--tools", "bash", "--session-dir", sessionDir,
				"Run exactly `node probe.cjs` once using bash. Do not read or modify files or environment variables. Report the result and stop.",
			], { cwd: root, env, stdio: ["ignore", "pipe", "pipe"] });
			let stdout = "", stderr = "";
			child.stdout.on("data", (chunk) => { stdout += chunk; });
			child.stderr.on("data", (chunk) => { stderr += chunk; });
			const timer = setTimeout(() => child.kill("SIGKILL"), 240_000);
			try {
				const code = await new Promise((resolve, reject) => { child.once("error", reject); child.once("close", resolve); });
				assert.equal(code, 0, stderr);
			} finally { clearTimeout(timer); }
			noLeaks(stdout + stderr);
			const events = stdout.trim().split("\n").map(JSON.parse);
			assert.ok(events.some((event) => event.type === "tool_execution_end" && event.toolName === "bash" &&
				!event.isError && JSON.stringify(event.result).includes("AUTH_OK")), "Pi must actually execute the successful auth probe");
			const files = (await readdir(sessionDir, { recursive: true })).filter((file) => file.endsWith(".jsonl"));
			assert.ok(files.length > 0, "sessions must be persisted");
			for (const file of files) noLeaks(await readFile(path.join(sessionDir, file), "utf8"));
		}
		const snapshots = (await readFile(path.join(root, "lifecycle.jsonl"), "utf8")).trim().split("\n").map(JSON.parse);
		assert.equal(snapshots.filter((item) => item.event === "session_start").length, 3);
		assert.equal(snapshots.filter((item) => item.event === "session_shutdown").length, 3);
		for (const item of snapshots) {
			if (item.event === "session_shutdown") {
				assert.equal(item.token, undefined);
				assert.equal(item.lower, undefined);
				assert.equal(item.upper, original);
			} else if (item.lower) await assert.rejects(stat(item.lower), { code: "ENOENT" });
		}
		const requests = await readFile(path.join(root, "requests.jsonl"), "utf8");
		noLeaks(requests);
		assert.ok(requests.trim().split("\n").length >= 6, "each model must receive a tool follow-up");
		assert.equal(await readFile(original, "utf8"), "fetch-retries=0\n");
		assert.deepEqual(await readdir(path.join(root, "tmp")), []);
		assert.throws(() => noLeaks(tokens[0]), /credential leaked/, "leak detector negative control");
	} finally { await rm(root, { recursive: true, force: true }); }
});
