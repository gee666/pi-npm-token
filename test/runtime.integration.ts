import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import path from "node:path";
import { test } from "node:test";
import { createAgentSession, DefaultResourceLoader, SessionManager, SettingsManager } from "@earendil-works/pi-coding-agent";

test("real Pi runtime loads auth, reloads credentials, recovers from invalid settings and restores the environment", async () => {
	await mkdir("tmp", { recursive: true });
	const root = await mkdtemp(path.resolve("tmp/integration-"));
	const agent = path.join(root, "agent");
	await mkdir(agent);
	const keys = ["NPM_TOKEN", "npm_config_userconfig", "NPM_CONFIG_USERCONFIG", "PI_CODING_AGENT_DIR", "PI_OFFLINE"];
	const before = keys.map((key) => [key, process.env[key]] as const);
	const original = path.join(root, "original.npmrc");
	const config = path.join(agent, "npm-auth.json");
	let session: Awaited<ReturnType<typeof createAgentSession>>["session"] | undefined;
	async function settings(token: string) {
		await writeFile(config, JSON.stringify({ token }), { mode: 0o600 });
	}
	async function gone(file: string) { await assert.rejects(stat(file), { code: "ENOENT" }); }
	try {
		process.env.PI_CODING_AGENT_DIR = agent;
		process.env.PI_OFFLINE = "1";
		process.env.NPM_TOKEN = "previous";
		delete process.env.npm_config_userconfig;
		process.env.NPM_CONFIG_USERCONFIG = original;
		await writeFile(original, "fetch-retries=0\n", { mode: 0o600 });
		await settings("npm_INTEGRATION_FIRST");
		const settingsManager = SettingsManager.inMemory();
		const loader = new DefaultResourceLoader({
			cwd: root, agentDir: agent, settingsManager,
			noExtensions: true, noSkills: true, noPromptTemplates: true, noThemes: true, noContextFiles: true,
			additionalExtensionPaths: [path.resolve("src/index.ts")],
		});
		await loader.reload();
		assert.deepEqual(loader.getExtensions().errors, []);
		({ session } = await createAgentSession({
			cwd: root, agentDir: agent, resourceLoader: loader, settingsManager,
			sessionManager: SessionManager.inMemory(root), tools: ["bash"],
		}));
		await session.bindExtensions({ onError: (error) => { throw new Error(error.error); } });
		assert.equal(process.env.NPM_TOKEN, "npm_INTEGRATION_FIRST");
		const first = process.env.npm_config_userconfig!;
		const shell = await session.executeBash("npm config list");
		assert.equal(shell.exitCode, 0);
		assert.match(shell.output, /_authToken = \(protected\)/);
		assert.ok(!shell.output.includes("npm_INTEGRATION_FIRST"));
		await settings("npm_INTEGRATION_REPLACEMENT");
		await session.prompt("/npm-token");
		await gone(first);
		assert.equal(process.env.NPM_TOKEN, "npm_INTEGRATION_REPLACEMENT");
		const second = process.env.npm_config_userconfig!;
		await session.reload();
		await gone(second);
		assert.equal(process.env.NPM_TOKEN, "npm_INTEGRATION_REPLACEMENT");
		const third = process.env.npm_config_userconfig!;
		await writeFile(config, "{invalid");
		await session.prompt("/npm-token");
		await gone(third);
		assert.equal(process.env.NPM_TOKEN, "previous");
		assert.equal(process.env.NPM_CONFIG_USERCONFIG, original);
		await settings("npm_INTEGRATION_RECOVERED");
		await session.prompt("/npm-token");
		assert.equal(process.env.NPM_TOKEN, "npm_INTEGRATION_RECOVERED");
		await rm(config);
		await session.prompt("/npm-token");
		assert.equal(process.env.NPM_TOKEN, "previous");
		assert.equal(await readFile(original, "utf8"), "fetch-retries=0\n");
	} finally {
		session?.dispose();
		for (const [key, value] of before) {
			if (value === undefined) delete process.env[key]; else process.env[key] = value;
		}
		await rm(root, { recursive: true, force: true });
	}
});
