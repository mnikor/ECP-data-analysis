import { ClinicalFile, MappingSpec } from '../types';
import { parseCsv } from './dataProcessing';

export interface ParsedReferenceMapping {
  sourceDomain: string;
  targetDomain: string;
  mappings: MappingSpec['mappings'];
  mode: 'MAPPED' | 'IDENTITY';
  sourceHeader?: string;
  targetHeader?: string;
}

export const parseReferenceMapping = (file: ClinicalFile): ParsedReferenceMapping | null => {
  if (!file.content) return null;

  try {
    const parsed = JSON.parse(file.content);
    const candidateMappings = Array.isArray(parsed) ? parsed : parsed?.mappings;
    if (Array.isArray(candidateMappings)) {
      const mappings = candidateMappings
        .map((m: any) => ({
          sourceCol: String(m.sourceCol ?? m.source ?? '').trim(),
          targetCol: String(m.targetCol ?? m.target ?? '').trim(),
          transformation: m.transformation ? String(m.transformation) : '',
        }))
        .filter((m: any) => m.sourceCol && m.targetCol);

      if (mappings.length > 0) {
        return {
          sourceDomain: String(parsed?.sourceDomain ?? parsed?.source ?? file.name.split('.')[0].toUpperCase()),
          targetDomain: String(parsed?.targetDomain ?? parsed?.target ?? 'DM'),
          mappings,
          mode: 'MAPPED',
        };
      }
    }
  } catch {
    // Continue to CSV parser fallback.
  }

  try {
    const { headers, rows } = parseCsv(file.content);
    const normalizeHeader = (h: string) => h.toLowerCase().replace(/[^a-z0-9]/g, '');
    const normalizedHeaders = headers.map((h) => ({ raw: h, norm: normalizeHeader(h) }));
    const findHeaderIndex = (patterns: string[]) =>
      normalizedHeaders.findIndex(({ norm }) => patterns.some((pattern) => norm.includes(pattern)));

    const sourceIdx = findHeaderIndex([
      'sourcecolumn',
      'sourcecol',
      'sourcefield',
      'rawcolumn',
      'rawcol',
      'inputcolumn',
      'inputcol',
      'srccolumn',
      'srccol',
      'fromcolumn',
      'fromcol',
      'source',
      'raw',
      'variable',
      'varname',
      'columnname',
      'column',
      'fieldname',
      'field',
    ]);

    const targetIdx = findHeaderIndex([
      'targetcolumn',
      'targetcol',
      'targetfield',
      'mappedcolumn',
      'mappedcol',
      'mappedto',
      'stdcolumn',
      'standardcolumn',
      'outputcolumn',
      'outputcol',
      'destinationcolumn',
      'destcolumn',
      'sdtm',
      'cdisc',
      'target',
    ]);

    const txIdx = findHeaderIndex(['transformation', 'transform', 'rule', 'logic', 'derivation', 'formula']);

    if (sourceIdx < 0) return null;

    const sourceHeader = headers[sourceIdx];
    const targetHeader = targetIdx >= 0 ? headers[targetIdx] : '';
    const txHeader = txIdx >= 0 ? headers[txIdx] : '';

    const baseRows = rows.map((row) => ({
      sourceCol: String(row[sourceHeader] ?? '').trim(),
      targetCol: targetHeader ? String(row[targetHeader] ?? '').trim() : '',
      transformation: txHeader ? String(row[txHeader] ?? '').trim() : '',
    }));

    const mappings = baseRows.filter((m) => m.sourceCol && m.targetCol);

    if (mappings.length > 0) {
      return {
        sourceDomain: file.name.split('.')[0].toUpperCase(),
        targetDomain: 'DM',
        mappings,
        mode: 'MAPPED',
        sourceHeader,
        targetHeader,
      };
    }

    if (!targetHeader) {
      const identityMappings = Array.from(
        new Map(
          baseRows
            .filter((m) => m.sourceCol)
            .map((m) => [m.sourceCol, { sourceCol: m.sourceCol, targetCol: m.sourceCol, transformation: '' }])
        ).values()
      );

      if (identityMappings.length > 0) {
        return {
          sourceDomain: file.name.split('.')[0].toUpperCase(),
          targetDomain: 'DM',
          mappings: identityMappings,
          mode: 'IDENTITY',
          sourceHeader,
        };
      }
    }

    return null;
  } catch {
    return null;
  }
};
