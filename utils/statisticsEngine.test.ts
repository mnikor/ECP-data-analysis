import { describe, expect, it } from 'vitest';
import { AnalysisConcept, ClinicalFile, DataType, StatTestType } from '../types';
import { executeLocalStatisticalAnalysis } from './statisticsEngine';

const makeFile = (content: string): ClinicalFile => ({
  id: 'f1',
  name: 'dm.csv',
  type: DataType.RAW,
  uploadDate: new Date().toISOString(),
  size: '1 KB',
  content,
});

describe('statisticsEngine', () => {
  it('runs t-test deterministically on grouped numeric values', () => {
    const file = makeFile(
      [
        'ARM,AGE',
        'Placebo,40',
        'Placebo,42',
        'Placebo,39',
        'Active,55',
        'Active,58',
        'Active,56',
      ].join('\n')
    );

    const result = executeLocalStatisticalAnalysis(file, StatTestType.T_TEST, 'ARM', 'AGE');
    expect(result.metrics.test).toBe('T-Test');
    expect(result.metrics.n_group_a).toBe(3);
    expect(result.metrics.n_group_b).toBe(3);
    expect(result.chartConfig.data.length).toBeGreaterThanOrEqual(2);
    expect(result.tableConfig?.columns).toContain('group');
  });

  it('runs correlation on numeric pairs', () => {
    const file = makeFile(
      [
        'DOSE,RESPONSE',
        '1,2',
        '2,4',
        '3,6',
        '4,8',
      ].join('\n')
    );

    const result = executeLocalStatisticalAnalysis(file, StatTestType.CORRELATION, 'DOSE', 'RESPONSE');
    expect(result.metrics.test).toBe('Correlation');
    expect(result.metrics.n).toBe(4);
    expect(result.interpretation.length).toBeGreaterThan(10);
  });

  it('runs chi-square with synonym-based event concept', () => {
    const file = makeFile(
      [
        'ARM,AETERM',
        'Placebo,Headache',
        'Placebo,Dermatitis',
        'Active,Rash',
        'Active,Erythema',
        'Active,Nausea',
      ].join('\n')
    );

    const concept: AnalysisConcept = {
      label: 'rash',
      sourceColumn: 'AETERM',
      terms: ['rash', 'dermatitis', 'erythema'],
    };

    const result = executeLocalStatisticalAnalysis(file, StatTestType.CHI_SQUARE, 'ARM', 'AETERM', concept);
    expect(result.metrics.test).toBe('Chi-Square');
    expect(result.metrics.groups).toBe(2);
    expect(result.chartConfig.data[0].type).toBe('heatmap');
    expect(result.chartConfig.layout.title.text).toBe('Rash incidence by Treatment Arm');
    expect(result.chartConfig.layout.xaxis.title).toBeUndefined();
    expect(result.tableConfig?.rows.length).toBe(2);
  });

  it('accepts common chi-square label variants from AI outputs', () => {
    const file = makeFile(
      [
        'ARM,RELATEDNESS',
        'Placebo,Related',
        'Placebo,Not Related',
        'Active,Related',
        'Active,Not Related',
      ].join('\n')
    );

    const result = executeLocalStatisticalAnalysis(file, 'Chi-Square Test' as StatTestType, 'ARM', 'RELATEDNESS');
    expect(result.metrics.test).toBe('Chi-Square');
    expect(result.chartConfig.data[0].type).toBe('heatmap');
  });

  it('runs Kaplan-Meier / log-rank on ADTTE-style data', () => {
    const file = makeFile(
      [
        'USUBJID,TRT01A,PARAMCD,PARAM,AVAL,CNSR',
        '01,DrugA,OS,Overall Survival,12,0',
        '02,DrugA,OS,Overall Survival,14,0',
        '03,DrugA,OS,Overall Survival,16,1',
        '04,DrugA,OS,Overall Survival,18,0',
        '05,DrugB,OS,Overall Survival,5,0',
        '06,DrugB,OS,Overall Survival,7,0',
        '07,DrugB,OS,Overall Survival,8,1',
        '08,DrugB,OS,Overall Survival,9,0',
      ].join('\n')
    );

    const result = executeLocalStatisticalAnalysis(file, StatTestType.KAPLAN_MEIER, 'TRT01A', 'AVAL');
    expect(result.metrics.test).toBe('Kaplan-Meier / Log-Rank');
    expect(result.chartConfig.data[0].type).toBe('scatter');
    expect(result.chartConfig.layout.title.text).toBe('Kaplan-Meier: Overall Survival by Actual Treatment');
    expect(result.tableConfig?.columns).toContain('median_survival');
  });

  it('runs a simple Cox proportional hazards model on binary treatment groups', () => {
    const file = makeFile(
      [
        'USUBJID,TRT01A,PARAMCD,PARAM,AVAL,CNSR',
        '01,DrugA,OS,Overall Survival,5,0',
        '02,DrugA,OS,Overall Survival,7,0',
        '03,DrugA,OS,Overall Survival,9,1',
        '04,DrugA,OS,Overall Survival,12,0',
        '05,DrugA,OS,Overall Survival,15,1',
        '06,DrugB,OS,Overall Survival,6,0',
        '07,DrugB,OS,Overall Survival,8,1',
        '08,DrugB,OS,Overall Survival,10,0',
        '09,DrugB,OS,Overall Survival,14,0',
        '10,DrugB,OS,Overall Survival,16,1',
      ].join('\n')
    );

    const result = executeLocalStatisticalAnalysis(file, StatTestType.COX_PH, 'TRT01A', 'AVAL');
    expect(result.metrics.test).toBe('Cox Proportional Hazards');
    expect(Number(result.metrics.hazard_ratio)).toBeGreaterThan(0);
    expect(result.chartConfig.layout.title.text).toBe('Cox model: Overall Survival');
    expect(result.tableConfig?.columns).toContain('hazard_ratio');
  });
});
