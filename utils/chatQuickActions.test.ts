import { describe, expect, it } from 'vitest';
import { ClinicalFile, DataType } from '../types';
import { buildChatQuickActions } from './chatQuickActions';

const makeFile = (overrides: Partial<ClinicalFile>): ClinicalFile => ({
  id: crypto.randomUUID(),
  name: 'file.csv',
  type: DataType.RAW,
  uploadDate: new Date().toISOString(),
  size: '1 KB',
  content: 'A,B\n1,2',
  ...overrides,
});

describe('chatQuickActions', () => {
  it('returns onboarding guidance when no files are selected', () => {
    const actions = buildChatQuickActions([], []);
    expect(actions[0].label).toBe('How should I start?');
  });

  it('returns safety and linked prompts for adverse event plus exposure context', () => {
    const ae = makeFile({
      name: 'raw_adverse_events.csv',
      content: 'USUBJID,SERIOUS,RELATEDNESS,PT\n01,N,Related,Rash',
    });
    const exposure = makeFile({
      name: 'raw_exposure.csv',
      content: 'USUBJID,DRUG,DOSE,EXSTDTC\n01,DrugA,50,2025-01-01',
    });

    const actions = buildChatQuickActions([ae, exposure], [ae, exposure]);
    expect(actions.map((action) => action.id)).toContain('safety');
    expect(actions.map((action) => action.id)).toContain('linked');
  });

  it('returns protocol-aware prompt when a document is selected', () => {
    const protocol = makeFile({
      name: 'Protocol.pdf',
      type: DataType.DOCUMENT,
      content: undefined,
    });
    const dm = makeFile({
      name: 'raw_demographics.csv',
      content: 'USUBJID,AGE,SEX,RACE\n01,65,M,White',
    });

    const actions = buildChatQuickActions([protocol, dm], [protocol, dm]);
    expect(actions.map((action) => action.id)).toContain('protocol');
  });

  it('returns ADaM-aware prompts for ADSL and ADTTE datasets', () => {
    const adsl = makeFile({
      name: 'adsl.csv',
      type: DataType.STANDARDIZED,
      content: 'USUBJID,TRT01A,AGE,SEX,ITTFL\n01,DrugA,65,M,Y',
    });
    const adtte = makeFile({
      name: 'adtte.csv',
      type: DataType.STANDARDIZED,
      content: 'USUBJID,PARAMCD,PARAM,AVAL,CNSR,TRT01A\n01,OS,Overall Survival,12,0,DrugA',
    });

    const actions = buildChatQuickActions([adsl, adtte], [adsl, adtte]);
    expect(actions.map((action) => action.id)).toContain('analysis-set');
    expect(actions.map((action) => action.id)).toContain('time-to-event');
  });
});
