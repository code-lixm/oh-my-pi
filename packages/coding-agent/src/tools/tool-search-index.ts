import type { ExternalXdevToolCatalogEntry } from "./xdev";

export interface ExternalToolSearchMatch {
	entry: ExternalXdevToolCatalogEntry;
	score: number;
}

interface SearchDocument {
	entry: ExternalXdevToolCatalogEntry;
	termFrequencies: Map<string, number>;
	length: number;
}

const BM25_K1 = 1.2;
const BM25_B = 0.75;
const BM25_DELTA = 1;
const FIELD_WEIGHTS = {
	name: 6,
	label: 4,
	summary: 2,
	schemaKey: 1,
} as const;

function tokenize(value: string): string[] {
	return value
		.normalize("NFKD")
		.replace(/\p{M}+/gu, "")
		.replace(/(\p{Lu}+)(\p{Lu}\p{Ll})/gu, "$1 $2")
		.replace(/(\p{Ll}|\p{N})(\p{Lu})/gu, "$1 $2")
		.replace(/[^\p{L}\p{N}]+/gu, " ")
		.toLowerCase()
		.trim()
		.split(/\s+/)
		.filter(token => token.length > 0);
}

function addWeightedTokens(termFrequencies: Map<string, number>, value: string, weight: number): void {
	for (const token of tokenize(value)) {
		termFrequencies.set(token, (termFrequencies.get(token) ?? 0) + weight);
	}
}

function buildSearchDocument(entry: ExternalXdevToolCatalogEntry): SearchDocument {
	const termFrequencies = new Map<string, number>();
	addWeightedTokens(termFrequencies, entry.name, FIELD_WEIGHTS.name);
	addWeightedTokens(termFrequencies, entry.label, FIELD_WEIGHTS.label);
	addWeightedTokens(termFrequencies, entry.summary, FIELD_WEIGHTS.summary);
	for (const schemaKey of entry.schemaKeys) addWeightedTokens(termFrequencies, schemaKey, FIELD_WEIGHTS.schemaKey);
	const length = Array.from(termFrequencies.values()).reduce((sum, value) => sum + value, 0);
	return { entry, termFrequencies, length };
}

/** Rank a bounded external-tool catalog by capability without exposing the catalog to the model. */
export function searchExternalTools(
	entries: readonly ExternalXdevToolCatalogEntry[],
	query: string,
	limit: number,
): ExternalToolSearchMatch[] {
	const queryTokens = tokenize(query);
	if (queryTokens.length === 0) throw new Error("Query must contain at least one letter or number.");
	if (entries.length === 0) return [];

	const documents = entries.map(buildSearchDocument);
	const averageLength = documents.reduce((sum, document) => sum + document.length, 0) / documents.length || 1;
	const documentFrequencies = new Map<string, number>();
	for (const document of documents) {
		for (const token of new Set(document.termFrequencies.keys())) {
			documentFrequencies.set(token, (documentFrequencies.get(token) ?? 0) + 1);
		}
	}

	const queryTermCounts = new Map<string, number>();
	for (const token of queryTokens) queryTermCounts.set(token, (queryTermCounts.get(token) ?? 0) + 1);

	return documents
		.map(document => {
			let score = 0;
			for (const [token, queryTermCount] of queryTermCounts) {
				const termFrequency = document.termFrequencies.get(token) ?? 0;
				if (termFrequency === 0) continue;
				const documentFrequency = documentFrequencies.get(token) ?? 0;
				const idf = Math.log(1 + (documents.length - documentFrequency + 0.5) / (documentFrequency + 0.5));
				const normalization = BM25_K1 * (1 - BM25_B + BM25_B * (document.length / averageLength));
				score +=
					queryTermCount * idf * ((termFrequency * (BM25_K1 + 1)) / (termFrequency + normalization) + BM25_DELTA);
			}
			return { entry: document.entry, score };
		})
		.filter(match => match.score > 0)
		.sort((left, right) => right.score - left.score || left.entry.name.localeCompare(right.entry.name))
		.slice(0, limit);
}
