# Multi Note production deployment

2026-11-21, Asia/Tokyo. Production deployment and backups were explicitly requested after the integration and channel-color review.

| Site | Production release | Code revision |
| --- | --- | --- |
| https://misskey.grid-space.io | `2026.11.0-grid-space.31.74` | `8a3311bfeb05000562767dd4ea0c955a8fe7bb2e` |
| https://misskey.resonite.love | `2026.11.0-resonite-love.31.73` | `8491d0dd97d2ea4ca4b88e427bdca300c38bc219` |

Both sites run the exact Linux/amd64 images built from committed Git archives. OCI revision/version labels, image IDs, packaged versions, public HTML, client assets and detailed API metadata were checked. Both `features.multiNote` and `features.multiNotePeer` are enabled. Existing public origins, private LAN transport, TLS CA, shared HMAC key, legacy channel roles, PostgreSQL, Redis and upload mounts were retained.

## Backups and migration rehearsal

Private recovery artifacts are stored outside either repository at `C:/Users/neo/AppData/Local/MisskeyDeployments/20261121-multi-note`, restricted to the local user and SYSTEM. This includes consistent PostgreSQL custom dumps and globals, compose/config/TLS archives, runtime inventories, local upload archives, stopped-web Redis snapshots, previous image archives, exact source archives, Git bundles and checksums. External object storage was not copied or modified.

Both full logical restores succeeded on an isolated internal Docker network without public ports or application workers. Note/user/channel counts matched the captured pre-dump counts: G 94,305 / 5,142 / 4; R 19,191,106 / 203,296 / 18. Configuration archives were fully read and checked. Temporary restored databases are disposable; the recovery files are retained.

The two new migrations `MultiNotePlacement1795200720406` and `GridspacePlacement1795200743973` were rehearsed against the full restores, then applied with both production web services stopped and one runner per database. Production migration runners took approximately 2.17 seconds on G and 19.31 seconds on R. Histories now contain 380 and 379 entries respectively; the new CHECK and trigger are valid and no invalid indexes or unvalidated constraints were found. Published migration files were unchanged.

G's schema check passed with zero pending DDL. R has a pre-existing custom PGroonga text index that its schema checker reports as DROP/CREATE. The previous production image on the original restored schema and the new image on the migrated full restore produced byte-identical DDL. The actual production index remains valid with the same definition. This is recorded as BASELINE, with zero additional schema differences; no schema synchronization or index removal was performed.

## Projection performance repair

Before enabling Multi Note, the first disabled rollout exposed a large-database query-plan problem: C-collated canonical URIs prevented use of the default-collation note URI index. R's legacy timeline briefly exceeded the read-check timeout while background projection and verification scans competed. ANALYZE restored ordinary read latency; a code repair was required before activation.

The final releases use indexed per-event ID/URI candidates, apply default collation only to indexed note URI lookups, and skip note lookups when no active default placement exists. Canonical URI uniqueness/order and existing placement authorization, checkpointing, pin refresh and fanout semantics were preserved. This repair adds no API or migration changes.

The two nearest suites passed 19 tests per fork, plus 19 tests on PostgreSQL 18 with builtin C collation. Full restored databases were exercised with empty placement tables, transaction-only active fixtures, canonical/activity aliases, duplicate suppression, wrong-origin exclusion and 1,000 historical events. R's historical batch took about 5 ms without note sequential scans. All fixture writes rolled back. Changed-file ESLint, SPDX, locale safety and diff checks passed; independent source review found no blocker.

Actual production read-only EXPLAIN ANALYZE confirmed no note sequential scans and no note lookups without active placements: G 0.461 ms, R 16.987 ms. After activation, both projection checkpoints caught up to their change heads and no projection query older than one second was active at the final check.

## Activation and browser verification

Both repaired images were first started with creation disabled. Image/health checks, existing ordinary timeline reads, relay-free note contents, public assets and signed LAN handshakes passed. Replay and invalid signatures were rejected. Only after both peers were ready was `multiNote.enabled: true` added and both web services restarted. Public capabilities and signed placement enable flags then passed in both directions.

Authenticated browser checks on both production sites verified favorite-first channel selection, combined local/peer search results with site chips, G ordinary posting plus both sites' channels, R channel-only selection across both sites, the existing relay-free delivery option, and readable historical channel timelines with 5 px color bands. Both empty composers were closed; no production test note was submitted. Captured console error lists were empty. Three-color/capped-four-color cases retain the prior unit and browser validation recorded with the feature work; no frontend behavior changed in the projection repair.

The existing kokopi G/R labs were also rebuilt to these final releases, preserving accounts, fixtures, databases, Redis and tunnels. Both local/peer capabilities, ordinary reads and exactly one representation of each original cross-site fixture passed. The external E lab was retained.

The earlier complete integration and color validation remain applicable. Full frontend type checking retains its previously documented 63 baseline diagnostics per fork; it is not reported as passing. G's broader feature evidence is in `plans/multi-note-validation.md`, and R's is in `plans/multi-note.md`.

## Recovery boundary

The previous binaries must not serve new-format channel-only roots or conversation replies: old code can classify public rows with NULL channelId as ordinary posts. After new-format writes exist, keep upgraded binaries and forward-fix, disabling new creation if necessary. Do not run destructive down migrations or restore an old dump over subsequent real user writes without explicitly handling those writes. The private `ROLLBACK.md` records the guarded recovery procedure.

Changelog candidate: Support one shared note across ordinary posting and multiple channels on both sites, with combined channel selection and up to three channel-color bands.
