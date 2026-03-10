import { describe, expect, it } from 'vitest';
import { applyFilters, matchesFilter, parseCsv, stringifyCsv } from './dataProcessing';
import { CohortFilter } from '../types';

describe('dataProcessing utilities', () => {
  const csv = [
    'SUBJID,AGE,SEX,ARM',
    '001,45,M,Placebo',
    '002,52,F,Active',
    '003,38,F,Active',
  ].join('\n');

  it('parses CSV and preserves headers', () => {
    const parsed = parseCsv(csv);
    expect(parsed.headers).toEqual(['SUBJID', 'AGE', 'SEX', 'ARM']);
    expect(parsed.rows).toHaveLength(3);
    expect(parsed.rows[1].SUBJID).toBe('002');
  });

  it('applies deterministic cohort filters', () => {
    const parsed = parseCsv(csv);
    const filters: CohortFilter[] = [
      { id: '1', field: 'AGE', operator: 'GREATER_THAN', value: '40', description: '' },
      { id: '2', field: 'ARM', operator: 'EQUALS', value: 'Active', description: '' },
    ];
    const out = applyFilters(parsed.rows, filters);
    expect(out).toHaveLength(1);
    expect(out[0].SUBJID).toBe('002');
  });

  it('supports contains operator in case-insensitive mode', () => {
    const row = { SUBJID: '001', ARM: 'Active 10mg' };
    const filter: CohortFilter = {
      id: 'x',
      field: 'ARM',
      operator: 'CONTAINS',
      value: 'active',
      description: '',
    };
    expect(matchesFilter(row, filter)).toBe(true);
  });

  it('supports >= and <= operators', () => {
    const row = { AGE: '18' };
    expect(
      matchesFilter(row, {
        id: 'g1',
        field: 'AGE',
        operator: 'GREATER_OR_EQUAL',
        value: '18',
        description: '',
      })
    ).toBe(true);
    expect(
      matchesFilter(row, {
        id: 'l1',
        field: 'AGE',
        operator: 'LESS_OR_EQUAL',
        value: '18',
        description: '',
      })
    ).toBe(true);
  });

  it('round-trips rows via stringify', () => {
    const parsed = parseCsv(csv);
    const encoded = stringifyCsv(parsed.headers, parsed.rows);
    const reparsed = parseCsv(encoded);
    expect(reparsed.rows).toEqual(parsed.rows);
  });
});
