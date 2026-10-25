import { constants } from "node:fs";
import { open } from "node:fs/promises";

/** Nonblocking open prevents FIFOs from hanging session startup on POSIX. */
export async function readConfig(file: string, label: string, privateFile = false): Promise<string | undefined> {
	let handle;
	try {
		handle = await open(file, constants.O_RDONLY | (process.platform === "win32" ? 0 : constants.O_NONBLOCK));
	} catch (error) {
		if (error instanceof Error && "code" in error && error.code === "ENOENT") return undefined;
		throw new Error(`Cannot open ${label}. Check its path and permissions.`);
	}
	try {
		const info = await handle.stat();
		if (!info.isFile() || info.size > 65_536) throw new Error(`${label} must be a regular file smaller than 64 KiB.`);
		if (privateFile && process.platform !== "win32" && (info.mode & 0o077) !== 0) {
			throw new Error(`${label} must be private. Run chmod 600 on the settings file.`);
		}
		return await handle.readFile("utf8");
	} finally { await handle.close(); }
}
