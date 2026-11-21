# Paired co-reaction source identity release

2026-11-21, Asia/Tokyo. The user requested incorporating the reaction investigation from Codex chat `01a1fc52-302c-76e0-aa63-14439d3adb39` into both Multi Note branches and deploying both sites with backups.

| Site | Production release | Committed source |
| --- | --- | --- |
| https://misskey.grid-space.io | `2026.11.0-grid-space.31.75` | `0ae528f4ae12798886d85e14dc4deacdb4a51e99` |
| https://misskey.resonite.love | `2026.11.0-resonite-love.31.74` | `9ec9ee9c252bc68b796b4c2b919d84d6c22ffa72` |

## Behavior and scope

Clicking an existing custom-emoji group on a paired-server note now preserves the original server's emoji identity. The frontend sends an explicitly source-qualified key for co-reaction adds. It still sends the original raw key for removal; picking a new emoji retains the actor's home-server namespace.

The referenced chat's original frontend-only change was insufficient for unlinked guests and dedicated Multi Note guests. The integrated backend checks the authenticated peer context, exact source host including port, and an existing primary or extended reaction on that same note before selecting the source-local emoji. It prepares the reaction once and persists that prepared value for first and additional reactions, avoiding a second namespace resolution that could turn it into a heart.

The actual actor remains responsible for visibility, blocks, roles, reaction acceptance, sensitivity, media silence and local-only rules. Arbitrary remote-looking strings are not globally reinterpreted as local emojis. This release adds no public API fields, schema, entity or migration changes. ActivityPub delivery and Multi Note placement contracts are unchanged. Previously stored hearts are not automatically rewritten because the intended original emoji cannot be reconstructed reliably.

## Validation

- PASS: 59 backend cases across six files in each fork, including 17 PostgreSQL persistence cases through the real action and primary/extended insertion path. Cases cover linked actors, legacy and dedicated unlinked guests, first/additional reactions, raw spellings, exact source host/port, wrong host/note, namespace collisions and policy denials.
- PASS: backend production-source and supplemental focused test typechecks; 18 frontend cases across the grouping, mounted viewer and picker suites in each fork. Independent Astra frontend/Vue review found no blocker.
- BASELINE: full frontend typechecks retain exactly 63 pre-existing diagnostics in each fork, matching diagnostic locations, codes and messages. This broad check is not reported as passing.
- PASS: final changed-file ESLint, SPDX, locale safety and whitespace checks; both official Linux/amd64 image builds and both complete lab builds.
- SKIPPED: SDK generation and migration/schema rehearsal for this release, since API schemas, entities and migration files are unchanged from the already deployed Multi Note releases.
- PASS: live browser adds and cancellations with unlinked guest accounts for G dedicated notes viewed from R, R dedicated notes viewed from G, and R legacy notes viewed from G. Actual source PostgreSQL rows contained the original local custom-emoji keys for both primary and extended reactions. After cancellation, both guest tables contained zero owned fixture reactions; seeded admin reactions remained.
- PASS: both public kokopi labs retain Multi Note capabilities, ordinary reads and exactly one representation of existing cross-site fixtures. The external E lab remains running.

## Backups and coordinated deployment

Fresh consistent PostgreSQL custom dumps and globals, compose/config/TLS archives, runtime inventories and local upload archives were saved outside the repositories in `C:/Users/neo/AppData/Local/MisskeyDeployments/20261121-reaction-source`, restricted to the local user and SYSTEM. Dump sizes are 69,133,218 bytes for G and 4,018,164,483 bytes for R. Every saved artifact's checksum, configuration/upload archive contents, PostgreSQL table of contents and all compressed data blocks were verified. This turn did not repeat a full logical restore; the preceding schema release's full restore rehearsal remains recorded in [the initial deployment record](multi-note-production-deployment.md). External object storage was neither copied nor modified. Redis storage is unchanged by this code-only release.

Both exact committed images were loaded and verified before downtime. Both old web services were stopped before either updated service was started, avoiding a mixed pair interpreting source-qualified keys differently. Existing configuration, storage, paired roles, TLS and authentication were retained; Multi Note and peer placement stayed enabled.

Post-deployment checks passed for public versions, exact image identities and OCI revisions, healthy containers, HTML and client assets, both signed LAN handshakes, placement enable flags, replay rejection, invalid-signature rejection, ordinary timelines and existing relay-free note fields/content. Authenticated production browser reads show the original post and grouped reactions on both sites with empty captured console-error lists. Production checks made no test posts or reaction mutations.

Both kokopi G/R labs run the same release versions. Private release/build manifests, browser evidence, backup verification and deployment results remain alongside the recovery artifacts.

## Recovery

The immediate previous images, G `.31.74` and R `.31.73`, already understand Multi Note storage. Their archived bytes and checksums were verified, with remote rollback tags and copies of the pre-release compose/config files retained. If this reaction change requires rollback, coordinate both web services and revert only to this immediate Multi Note-aware pair, retaining the database and configuration. Do not revert to pre-Multi Note binaries, run down migrations or overwrite subsequent real user writes with a backup.

Changelog candidate: Preserve original custom emojis when adding or removing reactions on paired-server notes, including unlinked Multi Note guests.

