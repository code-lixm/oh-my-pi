/**
 * Python extractor config — ported from upstream
 * `codegraph/src/extraction/languages/python.ts` (MIT, Copyright (c)
 * 2026 Colby Mchenry — see ../ATTRIBUTION.md and ../../UPSTREAM_LICENSE).
 */
import type { Node as SyntaxNode } from "web-tree-sitter";

import { getChildByField, getNodeText } from "../tree-sitter-helpers";
import type { LanguageExtractor } from "../tree-sitter-types";

function getSignature(node: SyntaxNode, source: string): string | undefined {
	const params = getChildByField(node, "parameters");
	if (!params) return undefined;
	const returnType = getChildByField(node, "return_type");
	let sig = getNodeText(params, source);
	if (returnType) sig += ` -> ${getNodeText(returnType, source)}`;
	return sig;
}

function isExported(_node: SyntaxNode, _source: string): boolean {
	// Python doesn't have explicit exports; top-level defs are public by convention.
	return true;
}

function isAsync(node: SyntaxNode): boolean {
	return node.previousSibling?.type === "async";
}

function isStatic(node: SyntaxNode): boolean {
	const prev = node.previousNamedSibling;
	if (prev?.type !== "decorator") return false;
	return getNodeText(prev, "").includes("staticmethod");
}

function extractImport(
	node: SyntaxNode,
	source: string,
): {
	moduleName: string;
	signature: string;
} | null {
	const text = getNodeText(node, source).trim();
	if (node.type === "import_from_statement") {
		const moduleNode = getChildByField(node, "module_name");
		if (moduleNode) {
			return { moduleName: getNodeText(moduleNode, source), signature: text };
		}
	}
	// `import a, b.c` — surface the dotted prefix of each name.
	const firstName = node.namedChildren.find(
		c => c !== null && (c.type === "dotted_name" || c.type === "aliased_import"),
	);
	if (firstName?.type === "dotted_name") {
		return { moduleName: getNodeText(firstName, source), signature: text };
	}
	return null;
}

export const pythonExtractor: LanguageExtractor = {
	functionTypes: ["function_definition"],
	classTypes: ["class_definition"],
	methodTypes: ["function_definition"],
	interfaceTypes: [],
	structTypes: [],
	enumTypes: [],
	typeAliasTypes: [],
	importTypes: ["import_statement", "import_from_statement"],
	callTypes: ["call"],
	variableTypes: ["assignment", "augmented_assignment"],
	nameField: "name",
	bodyField: "body",
	paramsField: "parameters",
	returnField: "return_type",
	getSignature,
	isExported,
	isAsync,
	isStatic,
	extractImport,
};
