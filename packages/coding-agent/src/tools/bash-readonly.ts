/**
 * Conservative "provably read-only" classifier for a bash command line.
 *
 * Mirrors the industry pattern for agent shell access (Claude Code's built-in
 * read-only command set, `auto` mode's "every segment provably read-only",
 * `pi-permission`'s `readonlyBashCommands`): instead of granting or denying the
 * whole `bash` tool, decide per command line whether it can only observe.
 *
 * The contract is deliberately one-sided: `true` means "this command cannot
 * mutate the workspace, the host, or remote state". Every uncertainty — shell
 * control characters, command substitution, unsupported binaries, unlisted
 * subcommands, a second segment — resolves to `false`, so an unmodeled case
 * degrades to "needs approval" rather than silently running.
 *
 * @see hasBashApprovalShellControl in `./bash` for the same shell-control
 * footprint used by the approval-pattern matcher.
 */
import { tokenizeShellSegments } from "./shell-tokenize";

/**
 * Characters that let a command line escape the single-command shape this
 * classifier reasons about: sequencing, piping, redirection, backgrounding,
 * subshells, and expansion/substitution (which re-enters the shell with
 * generated text). Quoting is preserved, so this is tested against the raw
 * command line — `$` stays conservative and rejects plain variable expansion
 * too.
 */
const SHELL_CONTROL_RE = /[;&|<>`$()]/u;

/** `git` subcommands that only report repository state. */
const GIT_READ_ONLY_SUBCOMMANDS: Record<string, true> = {
	status: true,
	log: true,
	show: true,
	diff: true,
	"diff-tree": true,
	"diff-index": true,
	"diff-files": true,
	blame: true,
	shortlog: true,
	"ls-files": true,
	"ls-tree": true,
	"cat-file": true,
	"rev-parse": true,
	"rev-list": true,
	"name-rev": true,
	describe: true,
	"show-ref": true,
	"for-each-ref": true,
	"count-objects": true,
	"verify-commit": true,
	"verify-tag": true,
	"check-ignore": true,
	"check-attr": true,
	"check-ref-format": true,
	var: true,
	whatchanged: true,
	grep: true,
};

/**
 * `git` subcommands whose bare form lists state but whose arguments can write
 * (`git branch <name>` creates, `git remote add` mutates). Only the explicit
 * listing forms are accepted.
 */
function isGitListingReadOnly(subcommand: string, positionals: readonly string[]): boolean {
	switch (subcommand) {
		case "branch":
		case "tag":
			// Bare (`git branch`) and flag-only (`git branch -a`) list; any
			// positional is a create/rename/delete target.
			return positionals.length === 0;
		case "stash":
			return positionals[0] === "list" || positionals[0] === "show";
		case "worktree":
			return positionals[0] === "list";
		case "reflog":
			return positionals.length === 0 || positionals[0] === "show";
		case "remote":
			return positionals.length === 0 || positionals[0] === "show" || positionals[0] === "get-url";
		default:
			return false;
	}
}

const GIT_LISTING_SUBCOMMANDS: Record<string, true> = {
	branch: true,
	tag: true,
	stash: true,
	worktree: true,
	reflog: true,
	remote: true,
};

function isGitReadOnly(args: readonly string[]): boolean {
	const positionals = args.filter(arg => !arg.startsWith("-"));
	const sub = positionals[0];
	if (sub === undefined) return false;
	if (GIT_READ_ONLY_SUBCOMMANDS[sub] === true) return true;
	if (GIT_LISTING_SUBCOMMANDS[sub] === true) return isGitListingReadOnly(sub, positionals.slice(1));
	return false;
}

/**
 * Options that redirect a reporting binary's output into a file or hand control
 * to another program, independent of which binary is running. `git log/diff
 * --output=<file>`, `git grep --open-files-in-pager=<cmd>`/`-O<cmd>`, and
 * `rg --pre=<cmd>` all read as reporting commands while writing files or
 * executing helpers, so they are rejected before any per-binary logic.
 */
const WRITE_OPTION_PATTERNS = [
	/^--output(?:=|$)/u,
	/^--pre(?:=|$)/u,
	/^--exec(?:=|$)/u,
	/^--open-files-in-pager(?:=|$)/u,
	/^-O/u,
];

/**
 * Per-binary write options that do not follow the shared shapes above:
 * `git shortlog -o <file>` and `tree -o <file>` take a short output flag, and
 * `file -C`/`--compile` writes a compiled magic database.
 */
const EXTRA_WRITE_OPTION_PATTERNS: Record<string, readonly RegExp[]> = {
	git: [/^-o(?:=|$)/u],
	tree: [/^-o(?:=|$)/u],
	file: [/^-C$/u, /^--compile$/u],
};

/**
 * Binaries whose positional forms can name an output file are excluded rather
 * than guessed at: `uniq [INPUT [OUTPUT]]`, `xxd [infile [outfile]]`, and
 * friends accept option *values* that look positional (`xxd -l 16 in`), so a
 * positional-count heuristic cannot tell `IN OUT` from `-l 16 IN`. The
 * remaining readers either write only stdout or take their output target as an
 * option this module rejects outright.
 */

/** `find` actions that write, delete, or spawn processes. */
const FIND_MUTATING_FLAGS = ["-delete", "-exec", "-execdir", "-ok", "-okdir", "-fprint", "-fprint0", "-fls"];

function isFindReadOnly(args: readonly string[]): boolean {
	return !args.some(arg => FIND_MUTATING_FLAGS.some(flag => arg === flag || arg.startsWith(`${flag}=`)));
}

/** `sort -o`/`--output` writes to a file instead of stdout. `-ofile` counts too. */
function isSortReadOnly(args: readonly string[]): boolean {
	return !args.some(arg => arg.startsWith("-o") || arg.startsWith("--output"));
}

/**
 * Binaries that only report. Anything not listed is unprovable and therefore
 * rejected — including `env`, `xargs`, `timeout`, `nice`, `find -exec`-style
 * wrappers, and every interpreter, all of which can run arbitrary commands.
 */
const READ_ONLY_COMMANDS: Record<string, true> = {
	// Filesystem / path inspection.
	ls: true,
	cat: true,
	head: true,
	tail: true,
	wc: true,
	stat: true,
	file: true,
	tree: true,
	du: true,
	df: true,
	realpath: true,
	readlink: true,
	basename: true,
	dirname: true,
	pwd: true,
	which: true,
	type: true,
	// Process / system identity.
	whoami: true,
	id: true,
	groups: true,
	uname: true,
	uptime: true,
	// Environment reporting (`env` itself is excluded: `env CMD` executes CMD).
	printenv: true,
	echo: true,
	printf: true,
	// Text transforms that read stdin/arguments and write only stdout.
	sort: true,
	cut: true,
	tr: true,
	nl: true,
	column: true,
	fold: true,
	rev: true,
	tac: true,
	paste: true,
	comm: true,
	cmp: true,
	diff: true,
	jq: true,
	// Search binaries (the dedicated read/grep/find tools remain preferred).
	grep: true,
	egrep: true,
	fgrep: true,
	rg: true,
	ag: true,
	// Digests — reporting only.
	md5sum: true,
	shasum: true,
	sha1sum: true,
	sha256sum: true,
	od: true,
	strings: true,
};

/**
 * Whether a bash command line is provably read-only: a single command, no shell
 * control syntax, a known reporting binary, and no option or subcommand that
 * writes.
 */
export function isReadOnlyBashCommand(command: string): boolean {
	const trimmed = command.trim();
	if (trimmed.length === 0) return false;
	if (SHELL_CONTROL_RE.test(trimmed)) return false;
	const segments = tokenizeShellSegments(trimmed);
	if (segments.length !== 1) return false;
	const tokens = segments[0];
	const binary = tokens[0].split("/").pop() ?? tokens[0];
	const args = tokens.slice(1);
	// Shared write-option gate first: it applies to every binary (including the
	// per-binary readers below), so `git log --output=x` cannot slip through as
	// an ordinary `git log`.
	if (WRITE_OPTION_PATTERNS.some(pattern => args.some(arg => pattern.test(arg)))) return false;
	if (EXTRA_WRITE_OPTION_PATTERNS[binary]?.some(pattern => args.some(arg => pattern.test(arg)))) return false;
	if (binary === "git") return isGitReadOnly(args);
	if (binary === "find") return isFindReadOnly(args);
	if (binary === "sort") return isSortReadOnly(args);
	if (READ_ONLY_COMMANDS[binary] !== true) return false;
	return true;
}
