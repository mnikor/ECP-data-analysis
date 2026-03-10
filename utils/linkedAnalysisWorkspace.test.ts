import { describe, expect, it } from 'vitest';
import { AnalysisSession, ClinicalFile, DataType, StatTestType, UsageMode } from '../types';
import {
  applyBenjaminiHochbergAdjustments,
  buildExploratorySignalTasks,
  buildLinkedAnalysisWorkspace,
} from './linkedAnalysisWorkspace';
import { parseCsv } from './dataProcessing';

const makeFile = (name: string, content: string): ClinicalFile => ({
  id: crypto.randomUUID(),
  name,
  type: DataType.RAW,
  uploadDate: new Date().toISOString(),
  size: '1 KB',
  content,
});

describe('linkedAnalysisWorkspace', () => {
  it('builds a subject-level workspace with derived cross-domain columns', () => {
    const dm = makeFile(
      'raw_demographics.csv',
      [
        'USUBJID,TRT_ARM,AGE,SEX',
        'S1,Arm A,60,F',
        'S2,Arm B,48,M',
      ].join('\n')
    );
    const ae = makeFile(
      'raw_adverse_events.csv',
      [
        'USUBJID,PT,SERIOUS,GRADE',
        'S1,Rash,Yes,2',
        'S1,Headache,No,1',
        'S2,Nausea,No,1',
      ].join('\n')
    );

    const workspace = buildLinkedAnalysisWorkspace(dm, [ae], ['rash', 'dermatitis']);
    const parsed = parseCsv(workspace.workspaceFile.content);

    expect(parsed.rows).toHaveLength(2);
    expect(parsed.headers).toContain('AGE');
    expect(parsed.headers).toContain('ADVERSE_EVENTS__RECORD_COUNT');
    expect(parsed.headers).toContain('ADVERSE_EVENTS__GRADE__MAX');
    expect(parsed.headers).toContain('ADVERSE_EVENTS__RASH_PRESENT');
    expect(parsed.rows.find((row) => row.USUBJID === 'S1')?.ADVERSE_EVENTS__RASH_PRESENT).toBe('Present');
    expect(parsed.rows.find((row) => row.USUBJID === 'S2')?.ADVERSE_EVENTS__RASH_PRESENT).toBe('Absent');
  });

  it('creates cross-domain exploratory tasks from linked workspace features', () => {
    const workspaceFile = makeFile(
      'workspace_demo.csv',
      [
        'USUBJID,TRT_ARM,AGE,SEX,ADVERSE_EVENTS__RASH_PRESENT,ADVERSE_EVENTS__RECORD_COUNT',
        'S1,Arm A,60,F,Present,2',
        'S2,Arm B,48,M,Absent,1',
        'S3,Arm A,54,F,Present,3',
        'S4,Arm B,50,M,Absent,0',
      ].join('\n')
    );

    const tasks = buildExploratorySignalTasks(workspaceFile, 4);

    expect(tasks.length).toBeGreaterThan(0);
    expect(
      tasks.some(
        (task) =>
          [task.var1, task.var2].includes('ADVERSE_EVENTS__RASH_PRESENT') &&
          [task.var1, task.var2].some((column) => ['AGE', 'SEX', 'TRT_ARM'].includes(column))
      )
    ).toBe(true);
  });

  it('adds adjusted p-values to exploratory sessions', () => {
    const baseSession = (id: string, pValue: string): AnalysisSession => ({
      id,
      timestamp: new Date().toISOString(),
      name: `Session ${id}`,
      usageMode: UsageMode.EXPLORATORY,
      params: {
        fileId: 'f1',
        fileName: 'workspace.csv',
        testType: StatTestType.CHI_SQUARE,
        var1: 'TRT_ARM',
        var2: 'RASH_PRESENT',
      },
      metrics: {
        test: 'Chi-Square',
        p_value: pValue,
      },
      interpretation: 'test',
      chartConfig: { data: [], layout: {} },
      executedCode: '# test',
    });

    const adjusted = applyBenjaminiHochbergAdjustments([
      baseSession('s1', '0.0100'),
      baseSession('s2', '0.0200'),
      baseSession('s3', '0.2000'),
    ]);

    expect(adjusted[0].metrics.adjusted_p_value).toBeDefined();
    expect(adjusted[0].metrics.multiple_testing_method).toBe('Benjamini-Hochberg FDR');
    expect(adjusted[0].params.autopilotAdjustedPValue).toBeDefined();
  });
});
