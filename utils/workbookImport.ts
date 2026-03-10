import { DataType } from '../types';
import { parseCsv, stringifyCsv, type CsvRow } from './dataProcessing';

export type WorkbookImportMode = 'SEPARATE' | 'MERGE_SIMILAR';

export interface WorkbookSheetCandidate {
  sheetName: string;
  csvContent: string;
}

export interface WorkbookSheetPreview {
  id: string;
  sheetName: string;
  csvContent: string;
  headers: string[];
  rowCount: number;
  columnCount: number;
  domainHint: string;
  keyColumns: string[];
  lineOfTherapy: string | null;
  sampleHeaders: string[];
}

export interface WorkbookImportFilePlan {
  name: string;
  content: string;
  rowCount: number;
  columnCount: number;
  sourceSheetNames: string[];
  metadata: Record<string, unknown>;
}

export interface WorkbookImportPlan {
  mode: WorkbookImportMode;
  selectedSheetCount: number;
  outputCount: number;
  outputs: WorkbookImportFilePlan[];
}

const SUBJECT_KEY_ALIASES = ['USUBJID', 'SUBJID', 'SUBJECT_ID', 'PATIENT_ID', 'PATIENTID'];
const VISIT_KEY_ALIASES = ['VISIT', 'VISITNUM', 'VISITDT', 'VISIT_DATE'];
const DATE_KEY_HINTS = ['DATE', 'DTC', 'DT', 'START', 'END'];

const normalize = (value: string) => value.trim().toLowerCase();
const slugify = (value: string) =>
  value
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '_')
    .replace(/^_+|_+$/g, '') || 'sheet';
const baseName = (name: string) => name.replace(/\.[^/.]+$/, '');
const unique = <T,>(items: T[]) => Array.from(new Set(items));

const headerSimilarity = (left: string[], right: string[]) => {
  const leftSet = new Set(left.map(normalize));
  const rightSet = new Set(right.map(normalize));
  const intersection = Array.from(leftSet).filter((item) => rightSet.has(item)).length;
  const union = new Set([...leftSet, ...rightSet]).size;
  return union === 0 ? 0 : intersection / union;
};

const inferDomainHint = (sheetName: string, headers: string[]) => {
  const haystack = `${sheetName} ${headers.join(' ')}`.toLowerCase();
  if (/(demog|subject|baseline|patient demographics|age|sex|race|ethnic)/.test(haystack)) return 'Demographics';
  if (/(adverse|ae\b|serious|relatedness|toxicity|grade|outcome|pt\b|soc\b)/.test(haystack)) return 'Adverse Events';
  if (/(lab|hematology|chemistry|testcd|lbtest|result|unit)/.test(haystack)) return 'Labs';
  if (/(exposure|therapy|treatment|drug|dose|cycle|line of therapy|1l\b|2l\b|3l\b)/.test(haystack)) return 'Treatment History';
  if (/(tumor|recist|response|lesion|assessment|best response)/.test(haystack)) return 'Tumor Assessments';
  if (/(molecular|gene|mutation|variant|ngs|pd-l1|pdl1|biomarker)/.test(haystack)) return 'Molecular Profile';
  if (/(conmed|medication|concomitant|cmtrt)/.test(haystack)) return 'Concomitant Medications';
  return 'Unclassified';
};

const inferKeyColumns = (headers: string[]) => {
  const normalizedHeaders = headers.map((header) => ({ raw: header, normalized: header.replace(/[^a-z0-9]/gi, '').toUpperCase() }));
  const matches: string[] = [];

  SUBJECT_KEY_ALIASES.forEach((alias) => {
    const normalizedAlias = alias.replace(/[^a-z0-9]/gi, '').toUpperCase();
    const found = normalizedHeaders.find(
      (header) => header.normalized === normalizedAlias || header.normalized.includes(normalizedAlias)
    );
    if (found) matches.push(found.raw);
  });

  VISIT_KEY_ALIASES.forEach((alias) => {
    const normalizedAlias = alias.replace(/[^a-z0-9]/gi, '').toUpperCase();
    const found = normalizedHeaders.find((header) => header.normalized === normalizedAlias);
    if (found) matches.push(found.raw);
  });

  headers.forEach((header) => {
    const upper = header.toUpperCase();
    if (DATE_KEY_HINTS.some((hint) => upper.includes(hint))) {
      matches.push(header);
    }
  });

  return unique(matches);
};

const inferLineOfTherapy = (sheetName: string): string | null => {
  const name = sheetName.toLowerCase();
  const patterns: Array<{ regex: RegExp; label: string }> = [
    { regex: /(^|\b)(1l|1st\s*line|first\s*line)(\b|$)/, label: '1L' },
    { regex: /(^|\b)(2l|2nd\s*line|second\s*line)(\b|$)/, label: '2L' },
    { regex: /(^|\b)(3l|3rd\s*line|third\s*line)(\b|$)/, label: '3L' },
    { regex: /(^|\b)(4l|4th\s*line|fourth\s*line)(\b|$)/, label: '4L' },
  ];
  return patterns.find((entry) => entry.regex.test(name))?.label || null;
};

export const buildWorkbookSheetPreviews = (sheets: WorkbookSheetCandidate[]): WorkbookSheetPreview[] =>
  sheets
    .map((sheet, index) => {
      const parsed = parseCsv(sheet.csvContent);
      return {
        id: `sheet-${index}-${slugify(sheet.sheetName)}`,
        sheetName: sheet.sheetName,
        csvContent: sheet.csvContent,
        headers: parsed.headers,
        rowCount: parsed.rows.length,
        columnCount: parsed.headers.length,
        domainHint: inferDomainHint(sheet.sheetName, parsed.headers),
        keyColumns: inferKeyColumns(parsed.headers),
        lineOfTherapy: inferLineOfTherapy(sheet.sheetName),
        sampleHeaders: parsed.headers.slice(0, 5),
      };
    })
    .filter((sheet) => sheet.columnCount > 0 && sheet.rowCount > 0);

const groupSheetsForMerge = (sheets: WorkbookSheetPreview[]): WorkbookSheetPreview[][] => {
  const groups: WorkbookSheetPreview[][] = [];
  const visited = new Set<string>();

  sheets.forEach((sheet) => {
    if (visited.has(sheet.id)) return;
    const group = [sheet];
    visited.add(sheet.id);

    sheets.forEach((candidate) => {
      if (visited.has(candidate.id)) return;
      const sameDomain = candidate.domainHint === sheet.domainHint && candidate.domainHint !== 'Unclassified';
      const similarity = headerSimilarity(sheet.headers, candidate.headers);
      const lineAwareTreatmentMerge =
        sheet.domainHint === 'Treatment History' &&
        candidate.domainHint === 'Treatment History' &&
        Boolean(sheet.lineOfTherapy || candidate.lineOfTherapy);

      if ((sameDomain && similarity >= 0.55) || similarity >= 0.8 || lineAwareTreatmentMerge) {
        group.push(candidate);
        visited.add(candidate.id);
      }
    });

    groups.push(group);
  });

  return groups;
};

const mergeWorkbookSheets = (workbookName: string, sheets: WorkbookSheetPreview[]): WorkbookImportFilePlan => {
  const parsedSheets = sheets.map((sheet) => ({ sheet, parsed: parseCsv(sheet.csvContent) }));
  const headerOrder: string[] = [];
  const headerSeen = new Set<string>();

  parsedSheets.forEach(({ parsed }) => {
    parsed.headers.forEach((header) => {
      if (!headerSeen.has(header)) {
        headerSeen.add(header);
        headerOrder.push(header);
      }
    });
  });

  if (!headerSeen.has('SOURCE_SHEET')) headerOrder.push('SOURCE_SHEET');
  const shouldAddLineColumn = sheets.some((sheet) => sheet.lineOfTherapy) && !headerSeen.has('LINE_OF_THERAPY');
  if (shouldAddLineColumn) headerOrder.push('LINE_OF_THERAPY');

  const mergedRows: CsvRow[] = [];
  parsedSheets.forEach(({ sheet, parsed }) => {
    parsed.rows.forEach((row) => {
      const nextRow: CsvRow = {};
      headerOrder.forEach((header) => {
        if (header === 'SOURCE_SHEET') {
          nextRow[header] = sheet.sheetName;
        } else if (header === 'LINE_OF_THERAPY') {
          nextRow[header] = sheet.lineOfTherapy || '';
        } else {
          nextRow[header] = row[header] ?? '';
        }
      });
      mergedRows.push(nextRow);
    });
  });

  const groupLabel =
    sheets.length === 1
      ? slugify(sheets[0].sheetName)
      : slugify(
          sheets.every((sheet) => sheet.domainHint === sheets[0].domainHint)
            ? sheets[0].domainHint
            : sheets.map((sheet) => sheet.sheetName).join('_')
        );
  const fileName = `${baseName(workbookName)}__${groupLabel}.csv`;

  return {
    name: fileName,
    content: stringifyCsv(headerOrder, mergedRows),
    rowCount: mergedRows.length,
    columnCount: headerOrder.length,
    sourceSheetNames: sheets.map((sheet) => sheet.sheetName),
    metadata: {
      workbookName,
      sheetNames: sheets.map((sheet) => sheet.sheetName),
      workbookImportMode: sheets.length > 1 ? 'MERGED_GROUP' : 'SINGLE_SHEET',
      inferredDomain: unique(sheets.map((sheet) => sheet.domainHint)).join(', '),
      keyColumns: unique(sheets.flatMap((sheet) => sheet.keyColumns)),
      lineOfTherapyValues: unique(sheets.map((sheet) => sheet.lineOfTherapy).filter(Boolean)),
    },
  };
};

const separateWorkbookSheet = (workbookName: string, sheet: WorkbookSheetPreview): WorkbookImportFilePlan => ({
  name: `${baseName(workbookName)}__${slugify(sheet.sheetName)}.csv`,
  content: sheet.csvContent,
  rowCount: sheet.rowCount,
  columnCount: sheet.columnCount,
  sourceSheetNames: [sheet.sheetName],
  metadata: {
    workbookName,
    sheetNames: [sheet.sheetName],
    workbookImportMode: 'SEPARATE',
    inferredDomain: sheet.domainHint,
    keyColumns: sheet.keyColumns,
    lineOfTherapyValues: sheet.lineOfTherapy ? [sheet.lineOfTherapy] : [],
  },
});

export const planWorkbookImport = (
  workbookName: string,
  previews: WorkbookSheetPreview[],
  selectedSheetIds: string[],
  mode: WorkbookImportMode,
  targetType: DataType
): WorkbookImportPlan => {
  const selected = previews.filter((sheet) => selectedSheetIds.includes(sheet.id));
  if (selected.length === 0) {
    return { mode, selectedSheetCount: 0, outputCount: 0, outputs: [] };
  }

  const mergeAllowed = mode === 'MERGE_SIMILAR' && (targetType === DataType.RAW || targetType === DataType.STANDARDIZED || targetType === DataType.COHORT_DEF);
  const outputs = mergeAllowed
    ? groupSheetsForMerge(selected).map((group) => mergeWorkbookSheets(workbookName, group))
    : selected.map((sheet) => separateWorkbookSheet(workbookName, sheet));

  return {
    mode,
    selectedSheetCount: selected.length,
    outputCount: outputs.length,
    outputs,
  };
};
