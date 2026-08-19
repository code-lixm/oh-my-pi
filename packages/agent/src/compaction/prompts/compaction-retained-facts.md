{{summary}}
{{#if retainedFacts}}

<retained-facts>
Deterministic session state. MUST prefer it over conflicting prose summary claims.
{{#if retainedFacts.todos}}
Open todos:
{{#each retainedFacts.todos}}
- [{{status}}] {{phase}} — {{content}}{{#if blocker}} (blocked: {{blocker}}){{/if}}
{{/each}}
{{/if}}
{{#if retainedFacts.commands}}
Compacted command outcomes:
{{#each retainedFacts.commands}}
- [{{outcome}}{{#if exitCode}}, exit {{exitCode}}{{/if}}] {{command}}
{{/each}}
{{/if}}
{{#if retainedFacts.unresolvedFailures}}
Unresolved failures:
{{#each retainedFacts.unresolvedFailures}}
- {{tool}} {{operation}}: {{error}}
{{/each}}
{{/if}}
{{#if retainedFacts.workspaceCheckpoint}}
Latest workspace checkpoint:
- {{retainedFacts.workspaceCheckpoint.id}} ({{retainedFacts.workspaceCheckpoint.reason}}{{#if retainedFacts.workspaceCheckpoint.label}}, {{retainedFacts.workspaceCheckpoint.label}}{{/if}})
{{/if}}
{{#if retainedFacts.recoverableUris}}
Recoverable references:
{{#each retainedFacts.recoverableUris}}
- {{this}}
{{/each}}
{{/if}}
</retained-facts>
{{/if}}
