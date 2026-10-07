import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * A file given to the crew, over HTTP: uploaded as its raw bytes, refused
 * with the reason when it may not be kept, served back so a browser cannot
 * run it, and removed only by an admin, with an audit line.
 */

const store = vi.hoisted(() => ({
  rows: [] as { id: string; name: string; mediaType: string; sizeBytes: number; sha256: string; uploadedBy: string; subjectRef: string | null; content: Buffer }[],
  audit: [] as Record<string, unknown>[],
}));

vi.mock('@fleetadlc/db', () => ({
  audit: vi.fn(async (entry: Record<string, unknown>) => void store.audit.push(entry)),
  attachments: {
    createUnclaimed: vi.fn(async (input: { name: string; mediaType: string; sha256: string; content: Buffer; uploadedBy: string }) => {
      const row = { id: `a-${store.rows.length + 1}`, subjectRef: null, sizeBytes: input.content.length, ...input };
      store.rows.push(row);
      const { content: _bytes, ...meta } = row;
      return meta;
    }),
    readAttachment: vi.fn(async (id: string) => {
      const row = store.rows.find((one) => one.id === id);
      if (!row) return null;
      const { content, ...meta } = row;
      return { meta, content };
    }),
    deleteAttachment: vi.fn(async (id: string) => {
      const at = store.rows.findIndex((one) => one.id === id);
      return at === -1 ? null : store.rows.splice(at, 1)[0]!;
    }),
    listForSubjects: vi.fn(async (refs: readonly string[]) =>
      store.rows.filter((one) => one.subjectRef && refs.includes(one.subjectRef)).map(({ content: _bytes, ...meta }) => ({ ...meta, source: 'console' })),
    ),
  },
}));

// The item a task's subject belongs to: its pull request is part of the issue's.
vi.mock('./items.js', () => ({
  resolveItem: vi.fn(async (subject: string) => (subject === 'api#31' ? { item: { subjects: ['request:a4b02784', 'api#12', 'api#31'] }, repo: null } : null)),
}));

const PNG = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 13, 1, 2, 3]);

let server: Server;
let url: string;

beforeEach(async () => {
  store.rows = [];
  store.audit = [];
  const { registerAttachmentRoutes, registerInternalAttachmentRoutes } = await import('./attachment-routes.js');
  const { HttpFailure, Router } = await import('./router.js');
  const router = new Router();
  registerAttachmentRoutes(router);
  registerInternalAttachmentRoutes(router, (raw) => {
    if (raw.headers['x-fleetadlc-internal-secret'] !== 'sekrit') throw new HttpFailure(401, "this route needs the install's internal secret");
  });
  server = createServer((request, response) => void router.handle(request, response));
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  url = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});

afterEach(async () => {
  await new Promise<void>((resolve) => server.close(() => resolve()));
});

function upload(name: string, body: Buffer | string, type = 'application/octet-stream') {
  return fetch(`${url}/v1/attachments`, {
    method: 'POST',
    headers: { 'content-type': type, 'x-file-name': encodeURIComponent(name), 'x-fleetadlc-identity': 'jane@acme.test' },
    body,
  });
}

describe('uploading a file', () => {
  it('keeps it unclaimed, as the type its bytes are, whatever the header said', async () => {
    const response = await upload('Screen Shot 1.png', PNG, 'text/plain');
    expect(response.status).toBe(200);
    const { attachment } = (await response.json()) as { attachment: Record<string, unknown> };
    expect(attachment).toMatchObject({ name: 'Screen Shot 1.png', mediaType: 'image/png', sizeBytes: PNG.length, uploadedBy: 'jane@acme.test' });
    expect(attachment.sha256).toMatch(/^[0-9a-f]{64}$/);
    expect(attachment).not.toHaveProperty('content');
  });

  it('refuses a file with a credential in it, an HTML page, and one too large, saying why', async () => {
    const secret = await upload('notes.txt', `token ghp_${'a'.repeat(36)}`);
    expect(secret.status).toBe(415);
    expect(((await secret.json()) as { error: string }).error).toMatch(/notes\.txt contains what looks like a credential/);

    const page = await upload('page.html', '<html><body>hi</body></html>');
    expect(page.status).toBe(415);

    const big = await upload('huge.png', Buffer.concat([PNG, Buffer.alloc(10 * 1024 * 1024)]));
    expect(big.status).toBe(413);
    expect(store.rows).toHaveLength(0);
  });
});

describe('looking at a file', () => {
  it('is served so a browser shows an image and runs nothing', async () => {
    await upload('mockup.png', PNG);
    const response = await fetch(`${url}/v1/attachments/a-1`);
    expect(response.status).toBe(200);
    expect(response.headers.get('content-type')).toBe('image/png');
    expect(response.headers.get('x-content-type-options')).toBe('nosniff');
    expect(response.headers.get('content-security-policy')).toMatch(/^sandbox/);
    expect(response.headers.get('content-disposition')).toMatch(/^inline; filename="mockup.png"/);
    expect(Buffer.from(await response.arrayBuffer()).equals(PNG)).toBe(true);
  });

  it('downloads text rather than showing it in place', async () => {
    await upload('notes.md', '# Notes');
    expect((await fetch(`${url}/v1/attachments/a-1`)).headers.get('content-disposition')).toMatch(/^attachment;/);
  });
});

describe('removing a file', () => {
  it('is audited with what it was', async () => {
    await upload('mockup.png', PNG);
    const response = await fetch(`${url}/v1/attachments/a-1`, { method: 'DELETE', headers: { 'x-fleetadlc-identity': 'admin@acme.test' } });
    expect(response.status).toBe(200);
    expect(store.audit).toEqual([expect.objectContaining({ actor: 'admin@acme.test', action: 'attachment.deleted', payload: expect.objectContaining({ name: 'mockup.png' }) })]);
  });
});

describe('the files a task is given', () => {
  it('are every file on its work item, so a review of the pull request sees the request’s screenshot', async () => {
    store.rows = [{ id: 'a-9', name: 'mockup.png', mediaType: 'image/png', sizeBytes: PNG.length, sha256: 'f'.repeat(64), uploadedBy: 'jane@acme.test', subjectRef: 'request:a4b02784', content: PNG }];
    const { attachmentsForTask } = await import('./attachment-routes.js');
    expect(await attachmentsForTask('api#31')).toEqual([
      { id: 'a-9', name: 'mockup.png', mediaType: 'image/png', size: PNG.length, sha256: 'f'.repeat(64), from: 'jane@acme.test', source: 'console' },
    ]);
  });

  it('are fetched by hostd with the install secret and the hash beside the bytes, and by nobody else', async () => {
    await upload('mockup.png', PNG);
    expect((await fetch(`${url}/internal/attachments/a-1`)).status).toBe(401);
    const response = await fetch(`${url}/internal/attachments/a-1`, { headers: { 'x-fleetadlc-internal-secret': 'sekrit' } });
    expect(response.status).toBe(200);
    expect(response.headers.get('x-fleetadlc-sha256')).toMatch(/^[0-9a-f]{64}$/);
    expect(Buffer.from(await response.arrayBuffer()).equals(PNG)).toBe(true);
  });
});
