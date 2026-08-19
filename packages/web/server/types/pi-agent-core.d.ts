export type AgentMessage =
	| {
			role: "user";
			timestamp: number;
			content: string | Array<{ type: "text"; text: string } | { type: "image"; data: string; mimeType: string }>;
	  }
	| {
			role: "assistant";
			timestamp: number;
			duration?: number;
			model: string;
			provider: string;
			usage: { cost?: { total?: number }; input: number; output: number; cacheRead: number; cacheWrite: number };
			stopReason: string;
			errorMessage?: string;
			content: Array<
				| { type: "text"; text: string }
				| { type: "thinking"; thinking: string }
				| { type: "toolCall"; id: string; name: string; arguments: unknown }
				| { type: "image"; data: string; mimeType: string }
			>;
	  }
	| {
			role: "toolResult";
			timestamp: number;
			toolCallId: string;
			toolName: string;
			isError: boolean;
			content: unknown;
			details?: unknown;
	  }
	| {
			role: "bashExecution";
			command: string;
			output: string;
			exitCode: number | undefined;
			cancelled: boolean;
			truncated: boolean;
			meta?: Record<string, unknown>;
			timestamp: number;
			excludeFromContext?: boolean;
	  }
	| {
			role: "pythonExecution";
			code: string;
			output: string;
			exitCode: number | undefined;
			cancelled: boolean;
			truncated: boolean;
			meta?: Record<string, unknown>;
			timestamp: number;
			excludeFromContext?: boolean;
	  }
	| {
			role: "custom" | "hookMessage";
			customType: string;
			content: string | Array<{ type: "text"; text: string } | { type: "image"; data: string; mimeType: string }>;
			display: boolean;
			details?: unknown;
			timestamp: number;
	  }
	| { role: "branchSummary"; summary: string; fromId: string; timestamp: number }
	| {
			role: "compactionSummary";
			summary: string;
			shortSummary?: string;
			tokensBefore: number;
			blocks?: Array<{ type: "text"; text: string } | { type: "image"; data: string; mimeType: string }>;
			images?: Array<{ type: "image"; data: string; mimeType: string }>;
			warning?: string;
			timestamp: number;
	  }
	| {
			role: "fileMention";
			files: Array<{
				path: string;
				content: string;
				lineCount?: number;
				byteSize?: number;
				skippedReason?: "tooLarge" | "binary";
				image?: { type: "image"; data: string; mimeType: string };
			}>;
			timestamp: number;
	  }
	| {
			role: "developer";
			content: string | Array<{ type: "text"; text: string } | { type: "image"; data: string; mimeType: string }>;
			timestamp: number;
	  };
