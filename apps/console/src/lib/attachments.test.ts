import { describe, expect, it } from 'vitest';
import { ATTACHMENT_LIMITS, ATTACHMENT_TYPES } from '../../../../packages/shared/src/attachments';
import { ACCEPT, FILE_LIMIT_BYTES, ITEM_BYTES, ITEM_FILES, refusalFor } from './attachments';

describe('the console’s copy of what may be attached', () => {
  it('holds files to the bridge’s limits', () => {
    expect(FILE_LIMIT_BYTES).toBe(ATTACHMENT_LIMITS.fileBytes);
    expect(ITEM_FILES).toBe(ATTACHMENT_LIMITS.itemFiles);
    expect(ITEM_BYTES).toBe(ATTACHMENT_LIMITS.itemBytes);
  });

  it('offers every type the bridge takes, and no other', () => {
    const offered = ACCEPT.split(',').filter((one) => one.includes('/'));
    expect(offered.sort()).toEqual(Object.keys(ATTACHMENT_TYPES).sort());
  });

  it('names the file in what it says is wrong, before anything is uploaded', () => {
    const none = { count: 0, bytes: 0 };
    expect(refusalFor({ name: 'demo.mov', size: 10 }, none)).toMatch(/^demo\.mov is not a type/);
    expect(refusalFor({ name: 'logo.svg', size: 10 }, none)).toMatch(/^logo\.svg can carry script/);
    expect(refusalFor({ name: 'big.png', size: FILE_LIMIT_BYTES + 1 }, none)).toMatch(/^big\.png is 10\.1 MB; a file can be 10 MB at most/);
    expect(refusalFor({ name: 'big.png', size: FILE_LIMIT_BYTES + 300 * 1024 }, none)).toMatch(/^big\.png is 10\.3 MB;/);
    expect(refusalFor({ name: 'one.png', size: 10 }, { count: 20, bytes: 0 })).toMatch(/more than 20 files/);
    expect(refusalFor({ name: 'mockup.png', size: 10 }, none)).toBeNull();
  });
});
