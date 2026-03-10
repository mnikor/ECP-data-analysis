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
});
