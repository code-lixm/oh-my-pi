/**
 * Extraction barrel — re-exports the entry points that `extraction.ts`
 * wires into the runtime facade. Living in its own file keeps the
 * symbols above `./extraction/{tree-sitter,kernel,...}` discoverable
 * to callers without dragging the whole subpackage into one import.
 */

export {
	detectLanguage,
	getParser,
	initGrammars,
	isFileLevelOnlyLanguage,
	isGrammarLoaded,
	isLanguageSupported,
	loadGrammarsForLanguages,
	readGrammarWasmBytes,
} from "./grammars";
export {
	DEFAULT_ROUTED,
	tryKernelExtract,
} from "./kernel";
export {
	extractFromSource,
	treeSitterExtract,
} from "./tree-sitter";
