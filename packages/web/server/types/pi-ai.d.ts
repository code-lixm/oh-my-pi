export interface ImageContent {
	type: "image";
	data: string;
	mimeType: string;
}

export interface ModelCost {
	input: number;
	output: number;
	cacheRead: number;
	cacheWrite: number;
	longContext?: {
		input: number;
		output: number;
		cacheRead: number;
		cacheWrite: number;
		inputThreshold: number;
	};
}

export interface ModelCompat {
	supportsSamplingParams?: boolean;
}

export interface Model {
	id: string;
	name: string;
	api: string;
	provider: string;
	baseUrl: string;
	reasoning: boolean;
	input: ("text" | "image")[];
	supportsTools?: boolean;
	cost: ModelCost;
	contextWindow: number | null;
	maxTokens: number | null;
	compat: ModelCompat | undefined;
}
