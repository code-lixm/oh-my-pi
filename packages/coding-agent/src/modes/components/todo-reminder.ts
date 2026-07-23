import { Box, Container, Spacer, Text } from "@oh-my-pi/pi-tui";
import { tSettingsUi } from "../../i18n/settings-locale";
import { theme } from "../../modes/theme/theme";
import type { TodoItem } from "../../tools/todo";

/**
 * Component that renders a todo completion reminder notification, committed into
 * the transcript like a TTSR notification so it stays anchored in history rather
 * than floating above the editor.
 * Shows when the agent stops with incomplete todos.
 */
export class TodoReminderComponent extends Container {
	#box: Box;

	constructor(
		private readonly todos: TodoItem[],
		private readonly attempt: number,
		private readonly maxAttempts: number,
	) {
		super();

		this.addChild(new Spacer(1));

		this.#box = new Box(1, 1);
		this.#box.setIgnoreTight(true);
		this.addChild(this.#box);

		this.#rebuild();
	}

	#rebuild(): void {
		this.#box.clear();

		const isFinalAttempt = this.attempt >= this.maxAttempts;
		this.#box.setBorder({
			chars: theme.boxRound,
			color: text => theme.fg(isFinalAttempt ? "warning" : "borderMuted", text),
		});

		const count = this.todos.length;
		const label = count === 1 ? tSettingsUi("todo") : tSettingsUi("todos");
		const headerText = tSettingsUi("{count} open {label} · reminder {attempt}/{maxAttempts}", {
			count,
			label,
			attempt: this.attempt,
			maxAttempts: this.maxAttempts,
		});
		const status = isFinalAttempt ? theme.status.warning : theme.status.pending;
		const headerColor = isFinalAttempt ? "warning" : "customMessageLabel";

		this.#box.addChild(new Text(theme.fg(headerColor, theme.bold(`${status} ${headerText}`)), 0, 0));
		this.#box.addChild(new Spacer(1));

		const todoList = this.todos.map(todo => `  ${theme.checkbox.unchecked} ${todo.content}`).join("\n");
		this.#box.addChild(new Text(theme.fg("customMessageText", todoList), 0, 0));
	}
}
