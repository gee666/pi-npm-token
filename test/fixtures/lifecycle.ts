import { appendFile } from "node:fs/promises";
import path from "node:path";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";

// Loaded AFTER the real extension: observes completed setup/restoration, not a replacement.
export default function observer(pi: ExtensionAPI) {
	async function record(event: string, ctx: ExtensionContext) {
		await appendFile(path.join(ctx.cwd, "lifecycle.jsonl"), JSON.stringify({
			event, token: process.env.NPM_TOKEN,
			lower: process.env.npm_config_userconfig, upper: process.env.NPM_CONFIG_USERCONFIG,
		}) + "\n");
	}
	pi.on("session_start", async (_event, ctx) => record("session_start", ctx));
	pi.on("session_shutdown", async (_event, ctx) => record("session_shutdown", ctx));
	pi.registerCommand("evergreen-reload", {
		description: "Exercise the supported runtime reload API",
		handler: async (_args, ctx) => { await ctx.reload(); },
	});
}
