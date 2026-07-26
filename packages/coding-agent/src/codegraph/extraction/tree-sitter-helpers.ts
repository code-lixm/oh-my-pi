/**
 * Tree-sitter shared helpers — ported from upstream
 * `codegraph/src/extraction/tree-sitter-helpers.ts` (MIT, Copyright (c)
 * 2026 Colby Mchenry — see ./ATTRIBUTION.md and ../UPSTREAM_LICENSE).
 *
 * Just the helpers the OMP extractor uses: text extraction, field lookup,
 * stable node-id hashing, and a docstring-recovery walk over the
 * preceding-line siblings. Upstream's wider helper set (pretty-printing,
 * `nth_*` shims, line-wrap printers, etc.) is omitted — if the OMP
 * extractor needs something we don't carry, port it on demand and link
 * back here so the upstream diff stays tight.
 */
import type { Node as SyntaxNode } from "web-tree-sitter";

import type { NodeKind } from "../types";

/**
 * Generate a stable per-symbol node ID. Two runs over the same source
 * MUST produce the same id (the DB uses `INSERT OR REPLACE` keyed on it).
 *
 *   `${hash8(filePath + '::' + qualifiedName + '::' + startLine)}`
 *
 * `startLine` disambiguates same-named symbols in different scopes of the
 * same file (overloads, multiple classes); the full qualified name
 * disambiguates across files.
 */
export function generateNodeId(filePath: string, kind: NodeKind, qualifiedName: string, startLine: number): string {
	let h = 0x811c9dc5;
	const src = `${filePath}::${kind}::${qualifiedName}::${startLine}`;
	for (let i = 0; i < src.length; i++) {
		h ^= src.charCodeAt(i);
		h = Math.imul(h, 0x01000193) >>> 0;
	}
	return `${h.toString(16).padStart(8, "0")}`;
}

/** Text slice of `node` inside `source`. */
export function getNodeText(node: SyntaxNode, source: string): string {
	return source.substring(node.startIndex, node.endIndex);
}

/** Locate a named field on a tree-sitter node. */
export function getChildByField(node: SyntaxNode, fieldName: string): SyntaxNode | null {
	return node.childForFieldName(fieldName);
}

/**
 * Look at `node.previousNamedSibling` and its ancestors until a sibling
 * whose source matches a comment shape, then strip the comment markers.
 * Returns `undefined` if nothing was found (caller decides whether to
 * store a docstring at all).
 */
export function getPrecedingDocstring(node: SyntaxNode, source: string): string | undefined {
	const docstringWrapperTypes: Record<string, true> = {
		export_statement: true,
		decorated_definition: true,
		function_definition: true,
	};

	let cursor: SyntaxNode | null = node.previousNamedSibling;
	while (cursor) {
		if (cursor.type === "comment") {
			const raw = getNodeText(cursor, source);
			return cleanCommentMarkers(raw);
		}
		// Some grammars wrap a declaration to capture its leading `export`/
		// decorator (`decorated_definition`, `export_statement`); a sibling
		// before THAT (not before the wrapped node) is the docstring's true
		// neighbour.
		if (docstringWrapperTypes[cursor.type]) {
			const inner = cursor.previousNamedSibling;
			if (inner) {
				if (inner.type === "comment") {
					const raw = getNodeText(inner, source);
					return cleanCommentMarkers(raw);
				}
				return undefined;
			}
			return undefined;
		}
		cursor = cursor.previousNamedSibling;
	}
	return undefined;
}

/**
 * Strip comment-syntax markers (for example line prefixes such as `//`,
 * block-form comments, and `#`) from a raw comment. Two passes: leading marker
 * from each line, then trim blank padding/whitespace so callers can
 * use the docstring verbatim.
 */
function cleanCommentMarkers(comment: string): string {
	const firstLineMarker = /^\s*(?:\/\/+\s*|<!--\s*|--\s*|#\s*|\/\*+\s*|;+\s*)/;
	const continuationMarker = /^\s*(?:\*+\s*|\/\/+\s*|--\s*|#\s*|;+\s*|<!--)/;
	const lines = comment.split(/\r?\n/);
	const stripped = lines.map((line, idx) =>
		idx === 0 ? line.replace(firstLineMarker, "") : line.replace(continuationMarker, ""),
	);
	return stripped.join("\n").trim();
}
