/**
 * Rust extractor config — ported from upstream
 * `codegraph/src/extraction/languages/rust.ts` (MIT, Copyright (c)
 * 2026 Colby Mchenry — see ../ATTRIBUTION.md and ../../UPSTREAM_LICENSE).
 */
import type { Node as SyntaxNode } from "web-tree-sitter";

import { getChildByField, getNodeText } from "../tree-sitter-helpers";
import type { LanguageExtractor } from "../tree-sitter-types";

function getSignature(node: SyntaxNode, source: string): string | undefined {
	const params = getChildByField(node, "parameters");
	if (!params) return undefined;
	const returnType = getChildByField(node, "return_type");
	const paramsText = getNodeText(params, source);
	return returnType ? `${paramsText} -> ${getNodeText(returnType, source)}` : paramsText;
}

function isAsync(node: SyntaxNode): boolean {
	for (let i = 0; i < node.childCount; i++) {
		const child = node.child(i);
		if (child?.type === "async") return true;
	}
	return false;
}

function getVisibility(node: SyntaxNode, source: string): "public" | "private" | "protected" | "internal" | undefined {
	for (let i = 0; i < node.childCount; i++) {
		const child = node.child(i);
		if (child?.type === "visibility_modifier") {
			const text = getNodeText(child, source).trim();
			if (text === "pub") return "public";
			if (text === "priv") return "private";
			if (text.startsWith("pub(crate)")) return "internal";
		}
	}
	return undefined;
}

function extractImport(
	node: SyntaxNode,
	source: string,
): {
	moduleName: string;
	signature: string;
} | null {
	const text = getNodeText(node, source).trim();
	const arg = node.namedChildren.find(c => c !== null && (c.type === "identifier" || c.type === "scoped_identifier"));
	if (!arg) return null;
	const raw = getNodeText(arg, source).trim();
	const simple = raw.split("::").filter(Boolean).pop() ?? raw;
	return { moduleName: simple, signature: text };
}

export const rustExtractor: LanguageExtractor = {
	functionTypes: ["function_item", "function_signature_item"],
	classTypes: [],
	methodTypes: ["function_item", "function_signature_item"],
	interfaceTypes: ["trait_item"],
	structTypes: ["struct_item"],
	enumTypes: ["enum_item"],
	enumMemberTypes: ["enum_variant"],
	typeAliasTypes: ["type_item"],
	importTypes: ["use_declaration"],
	callTypes: ["call_expression"],
	variableTypes: ["let_declaration", "const_item", "static_item"],
	interfaceKind: "trait",
	nameField: "name",
	bodyField: "body",
	paramsField: "parameters",
	returnField: "return_type",
	getSignature,
	isAsync,
	getVisibility,
	extractImport,
};
