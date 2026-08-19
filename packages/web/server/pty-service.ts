import type { ServerWebSocket } from "bun";
import type { OmpPty as Pty } from "../shared/omp-view-model";
import type { DurableStore } from "./store";

interface PtySocketData {
	ptyID: string;
}

type PtySocket = ServerWebSocket<PtySocketData>;

type Entry = {
	info: Pty;
	process: Bun.Subprocess;
	terminal: Bun.Terminal;
	sockets: Set<PtySocket>;
	tokens: Map<string, number>;
};

export class PtyService {
	readonly #entries = new Map<string, Entry>();
	readonly #store: DurableStore;

	constructor(store: DurableStore) {
		this.#store = store;
	}

	list(): Pty[] {
		return Array.from(this.#entries.values(), entry => entry.info);
	}

	get(id: string): Pty | undefined {
		return this.#entries.get(id)?.info;
	}

	create(input: {
		command?: string;
		args?: string[];
		cwd: string;
		title?: string;
		env?: Record<string, string>;
	}): Pty {
		const command =
			input.command ?? (process.platform === "win32" ? "powershell.exe" : (process.env.SHELL ?? "/bin/zsh"));
		const args = input.args ?? [];
		const id = `pty_${crypto.randomUUID()}`;
		const sockets = new Set<PtySocket>();
		const decoder = new TextDecoder();
		const ptyExited = Promise.withResolvers<void>();
		const terminal = new Bun.Terminal({
			name: "xterm-256color",
			cols: 120,
			rows: 40,
			data: (_terminal, chunk) => {
				const data = decoder.decode(chunk, { stream: true });
				for (const socket of sockets) socket.send(data);
			},
			exit: () => ptyExited.resolve(),
		});
		const child = Bun.spawn([command, ...args], {
			cwd: input.cwd,
			env: { ...process.env, ...input.env },
			terminal,
		});
		const info: Pty = {
			id,
			title: input.title ?? command,
			command,
			args,
			cwd: input.cwd,
			status: "running",
			pid: child.pid,
		};
		const entry: Entry = { info, process: child, terminal, sockets, tokens: new Map() };
		this.#entries.set(id, entry);
		void child.exited.then(async exitCode => {
			if (this.#entries.get(id) !== entry) return;
			await Bun.sleep(0);
			terminal.close();
			await ptyExited.promise;
			const remaining = decoder.decode();
			if (remaining) for (const socket of sockets) socket.send(remaining);
			entry.info = { ...entry.info, status: "exited" };
			this.#store.appendEvent(input.cwd, { type: "pty.exited", properties: { id, exitCode } });
			for (const socket of sockets) socket.close(1000, "PTY exited");
			terminal.close();
		});
		this.#store.appendEvent(input.cwd, { type: "pty.created", properties: { info } });
		return info;
	}

	update(id: string, input: { title?: string; size?: { rows: number; cols: number } }): Pty | undefined {
		const entry = this.#entries.get(id);
		if (!entry) return undefined;
		if (input.title !== undefined) entry.info = { ...entry.info, title: input.title };
		if (input.size) entry.terminal.resize(input.size.cols, input.size.rows);
		this.#store.appendEvent(entry.info.cwd, { type: "pty.updated", properties: { info: entry.info } });
		return entry.info;
	}

	write(id: string, data: string): boolean {
		const entry = this.#entries.get(id);
		if (entry?.info.status !== "running") return false;
		entry.terminal.write(data);
		return true;
	}

	delete(id: string): boolean {
		const entry = this.#entries.get(id);
		if (!entry) return false;
		entry.process.kill();
		entry.terminal.close();
		for (const socket of entry.sockets) socket.close(1000, "PTY deleted");
		this.#entries.delete(id);
		this.#store.appendEvent(entry.info.cwd, { type: "pty.deleted", properties: { id } });
		return true;
	}

	connectToken(id: string): string | undefined {
		const entry = this.#entries.get(id);
		if (!entry) return undefined;
		const token = crypto.randomUUID();
		entry.tokens.set(token, Date.now() + 30_000);
		return token;
	}

	consumeToken(id: string, token: string): boolean {
		const entry = this.#entries.get(id);
		const expiresAt = entry?.tokens.get(token);
		if (!entry || expiresAt === undefined) return false;
		entry.tokens.delete(token);
		return expiresAt >= Date.now();
	}

	attach(socket: PtySocket): boolean {
		const entry = this.#entries.get(socket.data.ptyID);
		if (!entry) return false;
		entry.sockets.add(socket);
		return true;
	}

	detach(socket: PtySocket): void {
		this.#entries.get(socket.data.ptyID)?.sockets.delete(socket);
	}

	close(): void {
		for (const id of Array.from(this.#entries.keys())) this.delete(id);
	}
}
