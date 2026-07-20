{{#when variant "==" "unsupportedMime"}}图片 MIME 类型 {{mimeType}} 不支持内联模型序列化；仅返回文本元数据{{/when}}
{{#when variant "==" "fallbackTextual"}}回退为使用初始响应的文本渲染{{/when}}
{{#when variant "==" "sourceLimit"}}图片超出内联源大小限制（{{actualBytes}} 字节 > {{maxBytes}} 字节）{{/when}}
{{#when variant "==" "outputLimit"}}图片在缩放后超出内联输出大小限制（{{actualBytes}} 字节 > {{maxBytes}} 字节）{{/when}}
{{#when variant "==" "invalidImage"}}获取到的载荷无法按 {{mimeType}} 解码；仅返回文本元数据{{/when}}
{{#when variant "==" "binaryFailed"}}{{#if error}}二进制抓取失败: {{error}}{{else}}二进制抓取失败{{/if}}{{/when}}
