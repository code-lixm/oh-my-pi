Search indexed file contents with smart-case, path constraints, and fuzzy recovery.

<instruction>
- Prefer a specific identifier or literal phrase; wildcard-only patterns are rejected.
- `path` includes a directory, filename, glob, or external path; `exclude` removes noisy paths.
- Omit `caseSensitive` for smart-case; set it only when exact case matters.
- Use the returned cursor for the next page. After useful matches, `read` the best file instead of chaining searches.
</instruction>

<critical>
- MUST use instead of shell `grep`/`rg`.
- Open-ended multi-round exploration → Task + scout, not chained searches.
</critical>
