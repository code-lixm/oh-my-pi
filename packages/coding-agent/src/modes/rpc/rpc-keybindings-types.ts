export type RpcKeybindingKeys = string[];

export interface RpcKeybindingCatalogItem {
	id: string;
	label: string;
	group: string;
	defaultKeys: RpcKeybindingKeys;
}

export interface RpcKeybindingsCatalog {
	version: 1;
	groups: Array<{ id: string; label: string }>;
	keybindings: RpcKeybindingCatalogItem[];
}

export interface RpcKeybindingsSnapshot {
	version: 1;
	values: Record<string, RpcKeybindingKeys>;
	configured: string[];
}
