import * as os from "node:os";
import * as path from "node:path";

/** Replace the current home-directory prefix with `~` for user-visible paths. */
export function shortenPath(filePath: unknown, homeDir?: string): string {
	if (typeof filePath !== "string") return "";
	const home = homeDir ?? os.homedir();
	if (!home || !filePath.startsWith(home)) return filePath;

	const suffix = filePath.slice(home.length);
	if (suffix !== "" && !suffix.startsWith(path.posix.sep) && !suffix.startsWith(path.win32.sep)) return filePath;
	return `~${suffix.replaceAll(path.win32.sep, path.posix.sep)}`;
}
