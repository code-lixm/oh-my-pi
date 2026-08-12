Line-anchored patch language: name original lines/gaps to replace, insert, cut, or paste; then give new content. `:` headers take `+` body rows; colonless paste `PUT`, `CUT`, `REM`, `MV` take none.

<headers>
Every file section starts `[PATH#TAG]`. `TAG` = 4-hex snapshot tag copied from your latest `read`/`search` or current-disk `codegraph` source section — REQUIRED on every section. Create new files with `write`; hashline only edits existing files.
</headers>

<ops>
`PUT N.=M:`: replace original inclusive lines N–M with body.
`PUT N*:`: replace syntactic block beginning N; closing line resolved.
`PUT <N:` / `PUT >N:`: insert before/after N; `<1` head, `>$` tail.
`PUT >N*:`: insert after block N's end, at sibling depth. Append inside block: `PUT >M:`.
`PUT <N` / `PUT >N` / `PUT N.=M @name` / `PUT N* @name`: paste captured register at gap/range/resolved block; no `:` or body. Unlabeled gap paste: anonymous register; range/block paste: `@name` required.
`CUT N.=M` / `CUT N*`: delete and capture inclusive lines N–M / block N; anonymous or given `@name`.
`REM`: delete section file. `MV DEST`: move/rename (quote paths with spaces); prior edits apply to source, final content to `DEST`.
Single line: `PUT N.=N:` / `CUT N.=N`. Ranges name original inclusive touched lines; body length irrelevant.
</ops>

<body-rows>
Only below `:` headers. Row: verbatim `+TEXT` (leading whitespace preserved); `+`: blank. NEVER `-old`, bare, or context rows: range deletes; body is final content. Keep line: exclude it from every range. Literal initial `-`/`+`: `- item` → `+- item`; `+ item` → `++ item`.
</body-rows>

<rules>
- Line numbers + `#TAG` come from your latest `read`/`search` or current-disk `codegraph` source section; numbers name ORIGINAL lines, never shifted by applied hunks. A CodeGraph `[PATH#TAG]` section preserves original lines and can directly anchor `edit`.
- Applied edits renumber the file and change the `#TAG` — take next numbers from the edit response or a fresh current snapshot. NEVER rerun CodeGraph solely after an edit.
- Touch only displayed lines — hunks on undisplayed lines are REJECTED. Far from the current visible range? `read` that exact range; do not re-explore unchanged coverage.
- Elided regions are UNSEEN (`…`/`..` markers, collapsed `N-M:` summary rows) — NEVER place or span a hunk inside one; `read` the range first.
- NEVER start or end a range mid-expression or mid-block.
- Ranges cover ONLY changed lines — never widen over keepers. Non-adjacent changes = separate hunks.
- Whole construct → `PUT N*:`; lines inside one → `PUT N.=M:`.
- `PUT N*:` resolves EXACTLY the node at N: leading decorators/attributes/doc-comments are separate nodes — point N at the FIRST decorator to sweep both; standalone line-comments are never swept (use `PUT N.=M:`).
- Block ops anchor the OPENING line of a MULTI-LINE construct — never the closer, last line, or a bare inner statement; one statement → plain op (`PUT N.=N:` / `CUT N.=N` / `PUT >N:`). Saw the closer? `PUT >M:`.
- Markdown: a heading IS a block opener — block ops on `##`/`###` resolve the WHOLE section (through deeper nested headings, up to the next same-or-higher heading). `PUT >N*:` after a section: end the body with a blank line to keep the next heading separated.
- Pure additions → `PUT <N:` / `PUT >N:`, never a widened `PUT N.=M:`.
- Move code with `CUT`+`PUT`: `CUT 5.=9 @fn` captures into `@fn`; `PUT >40 @fn` pastes it. Unlabeled `CUT` + `PUT >40` works for a single call-local move. Named registers persist across edit calls.
- NEVER format/restyle code with this tool; run the project formatter.
</rules>

<example>
`read` output shape:
```
[greet.py#A1B2]
1:def greet(name):
2:    msg = "Hello, " + name
3:    print(msg)
4:greet("world")
```

Edit, then move:
```
[greet.py#A1B2]
PUT 1.=3:
+def greet(name):
+    print(f"Hi, {name}")
MV lib/greet.py
```

Markdown bullets — file receives `- task`:
```
[PLAN.md#A1B2]
PUT >2:
+- task
+  - nested task
```

Move `greet` to sibling file via named register; flows across sections:
```
[greet.py#A1B2]
CUT 1* @fn
[other.py#3C4D]
PUT <1 @fn
```

`PUT 1*:` resolves lines 1–3 (`def` through `print(msg)`); line 4 separate, remains:
```
[greet.py#A1B2]
PUT 1*:
+def greet(name):
+    print(f"Hello, {name}")
```

Decorator/doc-comment separate block: point N at decorator to include both; anchoring `def` line 2 orphans `@cache`:
```
[svc.py#C3D4]
PUT 1*:
+@cache
+def load(key):
+    return store[key]
```
</example>

<anti-patterns>
# WRONG — empty `PUT` to delete. RIGHT: `CUT 4.=4`
PUT 4.=4:

# WRONG — range sized to the post-edit content. RIGHT: `PUT 1.=1:` (body length irrelevant)
PUT 1.=2:
+def greet(name):

# WRONG — `-` rows / bare context lines do not exist; the range deletes, the body is only new content.
PUT 3.=3:
    msg = "Hello, " + name
-   print(msg)
+   return msg
# RIGHT
PUT 3.=3:
+   return msg

# WRONG — pure insertion as a widened `PUT`: retyped keepers get dropped (here line 4).
PUT 2.=4:
+    msg = "Hello, " + name
+    extra = compute(name)
+    print(msg)
# RIGHT — touch nothing you keep.
PUT >2:
+    extra = compute(name)

# WRONG — `PUT >N*:` anchored on the closing delimiter / last visible line. RIGHT: plain `PUT >M:`
PUT >3*:
+after()
# RIGHT
PUT >3:
+after()

# WRONG — body rows under register PUT; register pastes take no body. RIGHT: bodyless `PUT >20 @fn`.
PUT >20 @fn:
+function f() {}
</anti-patterns>

<critical>
1. RE-GROUND AFTER EVERY EDIT: edits renumber and change `#TAG`; take next numbers from edit response or fresh `read`. Stale tag/surprise: STOP; re-`read`.
2. RANGES TIGHT: changed lines only. Whole construct: `PUT N*:`.
3. BODY FINAL CONTENT: every row starts `+`; Markdown bullet: `+- item`, not `- item`.
</critical>
