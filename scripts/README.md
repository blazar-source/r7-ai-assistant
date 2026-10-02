# Authored-code audit

Run `npm run audit` or `node scripts/static-audit.mjs <file-or-directory>...`.
The default inventory recursively scans JavaScript (`.js`, `.mjs`, `.cjs`)
under `src`, `scripts`, `dist`, `artifacts` and `packaging`. This includes
`src/plugin` and generated authored bundles. Explicit missing inputs, unreadable
files, symlinks, and parse errors fail closed; absent optional output directories
are permitted. Acorn 8.15.0 is pinned, development-only. Browser source imports no
runtime packages. Existing official R7 SDK remains installed, trusted under ADR
0002, unchanged and outside this repository; there is no broad vendor exclusion
within authored source.

The guard reports only file label, one-based line/column and static error code.
It never prints source snippets or raw parser/I/O errors. Regression fixtures in
`tests/security` are **inert strings passed only to the parser**, never executed.
Tests and node_modules are not default production/tooling audit inputs. A quoted
mention of `eval` inside data/comments is not executable code and is permitted.

Policy rejects references to eval/Function/constructor/execScript sinks,
including aliases, optional/global/static-computed forms and destructuring.
Ordinary computed **data** reads/writes (`array[i]`, `dictionary[field]`, Buffer
indexing and computed data fields) are allowed. Unknown computed calls/new/tagged
calls, global computed lookups, dynamic import and reflective dynamic lookup fail
closed. A scope-insensitive fixed-point check tracks computed values through local
variable/assignment/destructuring aliases and object/array containers when they
are actually called. Timers and callCommand must receive inline, synchronous,
non-generator authored functions; extracted aliases and variable/string bodies
are rejected. Validated JSON-compatible model data can cross through Asc.scope,
never interpolation into function source.

This is a conservative source-control guard, **not a JavaScript sandbox**, general
alias/flow analysis, or proof of runtime command eligibility. The local check is
monotone (no untainting), conflates shadowed names, and taints a whole container
on a computed-value assignment: calling even a harmless method on indexed data
may need rewriting. Callback aliases remain disallowed. Interprocedural returns,
higher-order callback execution, getters/proxies and arbitrary heap flow are not
fully modeled. It does not prove import/package trust, dynamic DOM script insertion,
all host execution APIs, mutable object
identity, editor atomicity, or malicious arbitrary JavaScript isolation. The
reviewed no-model-code architecture and runtime capability gate remain binding.
Any later new execution API, authored source directory or bundle location must be
reviewed and included explicitly; do not treat a PASS as R7/CEF compatibility.
