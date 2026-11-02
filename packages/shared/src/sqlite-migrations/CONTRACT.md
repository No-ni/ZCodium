# SQLite migrations

One runner owns admission, transaction, backup and ledger. Historical JSON checksums are explicit immutable hashes; SQL checksums are SHA-256 of trim SQL. Unknown or mismatched ledger entries fail closed.

Backups are required for affected existing tables, use explicitly configured directories, and publish metadata only after verification. Backup failure blocks all migration writes. No automatic volume discovery or backup deletion.

Restore requires stopped writers, matching database identity and unchanged table schema. It restores rows and ledger transactionally, checks foreign keys, and never claims generic DDL downgrade.

A scoped caller may supply recognizedMigrations for other scopes sharing the same ledger. Their immutable contracts are validated and their existing checksums checked; they are never pending or applied by this call. IDs outside both the active and recognized contracts still fail closed.
