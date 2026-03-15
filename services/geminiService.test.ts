import { describe, expect, it } from 'vitest';
import { ClinicalFile, DataType, QCIssue, StatTestType } from '../types';
import {
  buildChatContextText,
  buildTabularChatContext,
  executeStatisticalCode,
  extractCohortFiltersFromProtocol,
  extractPreSpecifiedAnalysisPlan,
  generateAnalysis,
  generateCleaningSuggestion,
  runQualityCheck,
} from './geminiService';

const protocolFile: ClinicalFile = {
  id: 'p1',
  name: 'Protocol.txt',
  type: DataType.DOCUMENT,
  uploadDate: new Date().toISOString(),
  size: '1 KB',
  content: [
    'Inclusion Criteria:',
    '- Age >= 18 years',
    '- Sex = Female',
    'Exclusion Criteria:',
    '- Exclude Age < 18',
  ].join('\n'),
};

const sourceFile: ClinicalFile = {
  id: 's1',
  name: 'analysis.csv',
  type: DataType.RAW,
  uploadDate: new Date().toISOString(),
  size: '1 KB',
  content: [
    'ARM,AETERM,AGE,CHG_SCORE',
    'Placebo,Headache,45,1.2',
    'Active,Rash,52,3.5',
    'Active,Dermatitis,49,2.8',
  ].join('\n'),
};

describe('extractCohortFiltersFromProtocol', () => {
  it('extracts filters from protocol text using fallback parser', async () => {
    const originalKey = process.env.GEMINI_API_KEY;
    process.env.GEMINI_API_KEY = '';
    try {
      const { filters } = await extractCohortFiltersFromProtocol(protocolFile, ['AGE', 'SEX', 'ARM']);
      const ageFilters = filters.filter((f) => f.field === 'AGE');
      const sexFilters = filters.filter((f) => f.field === 'SEX');

      expect(ageFilters.length).toBeGreaterThan(0);
      expect(sexFilters.length).toBeGreaterThan(0);
      expect(sexFilters.some((f) => f.operator === 'EQUALS' && f.value.toLowerCase().includes('female'))).toBe(true);
    } finally {
      process.env.GEMINI_API_KEY = originalKey;
    }
  });
});

describe('extractPreSpecifiedAnalysisPlan', () => {
  it('extracts at least one mapped pre-specified analysis with fallback path', async () => {
    const originalKey = process.env.GEMINI_API_KEY;
    process.env.GEMINI_API_KEY = '';
    try {
      const { plan } = await extractPreSpecifiedAnalysisPlan(
        {
          ...protocolFile,
          content: [
            'Statistical Analysis Plan',
            'Primary analysis: Compare adverse event incidence by treatment arm using chi-square test.',
            'Secondary analysis: compare CHG_SCORE by treatment arm using t-test.',
          ].join('\n'),
        },
        sourceFile
      );

      expect(plan.length).toBeGreaterThan(0);
      expect(plan.some((p) => p.var1 === 'ARM')).toBe(true);
    } finally {
      process.env.GEMINI_API_KEY = originalKey;
    }
  });
});

describe('executeStatisticalCode', () => {
  it('throws a readable execution error for invalid statistical setup', async () => {
    const badFile: ClinicalFile = {
      id: 'bad',
      name: 'bad.csv',
      type: DataType.RAW,
      uploadDate: new Date().toISOString(),
      size: '1 KB',
      content: [
        'ARM,CHG_SCORE',
        'Active,1.2',
        'Active,2.0',
        'Active,1.8',
      ].join('\n'),
    };

    await expect(
      executeStatisticalCode('print("run")', badFile, StatTestType.T_TEST, 'ARM', 'CHG_SCORE')
    ).rejects.toThrow('T-Test requires exactly two groups');
  });
});

describe('generateAnalysis', () => {
  it('runs deterministic exploratory analysis in chat for a single selected tabular dataset', async () => {
    const response = await generateAnalysis(
      'Compare age by arm and show the distribution',
      [
        {
          id: 'chat_dm',
          name: 'dm.csv',
          type: DataType.RAW,
          uploadDate: new Date().toISOString(),
          size: '1 KB',
          content: [
            'ARM,AGE',
            'Placebo,61',
            'Placebo,59',
            'Active,66',
            'Active,70',
          ].join('\n'),
        },
      ],
      'RAG',
      []
    );

    expect(response.answer).toMatch(/Exploratory analysis executed/i);
    expect(response.chartConfig).toBeTruthy();
    expect(response.tableConfig).toBeTruthy();
    expect(response.keyInsights?.[0]).toMatch(/deterministic exploratory/i);
  });

  it('runs Kaplan-Meier exploratory analysis in chat when an ADTTE dataset is selected', async () => {
    const response = await generateAnalysis(
      'Compare overall survival between treatment arms',
      [
        {
          id: 'chat_adtte',
          name: 'adtte.csv',
          type: DataType.STANDARDIZED,
          uploadDate: new Date().toISOString(),
          size: '1 KB',
          content: [
            'USUBJID,TRT01A,PARAMCD,PARAM,AVAL,CNSR',
            '01,DrugA,OS,Overall Survival,10,0',
            '02,DrugA,OS,Overall Survival,12,1',
            '03,DrugB,OS,Overall Survival,8,0',
            '04,DrugB,OS,Overall Survival,14,1',
          ].join('\n'),
        },
      ],
      'RAG',
      []
    );

    expect(response.answer).toMatch(/Kaplan-Meier/i);
    expect(response.chartConfig?.layout?.title?.text).toMatch(/Kaplan-Meier/i);
    expect(response.tableConfig?.columns).toContain('median_survival');
  });
});

describe('chat context building', () => {
  it('summarizes full tabular survival context instead of using a short fragment', () => {
    const context = buildTabularChatContext({
      id: 'chat_survival_context',
      name: 'adtte.csv',
      type: DataType.STANDARDIZED,
      uploadDate: new Date().toISOString(),
      size: '1 KB',
      content: [
        'USUBJID,TRT01A,PARAMCD,PARAM,AVAL,CNSR',
        '01,DrugA,OS,Overall Survival,10,0',
        '02,DrugA,OS,Overall Survival,12,1',
        '03,DrugB,OS,Overall Survival,8,0',
        '04,DrugB,OS,Overall Survival,14,1',
      ].join('\n'),
    });

    expect(context).toContain('Rows: 4');
    expect(context).toContain('Unique subjects (USUBJID): 4');
    expect(context).toContain('Treatment/group summary: TRT01A: DrugA (2), DrugB (2)');
    expect(context).toContain('Candidate time endpoint summary: AVAL: n=4');
    expect(context).toContain('Candidate censor/event summary: CNSR: 0 (2), 1 (2)');
    expect(context).toContain('Use these full-dataset counts and summaries');
  });

  it('uses structured tabular summaries in RAG mode instead of first-row fragments', () => {
    const context = buildChatContextText(
      [
        {
          id: 'chat_dm_context',
          name: 'dm.csv',
          type: DataType.STANDARDIZED,
          uploadDate: new Date().toISOString(),
          size: '1 KB',
          content: [
            'USUBJID,TRT01A,AGE,SEX',
            '01,DrugA,60,M',
            '02,DrugA,61,F',
            '03,DrugB,58,M',
            '04,DrugB,57,F',
          ].join('\n'),
        },
        protocolFile,
      ],
      'RAG'
    );

    expect(context).toContain('RETRIEVED CONTEXT:');
    expect(context).toContain('TABULAR DATASET PROFILE');
    expect(context).toContain('Rows: 4');
    expect(context).toContain('[Source: Protocol.txt]:');
    expect(context).not.toContain('RETRIEVED FRAGMENTS:');
  });
});

describe('runQualityCheck', () => {
  it('does not create row-level missing-critical-values issue when required columns are absent', async () => {
    const file: ClinicalFile = {
      id: 'qc1',
      name: 'no_required_columns.csv',
      type: DataType.RAW,
      uploadDate: new Date().toISOString(),
      size: '1 KB',
      content: [
        'ARM,AETERM',
        'Placebo,Headache',
        'Active,Rash',
      ].join('\n'),
    };

    const result = await runQualityCheck(file);
    const missingColumnIssue = result.issues.find((i) => /Missing critical columns/i.test(i.description));
    const missingValueIssue = result.issues.find((i) => /Missing critical values/i.test(i.description));

    expect(result.status).toBe('FAIL');
    expect(missingColumnIssue).toBeTruthy();
    expect(missingColumnIssue?.autoFixable).toBe(false);
    expect(missingValueIssue).toBeUndefined();
  });

  it('accepts source-style exposure headers without requiring treatment arm', async () => {
    const file: ClinicalFile = {
      id: 'qc_ex',
      name: 'raw_exposure.csv',
      type: DataType.RAW,
      uploadDate: new Date().toISOString(),
      size: '1 KB',
      content: [
        'STUDYID,USUBJID,CYCLE,THERAPY_CLASS,DRUG,DOSE,DOSEU,EXSTDTC,ROUTE,ADMIN_STATUS',
        'LC-RAW-001,LC-RAW-001-0001,C1,Chemotherapy,Carboplatin,500,mg,2024-05-04,IV,Completed',
      ].join('\n'),
    };

    const result = await runQualityCheck(file);
    const missingColumnIssue = result.issues.find((i) => /Missing critical columns/i.test(i.description));

    expect(result.status).toBe('PASS');
    expect(missingColumnIssue).toBeUndefined();
  });

  it('accepts concomitant medication datasets that use DRUG and CMSTDTC headers', async () => {
    const file: ClinicalFile = {
      id: 'qc_cm',
      name: 'raw_concomitant_meds.csv',
      type: DataType.RAW,
      uploadDate: new Date().toISOString(),
      size: '1 KB',
      content: [
        'STUDYID,USUBJID,CMID,THERAPY_CLASS,DRUG,CMSTDTC,CMENDTC,ROUTE',
        'LC-RAW-001,LC-RAW-001-0001,CM-001,Supportive,Ondansetron,2024-05-04,2024-05-06,PO',
      ].join('\n'),
    };

    const result = await runQualityCheck(file);
    const missingColumnIssue = result.issues.find((i) => /Missing critical columns/i.test(i.description));

    expect(result.status).toBe('PASS');
    expect(missingColumnIssue).toBeUndefined();
  });

  it('accepts tumor assessment datasets that use ASSTDT as assessment date', async () => {
    const file: ClinicalFile = {
      id: 'qc_tu',
      name: 'raw_tumor_assessments_recist.csv',
      type: DataType.RAW,
      uploadDate: new Date().toISOString(),
      size: '1 KB',
      content: [
        'STUDYID,USUBJID,ASSTDT,DY,BASE_SUMDIAM_MM,SUMDIAM_MM,RESPONSE',
        'LC-RAW-001,LC-RAW-001-0001,2024-06-01,1,52,48,PR',
      ].join('\n'),
    };

    const result = await runQualityCheck(file);
    const missingColumnIssue = result.issues.find((i) => /Missing critical columns/i.test(i.description));

    expect(result.status).toBe('PASS');
    expect(missingColumnIssue).toBeUndefined();
  });

  it('accepts source-style labs datasets that use TEST and TESTCD headers', async () => {
    const file: ClinicalFile = {
      id: 'qc_lb',
      name: 'raw_labs.csv',
      type: DataType.RAW,
      uploadDate: new Date().toISOString(),
      size: '1 KB',
      content: [
        'STUDYID,USUBJID,VISIT,LBDTC,TESTCD,TEST,RESULT,UNIT,REFLOW,REFHIGH,FLAG',
        'LC-RAW-001,LC-RAW-001-0001,SCREEN,2024-04-09,HGB,Hemoglobin,14.7,g/dL,10.5,16.5,NORMAL',
      ].join('\n'),
    };

    const result = await runQualityCheck(file);
    const missingColumnIssue = result.issues.find((i) => /Missing critical columns/i.test(i.description));

    expect(result.status).toBe('PASS');
    expect(missingColumnIssue).toBeUndefined();
  });

  it('recognizes ADSL as an ADaM subject-level dataset without failing generic raw checks', async () => {
    const file: ClinicalFile = {
      id: 'qc_adsl',
      name: 'adsl.csv',
      type: DataType.STANDARDIZED,
      uploadDate: new Date().toISOString(),
      size: '1 KB',
      content: [
        'USUBJID,TRT01A,AGE,SEX,ITTFL',
        '01,DrugA,65,M,Y',
        '02,DrugB,59,F,Y',
      ].join('\n'),
    };

    const result = await runQualityCheck(file);

    expect(result.status).toBe('PASS');
    expect(result.issues).toHaveLength(0);
  });

  it('warns when ADLB contains multiple parameters without an analysis flag', async () => {
    const file: ClinicalFile = {
      id: 'qc_adlb',
      name: 'adlb.csv',
      type: DataType.STANDARDIZED,
      uploadDate: new Date().toISOString(),
      size: '1 KB',
      content: [
        'USUBJID,TRT01A,PARAMCD,PARAM,AVAL,AVISIT',
        '01,DrugA,HGB,Hemoglobin,13.1,Week 1',
        '01,DrugA,ALT,Alanine Aminotransferase,32.4,Week 1',
      ].join('\n'),
    };

    const result = await runQualityCheck(file);
    expect(result.status).toBe('WARN');
    expect(result.issues.some((issue) => /analysis parameters|multiple parameters/i.test(issue.description))).toBe(true);
  });

  it('warns that ADTTE needs censoring and population review before survival interpretation', async () => {
    const file: ClinicalFile = {
      id: 'qc_adtte',
      name: 'adtte.csv',
      type: DataType.STANDARDIZED,
      uploadDate: new Date().toISOString(),
      size: '1 KB',
      content: [
        'USUBJID,TRT01A,PARAMCD,PARAM,AVAL,CNSR',
        '01,DrugA,OS,Overall Survival,12,0',
        '02,DrugB,OS,Overall Survival,10,1',
      ].join('\n'),
    };

    const result = await runQualityCheck(file);
    expect(result.status).toBe('WARN');
    expect(result.issues.some((issue) => /censoring semantics|Kaplan-Meier|Cox/i.test(issue.description))).toBe(true);
  });
});

describe('generateCleaningSuggestion', () => {
  it('returns manual-remediation guidance when selected issues are not auto-fixable', async () => {
    const file: ClinicalFile = {
      id: 'qc2',
      name: 'raw.csv',
      type: DataType.RAW,
      uploadDate: new Date().toISOString(),
      size: '1 KB',
      content: 'ARM,AETERM\nPlacebo,Headache',
    };
    const issues: QCIssue[] = [
      {
        severity: 'HIGH',
        description: 'Missing critical columns: SUBJID, AGE, SEX',
        autoFixable: false,
      },
    ];

    const plan = await generateCleaningSuggestion(file, issues);
    expect(plan.code).toContain('No automatic cleaning was generated');
    expect(plan.explanation).toContain('require manual remediation');
  });
});
