import { describe, expect, it } from 'vitest';
import { ClinicalFile, DataType, StatTestType } from '../types';
import { buildAutopilotAnalysisSuite } from './autopilotPlanner';

const dmFile: ClinicalFile = {
  id: 'dm1',
  name: 'dm.csv',
  type: DataType.RAW,
  uploadDate: new Date().toISOString(),
  size: '2 KB',
  content: [
    'USUBJID,TRT_ARM,AGE,SEX,RACE',
    '01,A,65,M,White',
    '02,A,61,F,Asian',
    '03,B,58,M,Black',
    '04,B,63,F,White',
  ].join('\n'),
};

const aeFile: ClinicalFile = {
  id: 'ae1',
  name: 'raw_adverse_events.csv',
  type: DataType.RAW,
  uploadDate: new Date().toISOString(),
  size: '4 KB',
  content: [
    'USUBJID,PT,GRADE,SERIOUS,RELATEDNESS,ACTION_TAKEN,OUTCOME',
    '01,Rash,1,0,Related,None,Recovered',
    '02,Nausea,2,1,Related,Dose reduced,Recovered',
    '03,Fatigue,3,1,Not Related,Dose interrupted,Not recovered',
    '04,Rash,2,0,Related,None,Recovered',
  ].join('\n'),
};

describe('autopilotPlanner', () => {
  it('builds useful demographic analyses without choosing identifier columns', () => {
    const tasks = buildAutopilotAnalysisSuite(dmFile);
    expect(tasks.length).toBeGreaterThan(1);
    expect(tasks.some((task) => task.var2 === 'AGE' && [StatTestType.T_TEST, StatTestType.ANOVA].includes(task.testType))).toBe(true);
    expect(tasks.some((task) => task.var2 === 'SEX' && task.testType === StatTestType.CHI_SQUARE)).toBe(true);
    expect(tasks.some((task) => task.var2 === 'USUBJID')).toBe(false);
  });

  it('builds multiple adverse-event analyses even without a treatment arm column', () => {
    const tasks = buildAutopilotAnalysisSuite(aeFile);
    expect(tasks.length).toBeGreaterThan(1);
    expect(tasks.some((task) => task.var1 === 'SERIOUS' && task.var2 === 'RELATEDNESS')).toBe(true);
    expect(tasks.some((task) => task.var1 === 'SERIOUS' && task.var2 === 'OUTCOME')).toBe(true);
    expect(tasks.some((task) => task.var1 === 'RELATEDNESS' && task.var2 === 'ACTION_TAKEN')).toBe(true);
  });
});
