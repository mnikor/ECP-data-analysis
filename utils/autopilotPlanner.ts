import { AnalysisConcept, ClinicalFile, StatTestType } from '../types';
import { parseCsv, toNumber } from './dataProcessing';
import { planAnalysisFromQuestion } from './queryPlanner';

export interface AutopilotAnalysisTask {
  id: string;
  label: string;
  question: string;
  testType: StatTestType;
  var1: string;
  var2: string;
  concept?: AnalysisConcept | null;
  covariates?: string[];
  imputationMethod?: string;
  applyPSM?: boolean;
  rationale?: string;
}

const ID_HINTS = ['id', 'subjid', 'usubjid', 'subject', 'patient', 'record'];
const GROUP_HINTS = ['arm', 'treatment', 'trt', 'group', 'cohort'];
const DEMOGRAPHIC_CATEGORICAL_HINTS = ['sex', 'gender', 'race', 'ethnicity'];
const AE_HINTS = ['aeterm', 'pt', 'serious', 'relatedness', 'action_taken', 'outcome', 'grade'];

const normalize = (value: string) => value.trim().toLowerCase();

const countDistinct = (values: string[]): number => new Set(values.filter(Boolean)).size;

const isLikelyNumericColumn = (rows: Record<string, string>[], col: string): boolean => {
  const sample = rows.slice(0, 300);
  if (sample.length === 0) return false;
  const numericCount = sample.filter((row) => toNumber(row[col]) != null).length;
  return numericCount >= Math.max(3, Math.floor(sample.length * 0.6));
};

const isIdentifierColumn = (rows: Record<string, string>[], col: string): boolean => {
  const lower = normalize(col);
  if (!ID_HINTS.some((hint) => lower.includes(hint))) return false;
  const values = rows.map((row) => (row[col] || '').trim()).filter(Boolean);
  return values.length > 0 && countDistinct(values) >= Math.max(10, Math.floor(values.length * 0.7));
};

const chooseGroupColumn = (headers: string[]): string | null => {
  for (const hint of GROUP_HINTS) {
    const found = headers.find((header) => normalize(header).includes(hint));
    if (found) return found;
  }
  return null;
};

const chooseCategoricalColumns = (headers: string[], rows: Record<string, string>[]) =>
  headers.filter((header) => {
    if (isLikelyNumericColumn(rows, header)) return false;
    if (isIdentifierColumn(rows, header)) return false;
    const distinct = countDistinct(rows.map((row) => (row[header] || '').trim()));
    return distinct >= 2 && distinct <= 12;
  });

const chooseNumericColumns = (headers: string[], rows: Record<string, string>[]) =>
  headers.filter((header) => !isIdentifierColumn(rows, header) && isLikelyNumericColumn(rows, header));

const findHeader = (headers: string[], hints: string[]) =>
  headers.find((header) => hints.some((hint) => normalize(header).includes(normalize(hint)))) || null;

export const buildAutopilotAnalysisSuite = (
  file: ClinicalFile,
  customSynonyms: string[] = []
): AutopilotAnalysisTask[] => {
  const { headers, rows } = parseCsv(file.content);
  if (headers.length === 0 || rows.length === 0) return [];

  const groupCol = chooseGroupColumn(headers);
  const numericColumns = chooseNumericColumns(headers, rows);
  const categoricalColumns = chooseCategoricalColumns(headers, rows);
  const tasks: AutopilotAnalysisTask[] = [];
  const isAeDataset = AE_HINTS.some((hint) => headers.some((header) => normalize(header).includes(hint)));
  const seriousColumn = findHeader(headers, ['SERIOUS']);
  const relatednessColumn = findHeader(headers, ['RELATEDNESS']);
  const outcomeColumn = findHeader(headers, ['OUTCOME']);
  const actionTakenColumn = findHeader(headers, ['ACTION_TAKEN', 'ACTION']);
  const gradeColumn = findHeader(headers, ['GRADE']);

  const addTask = (task: Omit<AutopilotAnalysisTask, 'id'>) => {
    const exists = tasks.some(
      (existing) =>
        existing.testType === task.testType &&
        existing.var1 === task.var1 &&
        existing.var2 === task.var2
    );
    if (exists) return;
    tasks.push({ id: crypto.randomUUID(), ...task });
  };

  if (groupCol) {
    const groupDistinct = countDistinct(rows.map((row) => (row[groupCol] || '').trim()));
    const ageColumn = headers.find((header) => normalize(header) === 'age');
    const firstNumeric = ageColumn && numericColumns.includes(ageColumn) ? ageColumn : numericColumns[0];

    if (firstNumeric) {
      addTask({
        label: `${firstNumeric} by ${groupCol}`,
        question: `Is ${firstNumeric.toLowerCase()} balanced across ${groupCol.toLowerCase()} groups?`,
        testType: groupDistinct === 2 ? StatTestType.T_TEST : StatTestType.ANOVA,
        var1: groupCol,
        var2: firstNumeric,
        rationale: 'Compare a continuous baseline characteristic across groups.',
      });
    }

    DEMOGRAPHIC_CATEGORICAL_HINTS.forEach((hint) => {
      const column = categoricalColumns.find((header) => normalize(header).includes(hint) && header !== groupCol);
      if (!column) return;
      addTask({
        label: `${column} by ${groupCol}`,
        question: `Is ${column.toLowerCase()} distribution balanced across ${groupCol.toLowerCase()} groups?`,
        testType: StatTestType.CHI_SQUARE,
        var1: groupCol,
        var2: column,
        rationale: 'Assess balance of a categorical baseline variable across groups.',
      });
    });

    const fallbackCategorical = categoricalColumns.find(
      (header) => header !== groupCol && !DEMOGRAPHIC_CATEGORICAL_HINTS.some((hint) => normalize(header).includes(hint))
    );
    if (fallbackCategorical) {
      addTask({
        label: `${fallbackCategorical} by ${groupCol}`,
        question: `Does ${fallbackCategorical.toLowerCase()} differ across ${groupCol.toLowerCase()} groups?`,
        testType: StatTestType.CHI_SQUARE,
        var1: groupCol,
        var2: fallbackCategorical,
        rationale: 'Assess a clinically relevant categorical variable across groups.',
      });
    }
  }

  if (isAeDataset) {
    if (seriousColumn && relatednessColumn) {
      addTask({
        label: `${relatednessColumn} by ${seriousColumn}`,
        question: 'Is event relatedness associated with seriousness?',
        testType: StatTestType.CHI_SQUARE,
        var1: seriousColumn,
        var2: relatednessColumn,
        rationale: 'Assess whether serious events are more likely to be treatment-related.',
      });
    }

    if (seriousColumn && outcomeColumn) {
      addTask({
        label: `${outcomeColumn} by ${seriousColumn}`,
        question: 'Does event outcome differ between serious and non-serious adverse events?',
        testType: StatTestType.CHI_SQUARE,
        var1: seriousColumn,
        var2: outcomeColumn,
        rationale: 'Assess whether clinical outcome differs with event seriousness.',
      });
    }

    if (relatednessColumn && actionTakenColumn) {
      addTask({
        label: `${actionTakenColumn} by ${relatednessColumn}`,
        question: 'Does action taken differ by relatedness assessment?',
        testType: StatTestType.CHI_SQUARE,
        var1: relatednessColumn,
        var2: actionTakenColumn,
        rationale: 'Assess whether investigators changed treatment more often for related events.',
      });
    }

    if (seriousColumn && gradeColumn && numericColumns.includes(gradeColumn)) {
      const distinctSerious = countDistinct(rows.map((row) => (row[seriousColumn] || '').trim()));
      addTask({
        label: `${gradeColumn} by ${seriousColumn}`,
        question: 'Is event grade higher among serious adverse events?',
        testType: distinctSerious === 2 ? StatTestType.T_TEST : StatTestType.ANOVA,
        var1: seriousColumn,
        var2: gradeColumn,
        rationale: 'Compare severity grade across seriousness groups.',
      });
    }
  }

  if (numericColumns.length >= 2) {
    addTask({
      label: `${numericColumns[0]} vs ${numericColumns[1]}`,
      question: `Are ${numericColumns[0].toLowerCase()} and ${numericColumns[1].toLowerCase()} correlated?`,
      testType: StatTestType.CORRELATION,
      var1: numericColumns[0],
      var2: numericColumns[1],
      rationale: 'Explore association between two continuous variables.',
    });
  }

  if (tasks.length === 0) {
    const fallback = planAnalysisFromQuestion(
      file,
      'Run a clinically meaningful exploratory analysis for this dataset.',
      customSynonyms
    );
    addTask({
      label: fallback.explanation,
      question: 'Run a clinically meaningful exploratory analysis for this dataset.',
      testType: fallback.testType,
      var1: fallback.var1,
      var2: fallback.var2,
      concept: fallback.concept,
      rationale: fallback.explanation,
    });
  }

  return tasks.slice(0, 4);
};
