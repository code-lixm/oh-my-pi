interface RequestBase {
	id: string;
}
export type RpcExtensionUIRequest =
	| (RequestBase & { method: "notify"; message: string; notifyType?: string })
	| (RequestBase & { method: "open_url"; url: string })
	| (RequestBase & { method: "confirm"; title: string; message: string })
	| (RequestBase & { method: "select"; title: string; options: string[] })
	| (RequestBase & { method: "input"; title: string })
	| (RequestBase & { method: "cancel"; targetId: string })
	| (RequestBase & { method: "setStatus" })
	| (RequestBase & { method: "setWidget" })
	| (RequestBase & { method: "setTitle"; title: string })
	| (RequestBase & { method: "set_editor_text" });
export type RpcExtensionUIResponse =
	| { type: "extension_ui_response"; id: string; cancelled: true }
	| { type: "extension_ui_response"; id: string; confirmed: boolean }
	| { type: "extension_ui_response"; id: string; value: string };
