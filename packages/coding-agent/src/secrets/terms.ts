/**
 * Read/write access to the terms in `secrets.yml`.
 *
 * `secrets.yml` is the single source of truth: the obfuscator reads it directly
 * and this module is the only writer. Keeping the mutation path here (rather
 * than in the slash command) means the settings UI and the command cannot drift
 * into two different serializations of the same file.
 *
 * The file is a YAML array of entries. Terms added through this module are
 * written as `plain` entries, which is what the obfuscator treats as a literal
 * substring. Terms the user hand-writes with `type: regex` are preserved
 * verbatim on rewrite — this module never normalizes or drops them.
 */
import * as fs from "node:fs/promises";
import * as path from "node:path";
import { isEnoent, logger } from "@oh-my-pi/pi-utils";
import { getAgentDir } from "@oh-my-pi/pi-utils/dirs";
import { YAML } from "bun";

/** Raw shape as stored on disk; unknown `type` values are preserved untouched. */
interface RawSecretFileEntry {
	type?: unknown;
	content?: unknown;
	friendlyName?: unknown;
	[key: string]: unknown;
}

export interface SecretTermSummary {
	/** Literal term text (a regex entry's source, already unescaped). */
	content: string;
	type: "plain" | "regex";
	kind: "keyword" | "pattern";
}

/**
 * Path of the global secrets file the obfuscator reads.
 *
 * `agentDir` is passed explicitly (rather than resolved from `getAgentDir()`
 * here) so this stays in lockstep with the caller that already resolved the
 * active profile's agent dir.
 */
export function globalSecretsPath(agentDir: string): string {
	return path.join(agentDir, "secrets.yml");
}

/** Path of the project-scoped override, which takes precedence over the global file. */
export function projectSecretsPath(cwd: string): string {
	return path.join(cwd, ".omp", "secrets.yml");
}

async function readRawEntries(filePath: string): Promise<RawSecretFileEntry[]> {
	try {
		const text = await Bun.file(filePath).text();
		const parsed = YAML.parse(text);
		if (!Array.isArray(parsed)) return [];
		return parsed.filter((entry): entry is RawSecretFileEntry => typeof entry === "object" && entry !== null);
	} catch (err) {
		if (isEnoent(err)) return [];
		logger.warn("Failed to read secrets file", { path: filePath, error: String(err) });
		return [];
	}
}

/**
 * Every configured term, global entries first.
 *
 * The project file is not merged over the global one here: the listing is a
 * view of what is configured, and a term present in both should be reported
 * once, at the scope where it was first declared.
 */
export async function listSecretTerms(cwd: string): Promise<SecretTermSummary[]> {
	const seen = new Set<string>();
	const out: SecretTermSummary[] = [];
	for (const filePath of [globalSecretsPath(getAgentDir()), projectSecretsPath(cwd)]) {
		for (const entry of await readRawEntries(filePath)) {
			if (typeof entry.content !== "string" || entry.content.length === 0) continue;
			const type = entry.type === "regex" ? "regex" : "plain";
			const key = `${type}\u0000${entry.content}`;
			if (seen.has(key)) continue;
			seen.add(key);
			out.push({ content: entry.content, type, kind: type === "regex" ? "pattern" : "keyword" });
		}
	}
	return out;
}

/**
 * Add one literal term to the global file.
 *
 * Rejects terms already present so a repeated call cannot grow the file, and
 * rejects an empty/whitespace-only term, which would match every position in
 * every string. A single-character term is rejected rather than silently
 * ignored at obfuscation time, with the reason pointing at the regex form.
 */
export async function addSecretTerm(
	term: string,
): Promise<{ ok: true; added: string } | { ok: false; reason: string }> {
	const value = term.trim();
	if (value.length === 0) return { ok: false, reason: "The term is empty." };
	if (value.length === 1) {
		return {
			ok: false,
			reason: `"${value}" is a single character and would match inside unrelated text. Add it as a regex with boundaries instead.`,
		};
	}

	const filePath = globalSecretsPath(getAgentDir());
	const entries = await readRawEntries(filePath);
	if (entries.some(entry => entry.content === value)) {
		return { ok: false, reason: `"${value}" is already configured.` };
	}

	// No `friendlyName`: the placeholder label comes from the
	// `secrets.placeholderPrefix` setting, so it stays in one place. An entry
	// only carries its own label when it needs to differ from the global one.
	entries.push({ type: "plain", content: value });
	await writeEntries(filePath, entries);
	return { ok: true, added: value };
}

/**
 * Remove every entry whose literal text matches `term`.
 *
 * Matching is by exact text so removing `合同` cannot accidentally drop the
 * separate `合同附件` entry. Regex entries are matched against their source
 * string, which is what the listing shows.
 */
export async function removeSecretTerm(
	term: string,
	cwd: string,
): Promise<{ ok: true; removed: number } | { ok: false; reason: string }> {
	const value = term.trim();
	if (value.length === 0) return { ok: false, reason: "The term is empty." };

	let removed = 0;
	for (const filePath of [globalSecretsPath(getAgentDir()), projectSecretsPath(cwd)]) {
		const entries = await readRawEntries(filePath);
		if (entries.length === 0) continue;
		const kept = entries.filter(entry => entry.content !== value);
		if (kept.length === entries.length) continue;
		removed += entries.length - kept.length;
		await writeEntries(filePath, kept);
	}

	if (removed === 0) return { ok: false, reason: `"${value}" is not configured.` };
	return { ok: true, removed };
}

/**
 * Serialize entries back to YAML.
 *
 * Written as a diff-free full rewrite: the file is a flat list owned by this
 * module, and a partial edit would have to locate the exact byte range of an
 * entry, which is more fragile than rewriting a list this small. Unknown keys
 * on preserved entries survive because each entry object is re-emitted whole.
 */
async function writeEntries(filePath: string, entries: RawSecretFileEntry[]): Promise<void> {
	const header = [
		"# Terms obfuscated before leaving this machine for an AI provider.",
		"# Managed by `omp` (the /secrets command and the secrets settings UI).",
		"# Entries are literal substrings unless `type: regex`.",
		"",
	].join("\n");
	const body = YAML.stringify(entries);
	await fs.mkdir(path.dirname(filePath), { recursive: true });
	await Bun.write(filePath, `${header}${body}`);
}
