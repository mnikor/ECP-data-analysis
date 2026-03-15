import {
  ChatMessage,
  ClinicalFile,
  DataType,
  MappingSpec,
  AnalysisResponse,
  StatAnalysisResult,
  StatTestType,
  QCStatus,
  QCIssue,
  CleaningSuggestion,
  StatSuggestion,
  BiasReport,
  CohortFilter,
  AnalysisConcept,
  AnalysisPlanEntry,
} from "../types";
import { isIsoDate, normalizeSex, parseCsv, stringifyCsv, toNumber } from "../utils/dataProcessing";
import { executeLocalStatisticalAnalysis } from "../utils/statisticsEngine";
import { formatComparisonLabel, formatDisplayName } from "../utils/displayNames";
import { planAnalysisFromQuestion } from "../utils/queryPlanner";
import {
  type DatasetProfileKind,
  findHeaderByAlias as matchHeaderByAlias,
  inferDatasetProfileFromHeaders,
} from "../utils/datasetProfile";

const JsonType = {
  OBJECT: 'OBJECT',
  STRING: 'STRING',
  BOOLEAN: 'BOOLEAN',
  ARRAY: 'ARRAY',
  NUMBER: 'NUMBER',
} as const;

const AI_MODEL = 'gemini-3.1-pro-preview';
const AI_ENDPOINT = '/api/ai/generate';
const isBrowserRuntime = typeof window !== 'undefined';

interface ProxyGenerateRequest {
  prompt: string;
  model?: string;
  systemInstruction?: string;
  temperature?: number;
  responseMimeType?: string;
  responseSchema?: Record<string, unknown>;
}

const getNodeClient = async () => {
  if (isBrowserRuntime) return null;
  const apiKey = process.env.GEMINI_API_KEY;
  if (!apiKey) {
    console.warn('GEMINI_API_KEY not found in environment.');
    return null;
  }
  const { GoogleGenAI } = await import('@google/genai');
  return new GoogleGenAI({ apiKey });
};

const callAiModel = async (request: ProxyGenerateRequest): Promise<{ text: string }> => {
  const model = request.model || AI_MODEL;

  if (isBrowserRuntime) {
    return withRetry(async () => {
      let response: Response;
      try {
        response = await fetch(AI_ENDPOINT, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ ...request, model }),
        });
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        throw new Error(
          message.includes('Failed to fetch')
            ? 'Unable to reach the AI service. Restart the integrated app server with `npm run dev` and try again.'
            : message
        );
      }

      const rawPayload = await response.text().catch(() => '');
      let payload: Record<string, unknown> = {};
      if (rawPayload) {
        try {
          payload = JSON.parse(rawPayload);
        } catch {
          payload = { error: rawPayload };
        }
      }

      if (!response.ok) {
        const serverError = typeof payload?.error === 'string' ? payload.error : '';
        if (response.status === 404) {
          throw new Error('AI endpoint is unavailable. The app is probably running without the integrated Node server. Restart with `npm run dev`.');
        }
        throw new Error(serverError || `AI proxy request failed (${response.status})`);
      }
      return { text: String(payload?.text || '') };
    });
  }

  const ai = await getNodeClient();
  if (!ai) {
    throw new Error('GEMINI_API_KEY not found in environment.');
  }

  const response = await withRetry(() =>
    ai.models.generateContent({
      model,
      contents: { parts: [{ text: request.prompt }] },
      config: {
        ...(request.systemInstruction ? { systemInstruction: request.systemInstruction } : {}),
        ...(request.temperature !== undefined ? { temperature: request.temperature } : {}),
        ...(request.responseMimeType ? { responseMimeType: request.responseMimeType } : {}),
        ...(request.responseSchema ? { responseSchema: request.responseSchema } : {}),
      },
    })
  );

  return { text: response.text || '' };
};

// Helper function to retry API calls
const withRetry = async <T>(operation: () => Promise<T>, maxRetries = 3, delayMs = 2000): Promise<T> => {
    for (let i = 0; i < maxRetries; i++) {
        try {
            return await operation();
        } catch (error: any) {
            const isTransient = error?.message?.includes("Model isn't available right now") || 
                                error?.message?.includes("503") ||
                                error?.message?.includes("429") ||
                                error?.status === 503 ||
                                error?.status === 429;
            
            if (isTransient && i < maxRetries - 1) {
                console.warn(`Gemini API transient error. Retrying in ${delayMs}ms... (Attempt ${i + 1}/${maxRetries})`);
                await new Promise(resolve => setTimeout(resolve, delayMs));
                continue;
            }
            throw error;
        }
    }
    throw new Error("Max retries reached");
};

const formatAiServiceError = (error: unknown): string => {
  const message = error instanceof Error ? error.message : String(error);

  if (!message) {
    return 'AI service error: Unknown failure while generating the response.';
  }

  if (message.includes('Unable to reach the AI service')) {
    return message;
  }

  if (message.includes('AI endpoint is unavailable')) {
    return message;
  }

  if (message.includes('AI service is not configured on the server') || message.includes('GEMINI_API_KEY')) {
    return 'AI service is not configured on the server. Add `GEMINI_API_KEY` to `.env.local`, restart `npm run dev`, and try again.';
  }

  return `AI service error: ${message}`;
};

const CHAT_EXECUTION_INTENT = /compare|difference|association|correlat|regress|incidence|rate|frequency|distribution|trend|outlier|analy[sz]e|analysis|run|test|chart|kaplan|survival|hazard|cox|anova|chi[- ]?square|t[- ]?test/i;
const CHAT_GUIDANCE_INTENT = /what can i do|which workflow|how should i|what does this dataset|review the selected|explain the dataset|what files|how to start/i;

const canRunExploratoryChatAnalysis = (query: string, contextFiles: ClinicalFile[]): ClinicalFile | null => {
  if (!CHAT_EXECUTION_INTENT.test(query) || CHAT_GUIDANCE_INTENT.test(query)) {
    return null;
  }

  const dataFiles = contextFiles.filter(
    (file) => (file.type === DataType.RAW || file.type === DataType.STANDARDIZED) && Boolean(file.content)
  );

  return dataFiles.length === 1 ? dataFiles[0] : null;
};

const median = (values: number[]): number | null => {
  if (values.length === 0) return null;
  const sorted = [...values].sort((a, b) => a - b);
  const middle = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 0
    ? (sorted[middle - 1] + sorted[middle]) / 2
    : sorted[middle];
};

const formatNumberSummary = (values: number[]): string => {
  if (values.length === 0) return 'no non-missing values';
  const min = Math.min(...values);
  const max = Math.max(...values);
  const med = median(values);
  return `n=${values.length}, min=${min.toFixed(2)}, median=${(med ?? 0).toFixed(2)}, max=${max.toFixed(2)}`;
};

const summarizeCategoricalColumn = (rows: Record<string, string>[], column: string, limit = 6): string => {
  const counts = new Map<string, number>();
  rows.forEach((row) => {
    const value = (row[column] || '').trim();
    if (!value) return;
    counts.set(value, (counts.get(value) || 0) + 1);
  });

  if (counts.size === 0) return `${column}: no non-missing values`;

  return `${column}: ${Array.from(counts.entries())
    .sort((a, b) => b[1] - a[1])
    .slice(0, limit)
    .map(([value, count]) => `${value} (${count})`)
    .join(', ')}`;
};

const summarizeNumericColumn = (rows: Record<string, string>[], column: string): string => {
  const values = rows.map((row) => toNumber(row[column])).filter((value): value is number => value != null);
  return `${column}: ${formatNumberSummary(values)}`;
};

export const buildTabularChatContext = (file: ClinicalFile): string => {
  if (!file.content) {
    return `TABULAR DATASET PROFILE\n- Source: ${file.name}\n- No tabular content is available.`;
  }

  try {
    const { headers, rows } = parseCsv(file.content);
    const profile = inferDatasetProfileFromHeaders(file.name, file.type, headers);
    const subjectColumn = matchHeaderByAlias(headers, ['USUBJID', 'SUBJID', 'SUBJECT_ID', 'PATIENT_ID', 'PATID', 'SUBJECT']);
    const treatmentColumn = matchHeaderByAlias(headers, ['TRT01A', 'TRTA', 'TRTP', 'ACTARM', 'ARM', 'ARMCD', 'TRTGRP']);
    const timeColumn = matchHeaderByAlias(headers, ['AVAL', 'TIME', 'OS_TIME', 'PFS_TIME', 'ADTTE', 'DTHDY', 'ADT']);
    const censorColumn = matchHeaderByAlias(headers, ['CNSR', 'STATUS', 'EVENT', 'EVENTFL', 'OS_EVENT', 'PFS_EVENT', 'CENSOR']);
    const parameterColumn = matchHeaderByAlias(headers, ['PARAMCD', 'PARAM']);
    const analysisFlagColumn = matchHeaderByAlias(headers, ['ANL01FL', 'ANL02FL', 'SAFFL', 'ITTFL', 'EFFFL']);

    const uniqueSubjects = subjectColumn
      ? new Set(rows.map((row) => (row[subjectColumn] || '').trim()).filter(Boolean)).size
      : null;

    const parameterValues = parameterColumn
      ? Array.from(new Set(rows.map((row) => (row[parameterColumn] || '').trim()).filter(Boolean))).slice(0, 10)
      : [];

    const lines = [
      'TABULAR DATASET PROFILE',
      `- Source: ${file.name}`,
      `- Dataset profile: ${profile.shortLabel} (${profile.label})`,
      `- Rows: ${rows.length}`,
      `- Columns: ${headers.length}`,
      subjectColumn ? `- Unique subjects (${subjectColumn}): ${uniqueSubjects}` : '- Unique subject count: no subject identifier detected',
      `- Headers: ${headers.slice(0, 20).join(', ')}${headers.length > 20 ? ', ...' : ''}`,
    ];

    if (profile.guidance) {
      lines.push(`- Guidance: ${profile.guidance}`);
    }

    if (parameterColumn) {
      lines.push(`- Parameter coverage (${parameterColumn}): ${parameterValues.length > 0 ? parameterValues.join(', ') : 'none detected'}`);
    }

    if (analysisFlagColumn) {
      lines.push(`- Analysis/population flag summary: ${summarizeCategoricalColumn(rows, analysisFlagColumn, 4)}`);
    }

    if (treatmentColumn) {
      lines.push(`- Treatment/group summary: ${summarizeCategoricalColumn(rows, treatmentColumn, 6)}`);
    }

    if (timeColumn) {
      lines.push(`- Candidate time endpoint summary: ${summarizeNumericColumn(rows, timeColumn)}`);
    }

    if (censorColumn) {
      lines.push(`- Candidate censor/event summary: ${summarizeCategoricalColumn(rows, censorColumn, 6)}`);
    }

    lines.push('- Use these full-dataset counts and summaries instead of inferring cohort size from a short row fragment.');
    return lines.join('\n');
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return `TABULAR DATASET PROFILE\n- Source: ${file.name}\n- Structured summary could not be prepared: ${message}`;
  }
};

export const buildChatContextText = (contextFiles: ClinicalFile[], mode: 'RAG' | 'STUFFING'): string => {
  if (contextFiles.length === 0) return 'No context files selected.';

  const sections = contextFiles.map((file) => {
    const isTabular = file.type === DataType.RAW || file.type === DataType.STANDARDIZED;
    if (isTabular) {
      return buildTabularChatContext(file);
    }

    if (mode === 'STUFFING') {
      return `--- DOCUMENT: ${file.name} ---\n${file.content || 'No text content available.'}\n--- END DOCUMENT ---`;
    }

    return `[Source: ${file.name}]: ${(file.content || 'No text content available.').substring(0, 1200)}...`;
  });

  return mode === 'RAG'
    ? `RETRIEVED CONTEXT:\n${sections.join('\n\n')}`
    : sections.join('\n\n');
};

const buildExploratoryChatInsights = (
  datasetName: string,
  testType: StatTestType,
  var1: string,
  var2: string,
  metrics: Record<string, string | number>
): string[] => {
  const insights = [
    `Executed a deterministic exploratory ${testType} on ${datasetName}.`,
    `Variables used: ${formatDisplayName(var1)} and ${formatDisplayName(var2)}.`,
  ];

  if (metrics.p_value != null) {
    insights.push(`Primary p-value: ${metrics.p_value}.`);
  }

  if (metrics.total_n != null) {
    insights.push(`Rows included in the analysis: ${metrics.total_n}.`);
  } else if (metrics.n != null) {
    insights.push(`Rows included in the analysis: ${metrics.n}.`);
  }

  return insights;
};

const normalizeDate = (value: string): string | null => {
  if (!value) return null;
  if (isIsoDate(value)) return value;

  const slashMatch = value.match(/^(\d{1,4})[\/.-](\d{1,2})[\/.-](\d{1,4})$/);
  if (slashMatch) {
    let a = Number(slashMatch[1]);
    let b = Number(slashMatch[2]);
    let c = Number(slashMatch[3]);

    let year: number;
    let month: number;
    let day: number;

    if (a > 1900) {
      year = a;
      month = b;
      day = c;
    } else if (c > 1900) {
      year = c;
      if (a > 12) {
        day = a;
        month = b;
      } else {
        month = a;
        day = b;
      }
    } else {
      return null;
    }

    if (month < 1 || month > 12 || day < 1 || day > 31) return null;
    return `${year.toString().padStart(4, '0')}-${month.toString().padStart(2, '0')}-${day.toString().padStart(2, '0')}`;
  }

  const parsed = new Date(value);
  if (Number.isNaN(parsed.getTime())) return null;
  return parsed.toISOString().slice(0, 10);
};

interface QCColumnRequirement {
  label: string;
  aliases: string[];
}

interface QCProfile {
  kind: DatasetProfileKind;
  name: string;
  required: QCColumnRequirement[];
  recommended?: QCColumnRequirement[];
}

const inferQCProfile = (file: ClinicalFile, headers: string[]): QCProfile => {
  const datasetProfile = inferDatasetProfileFromHeaders(file.name || '', file.type, headers);
  const fileName = (file.name || '').toLowerCase();
  const lowerHeaders = headers.map((header) => header.toLowerCase());
  const headerText = lowerHeaders.join(' ');

  const subjectId: QCColumnRequirement = {
    label: 'Subject ID',
    aliases: ['USUBJID', 'SUBJID', 'SUBJECT_ID', 'PATIENT_ID'],
  };
  const treatmentVariable: QCColumnRequirement = {
    label: 'Treatment Variable',
    aliases: ['TRT01A', 'TRTA', 'TRT01P', 'ARM', 'ACTARM', 'TRT_ARM', 'TREATMENT_ARM'],
  };
  const populationFlag: QCColumnRequirement = {
    label: 'Analysis Population Flag',
    aliases: ['ANL01FL', 'SAFFL', 'ITTFL', 'EFFFL', 'PPSFL'],
  };
  const parameterColumn: QCColumnRequirement = {
    label: 'Parameter',
    aliases: ['PARAM', 'PARAMCD'],
  };
  const valueColumn: QCColumnRequirement = {
    label: 'Analysis Value',
    aliases: ['AVAL', 'CHG', 'BASE'],
  };
  const analysisDate: QCColumnRequirement = {
    label: 'Analysis Date',
    aliases: ['ADT', 'ADTM', 'ADY', 'AVISIT', 'AVISITN'],
  };

  switch (datasetProfile.kind) {
    case 'ADSL':
      return {
        kind: datasetProfile.kind,
        name: datasetProfile.shortLabel,
        required: [subjectId],
        recommended: [treatmentVariable, populationFlag],
      };
    case 'ADAE':
      return {
        kind: datasetProfile.kind,
        name: datasetProfile.shortLabel,
        required: [
          subjectId,
          { label: 'Event Term', aliases: ['AEDECOD', 'AETERM', 'PT'] },
        ],
        recommended: [
          treatmentVariable,
          { label: 'Treatment-Emergent Flag', aliases: ['TRTEMFL'] },
          { label: 'Safety Flag', aliases: ['SAFFL'] },
          { label: 'Seriousness', aliases: ['AESER', 'SERIOUS'] },
        ],
      };
    case 'ADLB':
      return {
        kind: datasetProfile.kind,
        name: datasetProfile.shortLabel,
        required: [subjectId, parameterColumn, valueColumn],
        recommended: [treatmentVariable, populationFlag, analysisDate],
      };
    case 'ADTTE':
      return {
        kind: datasetProfile.kind,
        name: datasetProfile.shortLabel,
        required: [subjectId, parameterColumn, { label: 'Time-to-Event Value', aliases: ['AVAL'] }, { label: 'Censoring Flag', aliases: ['CNSR'] }],
        recommended: [treatmentVariable, populationFlag],
      };
    case 'BDS':
      return {
        kind: datasetProfile.kind,
        name: datasetProfile.shortLabel,
        required: [subjectId, parameterColumn, valueColumn],
        recommended: [treatmentVariable, populationFlag, analysisDate],
      };
    default:
      break;
  }

  if (fileName.includes('demog') || fileName.includes('dm') || / age | sex | race /.test(` ${headerText} `)) {
    return {
      kind: 'DEMOGRAPHICS',
      name: 'Demographics',
      required: [
        subjectId,
        { label: 'AGE', aliases: ['AGE'] },
        { label: 'SEX', aliases: ['SEX', 'GENDER'] },
      ],
    };
  }

  if (fileName.includes('adverse') || headerText.includes('aeterm') || headerText.includes(' pt ')) {
    return {
      kind: 'ADVERSE_EVENTS',
      name: 'Adverse Events',
      required: [
        subjectId,
        { label: 'Event Term', aliases: ['PT', 'AETERM'] },
        { label: 'Start Date', aliases: ['AESTDTC', 'AESTDT', 'START_DATE'] },
      ],
    };
  }

  if (fileName.includes('exposure') || headerText.includes('dose') || headerText.includes('exstdtc') || headerText.includes('extrt')) {
    return {
      kind: 'EXPOSURE',
      name: 'Exposure',
      required: [
        subjectId,
        { label: 'Exposure Agent', aliases: ['EXTRT', 'DRUG', 'THERAPY_CLASS', 'TRT_ARM', 'ARM', 'TREATMENT_ARM'] },
        { label: 'Dose', aliases: ['DOSE', 'EXDOSE', 'DOSE_AMT'] },
        { label: 'Start Date', aliases: ['EXSTDTC', 'EXSTDT', 'START_DATE'] },
      ],
    };
  }

  if (fileName.includes('lab') || headerText.includes('lbstres') || headerText.includes('lborres')) {
    return {
      kind: 'LABS',
      name: 'Labs',
      required: [
        subjectId,
        { label: 'Lab Test', aliases: ['LBTEST', 'LBTESTCD', 'TEST', 'TESTCD', 'TEST_NAME', 'ANALYTE'] },
        { label: 'Lab Result', aliases: ['LBSTRESN', 'LBSTRESC', 'LBORRES', 'RESULT'] },
      ],
    };
  }

  if (fileName.includes('visit') || headerText.includes('visitnum') || headerText.includes('visit')) {
    return {
      kind: 'VISITS',
      name: 'Visits',
      required: [
        subjectId,
        { label: 'Visit', aliases: ['VISIT', 'VISITNUM', 'VISIT_NAME'] },
        { label: 'Visit Date', aliases: ['VISITDTC', 'VISITDT', 'DATE'] },
      ],
    };
  }

  if (fileName.includes('concomitant') || headerText.includes('cmstdtc') || headerText.includes('cmid') || headerText.includes('cmtrt')) {
    return {
      kind: 'CONMEDS',
      name: 'Concomitant Medications',
      required: [
        subjectId,
        { label: 'Medication', aliases: ['CMTRT', 'MEDICATION_NAME', 'DRUG_NAME', 'CMDECOD', 'DRUG'] },
        { label: 'Medication Start Date', aliases: ['CMSTDTC', 'CMSTDT', 'START_DATE'] },
      ],
    };
  }

  if (fileName.includes('tumor') || fileName.includes('recist')) {
    return {
      kind: 'TUMOR',
      name: 'Tumor Assessments',
      required: [
        subjectId,
        { label: 'Assessment', aliases: ['TRRESP', 'RESPONSE', 'ASSESSMENT', 'RESULT'] },
        { label: 'Assessment Date', aliases: ['TUDTC', 'ASSESSDTC', 'ASSTDT', 'DATE'] },
      ],
    };
  }

  if (fileName.includes('molecular') || headerText.includes('gene') || headerText.includes('mutation')) {
    return {
      kind: 'MOLECULAR',
      name: 'Molecular Profile',
      required: [
        subjectId,
        { label: 'Biomarker', aliases: ['GENE', 'BIOMARKER', 'MUTATION', 'VARIANT'] },
      ],
    };
  }

  return {
    kind: 'GENERIC',
    name: 'Generic Clinical Dataset',
    required: [subjectId],
  };
};

const resolveRequiredColumns = (file: ClinicalFile, headers: string[]) => {
  const profile = inferQCProfile(file, headers);
  const resolvedRequired = profile.required.map((requirement) => ({
    ...requirement,
    actual: matchHeaderByAlias(headers, requirement.aliases),
  }));
  const resolvedRecommended = (profile.recommended || []).map((requirement) => ({
    ...requirement,
    actual: matchHeaderByAlias(headers, requirement.aliases),
  }));
  return { profile, resolvedRequired, resolvedRecommended };
};

const countDistinctColumnValues = (rows: Record<string, string>[], column: string): number =>
  new Set(rows.map((row) => (row[column] || '').trim()).filter(Boolean)).size;

const buildAdamAdvisoryIssues = (
  profile: QCProfile,
  headers: string[],
  rows: Record<string, string>[],
  resolvedRequired: Array<QCColumnRequirement & { actual: string | null }>,
  resolvedRecommended: Array<QCColumnRequirement & { actual: string | null }>
): QCIssue[] => {
  const issues: QCIssue[] = [];
  const missingRecommended = resolvedRecommended.filter((item) => !item.actual).map((item) => item.label);

  if (missingRecommended.length > 0) {
    issues.push({
      severity: 'LOW',
      description: `Recommended ADaM review columns not found for ${profile.name}: ${missingRecommended.join(', ')}`,
      affectedRows: 'Header',
      autoFixable: false,
      remediationHint: 'The dataset can still be explored, but confirm population flags, treatment variables, and analysis dates before making final conclusions.',
    });
  }

  if (profile.kind === 'ADLB' || profile.kind === 'BDS') {
    const parameterColumn =
      resolvedRequired.find((item) => item.label === 'Parameter')?.actual ||
      matchHeaderByAlias(headers, ['PARAM', 'PARAMCD']);
    const analysisFlagColumn =
      resolvedRecommended.find((item) => item.label === 'Analysis Population Flag')?.actual ||
      matchHeaderByAlias(headers, ['ANL01FL', 'SAFFL', 'ITTFL', 'EFFFL', 'PPSFL']);
    if (parameterColumn) {
      const distinctParameters = countDistinctColumnValues(rows, parameterColumn);
      if (distinctParameters > 1 && !analysisFlagColumn) {
        issues.push({
          severity: 'MEDIUM',
          description: `${profile.name} contains ${distinctParameters} analysis parameters but no analysis/population flag column.`,
          affectedRows: 'Header',
          autoFixable: false,
          remediationHint: 'Filter to a single parameter and confirm the intended analysis flag before running inferential statistics.',
        });
      }
    }
  }

  if (profile.kind === 'ADTTE') {
    const parameterColumn =
      resolvedRequired.find((item) => item.label === 'Parameter')?.actual ||
      matchHeaderByAlias(headers, ['PARAM', 'PARAMCD']);
    const distinctParameters = parameterColumn ? countDistinctColumnValues(rows, parameterColumn) : 0;
    if (distinctParameters > 1) {
      issues.push({
        severity: 'MEDIUM',
        description: `${profile.name} contains ${distinctParameters} time-to-event endpoints. Filter to one PARAM/PARAMCD before Kaplan-Meier or Cox analysis.`,
        affectedRows: 'Header',
        autoFixable: false,
        remediationHint: 'Select a single endpoint such as OS or PFS before running survival analysis.',
      });
    } else {
      issues.push({
        severity: 'LOW',
        description: `${profile.name} recognized. Review censoring semantics and population/treatment flags before interpreting Kaplan-Meier or Cox results.`,
        affectedRows: 'Header',
        autoFixable: false,
        remediationHint: 'Confirm the meaning of CNSR, the treatment variable, and the analysis population before final interpretation.',
      });
    }
  }

  return issues;
};

const applyMappingTransformation = (
  sourceValue: string,
  transformation: string | undefined,
  row: Record<string, string>
): string => {
  const rule = (transformation || '').trim().toLowerCase();
  if (!rule) return sourceValue;

  if (rule.startsWith('const:')) {
    return transformation!.slice(transformation!.indexOf(':') + 1).trim();
  }

  let value = sourceValue;

  if (rule.includes('trim')) value = value.trim();
  if (rule.includes('upper')) value = value.toUpperCase();
  if (rule.includes('lower')) value = value.toLowerCase();

  if (rule.includes('concat with studyid') || rule.includes('concat studyid')) {
    const studyId = (row.STUDYID || row.STUDY_ID || 'STUDY').trim();
    value = `${studyId}-${value}`;
  }

  return value;
};

export const generateAnalysis = async (
  query: string,
  contextFiles: ClinicalFile[],
  mode: 'RAG' | 'STUFFING',
  history: ChatMessage[]
): Promise<AnalysisResponse> => {
  const exploratoryFile = canRunExploratoryChatAnalysis(query, contextFiles);
  if (exploratoryFile) {
    try {
      const plan = planAnalysisFromQuestion(exploratoryFile, query);
      const result = executeLocalStatisticalAnalysis(
        exploratoryFile,
        plan.testType,
        plan.var1,
        plan.var2,
        plan.concept
      );

      return {
        answer: [
          '### Exploratory analysis executed',
          `Ran **${plan.testType}** on \`${exploratoryFile.name}\`.`,
          `**Variables:** \`${plan.var1}\` vs \`${plan.var2}\``,
          '',
          '### Statistical interpretation',
          result.interpretation,
          '',
          '### Why this test was chosen',
          plan.explanation,
          '',
          'Use **Statistical Analysis** when you need to edit variables, review code, or rerun this in a controlled workflow.',
        ].join('\n'),
        chartConfig: result.chartConfig,
        tableConfig: result.tableConfig,
        keyInsights: buildExploratoryChatInsights(
          exploratoryFile.name,
          plan.testType,
          plan.var1,
          plan.var2,
          result.metrics
        ),
      };
    } catch (error) {
      return {
        answer: [
          '### Exploratory analysis could not be executed',
          error instanceof Error ? error.message : String(error),
          '',
          'Use **Statistical Analysis** if you need to inspect variables manually or prepare the dataset before rerunning the analysis.',
        ].join('\n'),
      };
    }
  }

  const contextText = buildChatContextText(contextFiles, mode);

  const systemInstruction = `You are an expert Clinical Data Scientist and Medical Monitor. 
  Your goal is to assist with clinical study analysis, signal detection, and root cause analysis.
  
  CURRENT MODE: ${mode}
  
  OBJECTIVES:
  1. DATA MINING & DISCOVERY: Actively look for non-obvious patterns, such as outliers in vital signs, unexpected correlations between Age/Sex and Adverse Events, or site-specific anomalies.
  2. MEDICAL MONITORING: Prioritize patient safety. If you see an adverse event or lab anomaly, perform a "Root Cause Analysis". Check concomitant medications or medical history if available to explain the event.
  3. VISUALIZATION: If the data allows, or if the user asks for analysis, ALWAYS try to generate a chart to make the insight visible. Prefer complex charts: Box Plots (distributions), Kaplan-Meier (time-to-event), Scatter plots (correlations).
  4. ACCURACY OVER STYLE: Focus on data integrity and clinical precision. Do not worry about "publication style" unless explicitly asked. Focus on "Monitoring Reports" style (bullet points, risk flags).
  
  When answering:
  1. Cite your sources using [Doc Name] format.
  2. If asked for code, provide Python/Pandas or SAS pseudo-code.
  3. Be precise with clinical terminology (CDISC, SDTM, ADaM, MedDRA).
  4. VISUALIZATION DATA: 
     - Generate a Plotly.js configuration.
     - If the context data is insufficient, DO NOT invent records. Explicitly state what additional data is required.
  `;

  const prompt = `
  CONTEXT DATA:
  ${contextText}

  USER HISTORY:
  ${history.filter(h => h.role === 'user').slice(-3).map(h => h.content).join('\n')}

  CURRENT QUERY:
  ${query}
  `;

  // Schema for structured output
  const schema = {
    type: JsonType.OBJECT,
    properties: {
      answer: { 
        type: JsonType.STRING, 
        description: "The natural language response/analysis. Focus on clinical insights and safety signals." 
      },
      hasChart: { 
        type: JsonType.BOOLEAN, 
        description: "Set to true if a chart visualization is included." 
      },
      chartConfigJSON: { 
        type: JsonType.STRING, 
        description: "A valid JSON string representing the Plotly.js 'data' array and 'layout' object. Example: { \"data\": [{...}], \"layout\": {...} }" 
      },
      keyInsights: { 
        type: JsonType.ARRAY, 
        items: { type: JsonType.STRING }, 
        description: "List of 3-5 bullet points highlighting 'Hidden Insights', outliers, or critical findings." 
      }
    },
    required: ["answer", "hasChart"]
  };

  try {
    const response = await callAiModel({
      prompt,
      systemInstruction,
      temperature: 0.4,
      responseMimeType: 'application/json',
      responseSchema: schema,
    });

    if (response.text) {
        try {
            const parsed = JSON.parse(response.text);
            let chartConfig = undefined;
            if (parsed.hasChart && parsed.chartConfigJSON) {
                chartConfig = JSON.parse(parsed.chartConfigJSON);
            }
            return {
                answer: parsed.answer,
                chartConfig: chartConfig,
                keyInsights: parsed.keyInsights
            };
        } catch (e) {
            console.error("Failed to parse JSON response", e);
            return { answer: response.text || "Error parsing analysis." };
        }
    }
    return { answer: "No response generated." };

  } catch (error) {
    console.error("Gemini API Error", error);
    return { answer: formatAiServiceError(error) };
  }
};

/**
 * Step 1: Generate the Python code for the analysis.
 */
export const generateStatisticalCode = async (
  file: ClinicalFile,
  testType: StatTestType,
  var1: string,
  var2: string,
  contextDocuments: ClinicalFile[] = [],
  covariates: string[] = [],
  imputationMethod: string = 'None',
  applyPSM: boolean = false
): Promise<string> => {
  // Prepare context string from Protocol/SAP
  const contextSnippet = contextDocuments.length > 0
    ? contextDocuments.map(d => `--- ${d.name} ---\n${d.content?.substring(0, 3000)}...`).join('\n\n')
    : "No Protocol or SAP provided.";
  const survivalLibraryHint =
    testType === StatTestType.KAPLAN_MEIER || testType === StatTestType.COX_PH
      ? '\n  5a. For time-to-event analysis, use lifelines or statsmodels survival utilities. Treat Variable 2 as the time variable and infer the censor column from CNSR / STATUS / EVENT-like fields.\n'
      : '';

  const prompt = `
  You are a Senior Statistical Programmer.
  TASK: Write a clean, commented Python script using pandas and scipy.stats (or scikit-learn/statsmodels/lifelines for advanced or survival analyses) to perform a ${testType}.
  
  TARGET DATASET:
  - Name: ${file.name}
  - Variable 1: ${var1}
  - Variable 2: ${var2}
  - Data Snippet: 
  ${file.content?.substring(0, 300)}...

  ADVANCED ADJUSTMENTS (RWE):
  - Covariates to adjust for: ${covariates.length > 0 ? covariates.join(', ') : 'None'}
  - Missing Data Imputation: ${imputationMethod}
  - Propensity Score Matching (PSM): ${applyPSM ? 'Yes (match on covariates before analysis)' : 'No'}

  RELEVANT STUDY DOCUMENTS (Protocol / SAP):
  ${contextSnippet}

  REQUIREMENTS:
  1. Actively check the RELEVANT STUDY DOCUMENTS for definitions (e.g., "Baseline", "Responder", "Exclusion Criteria") and implement them in the code if applicable to ${var1} or ${var2}.
  2. If the Protocol defines specific exclusion criteria (e.g., "Exclude Age < 18"), add a filtering step in pandas.
  3. Assume the data is loaded into a DataFrame named 'df'.
  4. If Imputation is requested, use scikit-learn (e.g., SimpleImputer or IterativeImputer) before the main analysis.
  5. If PSM is requested, use LogisticRegression to calculate propensity scores based on the covariates, perform nearest-neighbor matching, and run the final ${testType} on the matched cohort.
  ${survivalLibraryHint}
  6. If covariates are provided but PSM is false, include them in a multivariable model if the test type supports it (e.g., ANCOVA, Logistic Regression).
  7. Perform the statistical test (${testType}).
  8. Print the key results (p-value, test statistic, etc).
  9. DO NOT output markdown blocks. Just return the raw code string.
  `;

  try {
    const response = await callAiModel({ prompt });
    // Strip markdown formatting if the model adds it
    let code = response.text || "# No code generated.";
    code = code.replace(/```python/g, '').replace(/```/g, '').trim();
    return code;
  } catch (error) {
    console.error("Code Generation Error", error);
    return [
      '# Deterministic local execution path (no external model required)',
      `# Test: ${testType}`,
      `# Dataset: ${file.name}`,
      `# Variables: ${var1}${var2 ? `, ${var2}` : ''}`,
      '',
      '# This script stub documents intended logic.',
      '# Actual execution is performed in the app deterministic engine.',
    ].join('\n');
  }
};

/**
 * Step 2: Execute the analysis deterministically and return results.
 */
export const executeStatisticalCode = async (
  code: string,
  file: ClinicalFile,
  testType: StatTestType,
  var1?: string,
  var2?: string,
  concept?: AnalysisConcept | null
): Promise<StatAnalysisResult> => {
  try {
    const { headers } = parseCsv(file.content);
    const resolvedVar1 = var1 && headers.includes(var1) ? var1 : headers[0];
    const resolvedVar2 = var2 && headers.includes(var2) ? var2 : headers.find((h) => h !== resolvedVar1) || '';

    if (!resolvedVar1) {
      throw new Error("Unable to infer analysis variables from dataset headers.");
    }

    const result = executeLocalStatisticalAnalysis(file, testType, resolvedVar1, resolvedVar2, concept);
    return { ...result, executedCode: code || result.executedCode };
  } catch (error) {
    console.error("Deterministic execution error", error);
    const message = error instanceof Error ? error.message : "Analysis execution failed.";
    throw new Error(message);
  }
};

const buildFallbackClinicalCommentary = (
  result: StatAnalysisResult,
  context: {
    question: string;
    dataScope: 'SINGLE_DATASET' | 'LINKED_WORKSPACE';
    sourceNames: string[];
    var1: string;
    var2: string;
  }
) => {
  const adjusted = result.metrics.adjusted_p_value;
  const scopeLabel = context.dataScope === 'LINKED_WORKSPACE' ? 'linked multi-file workspace' : 'single dataset';
  const comparison = formatComparisonLabel(context.var1, context.var2);

  const limitations = [
    context.dataScope === 'LINKED_WORKSPACE'
      ? 'This is an exploratory linked-workspace result; derived subject-level summaries may smooth over visit-level or event-level timing.'
      : 'This result is based on one dataset only and may omit confounding context from related domains.',
  ];

  if (adjusted) {
    limitations.push(`Multiple-testing adjustment was applied (${result.metrics.multiple_testing_method || 'Benjamini-Hochberg FDR'}).`);
  } else if (context.dataScope === 'LINKED_WORKSPACE') {
    limitations.push('Cross-domain signal scans can generate false positives and should be treated as hypothesis-generating.');
  }

  return {
    source: 'FALLBACK' as const,
    summary: `${result.interpretation} This commentary is based on the ${scopeLabel} result for ${comparison} across ${context.sourceNames.length} source dataset(s).`,
    limitations,
    caution:
      context.dataScope === 'LINKED_WORKSPACE'
        ? 'Use linked-workspace findings to prioritize follow-up analyses, not as confirmatory evidence.'
        : 'Interpret in conjunction with protocol context, sample size, and missing-data patterns.',
  };
};

export const generateClinicalCommentary = async (
  result: StatAnalysisResult,
  context: {
    question: string;
    dataScope: 'SINGLE_DATASET' | 'LINKED_WORKSPACE';
    sourceNames: string[];
    sourceDatasetName: string;
    var1: string;
    var2: string;
    testType: StatTestType;
  }
): Promise<NonNullable<StatAnalysisResult['aiCommentary']>> => {
  const fallback = buildFallbackClinicalCommentary(result, context);

  const prompt = `
  You are a clinical analytics copilot writing a short, careful commentary for an exploratory analysis result.

  REQUIREMENTS:
  - Stay grounded in the provided result only.
  - Do not invent effect sizes, causality, or medical claims beyond the metrics.
  - Explicitly acknowledge exploratory status when the scope is LINKED_WORKSPACE.
  - Keep the summary to 2-4 sentences.
  - Provide 2-4 limitations.

  RESULT CONTEXT:
  - Scope: ${context.dataScope}
  - Source datasets: ${context.sourceNames.join(', ')}
  - Primary dataset label: ${context.sourceDatasetName}
  - User question: ${context.question || 'Autopilot-selected exploratory analysis'}
  - Test type: ${context.testType}
  - Variables: ${formatDisplayName(context.var1)} vs ${formatDisplayName(context.var2)}
  - Deterministic interpretation: ${result.interpretation}
  - Metrics JSON: ${JSON.stringify(result.metrics)}
  `;

  const schema = {
    type: JsonType.OBJECT,
    properties: {
      summary: { type: JsonType.STRING },
      limitations: { type: JsonType.ARRAY, items: { type: JsonType.STRING } },
      caution: { type: JsonType.STRING },
    },
    required: ['summary', 'limitations'],
  };

  try {
    const response = await callAiModel({
      prompt,
      responseMimeType: 'application/json',
      responseSchema: schema,
      temperature: 0.2,
    });

    if (!response.text) return fallback;
    const parsed = JSON.parse(response.text);
    return {
      source: 'AI',
      summary: parsed.summary || fallback.summary,
      limitations: Array.isArray(parsed.limitations) && parsed.limitations.length > 0 ? parsed.limitations : fallback.limitations,
      caution: parsed.caution || fallback.caution,
    };
  } catch (error) {
    console.error('Clinical commentary generation error', error);
    return fallback;
  }
};

/**
 * Step 3: Generate SAS Code from Python Logic
 */
export const generateSASCode = async (
  file: ClinicalFile,
  testType: StatTestType,
  var1: string,
  var2: string,
  pythonCode: string,
  covariates: string[] = [],
  imputationMethod: string = 'None',
  applyPSM: boolean = false
): Promise<string> => {
  const procHint =
    testType === StatTestType.KAPLAN_MEIER
      ? 'PROC LIFETEST'
      : testType === StatTestType.COX_PH
        ? 'PROC PHREG'
        : 'PROC TTEST, PROC GLM, PROC FREQ, PROC CORR';

  const prompt = `
  You are a Senior Statistical Programmer in the Pharmaceutical Industry.
  TASK: Convert the following analysis logic into regulatory-grade SAS code (SAS 9.4+).

  CONTEXT:
  - Dataset: ${file.name} (Assume library 'ADAM' or 'WORK')
  - Analysis: ${testType}
  - Variable 1: ${var1}
  - Variable 2: ${var2}

  ADVANCED ADJUSTMENTS (RWE):
  - Covariates to adjust for: ${covariates.length > 0 ? covariates.join(', ') : 'None'}
  - Missing Data Imputation: ${imputationMethod}
  - Propensity Score Matching (PSM): ${applyPSM ? 'Yes (match on covariates before analysis)' : 'No'}

  REFERENCE PYTHON LOGIC:
  ${pythonCode}

  REQUIREMENTS:
  1. Use the appropriate SAS procedures (e.g., ${procHint}).
  2. If Imputation is requested, use PROC MI.
  3. If PSM is requested, use PROC PSMATCH.
  4. Include ODS OUTPUT statements to capture statistics.
  5. Add standard header comments (Program Name, Author, Date).
  6. Assume input data is in a dataset named 'INPUT_DATA'.
  7. Do NOT execute. Just write the code.
  8. Return only the code string.
  `;

  try {
    const response = await callAiModel({ prompt });
    let code = response.text || "/* No SAS code generated */";
    code = code.replace(/```sas/g, '').replace(/```/g, '').trim();
    return code;
  } catch (error) {
    console.error("SAS Gen Error", error);
    return "/* Error generating SAS code */";
  }
};

export const runQualityCheck = async (file: ClinicalFile): Promise<{ status: QCStatus, issues: QCIssue[] }> => {
  const issues: QCIssue[] = [];

  try {
    const { headers, rows } = parseCsv(file.content);
    const { profile, resolvedRequired, resolvedRecommended } = resolveRequiredColumns(file, headers);
    const missingHeaders = resolvedRequired.filter((item) => !item.actual).map((item) => item.label);
    const presentCriticalHeaders = resolvedRequired.filter((item) => item.actual).map((item) => item.actual as string);
    const ageColumn = resolvedRequired.find((item) => item.label === 'AGE')?.actual || matchHeaderByAlias(headers, ['AGE']);
    const sexColumn = resolvedRequired.find((item) => item.label === 'SEX')?.actual || matchHeaderByAlias(headers, ['SEX', 'GENDER']);

    if (missingHeaders.length > 0) {
      issues.push({
        severity: 'HIGH',
        description: `Missing critical columns for ${profile.name}: ${missingHeaders.join(', ')}`,
        affectedRows: 'Header',
        autoFixable: false,
        remediationHint: 'Re-map source data or re-ingest with required columns present.',
      });
    }

    const missingCriticalRows: number[] = [];
    const badAgeRows: number[] = [];
    const badDateRowsByColumn: Record<string, number[]> = {};
    const sexValues = new Set<string>();

    const dateColumns = headers.filter((h) => /(DATE|DT|DTC)/i.test(h));

    rows.forEach((row, index) => {
      const rowNumber = index + 1;
      const hasMissingCriticalValue =
        presentCriticalHeaders.length > 0 &&
        presentCriticalHeaders.some((col) => {
          const value = row[col];
          return value == null || String(value).trim() === '';
        });
      if (hasMissingCriticalValue) {
        missingCriticalRows.push(rowNumber);
      }

      if (ageColumn) {
        const rawAge = row[ageColumn];
        const age = toNumber(rawAge);
        if (rawAge != null && String(rawAge).trim() !== '' && age != null && (age < 0 || age > 120)) {
          badAgeRows.push(rowNumber);
        }
      }

      if (sexColumn) {
        const sex = (row[sexColumn] || '').trim();
        if (sex) sexValues.add(sex.toLowerCase());
      }

      dateColumns.forEach((col) => {
        const value = (row[col] || '').trim();
        if (!value) return;
        if (!isIsoDate(value)) {
          if (!badDateRowsByColumn[col]) badDateRowsByColumn[col] = [];
          badDateRowsByColumn[col].push(rowNumber);
        }
      });
    });

    if (missingCriticalRows.length > 0) {
      issues.push({
        severity: 'HIGH',
        description: `Missing critical values in ${presentCriticalHeaders.join(', ')}.`,
        affectedRows: `Rows ${missingCriticalRows.slice(0, 20).join(', ')}`,
        autoFixable: true,
        remediationHint: 'Auto-fix can drop incomplete rows. Consider source correction if many rows are affected.',
      });
    }

    if (badAgeRows.length > 0) {
      issues.push({
        severity: 'HIGH',
        description: 'Invalid AGE values found (outside 0-120).',
        affectedRows: `Rows ${badAgeRows.slice(0, 20).join(', ')}`,
        autoFixable: true,
        remediationHint: 'Auto-fix can coerce AGE and remove implausible records.',
      });
    }

    Object.entries(badDateRowsByColumn).forEach(([col, rowIds]) => {
      issues.push({
        severity: 'MEDIUM',
        description: `Invalid date format in column ${col}. Expected YYYY-MM-DD.`,
        affectedRows: `Rows ${rowIds.slice(0, 20).join(', ')}`,
        autoFixable: true,
        remediationHint: 'Auto-fix can normalize parseable dates to ISO format.',
      });
    });

    const hasShortSex = ['m', 'f'].some((v) => sexValues.has(v));
    const hasLongSex = ['male', 'female'].some((v) => sexValues.has(v));
    if (hasShortSex && hasLongSex) {
      issues.push({
        severity: 'LOW',
        description: "Inconsistent SEX terminology detected ('M/F' mixed with 'Male/Female').",
        autoFixable: true,
        remediationHint: 'Auto-fix can normalize SEX values to a consistent coding.',
      });
    }

    if (profile.kind === 'ADSL' || profile.kind === 'ADAE' || profile.kind === 'ADLB' || profile.kind === 'ADTTE' || profile.kind === 'BDS') {
      issues.push(...buildAdamAdvisoryIssues(profile, headers, rows, resolvedRequired, resolvedRecommended));
    }

    const hasHigh = issues.some((issue) => issue.severity === 'HIGH');
    const status: QCStatus = issues.length === 0 ? 'PASS' : hasHigh ? 'FAIL' : 'WARN';
    return { status, issues };
  } catch (e: any) {
    return {
      status: 'FAIL',
      issues: [
        {
          severity: 'HIGH',
          description: `Failed to parse dataset: ${e.message || 'Unknown CSV parsing error'}`,
          affectedRows: 'N/A',
          autoFixable: false,
          remediationHint: 'Validate delimiter, quoting, and file encoding before retrying.',
        },
      ],
    };
  }
};

export const generateCleaningSuggestion = async (file: ClinicalFile, issues: QCIssue[]): Promise<CleaningSuggestion> => {
  const headers = (() => {
    try {
      return parseCsv(file.content).headers;
    } catch {
      return [];
    }
  })();
  const { resolvedRequired } = resolveRequiredColumns(file, headers);
  const presentCriticalHeaders = resolvedRequired.filter((item) => item.actual).map((item) => item.actual as string);
  const ageColumn = resolvedRequired.find((item) => item.label === 'AGE')?.actual || matchHeaderByAlias(headers, ['AGE']);
  const sexColumn = resolvedRequired.find((item) => item.label === 'SEX')?.actual || matchHeaderByAlias(headers, ['SEX', 'GENDER']);
  const isAutoFixableIssue = (issue: QCIssue) => {
    if (typeof issue.autoFixable === 'boolean') return issue.autoFixable;
    return !/missing critical columns|failed to parse dataset/i.test(issue.description);
  };
  const autoFixableIssues = issues.filter(isAutoFixableIssue);
  const nonAutoFixableIssues = issues.filter((issue) => !isAutoFixableIssue(issue));

  const issueSummary = issues.map((i) => `${i.severity}: ${i.description}`).join('\n');
  const explanation = issues.length
    ? [
        `Deterministic cleaning plan generated from QC findings:\n${issueSummary}`,
        nonAutoFixableIssues.length > 0
          ? `\nNote: ${nonAutoFixableIssues.length} issue(s) require manual remediation (e.g., missing required columns cannot be auto-created).`
          : '',
      ]
        .filter(Boolean)
        .join('\n')
    : 'No specific QC findings were provided. Applying safe standardization only (trim strings and normalize SEX).';

  if (autoFixableIssues.length === 0 && issues.length > 0) {
    return {
      explanation,
      code: [
        '# No automatic cleaning was generated.',
        '# Selected issues are structural/manual and require source remapping or re-ingestion.',
      ].join('\n'),
    };
  }

  const code = [
    "import pandas as pd",
    "",
    "# Assumes dataframe is loaded as df",
    "df = df.copy()",
    "",
    "# Normalize SEX terms to M/F when a sex column is present",
    sexColumn
      ? `if '${sexColumn}' in df.columns:\n    df['${sexColumn}'] = (df['${sexColumn}'].astype(str).str.strip().str.lower()\n                .replace({'male': 'm', 'female': 'f'}).str.upper())`
      : "# No sex column detected for normalization",
    "",
    "# Remove rows with missing critical fields",
    `critical_cols = [c for c in ${JSON.stringify(presentCriticalHeaders)} if c in df.columns]`,
    "if critical_cols:",
    "    df = df.dropna(subset=critical_cols)",
    "    for c in critical_cols:",
    "        df = df[df[c].astype(str).str.strip() != '']",
    "",
    "# Keep realistic age values",
    ageColumn
      ? `if '${ageColumn}' in df.columns:\n    df['${ageColumn}'] = pd.to_numeric(df['${ageColumn}'], errors='coerce')\n    df = df[(df['${ageColumn}'] >= 0) & (df['${ageColumn}'] <= 120)]`
      : "# No age column detected for plausibility check",
    "",
    "# Normalize date-like columns to YYYY-MM-DD",
    "for c in df.columns:",
    "    if 'DT' in c.upper() or 'DATE' in c.upper() or 'DTC' in c.upper():",
    "        dt = pd.to_datetime(df[c], errors='coerce', infer_datetime_format=True)",
    "        df[c] = dt.dt.strftime('%Y-%m-%d')",
    "",
    "# Output cleaned frame",
    "df",
  ].join('\n');

  return { explanation, code };
};

export const parseNaturalLanguageAnalysis = async (
  query: string,
  availableColumns: string[],
  studyType: string
): Promise<any | null> => {
  const prompt = `
  You are an expert Clinical Data Scientist.
  A non-technical stakeholder has asked a natural language question about a clinical dataset.
  Your job is to translate this question into the exact statistical parameters needed to run the analysis.

  AVAILABLE COLUMNS IN DATASET:
  ${availableColumns.join(', ')}

  STUDY TYPE: ${studyType} (If RCT, do not use PSM or covariates unless explicitly requested. If RWE, consider them if appropriate).

  USER QUESTION:
  "${query}"

  INSTRUCTIONS:
  1. Determine the most appropriate statistical test (e.g., T-Test, Chi-Square, ANOVA, Logistic Regression, Survival Analysis).
  2. Identify the primary grouping/independent variable (var1) from the available columns.
  3. Identify the primary outcome/dependent variable (var2) from the available columns.
  4. Identify any covariates mentioned (e.g., "adjusting for age and sex").
  5. Determine if Propensity Score Matching (PSM) is implied (e.g., "match patients", "balanced cohorts").
  6. Provide a brief, non-technical explanation of what analysis will be run.

  Return a JSON object matching this schema:
  {
    "testType": "T-Test" | "Chi-Square" | "ANOVA" | "Linear Regression" | "Correlation Analysis" | "Kaplan-Meier / Log-Rank" | "Cox Proportional Hazards",
    "var1": "exact_column_name",
    "var2": "exact_column_name",
    "covariates": ["col1", "col2"],
    "imputationMethod": "None" | "Mean/Mode Imputation" | "Multiple Imputation (MICE)" | "Last Observation Carried Forward (LOCF)",
    "applyPSM": boolean,
    "explanation": "Brief explanation of the chosen test and variables."
  }
  `;

  try {
    const response = await callAiModel({
      prompt,
      responseMimeType: 'application/json',
    });

    if (response.text) {
      return JSON.parse(response.text);
    }
    return null;
  } catch (error) {
    console.error("NL Parsing Error", error);
    return null;
  }
};

export const applyCleaning = async (file: ClinicalFile, code: string): Promise<string> => {
  try {
    const { headers, rows } = parseCsv(file.content);
    const { resolvedRequired } = resolveRequiredColumns(file, headers);
    const presentCriticalHeaders = resolvedRequired.filter((item) => item.actual).map((item) => item.actual as string);
    const ageColumn = resolvedRequired.find((item) => item.label === 'AGE')?.actual || matchHeaderByAlias(headers, ['AGE']);
    const sexColumn = resolvedRequired.find((item) => item.label === 'SEX')?.actual || matchHeaderByAlias(headers, ['SEX', 'GENDER']);
    const cleanedRows = rows
      .map((row) => {
        const next = { ...row };

        if (sexColumn && sexColumn in next) {
          next[sexColumn] = normalizeSex(next[sexColumn]);
        }

        Object.keys(next).forEach((col) => {
          const value = (next[col] || '').trim();
          if (!value) return;
          if (/(DATE|DT|DTC)/i.test(col) && !isIsoDate(value)) {
            const normalized = normalizeDate(value);
            next[col] = normalized || value;
          } else {
            next[col] = value;
          }
        });

        return next;
      })
      .filter((row) => {
        const required = presentCriticalHeaders.filter((h) => headers.includes(h));
        const hasAllRequired = required.every((col) => (row[col] || '').trim() !== '');
        if (!hasAllRequired) return false;

        if (ageColumn && ageColumn in row) {
          const age = toNumber(row[ageColumn]);
          if (age == null) return false;
          if (age < 0 || age > 120) return false;
          row[ageColumn] = String(age);
        }
        return true;
      });

    return stringifyCsv(headers, cleanedRows);
  } catch (e) {
    console.error('applyCleaning failed, returning original content.', e);
    return file.content || '';
  }
};

export const generateMappingSuggestion = async (columns: string[], targetDomain: string): Promise<MappingSpec> => {
    const prompt = `
    Map these source columns to CDISC SDTM domain '${targetDomain}'.
    Source Columns: ${columns.join(', ')}
    
    Return JSON: { "mappings": [{ "sourceCol": "...", "targetCol": "...", "transformation": "..." }] }
    `;
    
    const response = await callAiModel({
        prompt,
        responseMimeType: 'application/json'
    });

    if (response.text) {
        try {
            const parsed = JSON.parse(response.text);
            return { 
                id: 'temp', 
                sourceDomain: 'RAW', 
                targetDomain, 
                mappings: parsed.mappings 
            };
        } catch (e) {
            console.error("Failed to parse mapping suggestion JSON", e);
            return { id: '', sourceDomain: '', targetDomain: '', mappings: [] };
        }
    }
    return { id: '', sourceDomain: '', targetDomain: '', mappings: [] };
};

export const generateETLScript = async (file: ClinicalFile, spec: MappingSpec): Promise<string> => {
    const prompt = `
    Write a Python script to transform dataset '${file.name}' to SDTM domain '${spec.targetDomain}'.
    
    MAPPINGS:
    ${JSON.stringify(spec.mappings)}

    Requirements:
    1. Use pandas.
    2. Handle 1-to-1 mappings.
    3. Implement transformations described in 'transformation' field.
    4. Add comments.
    `;
    
    try {
      const response = await callAiModel({ prompt });
      return response.text ? response.text.replace(/```python/g, '').replace(/```/g, '') : "# Error";
    } catch (error) {
      console.error('ETL script generation error', error);
      const mappingLines = spec.mappings
        .map((m) => `# ${m.sourceCol} -> ${m.targetCol}${m.transformation ? ` (${m.transformation})` : ''}`)
        .join('\n');
      return [
        'import pandas as pd',
        '',
        '# Deterministic fallback script',
        `# Source: ${file.name}`,
        `# Target Domain: ${spec.targetDomain}`,
        mappingLines,
        '',
        "df = pd.read_csv('input.csv')",
        'out = pd.DataFrame()',
        ...spec.mappings.map((m) => `out['${m.targetCol}'] = df['${m.sourceCol}']`),
        "out.to_csv('output.csv', index=False)",
      ].join('\n');
    }
};

export const runTransformation = async (file: ClinicalFile, spec: MappingSpec, script: string): Promise<string> => {
  try {
    const { rows } = parseCsv(file.content);
    if (rows.length === 0) return '';

    const mappings = spec.mappings.filter((m) => m.sourceCol && m.targetCol);
    if (mappings.length === 0) return '';

    const outputHeaders = Array.from(new Set(mappings.map((m) => m.targetCol)));
    const transformedRows = rows.map((row) => {
      const out: Record<string, string> = {};
      mappings.forEach((mapping) => {
        const sourceValue = (row[mapping.sourceCol] || '').trim();
        out[mapping.targetCol] = applyMappingTransformation(sourceValue, mapping.transformation, row);
      });
      return out;
    });

    return stringifyCsv(outputHeaders, transformedRows);
  } catch (error) {
    console.error('runTransformation failed', error);
    return '';
  }
};

export const generateStatisticalSuggestions = async (file: ClinicalFile): Promise<StatSuggestion[]> => {
     const headers = (() => {
        try { return parseCsv(file.content).headers; } catch { return []; }
     })();
 
     const prompt = `
     Suggest 3 statistical tests relevant for this clinical dataset.
     Prefer only these exact test names:
     - ${StatTestType.T_TEST}
     - ${StatTestType.CHI_SQUARE}
     - ${StatTestType.ANOVA}
     - ${StatTestType.REGRESSION}
     - ${StatTestType.CORRELATION}
     - ${StatTestType.KAPLAN_MEIER}
     - ${StatTestType.COX_PH}
     DATA HEADER: ${headers.join(', ')}
     
     OUTPUT JSON:
     [{ "testType": "T-Test", "var1": "ARM", "var2": "AGE", "reason": "Compare age distribution..." }]
     `;
     
     try {
         const response = await callAiModel({
             prompt,
             responseMimeType: 'application/json'
         });
         if (response.text) {
             let text = response.text.replace(/```json/g, '').replace(/```/g, '').trim();
             let parsed = JSON.parse(text);
             if (!Array.isArray(parsed)) {
                 if (parsed.suggestions && Array.isArray(parsed.suggestions)) {
                     parsed = parsed.suggestions;
                 } else {
                     parsed = [parsed];
                 }
             }
             return parsed;
         }
     } catch (e: any) { 
         console.error("Failed to parse suggestions", e);
         if (e?.message?.includes("Model isn't available right now") || e?.message?.includes("503")) {
             throw new Error("AI Model is currently overloaded. Please try again in a few minutes.");
         }
         throw e;
     }
     return [];
};

export const generateBiasAudit = async (dmFile: ClinicalFile, indication: string, aeFile?: ClinicalFile): Promise<BiasReport | null> => {
    const prompt = `
    Perform a Bias & Fairness Audit on this clinical data.
    Indication: ${indication}
    Demographics Data:
    ${dmFile.content?.substring(0, 1000)}
    ${aeFile ? `AE Data: ${aeFile.content?.substring(0, 1000)}` : ''}

    Tasks:
    1. Check gender/race balance against real-world prevalence for ${indication}.
    2. Check for site-specific anomalies.
    3. Assign a Fairness Score (0-100).
    4. Determine Risk Level.

    OUTPUT JSON matching BiasReport interface.
    `;

    const schema = {
      type: JsonType.OBJECT,
      properties: {
        overallFairnessScore: { type: JsonType.NUMBER },
        riskLevel: { type: JsonType.STRING, description: "LOW, MEDIUM, or HIGH" },
        demographicAnalysis: {
          type: JsonType.ARRAY,
          items: {
            type: JsonType.OBJECT,
            properties: {
              category: { type: JsonType.STRING },
              score: { type: JsonType.NUMBER },
              status: { type: JsonType.STRING, description: "OPTIMAL, WARN, or CRITICAL" },
              finding: { type: JsonType.STRING }
            }
          }
        },
        siteAnomalies: {
          type: JsonType.ARRAY,
          items: {
            type: JsonType.OBJECT,
            properties: {
              siteId: { type: JsonType.STRING },
              issue: { type: JsonType.STRING },
              deviation: { type: JsonType.STRING }
            }
          }
        },
        recommendations: {
          type: JsonType.ARRAY,
          items: { type: JsonType.STRING }
        },
        narrativeAnalysis: { type: JsonType.STRING }
      }
    };

    try {
        const response = await callAiModel({
            prompt,
            responseMimeType: 'application/json',
            responseSchema: schema
        });
        if (response.text) {
            let text = response.text.replace(/```json/g, '').replace(/```/g, '').trim();
            return JSON.parse(text);
        }
    } catch (e) { console.error(e); }
    return null;
};

const normalizeTestType = (raw: string): StatTestType | null => {
  const value = raw.toLowerCase().trim();
  if (value.includes('kaplan') || value.includes('log-rank') || value.includes('log rank')) return StatTestType.KAPLAN_MEIER;
  if (value.includes('cox') || value.includes('hazard')) return StatTestType.COX_PH;
  if (value.includes('chi')) return StatTestType.CHI_SQUARE;
  if (value.includes('anova')) return StatTestType.ANOVA;
  if (value.includes('t-test') || value.includes('ttest')) return StatTestType.T_TEST;
  if (value.includes('regression')) return StatTestType.REGRESSION;
  if (value.includes('correlation') || value.includes('corr')) return StatTestType.CORRELATION;
  return null;
};

const inferGroupColumn = (headers: string[]): string | null => {
  const hints = ['arm', 'treatment', 'trt', 'group', 'cohort', 'sex', 'race', 'site'];
  for (const hint of hints) {
    const found = headers.find((h) => h.toLowerCase().includes(hint));
    if (found) return found;
  }
  return null;
};

const inferEventColumn = (headers: string[]): string | null => {
  const hints = ['aeterm', 'adverse', 'event', 'meddra', 'reaction', 'symptom', 'diagnosis'];
  for (const hint of hints) {
    const found = headers.find((h) => h.toLowerCase().includes(hint));
    if (found) return found;
  }
  return null;
};

const inferNumericColumns = (headers: string[], rows: Record<string, string>[]): string[] => {
  return headers.filter((h) => {
    const sample = rows.slice(0, 300);
    const numericCount = sample.filter((row) => toNumber(row[h]) != null).length;
    return numericCount >= Math.max(3, Math.floor(sample.length * 0.6));
  });
};

const inferTimeToEventColumn = (headers: string[], rows: Record<string, string>[]): string | null => {
  const numericColumns = headers.filter((header) => {
    const sample = rows.slice(0, 300);
    const nonEmpty = sample.map((row) => row[header]).filter((value) => value != null && value.trim() !== '');
    if (nonEmpty.length === 0) return false;
    const numericCount = nonEmpty.filter((value) => toNumber(value) != null).length;
    return numericCount >= Math.max(1, Math.floor(nonEmpty.length * 0.75));
  });
  const hints = ['aval', 'time', 'month', 'months', 'day', 'days', 'duration', 'tte', 'os', 'pfs'];
  for (const hint of hints) {
    const found = numericColumns.find((header) => header.toLowerCase().includes(hint));
    if (found) return found;
  }
  return numericColumns[0] || null;
};

const extractPlanFallback = (protocolText: string, sourceFile: ClinicalFile): { plan: AnalysisPlanEntry[]; notes: string[] } => {
  const notes: string[] = [];
  const { headers, rows } = parseCsv(sourceFile.content);
  const numericColumns = inferNumericColumns(headers, rows);
  const groupCol = inferGroupColumn(headers) || headers[0];
  const eventCol = inferEventColumn(headers);
  const timeToEventCol = inferTimeToEventColumn(headers, rows);
  const text = protocolText.toLowerCase();
  const plan: AnalysisPlanEntry[] = [];

  const addEntry = (
    name: string,
    testType: StatTestType,
    var1: string | undefined,
    var2: string | undefined,
    rationale: string
  ) => {
    if (!var1 || !var2) return;
    if (!headers.includes(var1) || !headers.includes(var2)) return;
    const key = `${testType}|${var1}|${var2}`;
    if (plan.some((p) => `${p.testType}|${p.var1}|${p.var2}` === key)) return;
    plan.push({
      id: crypto.randomUUID(),
      name,
      testType,
      var1,
      var2,
      rationale,
    });
  };

  if (/(chi[- ]?square|adverse event|incidence|proportion|event rate|risk)/i.test(text) && eventCol) {
    addEntry('Event incidence by treatment/group', StatTestType.CHI_SQUARE, groupCol, eventCol, 'Detected incidence/event-rate analysis language.');
  }
  if (/(t[- ]?test|two[- ]sample|mean difference)/i.test(text)) {
    addEntry('Two-group mean comparison', StatTestType.T_TEST, groupCol, numericColumns[0], 'Detected T-test or mean-difference language.');
  }
  if (/anova|analysis of variance/i.test(text)) {
    addEntry('Multi-group mean comparison', StatTestType.ANOVA, groupCol, numericColumns[0], 'Detected ANOVA language.');
  }
  if (/correlation|association between|pearson/i.test(text)) {
    addEntry('Correlation analysis', StatTestType.CORRELATION, numericColumns[0], numericColumns[1], 'Detected correlation language.');
  }
  if (/regression|predict|effect of|adjust(ed|ment)/i.test(text)) {
    addEntry('Regression analysis', StatTestType.REGRESSION, numericColumns[0] || groupCol, numericColumns[1] || numericColumns[0], 'Detected regression/predictive language.');
  }
  if (/(kaplan|log[- ]?rank|time[- ]to[- ]event|overall survival|progression[- ]free|pfs|os\b|survival)/i.test(text)) {
    addEntry('Kaplan-Meier / Log-Rank analysis', StatTestType.KAPLAN_MEIER, groupCol, timeToEventCol, 'Detected time-to-event / survival analysis language.');
  }
  if (/(cox|hazard ratio|proportional hazards)/i.test(text)) {
    addEntry('Cox proportional hazards model', StatTestType.COX_PH, groupCol, timeToEventCol, 'Detected hazard ratio / Cox model language.');
  }

  if (plan.length === 0) {
    if (groupCol && eventCol) {
      addEntry('Default cohort incidence analysis', StatTestType.CHI_SQUARE, groupCol, eventCol, 'Fallback default for clinical incidence questions.');
    } else if (groupCol && numericColumns.length > 0) {
      addEntry('Default group mean comparison', StatTestType.T_TEST, groupCol, numericColumns[0], 'Fallback default for grouped numeric endpoint.');
    } else if (numericColumns.length > 1) {
      addEntry('Default correlation analysis', StatTestType.CORRELATION, numericColumns[0], numericColumns[1], 'Fallback default for numeric columns.');
    }
  }

  if (plan.length === 0) {
    notes.push('No pre-specified analyses could be mapped to dataset columns automatically.');
  } else {
    notes.push(`Fallback parser extracted ${plan.length} pre-specified analysis item${plan.length > 1 ? 's' : ''}.`);
  }

  return { plan, notes };
};

export const extractPreSpecifiedAnalysisPlan = async (
  protocolFile: ClinicalFile,
  sourceFile: ClinicalFile
): Promise<{ plan: AnalysisPlanEntry[]; notes: string[] }> => {
  const protocolText = protocolFile.content || '';
  if (!protocolText.trim()) {
    return { plan: [], notes: ['Protocol/SAP document is empty.'] };
  }

  const { headers } = parseCsv(sourceFile.content);
  const fallback = extractPlanFallback(protocolText, sourceFile);

  const schema = {
    type: JsonType.OBJECT,
    properties: {
      plan: {
        type: JsonType.ARRAY,
        items: {
          type: JsonType.OBJECT,
          properties: {
            name: { type: JsonType.STRING },
            testType: { type: JsonType.STRING },
            var1: { type: JsonType.STRING },
            var2: { type: JsonType.STRING },
            covariates: { type: JsonType.ARRAY, items: { type: JsonType.STRING } },
            imputationMethod: { type: JsonType.STRING },
            applyPSM: { type: JsonType.BOOLEAN },
            rationale: { type: JsonType.STRING },
          },
          required: ['name', 'testType', 'var1', 'var2'],
        },
      },
      notes: { type: JsonType.ARRAY, items: { type: JsonType.STRING } },
    },
    required: ['plan'],
  };

  const prompt = `
Extract PRE-SPECIFIED statistical analyses from this Protocol/SAP text and map each to exact dataset columns.

Supported test types only:
- ${StatTestType.T_TEST}
- ${StatTestType.CHI_SQUARE}
- ${StatTestType.ANOVA}
- ${StatTestType.REGRESSION}
- ${StatTestType.CORRELATION}
- ${StatTestType.KAPLAN_MEIER}
- ${StatTestType.COX_PH}

Dataset columns (use exact names only):
${headers.join(', ')}

Protocol/SAP text:
${protocolText.substring(0, 18000)}
  `;

  try {
    const response = await callAiModel({
      prompt,
      responseMimeType: 'application/json',
      responseSchema: schema,
      temperature: 0.1,
    });

    if (!response.text) return fallback;
    const parsed = JSON.parse(response.text);
    const rawPlan = Array.isArray(parsed.plan) ? parsed.plan : [];

    const validated: AnalysisPlanEntry[] = rawPlan
      .map((item: any) => {
        const normalizedTest = normalizeTestType(String(item.testType || ''));
        if (!normalizedTest) return null;
        const var1 = String(item.var1 || '').trim();
        const var2 = String(item.var2 || '').trim();
        if (!headers.includes(var1) || !headers.includes(var2)) return null;
        const covariates = Array.isArray(item.covariates)
          ? item.covariates.map((c: any) => String(c).trim()).filter((c: string) => headers.includes(c))
          : [];
        return {
          id: crypto.randomUUID(),
          name: String(item.name || `${normalizedTest}: ${var1} vs ${var2}`),
          testType: normalizedTest,
          var1,
          var2,
          covariates,
          imputationMethod: item.imputationMethod ? String(item.imputationMethod) : undefined,
          applyPSM: typeof item.applyPSM === 'boolean' ? item.applyPSM : undefined,
          rationale: item.rationale ? String(item.rationale) : undefined,
        } as AnalysisPlanEntry;
      })
      .filter((item: AnalysisPlanEntry | null): item is AnalysisPlanEntry => item !== null);

    const deduped = validated.filter(
      (p, idx, arr) => arr.findIndex((x) => x.testType === p.testType && x.var1 === p.var1 && x.var2 === p.var2) === idx
    );

    if (deduped.length === 0) return fallback;
    return {
      plan: deduped,
      notes: Array.isArray(parsed.notes) ? parsed.notes : [`AI extracted ${deduped.length} pre-specified analyses.`],
    };
  } catch {
    return fallback;
  }
};

export const generateCohortSQL = async (file: ClinicalFile, filters: CohortFilter[]): Promise<string> => {
  const tableName = file.name.replace(/\.[^/.]+$/, "").replace(/[^a-zA-Z0-9_]/g, "_");
  const formatValue = (raw: string): string => {
    const numeric = Number(raw);
    if (!Number.isNaN(numeric) && raw.trim() !== '') return String(numeric);
    return `'${raw.replace(/'/g, "''")}'`;
  };

  const filterToSql = (filter: CohortFilter): string => {
    const field = `"${filter.field.replace(/"/g, '""')}"`;
    const value = formatValue(filter.value);
    switch (filter.operator) {
      case 'EQUALS':
        return `${field} = ${value}`;
      case 'NOT_EQUALS':
        return `${field} <> ${value}`;
      case 'GREATER_THAN':
        return `${field} > ${value}`;
      case 'LESS_THAN':
        return `${field} < ${value}`;
      case 'GREATER_OR_EQUAL':
        return `${field} >= ${value}`;
      case 'LESS_OR_EQUAL':
        return `${field} <= ${value}`;
      case 'CONTAINS':
        return `${field} ILIKE '%' || ${value} || '%'`;
      default:
        return '1=1';
    }
  };

  const whereClause = filters.length > 0 ? filters.map(filterToSql).join('\n  AND ') : '1=1';
  const logicLines =
    filters.length > 0
      ? filters.map((f, i) => `-- ${i + 1}. ${f.description || `${f.field} ${f.operator} ${f.value}`}`).join('\n')
      : '-- 1. No filters applied (entire source population).';

  return [
    '-- Cohort Extraction Query',
    '-- Purpose: Build deterministic RWE cohort from selected filters.',
    logicLines,
    `SELECT *`,
    `FROM "${tableName}"`,
    'WHERE',
    `  ${whereClause};`,
  ].join('\n');
};

const inferOperatorAndValue = (
  line: string
): { operator: CohortFilter['operator']; value: string } | null => {
  const trimmed = line.trim();

  let match = trimmed.match(/(?:>=|at least|greater than or equal to|min(?:imum)?\s*)(\d+(?:\.\d+)?)/i);
  if (match) return { operator: 'GREATER_OR_EQUAL', value: match[1] };

  match = trimmed.match(/(?:<=|at most|less than or equal to|max(?:imum)?\s*)(\d+(?:\.\d+)?)/i);
  if (match) return { operator: 'LESS_OR_EQUAL', value: match[1] };

  match = trimmed.match(/(?:>\s*|greater than\s+)(\d+(?:\.\d+)?)/i);
  if (match) return { operator: 'GREATER_THAN', value: match[1] };

  match = trimmed.match(/(?:<\s*|less than\s+)(\d+(?:\.\d+)?)/i);
  if (match) return { operator: 'LESS_THAN', value: match[1] };

  match = trimmed.match(/(?:=|equals?|is)\s*["']?([a-z0-9 ._/-]+)["']?/i);
  if (match) return { operator: 'EQUALS', value: match[1].trim() };

  match = trimmed.match(/(?:contains?|including|with)\s+["']?([a-z0-9 ._/-]+)["']?/i);
  if (match) return { operator: 'CONTAINS', value: match[1].trim() };

  return null;
};

const mapAliasesToColumns = (availableColumns: string[]): Record<string, string> => {
  const aliases: Record<string, string[]> = {
    age: ['age'],
    sex: ['sex', 'gender'],
    race: ['race', 'ethnicity'],
    arm: ['arm', 'treatment', 'trt', 'group', 'cohort'],
    site: ['site', 'siteid'],
    diagnosis: ['diagnosis', 'diag', 'condition', 'indication'],
    bmi: ['bmi'],
  };

  const mapped: Record<string, string> = {};
  Object.entries(aliases).forEach(([key, hints]) => {
    const found = availableColumns.find((col) => hints.some((hint) => col.toLowerCase().includes(hint)));
    if (found) mapped[key] = found;
  });
  return mapped;
};

const invertOperator = (operator: CohortFilter['operator']): CohortFilter['operator'] => {
  switch (operator) {
    case 'EQUALS':
      return 'NOT_EQUALS';
    case 'NOT_EQUALS':
      return 'EQUALS';
    case 'GREATER_THAN':
      return 'LESS_OR_EQUAL';
    case 'LESS_THAN':
      return 'GREATER_OR_EQUAL';
    case 'GREATER_OR_EQUAL':
      return 'LESS_THAN';
    case 'LESS_OR_EQUAL':
      return 'GREATER_THAN';
    case 'CONTAINS':
      return 'NOT_EQUALS';
    default:
      return operator;
  }
};

const extractProtocolFiltersFallback = (protocolText: string, availableColumns: string[]) => {
  const lines = protocolText
    .split(/\n+/)
    .map((l) => l.trim())
    .filter(Boolean)
    .slice(0, 250);

  const aliasMap = mapAliasesToColumns(availableColumns);
  const filters: CohortFilter[] = [];
  const notes: string[] = [];

  lines.forEach((line) => {
    const lower = line.toLowerCase();
    if (!/(inclusion|exclusion|criteria|eligible|exclude|include|must|age|sex|race|treatment|cohort|diagnosis)/i.test(lower)) {
      return;
    }

    const matchedField =
      Object.entries(aliasMap).find(([alias]) => lower.includes(alias))?.[1] ||
      availableColumns.find((col) => lower.includes(col.toLowerCase()));

    if (!matchedField) return;

    const parsed = inferOperatorAndValue(line);
    if (!parsed) return;

    const isExclusion = /(exclude|exclusion|not eligible|must not|without)/i.test(lower);
    const operator = isExclusion ? invertOperator(parsed.operator) : parsed.operator;

    filters.push({
      id: crypto.randomUUID(),
      field: matchedField,
      operator,
      value: parsed.value,
      description: `${isExclusion ? 'Exclusion' : 'Inclusion'}: ${line.slice(0, 120)}`,
    });
  });

  const deduped = filters.filter(
    (f, idx, arr) =>
      arr.findIndex((x) => x.field === f.field && x.operator === f.operator && x.value === f.value) === idx
  );

  if (deduped.length === 0) {
    notes.push('No structured criteria could be extracted automatically. Please add rules manually.');
  } else {
    notes.push(`Extracted ${deduped.length} criterion${deduped.length > 1 ? 'a' : ''} from protocol text.`);
  }

  return { filters: deduped, notes };
};

export const extractCohortFiltersFromProtocol = async (
  protocolFile: ClinicalFile,
  availableColumns: string[]
): Promise<{ filters: CohortFilter[]; notes: string[] }> => {
  const protocolText = protocolFile.content || '';
  if (!protocolText.trim()) {
    return { filters: [], notes: ['Protocol content is empty.'] };
  }

  const fallback = extractProtocolFiltersFallback(protocolText, availableColumns);

  const schema = {
    type: JsonType.OBJECT,
    properties: {
      filters: {
        type: JsonType.ARRAY,
        items: {
          type: JsonType.OBJECT,
          properties: {
            field: { type: JsonType.STRING },
            operator: { type: JsonType.STRING },
            value: { type: JsonType.STRING },
            description: { type: JsonType.STRING },
          },
          required: ['field', 'operator', 'value', 'description'],
        },
      },
      notes: { type: JsonType.ARRAY, items: { type: JsonType.STRING } },
    },
    required: ['filters'],
  };

  const prompt = `
Extract structured cohort eligibility filters from the protocol text.
Only use these dataset columns: ${availableColumns.join(', ')}.
Allowed operators: EQUALS, NOT_EQUALS, GREATER_THAN, LESS_THAN, GREATER_OR_EQUAL, LESS_OR_EQUAL, CONTAINS.

Protocol text:
${protocolText.substring(0, 15000)}
  `;

  try {
    const response = await callAiModel({
      prompt,
      responseMimeType: 'application/json',
      responseSchema: schema,
      temperature: 0.1,
    });

    if (!response.text) return fallback;
    const parsed = JSON.parse(response.text);
    const rawFilters = Array.isArray(parsed.filters) ? parsed.filters : [];

    const validated = rawFilters
      .filter((f: any) => availableColumns.includes(f.field))
      .filter((f: any) =>
        ['EQUALS', 'NOT_EQUALS', 'GREATER_THAN', 'LESS_THAN', 'GREATER_OR_EQUAL', 'LESS_OR_EQUAL', 'CONTAINS'].includes(
          f.operator
        )
      )
      .map((f: any) => ({
        id: crypto.randomUUID(),
        field: f.field,
        operator: f.operator as CohortFilter['operator'],
        value: String(f.value ?? '').trim(),
        description: String(f.description ?? '').trim() || 'Protocol-derived criterion',
      }))
      .filter((f: CohortFilter) => f.value.length > 0);

    if (validated.length === 0) return fallback;
    return {
      filters: validated,
      notes: Array.isArray(parsed.notes) ? parsed.notes : [`AI extracted ${validated.length} criteria.`],
    };
  } catch {
    return fallback;
  }
};
