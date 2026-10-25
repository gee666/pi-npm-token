import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { once } from "node:events";
import { createServer } from "node:http";
import { mkdir, mkdtemp, readFile, readdir, rm, stat, writeFile } from "node:fs/promises";
import path from "node:path";
import { test } from "node:test";

const repo = process.cwd();
const provider = process.env.PI_EVERGREEN_E2E_PROVIDER ?? "openai";
const model = process.env.PI_EVERGREEN_E2E_MODEL ?? "gpt-6-luna";
const reasoning = process.env.PI_EVERGREEN_E2E_REASONING ?? "medium";
const globalToken = "npm_EVERGREEN_GLOBAL_SENTINEL";
const localToken = "npm_EVERGREEN_LOCAL_SENTINEL";
const replacement = "npm_EVERGREEN_REPLACEMENT_SENTINEL";
const sentinels = [globalToken, localToken, replacement];
const json = (file, value) => writeFile(file, JSON.stringify(value), { mode: 0o600 });
function noLeaks(value) {
	for (const token of sentinels) assert.ok(!JSON.stringify(value).includes(token), "token leaked into provider request/session");
}

// A loopback OpenAI transport, not a mocked Pi tool/provider function. Real Pi serializes
// every request and consumes SSE, then executes its own bash tool and follows up.
test("global CLI: auth inheritance, all outbound turns, retry, compaction, reload, replacement and recovery", { timeout: 120_000 }, async () => {
	assert.ok(process.env.PI_EVERGREEN_PI_BIN, "PI_EVERGREEN_PI_BIN is required; never substitute an npm runtime");
	await mkdir(path.join(repo, "tmp"), { recursive: true });
	const root = await mkdtemp(path.join(repo, "tmp/e2e-"));
	const agent = path.join(root, "agent");
	await mkdir(agent);
	await mkdir(path.join(root, ".pi"));
	const requests = [];
	let toolNext = true;
	let retryNext = false;
	let retryCount = 0;
	let summaryNext = false;
	const server = createServer(async (req, res) => {
		let raw = "";
		for await (const chunk of req) raw += chunk;
		const body = JSON.parse(raw);
		requests.push({ url: req.url, body, headers: req.headers });
		if (retryNext) {
			retryNext = false;
			retryCount++;
			res.writeHead(503, { "content-type": "application/json" });
			res.end(JSON.stringify({ error: { message: "overloaded: evergreen retry", type: "server_error" } }));
			return;
		}
		const summary = summaryNext;
		const tool = !summary && toolNext;
		if (!summary) toolNext = !toolNext;
		const delta = tool ? {
			role: "assistant", tool_calls: [{ index: 0, id: `probe_${requests.length}`, type: "function",
				function: { name: "bash", arguments: JSON.stringify({ command: "node probe.cjs", timeout: 10 }) } }],
		} : { role: "assistant", content: summary ? "## Summary\nHarmless auth probe completed." : "Done." };
		res.writeHead(200, { "content-type": "text/event-stream" });
		for (const [d, finish] of [[delta, null], [{}, tool ? "tool_calls" : "stop"]]) {
			res.write(`data: ${JSON.stringify({ id: `chat_${requests.length}`, object: "chat.completion.chunk", model,
				choices: [{ index: 0, delta: d, finish_reason: finish }] })}\n\n`);
		}
		res.end("data: [DONE]\n\n");
	});
	server.listen(0, "127.0.0.1");
	await once(server, "listening");
	const endpoint = `http://127.0.0.1:${server.address().port}/v1`;
	let child;
	let stderr = "";
	let records = [];
	let sequence = 0;
	const waiters = new Set();
	function waitFor(predicate) {
		return new Promise((resolve, reject) => {
			const timer = setTimeout(() => { waiters.delete(check); reject(new Error(`Pi deadline: ${stderr}`)); }, 25_000);
			function check(record) {
				if (!predicate(record)) return;
				clearTimeout(timer); waiters.delete(check); resolve(record);
			}
			waiters.add(check);
		});
	}
	async function command(type, data = {}) {
		const id = String(++sequence);
		const result = waitFor((record) => record.type === "response" && record.id === id);
		child.stdin.write(JSON.stringify({ id, type, ...data }) + "\n");
		const response = await result;
		assert.equal(response.success, true, JSON.stringify(response));
		return response.data;
	}
	async function prompt() {
		const before = requests.length;
		const settled = waitFor((record) => record.type === "agent_settled");
		await command("prompt", { message: "Run the harmless local auth probe." });
		await settled;
		assert.ok(requests.length >= before + 2, "must see actual tool call and follow-up requests");
		const followup = requests.at(-1).body;
		assert.ok(followup.messages.some((m) => m.role === "tool" && JSON.stringify(m).includes("AUTH_OK")), "real bash result must reach transport");
		noLeaks(requests);
	}
	async function probe(expected) {
		await json(path.join(root, "expected.json"), { token: expected });
		const result = await command("bash", { command: "node probe.cjs" });
		assert.equal(result.exitCode, 0, result.output);
		assert.match(result.output, /AUTH_OK/);
	}
	async function snapshots() {
		return (await readFile(path.join(root, "lifecycle.jsonl"), "utf8")).trim().split("\n").map(JSON.parse);
	}
	async function gone(file) { await assert.rejects(stat(file), { code: "ENOENT" }); }
	async function stop() {
		const exited = once(child, "exit");
		child.stdin.end();
		const [code] = await exited;
		assert.equal(code, 0, stderr);
		child = undefined;
	}
	try {
		await json(path.join(agent, "models.json"), { providers: { [provider]: {
			baseUrl: endpoint, api: "openai-completions", apiKey: "evergreen-dummy-key",
			models: [{ id: model, name: model, reasoning: true, input: ["text"],
				contextWindow: 32000, maxTokens: 256, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 } }],
		} } });
		await json(path.join(agent, "settings.json"), { retry: { enabled: true, maxRetries: 1, baseDelayMs: 1 }, compaction: { keepRecentTokens: 1, reserveTokens: 256 } });
		await json(path.join(agent, "npm-auth.json"), { token: globalToken });
		await json(path.join(root, ".pi/npm-auth.json"), { token: localToken });
		const original = path.join(root, "original.npmrc");
		await writeFile(original, "fetch-retries=0\n");
		// Token expectations stay on disk, never in command args, prompts or tool output.
		await writeFile(path.join(root, "probe.cjs"), `const assert = require('node:assert/strict');
const fs = require('node:fs');
const {execFileSync} = require('node:child_process');
const expected = JSON.parse(fs.readFileSync('expected.json')).token;
assert.ok(process.env.NPM_TOKEN === expected, 'credential mismatch');
if (expected) {
 assert.equal(process.env.npm_config_userconfig, process.env.NPM_CONFIG_USERCONFIG);
 const config = fs.readFileSync(process.env.npm_config_userconfig, 'utf8');
 assert.ok(config.includes('//registry.npmjs.org/:_authToken=\\$' + '{NPM_TOKEN}'));
 assert.ok(!config.includes(expected));
 assert.match(execFileSync('npm', ['config', 'list'], {encoding:'utf8'}), /_authToken = \\(protected\\)/);
}
console.log('AUTH_OK');
`);
		async function start(trust) {
			records = [];
			const env = { PATH: process.env.PATH, HOME: root, PI_CODING_AGENT_DIR: agent,
				NPM_CONFIG_USERCONFIG: original, PI_OFFLINE: "1", PI_TELEMETRY: "0" };
			child = spawn(process.env.PI_EVERGREEN_PI_BIN, ["--mode", "rpc", "--offline", trust,
				"--no-extensions", "--no-skills", "--no-prompt-templates", "--no-themes", "--no-context-files", "--no-mcp",
				"--extension", path.join(repo, "src/index.ts"), "--extension", path.join(repo, "test/fixtures/lifecycle.ts"),
				"--provider", provider, "--model", model, "--thinking", reasoning, "--tools", "bash", "--session-dir", path.join(root, "sessions")],
			{ cwd: root, env, stdio: ["pipe", "pipe", "pipe"] });
			let buffer = "";
			child.stderr.on("data", (data) => { stderr += data; });
			child.stdout.on("data", (data) => {
				buffer += data;
				let newline;
				while ((newline = buffer.indexOf("\n")) >= 0) {
					const record = JSON.parse(buffer.slice(0, newline)); buffer = buffer.slice(newline + 1);
					records.push(record);
					for (const waiter of waiters) waiter(record);
				}
			});
			await command("get_state");
		}
		await start("--approve");
		await probe(localToken);
		// Negative control: the same real shell probe must reject the wrong credential.
		await json(path.join(root, "expected.json"), { token: "wrong-sentinel" });
		assert.notEqual((await command("bash", { command: "node probe.cjs", excludeFromContext: true })).exitCode, 0);
		await json(path.join(root, "expected.json"), { token: localToken });
		await prompt();
		retryNext = true;
		await prompt();
		assert.equal(retryCount, 1);
		summaryNext = true;
		await command("compact");
		summaryNext = false;
		await prompt();
		const first = (await snapshots()).at(-1).lower;
		await json(path.join(root, ".pi/npm-auth.json"), { token: replacement });
		await command("prompt", { message: "/npm-token" });
		await gone(first);
		await probe(replacement);
		await prompt();
		await command("prompt", { message: "/evergreen-reload" });
		await probe(replacement);
		await command("new_session");
		await probe(replacement);
		await prompt();
		// Invalid reload releases previous auth and does not fall back to global settings.
		await writeFile(path.join(root, ".pi/npm-auth.json"), "{invalid");
		await command("prompt", { message: "/npm-token" });
		await probe(undefined);
		assert.equal(records.filter((r) => r.type === "extension_ui_request" && r.method === "notify").length, 1);
		await json(path.join(root, ".pi/npm-auth.json"), { token: replacement });
		await command("prompt", { message: "/npm-token" });
		await probe(replacement);
		const entries = await command("get_entries");
		noLeaks(entries);
		await stop();
		for (const item of await snapshots()) {
			if (item.event === "session_shutdown") {
				assert.equal(item.token, undefined); assert.equal(item.lower, undefined); assert.equal(item.upper, original);
			} else if (item.lower) await gone(item.lower);
		}
		await start("--no-approve");
		await probe(globalToken);
		await prompt();
		await stop();
		await rm(path.join(agent, "npm-auth.json"));
		await start("--no-approve");
		await probe(undefined);
		await stop();
		assert.equal(await readFile(original, "utf8"), "fetch-retries=0\n");
		assert.deepEqual((await readdir(path.join(root, "tmp"))).filter((name) => name.startsWith("pi-npm-token-")), []);
		for (const file of await readdir(path.join(root, "sessions"), { recursive: true })) {
			if (file.endsWith(".jsonl")) noLeaks(await readFile(path.join(root, "sessions", file), "utf8"));
		}
		noLeaks(requests);
		assert.ok(requests.length >= 15);
		assert.ok(requests.every((r) => r.url === "/v1/chat/completions" && r.body.model === model));
		assert.ok(requests.some((r) => r.body.messages.some((m) => m.role === "system" || m.role === "developer")));
		assert.throws(() => noLeaks({ messages: [{ role: "system", content: localToken }] }), /token leaked/, "leak detector negative control");
	} finally {
		if (child) { child.kill("SIGKILL"); await once(child, "exit"); }
		server.closeAllConnections();
		await new Promise((resolve) => server.close(resolve));
		await rm(root, { recursive: true, force: true });
	}
});
