import { describe, expect, it } from 'vitest';
import { ClinicalFile, DataType, StatTestType } from '../types';
import { planAnalysisFromQuestion } from './queryPlanner';

const file: ClinicalFile = {
  id: 'f1',
  name: 'ae.csv',
  type: DataType.RAW,
  uploadDate: new Date().toISOString(),
  size: '1 KB',
  content: [
    'SUBJID,ARM,AETERM,AGE',
    '001,Placebo,Headache,45',
    '002,Active,Dermatitis,52',
    '003,Active,Erythema,49',
    '004,Placebo,Nausea,38',
  ].join('\n'),
};

describe('queryPlanner', () => {
  it('maps rash query to chi-square with concept synonyms', () => {
    const plan = planAnalysisFromQuestion(
      file,
      'Compare skin rash incidence between treatment arms',
      ['maculopapular rash']
    );

    expect(plan.testType).toBe(StatTestType.CHI_SQUARE);
    expect(plan.var1).toBe('ARM');
    expect(plan.concept?.sourceColumn).toBe('AETERM');
    expect(plan.concept?.terms).toContain('dermatitis');
    expect(plan.concept?.terms).toContain('maculopapular rash');
  });

  it('maps ADTTE survival questions to Kaplan-Meier / log-rank', () => {
    const adtteFile: ClinicalFile = {
      id: 'adtte1',
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

    const plan = planAnalysisFromQuestion(adtteFile, 'Compare overall survival between treatment arms');
    expect(plan.testType).toBe(StatTestType.KAPLAN_MEIER);
    expect(plan.var1).toBe('TRT01A');
    expect(plan.var2).toBe('AVAL');
  });

  it('maps hazard-ratio language on ADTTE to Cox proportional hazards', () => {
    const adtteFile: ClinicalFile = {
      id: 'adtte2',
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

    const plan = planAnalysisFromQuestion(adtteFile, 'Estimate the hazard ratio for overall survival by treatment');
    expect(plan.testType).toBe(StatTestType.COX_PH);
    expect(plan.var1).toBe('TRT01A');
    expect(plan.var2).toBe('AVAL');
  });

  it('avoids pooled numeric inference on multi-parameter ADLB datasets', () => {
    const adlbFile: ClinicalFile = {
      id: 'adlb1',
      name: 'adlb.csv',
      type: DataType.STANDARDIZED,
      uploadDate: new Date().toISOString(),
      size: '1 KB',
      content: [
        'USUBJID,TRT01A,PARAMCD,PARAM,AVAL',
        '01,DrugA,HGB,Hemoglobin,13.1',
        '01,DrugA,ALT,Alanine Aminotransferase,32.4',
        '02,DrugB,HGB,Hemoglobin,12.8',
        '02,DrugB,ALT,Alanine Aminotransferase,28.5',
      ].join('\n'),
    };

    const plan = planAnalysisFromQuestion(adlbFile, 'Compare lab results between treatment arms');
    expect(plan.testType).toBe(StatTestType.CHI_SQUARE);
    expect(plan.var1).toBe('TRT01A');
    expect(plan.var2).toBe('PARAMCD');
    expect(plan.explanation).toMatch(/multiple parameters/i);
  });
});
