import { describe, expect, it } from 'vitest';
import { compareInstall, itemsOf } from './compare.js';
import { changeCount, planRestore, readPlain, writePlain, type BackupContents, type InstallSnapshot } from './index.js';
import { describeContents, describePlan } from './summary.js';

/**
 * Files given to the crew are in the history group: a restored request whose
 * screenshot was left behind is a question nobody can answer. They travel as
 * base64 with a count of their own, and an archive written before them still
 * reads as it was written.
 */

const PNG = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 1, 2, 3]);

function contents(withFiles: boolean): BackupContents {
  return {
    manifest: {
      version: 3,
      createdAt: '2026-09-30T09:00:00.000Z',
      counts: { secrets: 0, settings: 0, bots: 0 },
      includes: { install: false, repositories: false, bots: 'none', botSignIns: false, accounts: 'none', accountSignIns: false, history: true },
    },
    secrets: {},
    settings: {},
    bots: [],
    repositories: [],
    accounts: [],
    logins: {},
    identities: [],
    history: {
      threads: [],
      messages: [],
      audit: [],
      ledger: [],
      requests: [],
      ...(withFiles
        ? {
            attachments: [
              {
                id: '0b6a7e4c-2f1d-4c0a-9a55-3d2e1f0a9b8c',
                subjectRef: 'request:a4b02784',
                repo: 'api',
                requestId: 'a4b02784-3ae8-450b-abe9-0c93eb4d67dc',
                messageId: null,
                source: 'console' as const,
                sourceUrl: null,
                name: 'mockup.png',
                mediaType: 'image/png',
                sizeBytes: PNG.length,
                sha256: 'f'.repeat(64),
                content: PNG.toString('base64'),
                uploadedBy: 'jane@acme.test',
                createdAt: '2026-09-30T08:59:00.000Z',
              },
            ],
          }
        : {}),
    },
  };
}

describe('attachments in a backup', () => {
  it('come back byte for byte, counted on their own', () => {
    const read = readPlain(writePlain(contents(true)));
    expect(read.manifest.counts.attachments).toBe(1);
    const [file] = read.history!.attachments!;
    expect(Buffer.from(file!.content, 'base64').equals(PNG)).toBe(true);
    expect(file).toMatchObject({ name: 'mockup.png', subjectRef: 'request:a4b02784', source: 'console' });
    expect(describeContents(read).join('\n')).toContain('1 attachment');
  });

  it('leave an archive written before them reading as it was written', () => {
    const read = readPlain(writePlain(contents(false)));
    expect(read.manifest.counts).not.toHaveProperty('attachments');
    expect(read.history!.attachments).toBeUndefined();
  });
});

const EMPTY_INSTALL: InstallSnapshot = {
  secrets: {},
  settings: {},
  bots: [],
  credentials: {},
  repositories: [],
  accounts: [],
  logins: {},
  history: null,
};

describe('attachments in a restore', () => {
  it('are counted in what a restore says it adds, as they are written', () => {
    // The restore wrote every archived file, but the plan, its summary and the
    // comparison spoke only of threads, messages, the audit log, costs and
    // requests: a person approving it did not know the old install's files came too.
    const archive = contents(true);
    const plan = planRestore(archive, { secretRefs: [], settingKeys: [], bots: [] });

    expect(plan.history?.attachments).toBe(1);
    expect(changeCount(plan)).toBe(1);
    expect(describePlan(plan).join('\n')).toContain('1 attachment');

    const history = itemsOf(compareInstall({ contents: archive, here: EMPTY_INSTALL, signIns: [], historyHere: null })).find(
      (item) => item.key === 'history',
    );
    expect(history?.label).toContain('files');
    expect(history?.differences.join(' ')).toContain('1 file');
  });

  it('are said to be there already when the install has them', () => {
    const history = itemsOf(
      compareInstall({
        contents: contents(true),
        here: EMPTY_INSTALL,
        signIns: [],
        historyHere: { threads: 0, messages: 0, audit: 0, ledger: 0, requests: 0, attachments: 1 },
      }),
    ).find((item) => item.key === 'history');
    expect(history?.state).toBe('same');
  });
});
