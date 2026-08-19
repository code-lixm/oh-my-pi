import type { RpcSettingValue } from "./rpc-settings-types";

export type RpcPluginKind = "npm" | "marketplace";
export type RpcPluginScope = "global" | "user" | "project";

export interface RpcPluginFeatureInfo {
	id: string;
	description?: string;
	enabled: boolean;
}

export interface RpcPluginSettingInfo {
	key: string;
	type: "string" | "number" | "boolean" | "enum";
	description?: string;
	secret: boolean;
	configured: boolean;
	value?: RpcSettingValue;
	defaultValue?: RpcSettingValue;
	values?: string[];
	min?: number;
	max?: number;
	step?: number;
}

export interface RpcPluginInfo {
	id: string;
	name: string;
	version: string;
	description?: string;
	kind: RpcPluginKind;
	scope: RpcPluginScope;
	enabled: boolean;
	shadowedBy?: "project";
	features?: RpcPluginFeatureInfo[];
	settings?: RpcPluginSettingInfo[];
}

export interface RpcPluginSelector {
	id: string;
	kind: RpcPluginKind;
	scope: RpcPluginScope;
}

export interface RpcMcpServerInfo {
	name: string;
	enabled: boolean;
	status: "connected" | "connecting" | "disconnected" | "disabled";
	transport: "stdio" | "sse" | "http";
	scope: "user" | "project" | "native";
	source: string;
	removable: boolean;
}

export type RpcMcpServerConfigInput =
	| {
			type: "stdio";
			command: string;
			args?: string[];
			env?: Record<string, string>;
	  }
	| {
			type: "sse" | "http";
			url: string;
			headers?: Record<string, string>;
	  };
