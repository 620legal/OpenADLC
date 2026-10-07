-- Whether opening a gate put `needs-human` on its subject. The label is also
-- how a person holds a pull request, and answering any gate took it off,
-- lifting the hold without a word. A gate answered now takes it off only when
-- it was the crew's question that put it there. A gate already open when this
-- runs did put it there, as far as anyone can tell: it keeps today's
-- behaviour.
alter table gates add column if not exists added_needs_human boolean not null default true;
