import path from "node:path";
import { readConfig } from "./files.ts";

export interface AuthSettings {
	token: string;
	source: string;
}

async function readSettings(file: string): Promise<AuthSettings | undefined> {
	const content = await readConfig(file, "npm-auth.json", true);
	if (content === undefined) return undefined;
	let value: unknown;
	try { value = JSON.parse(content); }
	catch { throw new Error("npm-auth.json is not valid JSON."); }
	if (typeof value !== "object" || value === null || Array.isArray(value) ||
		!("token" in value) || typeof value.token !== "string" ||
		!value.token || value.token.length > 4096 || !/^[A-Za-z0-9_-]+$/.test(value.token)) {
		throw new Error("npm-auth.json must contain a non-empty token using letters, digits, underscores or hyphens.");
	}
	return { token: value.token, source: file };
}

/** A malformed local file must never silently fall back to a global credential. */
export async function loadSettings(cwd: string, agentDir: string, trusted: boolean): Promise<AuthSettings | undefined> {
	if (trusted) {
		const local = await readSettings(path.join(cwd, ".pi", "npm-auth.json"));
		if (local) return local;
	}
	return readSettings(path.join(agentDir, "npm-auth.json"));
}
