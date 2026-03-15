import { ClinicalFile, DataType } from '../types';
import { parseCsv } from './dataProcessing';

export type DatasetProfileKind =
  | 'DOCUMENT'
  | 'DEMOGRAPHICS'
  | 'ADVERSE_EVENTS'
  | 'LABS'
  | 'EXPOSURE'
  | 'VISITS'
  | 'CONMEDS'
  | 'TUMOR'
  | 'MOLECULAR'
  | 'ADSL'
  | 'ADAE'
  | 'ADLB'
  | 'ADTTE'
  | 'BDS'
  | 'GENERIC';

export type DatasetModel = 'DOCUMENT' | 'RAW_CLINICAL' | 'STANDARDIZED' | 'ADAM';

export interface DatasetProfile {
  kind: DatasetProfileKind;
  model: DatasetModel;
  label: string;
  shortLabel: string;
  guidance?: string;
}

const normalize = (value: string) => value.trim().toLowerCase();

const normalizeToken = (value: string) => normalize(value).replace(/[^a-z0-9]/g, '');

export const findHeaderByAlias = (headers: string[], aliases: string[]): string | null => {
  const normalizedHeaders = headers.map((header) => ({
    raw: header,
    lower: normalizeToken(header),
  }));

  for (const alias of aliases) {
    const normalizedAlias = normalizeToken(alias);
    const exact = normalizedHeaders.find((header) => header.lower === normalizedAlias);
    if (exact) return exact.raw;
    const partial = normalizedHeaders.find((header) => header.lower.includes(normalizedAlias));
    if (partial) return partial.raw;
  }

  return null;
};

const hasAnyHeader = (headers: string[], aliases: string[]) => Boolean(findHeaderByAlias(headers, aliases));

const parseHeadersSafely = (file: ClinicalFile): string[] => {
  if (!file.content) return [];
  try {
    return parseCsv(file.content).headers;
  } catch {
    return [];
  }
};

const isAdaMAdsl = (name: string, headers: string[]) =>
  /\badsl\b/.test(name) ||
  (hasAnyHeader(headers, ['USUBJID']) &&
    hasAnyHeader(headers, ['TRT01A', 'TRTA', 'TRT01P', 'ARM', 'ACTARM']) &&
    hasAnyHeader(headers, ['AGE', 'SEX']));

const isAdaMAdae = (name: string, headers: string[]) =>
  /\badae\b/.test(name) ||
  (hasAnyHeader(headers, ['USUBJID']) &&
    hasAnyHeader(headers, ['AETERM', 'AEDECOD', 'PT']) &&
    hasAnyHeader(headers, ['TRTEMFL', 'SAFFL', 'TRTA', 'TRT01A', 'AESER']));

const isAdaMAdlb = (name: string, headers: string[]) =>
  /\badlb\b/.test(name) ||
  (hasAnyHeader(headers, ['USUBJID']) &&
    hasAnyHeader(headers, ['PARAMCD', 'PARAM']) &&
    hasAnyHeader(headers, ['AVAL', 'CHG', 'BASE']) &&
    hasAnyHeader(headers, ['AVISIT', 'AVISITN', 'ADT', 'ADY']));

const isAdaMAdtte = (name: string, headers: string[]) =>
  /\badtte\b/.test(name) ||
  (hasAnyHeader(headers, ['USUBJID']) &&
    hasAnyHeader(headers, ['PARAMCD', 'PARAM']) &&
    hasAnyHeader(headers, ['AVAL']) &&
    hasAnyHeader(headers, ['CNSR']));

const isAdaMBds = (headers: string[]) =>
  hasAnyHeader(headers, ['USUBJID']) &&
  hasAnyHeader(headers, ['PARAMCD', 'PARAM']) &&
  hasAnyHeader(headers, ['AVAL']);

export const inferDatasetProfileFromHeaders = (
  fileName: string,
  type: DataType,
  headers: string[] = []
): DatasetProfile => {
  const name = normalize(fileName);
  const lowerHeaders = headers.map(normalize);
  const headerText = lowerHeaders.join(' ');

  if (type === DataType.DOCUMENT) {
    return {
      kind: 'DOCUMENT',
      model: 'DOCUMENT',
      label: 'Study document',
      shortLabel: 'Document',
    };
  }

  if (isAdaMAdsl(name, headers)) {
    return {
      kind: 'ADSL',
      model: 'ADAM',
      label: 'ADSL subject-level analysis dataset',
      shortLabel: 'ADaM • ADSL',
      guidance: 'Subject-level analysis-ready dataset. Respect analysis population and treatment variables.',
    };
  }

  if (isAdaMAdae(name, headers)) {
    return {
      kind: 'ADAE',
      model: 'ADAM',
      label: 'ADAE adverse event analysis dataset',
      shortLabel: 'ADaM • ADAE',
      guidance: 'Event-level analysis-ready dataset. Confirm treatment-emergent and safety population flags before interpretation.',
    };
  }

  if (isAdaMAdlb(name, headers)) {
    return {
      kind: 'ADLB',
      model: 'ADAM',
      label: 'ADLB lab analysis dataset',
      shortLabel: 'ADaM • ADLB',
      guidance: 'Parameterised analysis dataset. Filter by parameter, visit, and analysis flag before inferential use.',
    };
  }

  if (isAdaMAdtte(name, headers)) {
    return {
      kind: 'ADTTE',
      model: 'ADAM',
      label: 'ADTTE time-to-event analysis dataset',
      shortLabel: 'ADaM • ADTTE',
      guidance: 'Time-to-event dataset. Kaplan-Meier/log-rank and simple single-covariate Cox workflows are supported, but endpoint filtering and censoring assumptions still require review.',
    };
  }

  if ((type === DataType.STANDARDIZED || /\bad/.test(name)) && isAdaMBds(headers)) {
    return {
      kind: 'BDS',
      model: 'ADAM',
      label: 'ADaM BDS-style analysis dataset',
      shortLabel: 'ADaM • BDS',
      guidance: 'Analysis-ready BDS dataset. Use PARAM/PARAMCD and analysis flags to avoid mixing endpoints.',
    };
  }

  if (/demo|demograph|\bdm\b/.test(name) || / age | sex | race /.test(` ${headerText} `)) {
    return {
      kind: 'DEMOGRAPHICS',
      model: type === DataType.STANDARDIZED ? 'STANDARDIZED' : 'RAW_CLINICAL',
      label: 'Demographics dataset',
      shortLabel: 'Demographics',
    };
  }

  if (/adverse|\bae\b/.test(name) || headerText.includes('aeterm') || headerText.includes(' pt ')) {
    return {
      kind: 'ADVERSE_EVENTS',
      model: type === DataType.STANDARDIZED ? 'STANDARDIZED' : 'RAW_CLINICAL',
      label: 'Adverse events dataset',
      shortLabel: 'Adverse events',
    };
  }

  if (/lab|\blb\b/.test(name) || headerText.includes('lbstres') || headerText.includes('lborres')) {
    return {
      kind: 'LABS',
      model: type === DataType.STANDARDIZED ? 'STANDARDIZED' : 'RAW_CLINICAL',
      label: 'Labs dataset',
      shortLabel: 'Labs',
    };
  }

  if (/exposure|dose|therapy/.test(name) || headerText.includes('exstdtc') || headerText.includes('extrt')) {
    return {
      kind: 'EXPOSURE',
      model: type === DataType.STANDARDIZED ? 'STANDARDIZED' : 'RAW_CLINICAL',
      label: 'Exposure dataset',
      shortLabel: 'Exposure',
    };
  }

  if (/visit/.test(name) || headerText.includes('visitnum') || headerText.includes('visit')) {
    return {
      kind: 'VISITS',
      model: type === DataType.STANDARDIZED ? 'STANDARDIZED' : 'RAW_CLINICAL',
      label: 'Visit dataset',
      shortLabel: 'Visits',
    };
  }

  if (/concomitant|cm/.test(name) || headerText.includes('cmstdtc') || headerText.includes('cmtrt')) {
    return {
      kind: 'CONMEDS',
      model: type === DataType.STANDARDIZED ? 'STANDARDIZED' : 'RAW_CLINICAL',
      label: 'Concomitant medication dataset',
      shortLabel: 'Conmeds',
    };
  }

  if (/tumor|recist/.test(name)) {
    return {
      kind: 'TUMOR',
      model: type === DataType.STANDARDIZED ? 'STANDARDIZED' : 'RAW_CLINICAL',
      label: 'Tumor assessment dataset',
      shortLabel: 'Tumor',
    };
  }

  if (/molecular|genom|ngs|biomarker|pdl1|egfr|alk|ros1/.test(name) || headerText.includes('mutation')) {
    return {
      kind: 'MOLECULAR',
      model: type === DataType.STANDARDIZED ? 'STANDARDIZED' : 'RAW_CLINICAL',
      label: 'Molecular profile dataset',
      shortLabel: 'Molecular',
    };
  }

  return {
    kind: 'GENERIC',
    model: type === DataType.STANDARDIZED ? 'STANDARDIZED' : 'RAW_CLINICAL',
    label: type === DataType.STANDARDIZED ? 'Standardized clinical dataset' : 'Generic clinical dataset',
    shortLabel: type === DataType.STANDARDIZED ? 'Standardized' : 'Clinical',
  };
};

export const inferDatasetProfile = (file: ClinicalFile): DatasetProfile =>
  inferDatasetProfileFromHeaders(file.name, file.type, parseHeadersSafely(file));

export const isAdamDatasetProfile = (profile: DatasetProfile): boolean => profile.model === 'ADAM';
