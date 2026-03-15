import { ClinicalFile } from '../types';
import { inferDatasetProfile } from './datasetProfile';

export type ChatQuickActionIcon =
  | 'OVERVIEW'
  | 'PROTOCOL'
  | 'SAFETY'
  | 'LABS'
  | 'EXPOSURE'
  | 'BIOMARKER'
  | 'LINKED'
  | 'DEMOGRAPHICS'
  | 'TIME_TO_EVENT';

export interface ChatQuickAction {
  id: string;
  label: string;
  prompt: string;
  icon: ChatQuickActionIcon;
}

export const buildChatQuickActions = (selectedFiles: ClinicalFile[], allFiles: ClinicalFile[] = []): ChatQuickAction[] => {
  const contextFiles = selectedFiles.length > 0 ? selectedFiles : allFiles;
  const profiles = contextFiles.map((file) => inferDatasetProfile(file));
  const selectedKinds = new Set(profiles.map((profile) => profile.kind));
  const hasDocuments = profiles.some((profile) => profile.kind === 'DOCUMENT');
  const hasDemographics = selectedKinds.has('DEMOGRAPHICS') || selectedKinds.has('ADSL');
  const hasAe = selectedKinds.has('ADVERSE_EVENTS') || selectedKinds.has('ADAE');
  const hasLabs = selectedKinds.has('LABS') || selectedKinds.has('ADLB') || selectedKinds.has('BDS');
  const hasExposure = selectedKinds.has('EXPOSURE');
  const hasMolecular = selectedKinds.has('MOLECULAR');
  const hasAdsl = selectedKinds.has('ADSL');
  const hasParameterisedAdam = selectedKinds.has('ADLB') || selectedKinds.has('BDS');
  const hasAdtte = selectedKinds.has('ADTTE');
  const nonDocumentKinds = Array.from(selectedKinds).filter((kind) => kind !== 'DOCUMENT' && kind !== 'GENERIC');
  const actions: ChatQuickAction[] = [];

  actions.push({
    id: 'overview',
    label: selectedFiles.length > 0 ? 'What can I do with these sources?' : 'How should I start?',
    icon: 'OVERVIEW',
    prompt:
      selectedFiles.length > 0
        ? 'Review the selected sources and tell me which analyses are realistic, which workflow I should use next (AI Chat, Autopilot, or Statistical Analysis), and any obvious data gaps, ADaM guardrails, or risks before analysis.'
        : 'I have not selected any sources yet. Tell me which files I should pick first for ingestion review, analysis-ready datasets, and protocol-driven work, and explain when to use AI Chat, Autopilot, or Statistical Analysis.',
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

  if (hasAdsl) {
    actions.push({
      id: 'analysis-set',
      label: 'Analysis set review',
      icon: 'DEMOGRAPHICS',
      prompt:
        'Review the selected ADSL or subject-level analysis datasets. Confirm treatment variables, population flags, and subject counts, and explain whether the dataset is ready for controlled statistical analysis.',
    });
  }

  if (hasParameterisedAdam) {
    actions.push({
      id: 'parameter-review',
      label: 'Parameter review',
      icon: 'LABS',
      prompt:
        'Review the selected ADaM parameterised datasets. Summarize PARAM/PARAMCD coverage, identify whether multiple parameters are mixed together, and explain what should be filtered before inferential analysis.',
    });
  }

  if (hasAdtte) {
    actions.push({
      id: 'time-to-event',
      label: 'Time-to-event review',
      icon: 'TIME_TO_EVENT',
      prompt:
        'Review the selected ADTTE or time-to-event datasets. Explain the endpoint variables, censoring structure, and whether the selected file is ready for a lightweight exploratory Kaplan-Meier run in AI Chat or should be opened in Statistical Analysis for a controlled survival workflow.',
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

  if (hasLabs && !hasParameterisedAdam) {
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

  if (hasDemographics && !hasAe && !hasLabs && !hasExposure && !hasMolecular && !hasAdtte) {
    actions.push({
      id: 'demographics',
      label: 'Baseline balance',
      icon: 'DEMOGRAPHICS',
      prompt:
        'Summarize the selected demographics or subject-level analysis source, highlight baseline imbalances or unusual category distributions, and suggest the most meaningful next analyses.',
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
