import { ClinicalFile, DataType } from '../types';
import { parseCsv } from './dataProcessing';

export type ChatQuickActionIcon =
  | 'OVERVIEW'
  | 'PROTOCOL'
  | 'SAFETY'
  | 'LABS'
  | 'EXPOSURE'
  | 'BIOMARKER'
  | 'LINKED'
  | 'DEMOGRAPHICS';

export interface ChatQuickAction {
  id: string;
  label: string;
  prompt: string;
  icon: ChatQuickActionIcon;
}

type DatasetKind =
  | 'DOCUMENT'
  | 'DEMOGRAPHICS'
  | 'ADVERSE_EVENTS'
  | 'LABS'
  | 'EXPOSURE'
  | 'MOLECULAR'
  | 'TUMOR'
  | 'GENERIC';

const normalize = (value: string) => value.trim().toLowerCase();

const inferDatasetKind = (file: ClinicalFile): DatasetKind => {
  const name = normalize(file.name);
  if (file.type === DataType.DOCUMENT) return 'DOCUMENT';

  let headers: string[] = [];
  if (file.content) {
    try {
      headers = parseCsv(file.content).headers.map(normalize);
    } catch {
      headers = [];
    }
  }

  const hasAnyHeader = (...candidates: string[]) => candidates.some((candidate) => headers.includes(normalize(candidate)));

  if (/demo|demograph|\bdm\b/.test(name) || hasAnyHeader('age', 'sex', 'race', 'trt_arm', 'arm')) return 'DEMOGRAPHICS';
  if (/adverse|\bae\b/.test(name) || hasAnyHeader('serious', 'relatedness', 'aeterm', 'aedecod', 'pt')) return 'ADVERSE_EVENTS';
  if (/lab|\blb\b/.test(name) || hasAnyHeader('test', 'testcd', 'result', 'unit', 'lbdtc')) return 'LABS';
  if (/exposure|dose|therapy/.test(name) || hasAnyHeader('drug', 'dose', 'doseu', 'therapy_class', 'exstdtc')) return 'EXPOSURE';
  if (/molecular|genom|ngs|biomarker|pdl1|egfr|alk|ros1/.test(name) || hasAnyHeader('ngs_platform', 'pdl1_cat', 'biomarker')) return 'MOLECULAR';
  if (/tumor|recist|response|outcome/.test(name) || hasAnyHeader('visit_response', 'best_response', 'assessment_date', 'asstdt')) return 'TUMOR';
  return 'GENERIC';
};

export const buildChatQuickActions = (selectedFiles: ClinicalFile[], allFiles: ClinicalFile[] = []): ChatQuickAction[] => {
  const contextFiles = selectedFiles.length > 0 ? selectedFiles : allFiles;
  const selectedKinds = new Set(contextFiles.map(inferDatasetKind));
  const hasDocuments = contextFiles.some((file) => inferDatasetKind(file) === 'DOCUMENT');
  const hasDemographics = selectedKinds.has('DEMOGRAPHICS');
  const hasAe = selectedKinds.has('ADVERSE_EVENTS');
  const hasLabs = selectedKinds.has('LABS');
  const hasExposure = selectedKinds.has('EXPOSURE');
  const hasMolecular = selectedKinds.has('MOLECULAR');
  const nonDocumentKinds = Array.from(selectedKinds).filter((kind) => kind !== 'DOCUMENT' && kind !== 'GENERIC');
  const actions: ChatQuickAction[] = [];

  actions.push({
    id: 'overview',
    label: selectedFiles.length > 0 ? 'What can I do with these sources?' : 'How should I start?',
    icon: 'OVERVIEW',
    prompt:
      selectedFiles.length > 0
        ? 'Review the selected sources and tell me which analyses are realistic, which workflow I should use next (AI Chat, Autopilot, or Statistical Analysis), and any obvious data gaps or risks before analysis.'
        : 'I have not selected any sources yet. Tell me what kinds of files I should pick for demographic review, safety review, and protocol-driven analysis, and explain when to use AI Chat, Autopilot, or Statistical Analysis.',
  });

  if (hasDocuments) {
    actions.push({
      id: 'protocol',
      label: 'Protocol to data',
      icon: 'PROTOCOL',
      prompt:
        'Summarize the key endpoints, populations, and analysis expectations from the selected protocol or SAP documents, then explain whether the selected datasets can support them and what is still missing.',
    });
  }

  if (hasAe) {
    actions.push({
      id: 'safety',
      label: 'Safety review',
      icon: 'SAFETY',
      prompt:
        'Review the selected adverse event and safety-related sources. Summarize serious events, treatment-related events, and any clinically important patterns that deserve follow-up.',
    });
  }

  if (hasLabs) {
    actions.push({
      id: 'labs',
      label: 'Lab anomalies',
      icon: 'LABS',
      prompt:
        'Review the selected lab sources for abnormal values, lab shifts over time, and any subjects or visits that need follow-up.',
    });
  }

  if (hasExposure) {
    actions.push({
      id: 'exposure',
      label: 'Exposure patterns',
      icon: 'EXPOSURE',
      prompt:
        'Summarize treatment exposure, dose modifications, and any exposure patterns that might relate to tolerability, safety, or outcomes.',
    });
  }

  if (hasMolecular) {
    actions.push({
      id: 'biomarker',
      label: 'Biomarker patterns',
      icon: 'BIOMARKER',
      prompt:
        'Summarize biomarker or molecular subgroup patterns in the selected sources and explain whether any subgroup appears associated with treatment patterns or outcomes.',
    });
  }

  if (hasDemographics && !hasAe && !hasLabs && !hasExposure && !hasMolecular) {
    actions.push({
      id: 'demographics',
      label: 'Baseline balance',
      icon: 'DEMOGRAPHICS',
      prompt:
        'Summarize the selected demographics source, highlight baseline imbalances or unusual category distributions, and suggest the most meaningful next analyses.',
    });
  }

  if (nonDocumentKinds.length >= 2) {
    actions.push({
      id: 'linked',
      label: 'Cross-file signals',
      icon: 'LINKED',
      prompt:
        'Using the selected sources together, suggest the most credible cross-file analyses, explain which joins are likely needed, and call out any limitations before drawing conclusions.',
    });
  }

  const deduped = new Map<string, ChatQuickAction>();
  actions.forEach((action) => {
    if (!deduped.has(action.id)) deduped.set(action.id, action);
  });

  return Array.from(deduped.values()).slice(0, 4);
};
