# Resonite package attachments

The Web client displays `.resonitepackage` attachments as a card with package name,
file size, embedded assets, slot/component counts, optional thumbnail and download.
Download counts are outside this change. ActivityPub messages are unchanged.

## Format findings (2026-11-26)

Validated against four local packages and the installed Resonite package reader.
The container is ZIP, with `R-Main.record` JSON and extensionless
`Assets/<SHA-256>` entries. `packdb:///<hash>[.extension]` references those entries.
Count assets from ZIP entries: a valid record can have an empty asset manifest.

The object payload starts with `FrDT`, little-endian version 0 and a compression
byte. Brotli (3) wraps BSON. Count `Object` plus recursive `Children` as slots;
count each slot's `Components.Data` as attached components. Root `Assets` are
standalone providers and must not be counted as attached components.

LZ4/LZMA object payloads retain basic archive statistics, with unknown tree counts.
Mesh metadata is optional and excludes procedural meshes; polygon totals are not
reported. Never present unsupported or failed analysis as zero.

## Integration and limits

New uploads are inspected from their existing temporary file. Successful results
use the existing DriveFile properties JSONB; no migration or background backfill.
Older readable attachments are inspected only when requested, with visibility
checked before and after I/O. Owner/moderator access requires the drive-read scope
for scoped tokens. Errors are retryable and never remove the download action.

Archive size, entry count, individual reads, object expansion, BSON traversal,
thumbnail pixels/output and concurrent lazy inspections are bounded. Content is
read without loading engine types or fetching package-referenced external URLs.
Private peer attachments cannot request local analysis. Sensitive cards follow
the existing reveal rules; authorized local blob downloads remain supported.

Validation includes synthetic parser, access-control and retry tests, frontend
reveal/cancellation/context tests, SDK generation, migration checks and isolated
browser/API fixtures on both forks. Original packages and decompiled source stay
outside the repository.

Changelog candidate: Show content statistics and downloads for Resonite package attachments.
