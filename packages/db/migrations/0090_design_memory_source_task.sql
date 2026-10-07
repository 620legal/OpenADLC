-- Which design task proposed an entry. Only the design (spec) task on an
-- issue may propose design memory for it, read from a comment whose signature
-- verifies to that task; any crew comment used to, a builder's or one the
-- bridge echoed for a person included, and was accepted with the issue's move
-- to build. An entry proposed before this has none, and is never accepted on
-- its own: a person accepts or retires it in Settings.
alter table design_memory add column source_task uuid;
