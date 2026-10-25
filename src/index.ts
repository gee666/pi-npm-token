import { getAgentDir, type ExtensionAPI, type ExtensionContext } from "@earendil-works/pi-coding-agent";
import { loadSettings } from "./config.ts";
import { activateCredentials, type Credentials } from "./credentials.ts";

export default function npmToken(pi: ExtensionAPI) {
	let credentials: Credentials | undefined;

	async function cleanup() {
		await credentials?.dispose();
		credentials = undefined;
	}

	async function configure(ctx: ExtensionContext) {
		try {
			await cleanup();
			const settings = await loadSettings(ctx.cwd, getAgentDir(), ctx.isProjectTrusted());
			if (settings) credentials = await activateCredentials(ctx.cwd, settings);
		} catch (error) {
			ctx.ui.notify(error instanceof Error ? error.message : "Could not configure npm authentication.", "error");
		}
	}

	pi.on("session_start", async (_event, ctx) => configure(ctx));
	pi.on("session_shutdown", async (_event, ctx) => {
		try { await cleanup(); }
		catch { ctx.ui.notify("Could not remove the temporary npm config. Check the project's tmp directory.", "error"); }
	});
	pi.registerCommand("npm-token", {
		description: "Reload npm-auth.json silently, reporting only errors",
		handler: async (_args, ctx) => {
			await ctx.waitForIdle();
			await configure(ctx);
		},
	});
}
