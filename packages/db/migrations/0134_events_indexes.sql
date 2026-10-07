-- The board, the health checks and the dispatcher read events by type and
-- by source over a window, and the table had only its primary key and the
-- unprocessed index, so each read scanned every delivery the install had ever
-- received. Plain, not concurrently: migrate.ts applies each file in a
-- transaction. The brief write lock is fine at these tables' sizes.
create index if not exists events_type_at on events (type, at);
create index if not exists events_source_at on events (source, at);
