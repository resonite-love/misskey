# Linked channel follows in Home

2026-11-21, Asia/Tokyo.

| Site | Production and kokopi lab release | Committed runtime source |
| --- | --- | --- |
| https://misskey.grid-space.io | `2026.11.0-grid-space.31.76` | `5aaafd8c6a74fd3e70971659d417ff4b0b58671e` |
| https://misskey.resonite.love | `2026.11.0-resonite-love.31.75` | `1fd7a588ca56fb2b77b201defbd2b8735c633f2d` |

## Problem and correction

The existing G channel UI used the linked R native account's authorized channel read context. Multi Note Home instead looked only at the current G actor's R guest follows. A channel could therefore correctly appear followed in the UI while its new placements were missing from Home. The reported example was https://misskey.grid-space.io/notes/attm1r5y49r80225, a channel-only root placed in R's LLM channel. Its note and placement were already active; ordinary-post classification was not the cause.

The remote followed lane now obtains the existing private channel read grant when the configured legacy channel client is linked to the source. The receiver validates the current actor, exact grant subject, private grant, source direction and link direction, and revalidates authorization after querying. It uses the authorized native account's follows alongside the current actor's follows. Either account's channel mute or channel-owner block excludes the channel. Follow, unfollow and policy invalidation checks cover both preference identities.

The actual actor still controls note visibility, hydration, ownership, deletion, roles, reactions and votes. No follows are copied, moved or recreated, and no linked actors are merged for writing or counting. New subscriptions retain their existing current-actor storage. This is a read compatibility path for the existing linked channel UI, not a subscription migration or a general union of linked account permissions.

The optional private request credential is gated by `channel-placement-linked-follows-v1`. Old peers and viewers without a private grant retain current-actor-only followed reads. The change uses the existing signed two-site protocol. It changes neither ActivityPub nor public API/SDK fields, entities or database migrations.

## Validation

- PASS: 53 focused backend tests in each fork after integrating the paired reaction repair. These include 17 placement-source tests with real PostgreSQL temporary tables, grant revocation before/after reads, wrong subject/purpose/direction, old-peer fallback, follow selection, mute/block denial and policy invalidation; the peer-server suite contributes 36 cases.
- PASS: independent Astra review found no Critical or Major findings. Changed-file ESLint, SPDX, locale safety and diff checks passed.
- PASS: both official Linux/amd64 images were built from clean committed Git archives. Version/revision labels, source bundles, packaged versions, exported archive checksums and loaded runtime image identity were verified.
- PASS: both kokopi labs were fully rebuilt and safely restarted. Public metadata/frontends and existing ordinary/channel fixtures passed, including one deduplicated peer mirror. The external lab, databases, Redis, accounts, fixtures and tunnels were retained.
- PASS: production R was upgraded before G. Both services are healthy; public metadata, HTML, assets, ordinary timeline reads, signed TLS peer capabilities, replay rejection and invalid-signature rejection passed. Existing configuration hashes and relay-free sample behavior were preserved.
- PASS: the authenticated production G browser showed the originally reported note exactly once in Home, with its R channel chip, channel-color band and original body. The native follow remained present and the guest follow remained absent, confirming that no re-follow or preference copying was required. No production test post or subscription mutation was made.
- SKIPPED: SDK regeneration and migration checking for this repair, because public API definitions and entity/schema files are unchanged. The earlier release's documented frontend type-check baseline remains applicable; full application builds are passing.

## Backups and recovery

Private artifacts are at `C:/Users/neo/AppData/Local/MisskeyDeployments/20261121-home-follow`, outside Git and restricted to the local user and SYSTEM. Fresh configuration/runtime snapshots and rollback image tags were captured before switching either service. Both hosts retain a private `/home/neo/misskey/backups/20261121-home-follow` snapshot. Existing current data was retained.

The database recovery baseline is the immediately preceding paired-reaction release's consistent online dumps, completed at 15:46:35 JST on G and 15:57:21 JST on R. Their complete decoding checks and SHA-256 hashes were verified again before this code-only release. No new database dump, data migration, Redis rewrite or object-storage change was performed for this repair. Source archives, verified Git bundles, image archives, checksums, lab checks, health results, signed peer checks and `production-g-home.jpg` are retained privately.

The Multi Note recovery boundary still applies: do not serve new-format channel-only roots through pre-Multi-Note binaries or restore an old database over subsequent real posts. Preserve upgraded binaries and forward-fix.

Changelog candidate: Fix missing Home posts when a channel is followed through the existing linked-account channel UI.
