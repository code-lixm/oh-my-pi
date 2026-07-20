{{#when variant "==" "summary"}}Fetched image content ({{mimeType}}).{{#if dimensionNote}}
{{dimensionNote}}{{/if}}{{/when}}
{{#when variant "==" "tooLarge"}}Fetched image content ({{mimeType}}), but it is too large to inline render.{{/when}}
{{#when variant "==" "invalidBytes"}}Fetched payload was labeled {{mimeType}}, but bytes were not a valid image.{{/when}}
