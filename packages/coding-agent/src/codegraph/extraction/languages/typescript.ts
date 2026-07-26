/**
 * TypeScript extractor config — ported from upstream
 * `codegraph/src/extraction/languages/typescript.ts` (MIT, Copyright (c)
 * 2026 Colby Mchenry — see ../ATTRIBUTION.md and ../../UPSTREAM_LICENSE).
 */
import type { Node as SyntaxNode } from "web-tree-sitter";

import { getChildByField, getNodeText } from "../tree-sitter-helpers";
import type { LanguageExtractor } from "../tree-sitter-types";

function hasKeywordChild(node: SyntaxNode, keyword: string): boolean {
	for (let i = 0; i < node.childCount; i++) {
		const child = node.child(i);
		if (!child) continue;
		if (child.type === keyword) return true;
	}
	return false;
}

/** TS/JS class field is a `method` only when its value is callable. */
export function classifyTsClassMember(node: SyntaxNode): "method" | "property" {
	if (node.type !== "public_field_definition" && node.type !== "field_definition") {
		return "method";
	}
	for (let i = 0; i < node.namedChildCount; i++) {
		const child = node.namedChild(i);
		if (
			child &&
			(child.type === "arrow_function" || child.type === "function_expression" || child.type === "call_expression")
		) {
			return "method";
		}
	}
	return "property";
}

/** Unwrap nested body holders (field → arrow / call → arrow). */
function resolveBody(node: SyntaxNode, bodyField: string): SyntaxNode | null {
	if (node.type === "field_definition" || node.type === "public_field_definition") {
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
	if (!params) return undefined;
	const returnType = getChildByField(node, "return_type");
	const paramsText = getNodeText(params, source);
	return returnType ? `${paramsText}: ${getNodeText(returnType, source)}` : paramsText;
}

function getVisibility(node: SyntaxNode, source: string): "public" | "private" | "protected" | undefined {
	for (let i = 0; i < node.childCount; i++) {
		const child = node.child(i);
		if (child?.type === "accessibility_modifier") {
			const text = getNodeText(child, source);
			if (text === "public") return "public";
			if (text === "private") return "private";
			if (text === "protected") return "protected";
		}
	}
	return undefined;
}

function isExported(node: SyntaxNode): boolean {
	if (node.parent?.type === "export_statement" || node.parent?.type === "export_specifier") {
		return true;
	}
	return hasKeywordChild(node, "export") || hasKeywordChild(node, "default");
}

function isAsync(node: SyntaxNode): boolean {
	return hasKeywordChild(node, "async");
}

function isStatic(node: SyntaxNode): boolean {
	return hasKeywordChild(node, "static");
}

function isConst(node: SyntaxNode): boolean {
	return hasKeywordChild(node, "const");
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

export const typescriptExtractor: LanguageExtractor = {
	functionTypes: ["function_declaration", "arrow_function", "function_expression", "method_definition"],
	classTypes: ["class_declaration", "abstract_class_declaration"],
	methodTypes: ["method_definition", "public_field_definition"],
	interfaceTypes: ["interface_declaration"],
	structTypes: [],
	enumTypes: ["enum_declaration"],
	typeAliasTypes: ["type_alias_declaration"],
	importTypes: ["import_statement"],
	callTypes: ["call_expression"],
	variableTypes: ["lexical_declaration", "variable_declaration"],
	nameField: "name",
	bodyField: "body",
	paramsField: "parameters",
	returnField: "return_type",
	classifyMethodNode: classifyTsClassMember,
	resolveBody,
	getSignature,
	getVisibility,
	isExported,
	isAsync,
	isStatic,
	isConst,
	extractImport,
};
