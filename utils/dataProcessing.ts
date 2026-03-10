import Papa from 'papaparse';
import { CohortFilter } from '../types';

export type CsvRow = Record<string, string>;

export interface ParsedCsv {
  headers: string[];
  rows: CsvRow[];
}

export const parseCsv = (content?: string): ParsedCsv => {
  if (!content || !content.trim()) {
    return { headers: [], rows: [] };
  }

  const parsed = Papa.parse<Record<string, unknown>>(content, {
    header: true,
    skipEmptyLines: 'greedy',
    transformHeader: (header) => header.trim(),
  });

  if (parsed.errors.length > 0) {
    throw new Error(`CSV parse failed: ${parsed.errors[0].message}`);
  }

  const headers = (parsed.meta.fields || []).map((h) => h.trim()).filter(Boolean);
  const rows: CsvRow[] = parsed.data.map((row) => {
    const normalized: CsvRow = {};
    headers.forEach((header) => {
      const value = row[header];
      normalized[header] = value == null ? '' : String(value).trim();
    });
    return normalized;
  });

  return { headers, rows };
};

export const stringifyCsv = (headers: string[], rows: CsvRow[]): string => {
  const data = rows.map((row) => {
    const ordered: CsvRow = {};
    headers.forEach((header) => {
      ordered[header] = row[header] ?? '';
    });
    return ordered;
  });

  return Papa.unparse(data, { columns: headers });
};

export const toNumber = (value: string | undefined | null): number | null => {
  if (value == null) return null;
  const trimmed = value.trim();
  if (!trimmed) return null;
  const parsed = Number(trimmed);
  return Number.isFinite(parsed) ? parsed : null;
};

export const normalizeSex = (value: string): string => {
  const v = value.trim().toLowerCase();
  if (!v) return '';
  if (['m', 'male'].includes(v)) return 'M';
  if (['f', 'female'].includes(v)) return 'F';
  return value.trim();
};

export const isIsoDate = (value: string): boolean => {
  if (!value) return false;
  return /^\d{4}-\d{2}-\d{2}$/.test(value);
};

const compareString = (left: string, right: string): number => {
  return left.localeCompare(right, undefined, { sensitivity: 'accent' });
};

export const matchesFilter = (row: CsvRow, filter: CohortFilter): boolean => {
  const fieldValue = (row[filter.field] ?? '').trim();
  const targetValue = filter.value.trim();

  const leftNum = toNumber(fieldValue);
  const rightNum = toNumber(targetValue);
  const bothNumeric = leftNum != null && rightNum != null;

  switch (filter.operator) {
    case 'EQUALS':
      return bothNumeric ? leftNum === rightNum : compareString(fieldValue, targetValue) === 0;
    case 'NOT_EQUALS':
      return bothNumeric ? leftNum !== rightNum : compareString(fieldValue, targetValue) !== 0;
    case 'GREATER_THAN':
      if (bothNumeric) return leftNum > rightNum;
      return compareString(fieldValue, targetValue) > 0;
    case 'LESS_THAN':
      if (bothNumeric) return leftNum < rightNum;
      return compareString(fieldValue, targetValue) < 0;
    case 'GREATER_OR_EQUAL':
      if (bothNumeric) return leftNum >= rightNum;
      return compareString(fieldValue, targetValue) >= 0;
    case 'LESS_OR_EQUAL':
      if (bothNumeric) return leftNum <= rightNum;
      return compareString(fieldValue, targetValue) <= 0;
    case 'CONTAINS':
      return fieldValue.toLowerCase().includes(targetValue.toLowerCase());
    default:
      return false;
  }
};

export const applyFilters = (rows: CsvRow[], filters: CohortFilter[]): CsvRow[] => {
  if (filters.length === 0) return rows;
  return rows.filter((row) => filters.every((filter) => matchesFilter(row, filter)));
};

export const getNumericPairs = (rows: CsvRow[], xCol: string, yCol: string): Array<{ x: number; y: number }> => {
  return rows
    .map((row) => ({ x: toNumber(row[xCol]), y: toNumber(row[yCol]) }))
    .filter((p): p is { x: number; y: number } => p.x != null && p.y != null);
};
