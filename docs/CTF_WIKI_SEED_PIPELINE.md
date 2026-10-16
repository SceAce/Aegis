# CTF Wiki GitHub seed pipeline

The primary input is the official Markdown/image repository, not an anchor crawl. Run from the repository root with Node.js and Git:

```sh
node build-ctf-wiki-seeds.mjs --github-repo https://github.com/ctf-wiki/ctf-wiki.git --github-ref master --github-output knowledge/ctf-wiki-github
```

Git uses the optional local proxy `http://127.0.0.1:7897` by default (`--proxy`). No credentials, provider, model, or target are used. Git prompting and credential helpers are disabled. A shallow branch clone is staged temporarily; no `.git` metadata enters the knowledge output. The actual resolved commit is recorded and all seed source URIs are pinned to that SHA. For repeatability, pass a commit SHA as `--github-ref` after selecting a revision.

The builder inventories tracked paths, applies repository byte/file bounds before checkout, compiles Markdown with the existing `compileDocumentSeed`, and inventories allowed image formats by relative path, SHA-256 digest, and size. Image bytes are not put in seeds or copied to knowledge output. Vendored/generated, `.git`, and `node_modules` paths are excluded; non-Markdown files are not compiled. Categories derive from the leading category path, with optional leading language retained. Unknown paths map to `other`.

| Option | Default | Hard maximum |
| --- | --- | --- |
| `--max-files` | 20000 tracked paths | 100000 |
| `--max-repo-bytes` | 800000000 tracked blob bytes | 2000000000 |
| `--max-seed-bytes` | 262144 bytes per Markdown file | compiler maximum |

These are explicit bounded defaults, not a claim that every current repository file was fetched or compiled. Raise bounds only when the repository size and local disk capacity are understood. A repository exceeding a bound fails before checkout and writes a failure manifest when output ownership permits. Runtime manifest counts are authoritative: `markdown.found`, `compiled`, `failed`, `skipped`, `skipped_reasons`, `transformed_fences`, and `split_parts`, plus `assets.found`, `assets.bytes`, and the per-asset inventory. Fetch failure exits nonzero and does not create fake seeds. Git LFS smudging is disabled, so LFS pointers are not expanded into assets.

Empty tracked Markdown files are counted as `skipped_reasons.empty_markdown`; they contain no reference content and are not errors. Malformed/unclosed fence documents use the GitHub-only bounded normalization path when possible, and each transformed seed records `provenance.source_transform`; this does not alter the strict general document compiler.

Each compiled JSON is a normal compiler-produced document seed with `source_kind: external_reference`, `approved: true`, `verified: false`, and `action_policy: none`. The compiler owns all semantic fields. Seed paths retain category and optional language; original repository paths remain in the manifest. Failures are recorded per path. The output manifest records repository URL, ref, resolved commit SHA, generation time, compiler, bounds, counts, inventory, and errors.

`knowledge/ctf-wiki/` is ignored. Output must be absent: the builder refuses existing, symlink, or non-directory output paths instead of deleting or replacing stale/unrelated files. It creates output in a sibling staging directory and promotes it by rename only after writing the complete manifest. Temporary clone data is removed. A failed fetch can leave only a failure manifest, never seeds from a fabricated or partial source. Review any old output separately before choosing a new destination; stale output is never silently deleted.

Offline validation uses only a temporary local Git fixture and performs no GitHub fetch:

```sh
node Pi_Agent_base/tests/aegis-ctf-wiki-seeds.mjs
```

This test verifies commit-pinned provenance, path classification, compiler output, asset metadata without image bytes in seeds, CLI bounds, and refusal of existing/symlink outputs. It does not establish live repository size or coverage. No real GitHub fetch is performed by tests.
