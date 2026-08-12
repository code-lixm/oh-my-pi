<available_skills>
{{#each skills}}
<skill>
  <name>{{name}}</name>
  <type>python</type>
  <python_import>{{importName}}</python_import>
  <call_pattern>await {{importName}}(…)</call_pattern>
  <description>{{description}}</description>
  <location>{{filePath}}</location>
</skill>
{{/each}}
</available_skills>

Use each preloaded binding directly; do not import it again. Bindings load independently: a failed binding is `_UnavailableSkill`, and calling or accessing it raises a diagnostic containing the skill, import, and load error. Healthy skills and ordinary Python remain available.
