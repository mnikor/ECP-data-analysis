import { AnalysisConcept, ClinicalFile, StatTestType } from '../types';
import { CsvRow, parseCsv, toNumber } from './dataProcessing';
import { inferDatasetProfile } from './datasetProfile';

export interface PlannedAnalysis {
  testType: StatTestType;
  var1: string;
  var2: string;
  explanation: string;
  concept: AnalysisConcept | null;
}

const EVENT_COLUMN_HINTS = ['aeterm', 'adverse', 'event', 'meddra', 'reaction', 'symptom', 'diagnosis'];
const GROUP_COLUMN_HINTS = ['arm', 'treatment', 'trt', 'group', 'cohort', 'sex', 'race', 'site'];
const IDENTIFIER_COLUMN_HINTS = ['id', 'subjid', 'usubjid', 'subject', 'patient', 'record'];
const TIME_TO_EVENT_HINTS = ['aval', 'time', 'month', 'months', 'day', 'days', 'duration', 'tte', 'os', 'pfs'];
const SURVIVAL_QUERY_HINTS = /survival|overall survival|progression[- ]free|pfs|os\b|time[- ]to[- ]event|time to event|kaplan|log[- ]rank|cox|hazard/i;

const CLINICAL_CONCEPTS: Record<string, { triggers: string[]; synonyms: string[] }> = {
  skin_rash: {
    triggers: ['rash', 'skin rash', 'dermatitis', 'erythema', 'exanthema', 'urticaria'],
    synonyms: ['rash', 'skin rash', 'dermatitis', 'erythema', 'exanthema', 'urticaria', 'maculopapular', 'pruritic rash'],
  },
  headache: {
    triggers: ['headache', 'migraine', 'cephalalgia'],
    synonyms: ['headache', 'migraine', 'cephalalgia'],
  },
  nausea: {
    triggers: ['nausea', 'vomit', 'emesis'],
    synonyms: ['nausea', 'vomit', 'emesis'],
  },
};

const tokenize = (text: string): string[] =>
  text
    .toLowerCase()
    .replace(/[^a-z0-9_ ]+/g, ' ')
    .split(/\s+/)
    .filter(Boolean);

const isLikelyNumericColumn = (rows: CsvRow[], col: string): boolean => {
  const sample = rows.slice(0, 300).map((row) => toNumber(row[col])).filter((v) => v != null);
  if (sample.length < 3) return false;
  return sample.length >= Math.max(3, Math.floor(rows.slice(0, 300).length * 0.6));
};

const countDistinct = (rows: CsvRow[], col: string): number => {
  return new Set(rows.map((r) => (r[col] || '').trim()).filter(Boolean)).size;
};

const isLikelyIdentifierColumn = (rows: CsvRow[], col: string): boolean => {
  const lower = col.toLowerCase();
  if (!IDENTIFIER_COLUMN_HINTS.some((hint) => lower.includes(hint))) return false;
  const distinct = countDistinct(rows, col);
  return distinct >= Math.max(10, Math.floor(rows.length * 0.7));
};

const chooseGroupColumn = (headers: string[], rows: CsvRow[]): string | null => {
  const normalized = headers.map((h) => ({ original: h, lower: h.toLowerCase() }));

  for (const hint of GROUP_COLUMN_HINTS) {
    const found = normalized.find((h) => h.lower.includes(hint));
    if (found) return found.original;
  }

  const candidate = headers
    .filter((h) => !isLikelyNumericColumn(rows, h))
    .filter((h) => !isLikelyIdentifierColumn(rows, h))
    .map((h) => ({ h, distinct: countDistinct(rows, h) }))
    .filter((x) => x.distinct >= 2 && x.distinct <= Math.max(20, rows.length * 0.4))
    .sort((a, b) => a.distinct - b.distinct)[0];

  return candidate?.h || null;
};

const chooseNumericOutcomeColumn = (headers: string[], rows: CsvRow[], exclude: string): string | null => {
  const candidates = headers.filter((h) => h !== exclude && !isLikelyIdentifierColumn(rows, h) && isLikelyNumericColumn(rows, h));
  return candidates[0] || null;
};

const chooseCategoricalOutcomeColumn = (headers: string[], rows: CsvRow[], exclude: string): string | null => {
  const candidates = headers
    .filter((h) => h !== exclude)
    .filter((h) => !isLikelyNumericColumn(rows, h))
    .filter((h) => !isLikelyIdentifierColumn(rows, h))
    .map((h) => ({ h, distinct: countDistinct(rows, h) }))
    .filter((x) => x.distinct >= 2 && x.distinct <= 12)
    .sort((a, b) => a.distinct - b.distinct);
  return candidates[0]?.h || null;
};

const isPotentialTimeToEventColumn = (rows: CsvRow[], col: string): boolean => {
  const sample = rows.slice(0, 300);
  const nonEmpty = sample.map((row) => row[col]).filter((value) => value != null && value.trim() !== '');
  if (nonEmpty.length === 0) return false;
  const numericCount = nonEmpty.filter((value) => toNumber(value) != null).length;
  return numericCount >= Math.max(1, Math.floor(nonEmpty.length * 0.75));
};

const chooseTimeToEventColumn = (headers: string[], rows: CsvRow[], exclude: string): string | null => {
  const numericCandidates = headers.filter(
    (h) => h !== exclude && !isLikelyIdentifierColumn(rows, h) && isPotentialTimeToEventColumn(rows, h)
  );

  for (const hint of TIME_TO_EVENT_HINTS) {
    const found = numericCandidates.find((header) => header.toLowerCase().includes(hint));
    if (found) return found;
  }

  return numericCandidates[0] || null;
};

const detectClinicalConcept = (
  query: string,
  headers: string[],
  rows: CsvRow[],
  customSynonyms: string[] = []
): AnalysisConcept | null => {
  const q = query.toLowerCase();
  let bestConcept: { key: string; score: number } | null = null;

  Object.entries(CLINICAL_CONCEPTS).forEach(([key, cfg]) => {
    const score = cfg.triggers.reduce((acc, trigger) => acc + (q.includes(trigger) ? 1 : 0), 0);
    if (score > 0 && (!bestConcept || score > bestConcept.score)) {
      bestConcept = { key, score };
    }
  });

  if (!bestConcept) return null;

  const conceptConfig = CLINICAL_CONCEPTS[bestConcept.key];
  const terms = Array.from(new Set([...conceptConfig.synonyms, ...customSynonyms.map((s) => s.toLowerCase())]));

  const eventColumns = headers.filter((h) => {
    const lower = h.toLowerCase();
    return EVENT_COLUMN_HINTS.some((hint) => lower.includes(hint));
  });

  const textualColumns = headers.filter((h) => !isLikelyNumericColumn(rows, h));
  const candidateColumns = Array.from(new Set([...eventColumns, ...textualColumns]));
  if (candidateColumns.length === 0) return null;

  let bestColumn: string | null = null;
  let bestCount = 0;
  const bestTermCounts: Record<string, number> = {};

  candidateColumns.forEach((col) => {
    const termCounts: Record<string, number> = {};
    let columnMatches = 0;

    terms.forEach((term) => {
      const count = rows.reduce((acc, row) => {
        const value = (row[col] || '').toLowerCase();
        return value.includes(term) ? acc + 1 : acc;
      }, 0);
      if (count > 0) {
        termCounts[term] = count;
        columnMatches += count;
      }
    });

    if (columnMatches > bestCount) {
      bestCount = columnMatches;
      bestColumn = col;
      Object.keys(bestTermCounts).forEach((k) => delete bestTermCounts[k]);
      Object.assign(bestTermCounts, termCounts);
    }
  });

  if (!bestColumn) return null;

  return {
    label: conceptConfig.triggers[0],
    sourceColumn: bestColumn,
    terms,
    matchCounts: bestTermCounts,
  };
};

const inferTestType = (query: string, concept: AnalysisConcept | null, rows: CsvRow[], var1: string): StatTestType => {
  const q = query.toLowerCase();
  if (
    concept ||
    /incidence|rate|risk|proportion|frequency|event|adverse|rash|headache|nausea|safety/.test(q)
  ) {
    return StatTestType.CHI_SQUARE;
  }

  if (/correlat|relationship|association between|linked to/.test(q)) {
    return StatTestType.CORRELATION;
  }

  if (/predict|effect of|impact of|regress/.test(q)) {
    return StatTestType.REGRESSION;
  }

  const distinct = countDistinct(rows, var1);
  if (distinct <= 2) return StatTestType.T_TEST;
  if (distinct > 2 && distinct <= 20) return StatTestType.ANOVA;
  return StatTestType.REGRESSION;
};

export const planAnalysisFromQuestion = (
  file: ClinicalFile,
  query: string,
  customSynonyms: string[] = []
): PlannedAnalysis => {
  const { headers, rows } = parseCsv(file.content);
  if (headers.length === 0 || rows.length === 0) {
    throw new Error('Selected dataset has no parsable rows.');
  }

  const datasetProfile = inferDatasetProfile(file);
  const queryLower = query.toLowerCase();
  const parameterColumn = headers.find((header) => ['param', 'paramcd'].some((hint) => header.toLowerCase().includes(hint))) || null;
  const parameterCount = parameterColumn ? countDistinct(rows, parameterColumn) : 0;

  if ((datasetProfile.kind === 'ADTTE' || SURVIVAL_QUERY_HINTS.test(queryLower)) && parameterColumn && parameterCount > 1) {
    throw new Error(
      'This time-to-event dataset contains multiple PARAM/PARAMCD endpoints. Filter to a single endpoint before running Kaplan-Meier or Cox analysis.'
    );
  }

  if (datasetProfile.kind === 'ADTTE' || SURVIVAL_QUERY_HINTS.test(queryLower)) {
    const groupVar = chooseGroupColumn(headers, rows) || headers.find((header) => !isLikelyIdentifierColumn(rows, header)) || headers[0];
    const timeVar = chooseTimeToEventColumn(headers, rows, groupVar);

    if (!groupVar || !timeVar) {
      throw new Error('A survival analysis requires a grouping/covariate column and a numeric time-to-event column.');
    }

    const survivalTestType = /cox|hazard/i.test(queryLower)
      ? StatTestType.COX_PH
      : StatTestType.KAPLAN_MEIER;

    return {
      testType: survivalTestType,
      var1: groupVar,
      var2: timeVar,
      explanation:
        survivalTestType === StatTestType.COX_PH
          ? `Interpreted this as a Cox proportional hazards analysis. Will model time-to-event using ${timeVar} with ${groupVar} as the primary covariate/grouping variable.`
          : `Interpreted this as a time-to-event analysis. Will run Kaplan-Meier curves with a log-rank comparison using ${timeVar} and ${groupVar}.`,
      concept: null,
    };
  }

  if ((datasetProfile.kind === 'ADLB' || datasetProfile.kind === 'BDS') && parameterColumn && parameterCount > 1) {
    const treatmentColumn = headers.find((header) =>
      ['trt01a', 'trta', 'trt01p', 'treatment', 'arm', 'trt_arm', 'actarm'].some((hint) =>
        header.toLowerCase().includes(hint)
      )
    );
    if (treatmentColumn) {
      return {
        testType: StatTestType.CHI_SQUARE,
        var1: treatmentColumn,
        var2: parameterColumn,
        explanation:
          'This ADaM dataset contains multiple parameters. The app cannot safely pool analysis values across parameters in one step, so it falls back to parameter coverage by treatment. Filter to a single PARAM/PARAMCD before running inferential comparisons.',
        concept: null,
      };
    }

    throw new Error(
      'This ADaM dataset contains multiple parameters and no clear treatment grouping variable. Filter to one PARAM/PARAMCD and confirm the intended analysis set before running inferential analysis.'
    );
  }

  const concept = detectClinicalConcept(query, headers, rows, customSynonyms);
  const var1 = chooseGroupColumn(headers, rows) || headers[0];
  const testType = inferTestType(query, concept, rows, var1);
  let var2 =
    concept?.sourceColumn ||
    (testType === StatTestType.CHI_SQUARE
      ? chooseCategoricalOutcomeColumn(headers, rows, var1)
      : chooseNumericOutcomeColumn(headers, rows, var1)) ||
    chooseNumericOutcomeColumn(headers, rows, var1) ||
    chooseCategoricalOutcomeColumn(headers, rows, var1) ||
    headers.find((h) => h !== var1 && !isLikelyIdentifierColumn(rows, h)) ||
    headers.find((h) => h !== var1) ||
    headers[0];

  const explanation = concept
    ? `Interpreted this as an event-incidence question. Will test association between ${var1} and ${concept.label} event presence derived from ${concept.sourceColumn}.`
    : `Auto-selected ${testType} using ${var1} as grouping/exposure variable and ${var2} as outcome variable based on the question and dataset structure.`;

  return { testType, var1, var2, explanation, concept };
};
