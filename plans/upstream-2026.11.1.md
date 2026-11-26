# Official 2026.11.1 upgrade

Released to both production servers on 2026-11-26 (Asia/Tokyo), as requested by the owner. Upstream tag `2026.11.1` resolves to `f14aeee1bdb6a97e8f5d1ff3ecfb570cc5ad608c` ([release notes](https://github.com/misskey-dev/misskey/releases/tag/2026.11.1)). Both forks merge the complete upstream history into their latest master branches.

| Site | Version | Packaged source |
| --- | --- | --- |
| Gridspace | `2026.11.1-grid-space.0` | `bdda10850d94b1778a45bd561ba7a8bf1a043f34` |
| Resonite Love | `2026.11.1-resonite-love.0` | `a14e9af02bf11d2985e711a7e0906a75794fb97c` |

The official dependency and translation updates are included, using Node 26.13.1 and the new pnpm 12.20.0 pin. Existing fork-only dependencies and intentionally disabled fork workflows are retained. Non-Japanese translations were not manually edited: the 11 imported locale files were checked against their automatic upstream three-way merge results. English retains the existing fork `morse` key. The shipping script flags these imported files under its usual locale rule; import provenance is verified separately. The official changelog is merged alongside the existing fork entries, with no new manual changelog entries.

## Integration changes

Multi Note, paired-server placement, channel-only posts, relay-free distribution, custom previews and paired emoji routing are retained. The recipient-specific note packing changes coexist with placement checks and follow guards. The fork's authorized follow-request path now retains the upstream Follow activity ID, matching ordinary follow creation and preserving the new Undo behavior.

Gridspace's Spaces Play component now uses the upstream AiScript root callback. Restart unmounts the previous UI before rendering a new root; real modern and legacy interpreters cover rendering, restart and disposal. Spaces remains enabled on G and disabled on R, as before. G's reaction display preference and web-icon settings remain intact.

R receives the previously verified generic preference compatibility fix: preserve unfamiliar records/revisions, avoid rewriting unchanged reactive values, and isolate older clients with BroadcastChannel v3. This prevents the newly introduced official URL-preview preference from triggering older clients' repair loop. This port does not add G-specific icon or reaction preferences to R.

## Validation

- PASS: both complete Linux/amd64 production image builds and image unpack/execution checks.
- PASS: 31 backend unit tests per fork, including Follow/Undo behavior, proxy handling and HTML parsing; SDK regeneration and API extractor completed with no tracked SDK changes.
- PASS: G frontend runs of 250 tests, 79 preview tests, and 52 player/AiScript tests; the latter overlaps the AiScript suite in the first run. R frontend runs of 117 tests and 22 preference tests.
- PASS with fixture baseline: all 39 distinct selected backend E2E cases per fork passed across a combined run (38/39) and an isolated fresh-database retry (1/1). The combined run's remaining case assumes its author is the first signup and therefore the administrator; earlier describes claim that role. The relevant fixture and helpers are unchanged from the previous fork versions.
- PASS: changed-file ESLint, SPDX, whitespace checks, independent Vue/backend integration review, and automatic translation provenance checks.
- BASELINE: frontend typechecking retains 101 diagnostics on both forks. G exactly matches its previous normalized diagnostic set after building workspace prerequisites; R matches the same files/error codes and has no AiScript/preference/new-API diagnostics.
- PASS: Chrome login on both synthetic servers, ordinary/channel placement badges, G numeric reactions (`2`, no avatars), both relay menus, R favorites picker and actual ordinary-plus-channel posting with `noRelay: true`. G's real AiScript Play rendered its expected message. Console errors: zero on both previews and production about pages.

The [channel screenshot](../docs/screenshots/upstream-2026.11.1-channel.jpg) contains only synthetic accounts and notes. Disposable browser and restored-database fixtures were removed after verification. Production preferences were not changed.

## Database and recovery

The sole new official migration adds nullable `following.requestId` as `varchar(512)`. Existing migration files are unchanged. Full production backups were restored into isolated databases, using PostgreSQL 18 for G and the matching PGroonga/PostgreSQL 15 image for R. Migration up/down/up preserved every data table's row count. Old application models successfully read the upgraded following records. The new migration and exact column shape were also confirmed on production after rollout.

G: 146 restored data tables, 151,967 notes, 13,692 following records; final schema check pending DDL 0.

R: 143 restored data tables, 19,253,149 notes, 26,902 following records, including its large search index. Schema checking exits 1 for the same existing PGroonga index DROP/CREATE pair before and after the upgrade; **new pending DDL is 0**. This baseline was compared explicitly. No search-index DDL was applied to production.

Fresh consistent database dumps, globals, configuration/TLS, runtime inventories and local uploads were retained and their checksums and complete archive blocks verified before rollout. Dump sizes: G 81,783,054 bytes; R 4,030,233,392 bytes. Both application hosts retain recovery files at `/home/neo/misskey/backups/20261126-upstream-2026-11-1` and previous images tagged `upstream-2026-11-1-rollback-g:20261126` / `upstream-2026-11-1-rollback-r:20261126`. Application rollback can retain the additive nullable column; a database restore is not required for ordinary image rollback.

Production is healthy at both requested versions. Config checksums, existing relay behavior and feature flags match pre-release values. Only the application image references were changed in compose. Unused application images were removed only after checking all container references and excluding rollback-tagged images; databases, volumes and backups on production were preserved.

Changelog candidate: Merge official Misskey 2026.11.1 while retaining the Gridspace and Resonite Love extensions.
