{{#when variant "==" "unsupportedMime"}}Image MIME type {{mimeType}} is unsupported for inline model serialization; returning text metadata only{{/when}}
{{#when variant "==" "fallbackTextual"}}Falling back to textual rendering from initial response{{/when}}
{{#when variant "==" "sourceLimit"}}Image exceeds inline source limit ({{actualBytes}} bytes > {{maxBytes}} bytes){{/when}}
{{#when variant "==" "outputLimit"}}Image exceeds inline output limit after resize ({{actualBytes}} bytes > {{maxBytes}} bytes){{/when}}
{{#when variant "==" "invalidImage"}}Fetched payload could not be decoded as {{mimeType}}; returning text metadata only{{/when}}
{{#when variant "==" "binaryFailed"}}{{#if error}}Binary fetch failed: {{error}}{{else}}Binary fetch failed{{/if}}{{/when}}
