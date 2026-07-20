{{#when variant "==" "summary"}}已获取图片内容（{{mimeType}}）。{{#if dimensionNote}}
{{dimensionNote}}{{/if}}{{/when}}
{{#when variant "==" "tooLarge"}}已获取图片内容（{{mimeType}}），但体积过大，无法以内联方式渲染。{{/when}}
{{#when variant "==" "invalidBytes"}}获取到的载荷标记为 {{mimeType}}，但其字节并非有效图片。{{/when}}
