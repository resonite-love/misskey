# Selected-user search recovery

2026-11-26, Asia/Tokyo.

| Site | Production release | Runtime source |
| --- | --- | --- |
| grid-space | `2026.11.0-grid-space.31.101` | `7a584244dbe36d124803a88c4e015436ba3fd3e8` |
| resonite-love | `2026.11.0-resonite-love.31.101` | `7f56314a5a1b9f626fe066566ccdf91be78e7f27` |

The reported `/search` request selected one paired-site author and a one-character term. It returned an empty partial unified page (`peer: unavailable`), followed by an empty local fallback. The corresponding peer timeline requests took about three seconds and returned HTTP 403. A 403 alone does not establish a revoked account grant: this route also maps database failures to a peer-unavailable response.

`GridspaceSearchService.readAuthorPage` skipped the direct `note.userId` predicate for zero or one resolved author. In the singleton case, the public peer search arm retained only its constructed-URI author filter, losing the intended indexed author scan. Every resolved author now gets the same cloned, author-constrained query. An explicit empty author list returns no matches; an omitted list retains unscoped search. The legacy unscoped caller uses the ordinary read path explicitly. Existing audience, mute/block, time and cursor conditions remain composed with the author predicate.

Validation:

- PASS: the new PostgreSQL singleton-author regression fails against deployed `.100` source supplied in memory and passes after the fix. The nearest complete suite passes 11/11 on each fork, including multiple-author pagination and public/private audience cases.
- PASS: changed-file ESLint, SPDX, locale safety and whitespace checks on both forks. Independent Astra review found no blocking ACL or pagination regression.
- PASS: full Linux/amd64 images built from clean committed Git archives; source bundles, archive checksums, OCI source/revision/version labels and packaged versions checked. No public API schema, SDK, entity, migration or ActivityPub changes.
- PASS: R backend source typecheck. G's local source check is not claimed as passing: its new worktree lacks workspace build artifacts and reports diagnostics outside the changed files. The full Linux image build succeeds on both forks.
- PASS: deployed R, checked health, then deployed G. Both runtime versions/revisions/image identities, public metadata/HTML/client assets, ordinary timeline samples, relay-free sample behavior and configuration hashes checked. Signed peer capability, replay rejection and invalid-signature probes pass in both directions.
- PASS: authenticated production browser repeated the original selected-user request and received 27 items, `complete: true`, with both local and peer sources `ok` and no fallback. The visible first result contains the searched term. No production test post or account relationship change was made.

Fresh online PostgreSQL backups were taken before rollout: G 80,788,990 bytes, R 4,029,417,811 bytes. Both checksums, archive contents, database TOCs and every compressed data block were verified. Compose/config/TLS, globals, runtime inventory and local uploads are retained privately under `C:/Users/neo/AppData/Local/MisskeyDeployments/20261126-selected-user-search/database-backup`. Previous application images and compose/config snapshots are retained on each host under `/home/neo/misskey/backups/20261126-selected-user-search`. The database schema and external object storage were not modified.

Release, backup, health, peer and browser evidence, including `search-fixed.jpg`, is retained in the private deployment directory. Separate worktrees based on the latest respective masters preserve the earlier `feat/multi-note` worktrees. Integration is through master-targeting PRs while parallel work exists, following the repository release policy.

Changelog candidate: Fix selected-user search timing out when exactly one paired author resolves.
