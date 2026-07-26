import { afterEach, beforeEach, describe, expect, test } from "bun:test";

import { tryKernelExtract } from "../extraction/kernel";
import { EDGE_ROW_SIZE, META, META_SIZE, NODE_ROW_SIZE, REF_ROW_SIZE } from "../extraction/kernel/layout";
import { getKernel, resetKernelForTests } from "../extraction/kernel/loader";

describe("native kernel ABI contract", () => {
	beforeEach(() => {
		resetKernelForTests();
	});

	afterEach(() => {
		resetKernelForTests();
	});

	test("TypeScript extraction raw buffers match declared layout and decode into the exported function plus a basic edge", async () => {
		const kernel = await getKernel();
		expect(kernel).not.toBeNull();
		expect(kernel!.grammarInfo("typescript")).not.toBeNull();

		const source = ["export function greet(name: string): string {", "  return name.toUpperCase();", "}"].join("\n");

		const buffers = kernel!.extractFile("fixture.ts", source, "typescript");
		const meta = new DataView(buffers.meta.buffer, buffers.meta.byteOffset, buffers.meta.byteLength);
		const nodeCount = meta.getUint32(META.nodeCount, true);
		const edgeCount = meta.getUint32(META.edgeCount, true);
		const refCount = meta.getUint32(META.refCount, true);
		const arenaLen = meta.getUint32(META.arenaLen, true);

		expect(buffers.meta.byteLength).toBe(META_SIZE);
		expect(buffers.nodes.byteLength).toBe(nodeCount * NODE_ROW_SIZE);
		expect(buffers.edges.byteLength).toBe(edgeCount * EDGE_ROW_SIZE);
		expect(buffers.refs.byteLength).toBe(refCount * REF_ROW_SIZE);
		expect(buffers.arena.byteLength).toBe(arenaLen);

		const result = await tryKernelExtract("fixture.ts", source, "typescript");
		expect(result).not.toBeNull();

		const fileNode = result!.nodes.find(node => node.kind === "file" && node.filePath === "fixture.ts");
		const greetNode = result!.nodes.find(node => node.name === "greet");
		expect(fileNode).toBeDefined();
		expect(greetNode).toBeDefined();
		expect(greetNode!.kind).toBe("function");
		expect(
			result!.edges.some(
				edge => edge.kind === "contains" && edge.source === fileNode!.id && edge.target === greetNode!.id,
			),
		).toBe(true);
	});
});
