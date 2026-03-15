import { describe, expect, it } from 'vitest';
import { ClinicalFile, DataType } from '../types';
import { inferDatasetProfile } from './datasetProfile';

const makeFile = (overrides: Partial<ClinicalFile>): ClinicalFile => ({
  id: crypto.randomUUID(),
  name: 'file.csv',
  type: DataType.RAW,
  uploadDate: new Date().toISOString(),
  size: '1 KB',
  content: 'A,B\n1,2',
  ...overrides,
});

describe('datasetProfile', () => {
  it('recognizes ADSL datasets', () => {
    const profile = inferDatasetProfile(
      makeFile({
        name: 'adsl.csv',
        type: DataType.STANDARDIZED,
        content: 'USUBJID,TRT01A,AGE,SEX,ITTFL\n01,DrugA,65,M,Y',
      })
    );

    expect(profile.kind).toBe('ADSL');
    expect(profile.model).toBe('ADAM');
  });

  it('recognizes ADLB datasets', () => {
    const profile = inferDatasetProfile(
      makeFile({
        name: 'adlb.csv',
        type: DataType.STANDARDIZED,
        content: 'USUBJID,PARAMCD,PARAM,AVAL,AVISIT\n01,HGB,Hemoglobin,13.1,Week 1',
      })
    );

    expect(profile.kind).toBe('ADLB');
    expect(profile.shortLabel).toBe('ADaM • ADLB');
  });

  it('recognizes ADTTE datasets', () => {
    const profile = inferDatasetProfile(
      makeFile({
        name: 'adtte.csv',
        type: DataType.STANDARDIZED,
        content: 'USUBJID,PARAMCD,PARAM,AVAL,CNSR\n01,OS,Overall Survival,12,0',
      })
    );

    expect(profile.kind).toBe('ADTTE');
    expect(profile.guidance).toMatch(/Kaplan-Meier\/log-rank/i);
  });
});
