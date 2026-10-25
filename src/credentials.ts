import { lstat, mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { parse, stringify } from "ini";
import type { AuthSettings } from "./config.ts";
import { readConfig } from "./files.ts";

const KEYS = ["NPM_TOKEN", "npm_config_userconfig", "NPM_CONFIG_USERCONFIG"] as const;

declare global {
	var __oira666NpmTokenOwner: object | undefined;
}

export interface Credentials {
	source: string;
	dispose(): Promise<void>;
}

async function checkProjectConfig(cwd: string): Promise<void> {
	// Check ancestors too, since npm can find its project root above Pi's cwd.
	for (let dir = cwd; ; dir = path.dirname(dir)) {
		const content = await readConfig(path.join(dir, ".npmrc"), "project npm config");
		if (content !== undefined && Object.keys(parse(content)).some((key) => key.toLowerCase() === "userconfig")) {
			throw new Error("Project or ancestor .npmrc userconfig settings are not supported. Select the npm user config through NPM_CONFIG_USERCONFIG instead.");
		}
		if (path.dirname(dir) === dir) return;
	}
}

/** One owner per process, including separately loaded copies of this module. */
export async function activateCredentials(cwd: string, settings: AuthSettings): Promise<Credentials> {
	if (globalThis.__oira666NpmTokenOwner) throw new Error("npm authentication is already managed by another active extension instance.");
	const owner = {};
	globalThis.__oira666NpmTokenOwner = owner;
	const previous = new Map(KEYS.map((key) => [key, process.env[key]]));
	let directory: string | undefined;
	try {
		await checkProjectConfig(cwd);
		const originalConfig = process.env.npm_config_userconfig ?? process.env.NPM_CONFIG_USERCONFIG ?? path.join(os.homedir(), ".npmrc");
		const original = await readConfig(path.resolve(cwd, originalConfig), "npm user config") ?? "";
		const config: Record<string, unknown> = parse(original);
		config["//registry.npmjs.org/:_authToken"] = "${NPM_TOKEN}";
		const tempRoot = path.join(cwd, "tmp");
		await mkdir(tempRoot, { recursive: true });
		const info = await lstat(tempRoot);
		if (!info.isDirectory() || info.isSymbolicLink() ||
			(process.platform !== "win32" && (info.uid !== process.getuid?.() || (info.mode & 0o022) !== 0))) {
			throw new Error("The project's tmp directory must be owned by you, not a symlink, and not writable by other users.");
		}
		directory = await mkdtemp(path.join(tempRoot, "pi-npm-token-"));
		const generatedDirectory = directory;
		const userconfig = path.join(directory, "npmrc");
		await writeFile(userconfig, stringify(config), { mode: 0o600, flag: "wx" });
		const assigned = { NPM_TOKEN: settings.token, npm_config_userconfig: userconfig, NPM_CONFIG_USERCONFIG: userconfig };
		for (const key of KEYS) process.env[key] = assigned[key];
		let disposed = false;
		return {
			source: settings.source,
			async dispose() {
				if (disposed) return;
				for (const key of KEYS) {
					if (process.env[key] !== assigned[key]) continue;
					const value = previous.get(key);
					if (value === undefined) delete process.env[key];
					else process.env[key] = value;
				}
				await rm(generatedDirectory, { recursive: true, force: true });
				if (globalThis.__oira666NpmTokenOwner === owner) globalThis.__oira666NpmTokenOwner = undefined;
				disposed = true;
			},
		};
	} catch (error) {
		if (directory) await rm(directory, { recursive: true, force: true }).catch(() => {});
		globalThis.__oira666NpmTokenOwner = undefined;
		// Filesystem and parser errors can contain config values. Only emit our own diagnostics.
		if (error instanceof Error && /^(Project or ancestor|The project's tmp|npm user config|project npm config|Cannot open)/.test(error.message)) throw error;
		throw new Error("Cannot prepare npm authentication. Check the project's tmp directory and npm configuration.");
	}
}
