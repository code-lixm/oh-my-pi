/**
 * JavaScript extractor config — ported from upstream
 * `codegraph/src/extraction/languages/javascript.ts` (MIT, Copyright (c)
 * 2026 Colby Mchenry — see ../ATTRIBUTION.md and ../../UPSTREAM_LICENSE).
 */
import type { Node as SyntaxNode } from "web-tree-sitter";

import { getChildByField, getNodeText } from "../tree-sitter-helpers";
import type { LanguageExtractor } from "../tree-sitter-types";

import { classifyTsClassMember } from "./typescript";

/**
 * JS class field — the name lives on the `property` field (TS's
 * `public_field_definition` uses `name`).
 */
function resolveName(node: SyntaxNode, source: string): string | undefined {
	if (node.type === "field_definition") {
		const prop = getChildByField(node, "property");
		if (prop) return getNodeText(prop, source);
	}
	return undefined;
}

/** Field → call → arrow unwrapping (mirrors TS). */
function resolveBody(node: SyntaxNode, bodyField: string): SyntaxNode | null {
	if (node.type === "field_definition") {
		for (let i = 0; i < node.namedChildCount; i++) {
			const child = node.namedChild(i);
			if (child?.type === "arrow_function" || child?.type === "function_expression") {
				const inner = getChildByField(child, bodyField);
				if (inner) return inner;
			}
			if (child?.type === "call_expression") {
				for (let j = 0; j < child.namedChildCount; j++) {
					const arg = child.namedChild(j);
					if (arg && (arg.type === "arrow_function" || arg.type === "function_expression")) {
						const inner = getChildByField(arg, bodyField);
						if (inner) return inner;
					}
				}
			}
		}
	}
	return getChildByField(node, bodyField);
}

function getSignature(node: SyntaxNode, source: string): string | undefined {
	const params = getChildByField(node, "parameters");
	return params ? getNodeText(params, source) : undefined;
}

function isExported(node: SyntaxNode, source: string): boolean {
	if (node.parent?.type === "export_statement") return true;
	for (let i = 0; i < node.childCount; i++) {
		const child = node.child(i);
		if (child && getNodeText(child, source).trim() === "export") return true;
	}
	return false;
}

function isAsync(node: SyntaxNode, source: string): boolean {
	for (let i = 0; i < node.childCount; i++) {
		const child = node.child(i);
		if (child && getNodeText(child, source).trim() === "async") return true;
	}
	return false;
}

function isConst(node: SyntaxNode): boolean {
	for (let i = 0; i < node.childCount; i++) {
		if (node.child(i)?.type === "const") return true;
	}
	return false;
}

function extractImport(node: SyntaxNode, source: string): { moduleName: string; signature: string } | null {
	const text = getNodeText(node, source).trim();
	const literal = node.namedChildren.find(
		c =>
			c !== null && (c.type === "string" || c.type === "string_literal" || c.type === "interpreted_string_literal"),
	);
	if (!literal) return null;
	const raw = getNodeText(literal, source).trim();
	return { moduleName: raw.slice(1, -1), signature: text };
}

export const javascriptExtractor: LanguageExtractor = {
	functionTypes: ["function_declaration", "arrow_function", "function_expression"],
	classTypes: ["class_declaration"],
	methodTypes: ["method_definition", "field_definition"],
	interfaceTypes: [],
	structTypes: [],
	enumTypes: [],
	typeAliasTypes: [],
	importTypes: ["import_statement"],
	callTypes: ["call_expression"],
	variableTypes: ["lexical_declaration", "variable_declaration"],
	nameField: "name",
	bodyField: "body",
	paramsField: "parameters",
	resolveName,
	classifyMethodNode: classifyTsClassMember,
	resolveBody,
	getSignature,
	isExported,
	isAsync,
	isConst,
	extractImport,
};
