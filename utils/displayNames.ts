const DISPLAY_NAME_MAP: Record<string, string> = {
  USUBJID: 'Subject ID',
  SUBJID: 'Subject ID',
  STUDYID: 'Study ID',
  TRT_ARM: 'Treatment Arm',
  ARM: 'Treatment Arm',
  TREATMENT_ARM: 'Treatment Arm',
  PDL1_CAT: 'PD-L1 Category',
  PDL1: 'PD-L1',
  NGS_PLATFORM: 'NGS Platform',
  PT: 'Preferred Term',
  SOC: 'System Organ Class',
  AETERM: 'Adverse Event Term',
  RELATEDNESS: 'Relatedness',
  SERIOUS: 'Seriousness',
  ACTION_TAKEN: 'Action Taken',
  OUTCOME: 'Outcome',
  GRADE: 'Grade',
  SEX: 'Sex',
  RACE: 'Race',
  AGE: 'Age',
  TEST: 'Lab Test',
  TESTCD: 'Lab Test Code',
  LBTEST: 'Lab Test',
  LBTESTCD: 'Lab Test Code',
  RESULT: 'Result',
  UNIT: 'Unit',
  VISIT: 'Visit',
  LBDTC: 'Lab Collection Date',
  EXSTDTC: 'Exposure Start Date',
  THERAPY_CLASS: 'Therapy Class',
  DRUG: 'Drug',
  DOSE: 'Dose',
  DOSEU: 'Dose Unit',
  CMSTDTC: 'Medication Start Date',
  ASSTDT: 'Assessment Date',
  LINKED_SOURCE_COUNT: 'Linked Source Count',
  RECORD_COUNT: 'Record Count',
  MEAN: 'Mean',
  MAX: 'Maximum',
  TERMS: 'Terms',
  PRESENT: 'Present',
};

const toTitleCase = (value: string) =>
  value
    .split(' ')
    .filter(Boolean)
    .map((word) => {
      if (/^[A-Z0-9-]{2,}$/.test(word) && (word.length <= 4 || /\d/.test(word) || word.includes('-'))) return word;
      return word.charAt(0).toUpperCase() + word.slice(1).toLowerCase();
    })
    .join(' ');

export const formatDisplayName = (value?: string | null): string => {
  if (!value) return '';
  const trimmed = value.trim();
  if (!trimmed) return '';

  const direct = DISPLAY_NAME_MAP[trimmed] || DISPLAY_NAME_MAP[trimmed.toUpperCase()];
  if (direct) return direct;

  const normalized = trimmed.replace(/__/g, ' ').replace(/_/g, ' ').replace(/\s+/g, ' ').trim();
  return toTitleCase(normalized);
};

export const formatComparisonLabel = (left?: string | null, right?: string | null): string => {
  const leftLabel = formatDisplayName(left);
  const rightLabel = formatDisplayName(right);
  if (leftLabel && rightLabel) return `${leftLabel} vs ${rightLabel}`;
  return leftLabel || rightLabel || '';
};

export const formatChartTitle = (text: string) => ({
  text,
  x: 0.02,
  xanchor: 'left' as const,
  y: 0.98,
  yanchor: 'top' as const,
  font: {
    size: 18,
    color: '#0f172a',
  },
});
