import { describe, expect, it } from 'vitest';
import { parseCsvLine, parseUnitsCsv } from './org.js';

describe('CSV parsing', () => {
  it('keeps commas and doubled quotes inside quoted fields', () => {
    expect(parseCsvLine('A,"Ward, East","New ""east"" ward", 5 ')).toEqual(['A', 'Ward, East', 'New "east" ward', '5']);
  });

  it('rejects an unclosed quote', () => {
    expect(() => parseCsvLine('A,"open')).toThrow('Unclosed quote');
  });

  it('ignores a byte-order mark, blank lines and header case; beds must be whole numbers', () => {
    const rows = parseUnitsCsv(`${String.fromCharCode(0xfeff)}UNIT_CODE,Name,Department_Code,Beds\r\n\r\nicu1,ICU,crit,12\nx,X,crit,1.5\n`);
    expect(rows).toEqual([
      { line: 3, unitCode: 'ICU1', name: 'ICU', departmentCode: 'CRIT', beds: 12, description: undefined },
      { line: 4, unitCode: 'X', name: 'X', departmentCode: 'CRIT', beds: Number.NaN, description: undefined },
    ]);
  });

  it('names the missing header columns', () => {
    expect(() => parseUnitsCsv('unit_code,name\nA,B')).toThrow('department_code, beds');
  });
});
