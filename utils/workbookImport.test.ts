import { describe, expect, it } from 'vitest';
import { DataType } from '../types';
import { buildWorkbookSheetPreviews, planWorkbookImport } from './workbookImport';
import { parseCsv } from './dataProcessing';

describe('workbookImport', () => {
  const sheets = buildWorkbookSheetPreviews([
    {
      sheetName: 'Demographics',
      csvContent: 'USUBJID,AGE,SEX\n01,65,M\n02,72,F',
    },
    {
      sheetName: '1st line therapy',
      csvContent: 'USUBJID,DRUG,DOSE,START_DATE\n01,Carboplatin,500,2024-01-01\n02,Pemetrexed,800,2024-01-03',
    },
    {
      sheetName: '2nd line therapy',
      csvContent: 'USUBJID,DRUG,DOSE,START_DATE\n01,Docetaxel,75,2024-06-01\n02,Gemcitabine,1000,2024-06-04',
    },
  ]);

  it('builds sheet previews with inferred domain and keys', () => {
    expect(sheets).toHaveLength(3);
    expect(sheets[0].domainHint).toBe('Demographics');
    expect(sheets[1].domainHint).toBe('Treatment History');
    expect(sheets[1].lineOfTherapy).toBe('1L');
    expect(sheets[2].lineOfTherapy).toBe('2L');
    expect(sheets[0].keyColumns).toContain('USUBJID');
  });

  it('imports sheets separately when requested', () => {
    const plan = planWorkbookImport(
      'rwe_workbook.xlsx',
      sheets,
      sheets.map((sheet) => sheet.id),
      'SEPARATE',
      DataType.RAW
    );

    expect(plan.outputCount).toBe(3);
    expect(plan.outputs.map((output) => output.name)).toEqual([
      'rwe_workbook__demographics.csv',
      'rwe_workbook__1st_line_therapy.csv',
      'rwe_workbook__2nd_line_therapy.csv',
    ]);
  });

  it('merges similar treatment tabs and adds source metadata columns', () => {
    const plan = planWorkbookImport(
      'rwe_workbook.xlsx',
      sheets,
      sheets.map((sheet) => sheet.id),
      'MERGE_SIMILAR',
      DataType.RAW
    );

    expect(plan.outputCount).toBe(2);

    const mergedTreatment = plan.outputs.find((output) => output.sourceSheetNames.length === 2);
    expect(mergedTreatment).toBeDefined();
    expect(mergedTreatment?.name).toBe('rwe_workbook__treatment_history.csv');

    const parsed = parseCsv(mergedTreatment?.content);
    expect(parsed.headers).toContain('SOURCE_SHEET');
    expect(parsed.headers).toContain('LINE_OF_THERAPY');
    expect(parsed.rows[0].SOURCE_SHEET).toBe('1st line therapy');
    expect(parsed.rows[0].LINE_OF_THERAPY).toBe('1L');
    expect(parsed.rows[2].SOURCE_SHEET).toBe('2nd line therapy');
    expect(parsed.rows[2].LINE_OF_THERAPY).toBe('2L');
  });
});
