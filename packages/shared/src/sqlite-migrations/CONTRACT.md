# SQLite migrations

One runner owns admission, transaction, backup and ledger. Historical JSON checksums are explicit immutable hashes; SQL checksums are SHA-256 of trim SQL. Unknown or mismatched ledger entries fail closed.

Backups are required for affected existing tables, use explicitly configured directories, and publish metadata only after verification. Backup failure blocks all migration writes. No automatic volume discovery or backup deletion.

Restore requires stopped writers, matching database identity and unchanged table schema. It restores rows and ledger transactionally, checks foreign keys, and never claims generic DDL downgrade.
