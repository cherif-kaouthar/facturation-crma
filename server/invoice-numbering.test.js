import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

// The db module opens/migrates its sqlite file as a side effect of being
// imported, from LFB_DATA_DIR/LFB_DB_FILE. Point those at a throwaway
// directory before importing anything that touches it, so this test never
// runs against a developer's real data/lfb.db.
const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'facturation-test-'));
process.env.LFB_DATA_DIR = tmpDir;
process.env.LFB_DB_FILE = path.join(tmpDir, 'test.db');

const { createUnit, createInvoice, peekNextNumber, setNextSeq, formatNumber } = await import('./repo.js');

let unitId;

beforeAll(() => {
  unitId = createUnit({ name: 'Unite Test', address: '' }).id;
});

afterAll(() => {
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

function makeInvoice(overrides = {}) {
  return createInvoice({
    unitId,
    clientName: 'Client Test',
    date: overrides.date ?? '2026-01-15',
    lines: [{ nette: 1000, fga: 0, timbre: 40 }],
    ...overrides,
  });
}

describe('invoice numbering', () => {
  it('starts at 0001 for a fresh year', () => {
    expect(peekNextNumber(2026).number).toBe('0001');
  });

  it('allocates sequential numbers within a year', () => {
    const first = makeInvoice();
    const second = makeInvoice();
    expect(first.number).toBe('0001');
    expect(second.number).toBe('0002');
    expect(peekNextNumber(2026).number).toBe('0003');
  });

  it('keeps separate counters per year', () => {
    makeInvoice({ date: '2027-03-01', year: 2027 });
    expect(peekNextNumber(2027).number).toBe('0002');
    expect(peekNextNumber(2026).number).toBe('0003');
  });

  it('setNextSeq refuses to rewind onto an already-issued number', () => {
    expect(() => setNextSeq(2026, 1)).toThrow(/déjà utilisé/);
  });

  it('setNextSeq can move the counter forward', () => {
    const moved = setNextSeq(2026, 100);
    expect(moved.number).toBe(formatNumber(100));
    const third = makeInvoice();
    expect(third.number).toBe('0100');
  });
});
