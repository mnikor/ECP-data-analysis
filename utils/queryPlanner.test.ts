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
});
