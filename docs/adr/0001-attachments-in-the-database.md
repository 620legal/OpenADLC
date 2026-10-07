# 0001. Attachments live in the database

- **Status:** accepted
- **Date:** 2026-09-30

## Context

A request is better with a screenshot of what the page should look like, a
mockup, or the PDF of the requirements, and intake has to see them to ask the
right questions. Those files have to be kept somewhere both kinds of install
reach:

- A **local** install has a disk under `FLEETADLC_HOME`, a Postgres in a
  container, and backups that archive the database's history.
- A **cloud** install runs the bridge on Cloud Run, which has no disk that
  outlives a revision, and Cloud SQL, which every component already uses. A
  file written under `FLEETADLC_HOME` by one revision is gone for the next.

The files are small by design (10 MB each, 20 files and 25 MB per work item),
and they are read rarely: when a person looks at them, and when a task that
needs them starts.

## Decision

Attachments are rows in Postgres (`attachments`, migration 0029), the bytes in
a `bytea` column, behind one module (`packages/db/src/store/attachments.ts`)
that nothing reads around: no caller selects `content` by name, and the
metadata reads never select it. They are claimed by the request or message
they were sent with, swept after a day when nothing claimed them, and carried
by a backup's history group as base64 with a count of their own.

They are never posted to GitHub: a private repository's screenshot on an
issue is one link away from anyone it is forwarded to, and the crew reads the
file from FleetADLC, not from the issue.

## What this rules out

- **Files under `FLEETADLC_HOME`.** Lost on every Cloud Run revision, not in a
  backup's history, and a second store to keep in step with the rows that name
  them.
- **A bucket (GCS, S3) now.** A new dependency, a credential per install, and
  a second thing a local install would have to run or fake, for files that fit
  comfortably in the database at these limits. The module boundary is where a
  bucket driver goes if the limits ever grow.
- **Uploading them to GitHub** (as an issue's user-attachments). Public to
  anyone with the link, out of FleetADLC's control once posted, and not
  deletable by FleetADLC.

## What would make this worth revisiting

Limits large enough that a backup or the database's size is dominated by
attachments: video, or hundreds of megabytes per item. Then the module grows a
bucket driver, the rows keep the metadata, and this record is superseded.
