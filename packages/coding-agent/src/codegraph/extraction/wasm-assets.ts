import * as path from "node:path";
import { fileURLToPath } from "node:url";

import arktsWasm from "../../../assets/codegraph/wasm/tree-sitter-arkts.wasm" with { type: "file" };
import cWasm from "../../../assets/codegraph/wasm/tree-sitter-c.wasm" with { type: "file" };
import csharpWasm from "../../../assets/codegraph/wasm/tree-sitter-c_sharp.wasm" with { type: "file" };
import cfmlWasm from "../../../assets/codegraph/wasm/tree-sitter-cfml.wasm" with { type: "file" };
import cfqueryWasm from "../../../assets/codegraph/wasm/tree-sitter-cfquery.wasm" with { type: "file" };
import cfscriptWasm from "../../../assets/codegraph/wasm/tree-sitter-cfscript.wasm" with { type: "file" };
import cobolWasm from "../../../assets/codegraph/wasm/tree-sitter-cobol.wasm" with { type: "file" };
import cppWasm from "../../../assets/codegraph/wasm/tree-sitter-cpp.wasm" with { type: "file" };
import dartWasm from "../../../assets/codegraph/wasm/tree-sitter-dart.wasm" with { type: "file" };
import erlangWasm from "../../../assets/codegraph/wasm/tree-sitter-erlang.wasm" with { type: "file" };
import goWasm from "../../../assets/codegraph/wasm/tree-sitter-go.wasm" with { type: "file" };
import javaWasm from "../../../assets/codegraph/wasm/tree-sitter-java.wasm" with { type: "file" };
import javascriptWasm from "../../../assets/codegraph/wasm/tree-sitter-javascript.wasm" with { type: "file" };
import kotlinWasm from "../../../assets/codegraph/wasm/tree-sitter-kotlin.wasm" with { type: "file" };
import luaWasm from "../../../assets/codegraph/wasm/tree-sitter-lua.wasm" with { type: "file" };
import luauWasm from "../../../assets/codegraph/wasm/tree-sitter-luau.wasm" with { type: "file" };
import nixWasm from "../../../assets/codegraph/wasm/tree-sitter-nix.wasm" with { type: "file" };
import pascalWasm from "../../../assets/codegraph/wasm/tree-sitter-pascal.wasm" with { type: "file" };
import phpWasm from "../../../assets/codegraph/wasm/tree-sitter-php.wasm" with { type: "file" };
import pythonWasm from "../../../assets/codegraph/wasm/tree-sitter-python.wasm" with { type: "file" };
import rWasm from "../../../assets/codegraph/wasm/tree-sitter-r.wasm" with { type: "file" };
import rubyWasm from "../../../assets/codegraph/wasm/tree-sitter-ruby.wasm" with { type: "file" };
import runtimeWasm from "../../../assets/codegraph/wasm/tree-sitter-runtime.wasm" with { type: "file" };
import rustWasm from "../../../assets/codegraph/wasm/tree-sitter-rust.wasm" with { type: "file" };
import scalaWasm from "../../../assets/codegraph/wasm/tree-sitter-scala.wasm" with { type: "file" };
import swiftWasm from "../../../assets/codegraph/wasm/tree-sitter-swift.wasm" with { type: "file" };
import terraformWasm from "../../../assets/codegraph/wasm/tree-sitter-terraform.wasm" with { type: "file" };
import tsxWasm from "../../../assets/codegraph/wasm/tree-sitter-tsx.wasm" with { type: "file" };
import typescriptWasm from "../../../assets/codegraph/wasm/tree-sitter-typescript.wasm" with { type: "file" };
import vbnetWasm from "../../../assets/codegraph/wasm/tree-sitter-vbnet.wasm" with { type: "file" };

/** Resolve Bun's relative bundle asset names against the emitted module, never the caller's cwd. */
function resolveWasmAssetPath(assetPath: string): string {
	if (assetPath.startsWith("file:")) return fileURLToPath(assetPath);
	if (path.isAbsolute(assetPath)) return assetPath;
	return fileURLToPath(new URL(assetPath, import.meta.url));
}

const RAW_CODEGRAPH_WASM_PATH_BY_FILENAME = {
	"tree-sitter-arkts.wasm": arktsWasm,
	"tree-sitter-c.wasm": cWasm,
	"tree-sitter-c_sharp.wasm": csharpWasm,
	"tree-sitter-cfml.wasm": cfmlWasm,
	"tree-sitter-cfquery.wasm": cfqueryWasm,
	"tree-sitter-cfscript.wasm": cfscriptWasm,
	"tree-sitter-cobol.wasm": cobolWasm,
	"tree-sitter-cpp.wasm": cppWasm,
	"tree-sitter-dart.wasm": dartWasm,
	"tree-sitter-erlang.wasm": erlangWasm,
	"tree-sitter-go.wasm": goWasm,
	"tree-sitter-java.wasm": javaWasm,
	"tree-sitter-javascript.wasm": javascriptWasm,
	"tree-sitter-kotlin.wasm": kotlinWasm,
	"tree-sitter-lua.wasm": luaWasm,
	"tree-sitter-luau.wasm": luauWasm,
	"tree-sitter-nix.wasm": nixWasm,
	"tree-sitter-pascal.wasm": pascalWasm,
	"tree-sitter-php.wasm": phpWasm,
	"tree-sitter-python.wasm": pythonWasm,
	"tree-sitter-r.wasm": rWasm,
	"tree-sitter-ruby.wasm": rubyWasm,
	"tree-sitter-runtime.wasm": runtimeWasm,
	"tree-sitter-rust.wasm": rustWasm,
	"tree-sitter-scala.wasm": scalaWasm,
	"tree-sitter-swift.wasm": swiftWasm,
	"tree-sitter-terraform.wasm": terraformWasm,
	"tree-sitter-tsx.wasm": tsxWasm,
	"tree-sitter-typescript.wasm": typescriptWasm,
	"tree-sitter-vbnet.wasm": vbnetWasm,
} satisfies Record<string, string>;

/** Static file imports keep fallback grammars reachable in source, npm bundles, and compiled binaries. */
export const CODEGRAPH_WASM_PATH_BY_FILENAME: Readonly<Record<string, string>> = Object.freeze(
	Object.fromEntries(
		Object.entries(RAW_CODEGRAPH_WASM_PATH_BY_FILENAME).map(([filename, assetPath]) => [
			filename,
			resolveWasmAssetPath(assetPath),
		]),
	),
);
