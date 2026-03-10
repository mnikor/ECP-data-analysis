import React, { useEffect, useMemo, useState } from 'react';
import {
  BarChart3,
  Bot,
  CheckCircle2,
  Clock3,
  Download,
  ExternalLink,
  FileText,
  FolderOpen,
  Loader2,
  PencilLine,
  Play,
  Save,
  Sparkles,
  Table2,
  X,
  XCircle,
} from 'lucide-react';
import {
  AnalysisPlanEntry,
  AnalysisSession,
  AutopilotDataScope,
  AutopilotExecutionMode,
  AutopilotMappingDecision,
  AutopilotReviewBundle,
  ClinicalFile,
  DataType,
  MappingSpec,
  ProvenanceRecord,
  ProvenanceType,
  QCIssue,
  ResultTable,
  StatAnalysisResult,
  StudyType,
  UsageMode,
  User,
} from '../types';
import {
  applyCleaning,
  executeStatisticalCode,
  extractPreSpecifiedAnalysisPlan,
  generateClinicalCommentary,
  generateCleaningSuggestion,
  generateETLScript,
  generateMappingSuggestion,
  generateSASCode,
  generateStatisticalCode,
  runQualityCheck,
  runTransformation,
} from '../services/geminiService';
import { parseCsv } from '../utils/dataProcessing';
import { parseReferenceMapping } from '../utils/mappingReference';
import { planAnalysisFromQuestion } from '../utils/queryPlanner';
import { AutopilotAnalysisTask, buildAutopilotAnalysisSuite } from '../utils/autopilotPlanner';
import {
  applyBenjaminiHochbergAdjustments,
  buildExploratorySignalTasks,
  buildLinkedAnalysisWorkspace,
  LinkedWorkspaceBuildResult,
} from '../utils/linkedAnalysisWorkspace';
import { formatComparisonLabel } from '../utils/displayNames';
import { Chart } from './Chart';

type StepKey = 'qc' | 'cleaning' | 'mapping' | 'transform' | 'plan' | 'analysis';
type StepStatus = 'PENDING' | 'RUNNING' | 'DONE' | 'FAILED' | 'SKIPPED';
type ResultDetailView = 'CHART' | 'TABLE';
type ExperienceMode = 'EXPLORE_FAST' | 'RUN_CONFIRMED';

interface StepState {
  status: StepStatus;
  detail: string;
}

interface AutopilotRunGroup {
  runId: string;
  runName: string;
  sessions: AnalysisSession[];
  datasetName: string;
  latestTimestamp: string;
  firstTimestamp: string;
  analysisCount: number;
  modeLabel: string;
  scopeLabel: string;
  workflowMode: UsageMode;
  questionPreview: string;
}

interface AutopilotProps {
  files: ClinicalFile[];
  onAddFile: (file: ClinicalFile) => void;
  onSaveSpec: (spec: MappingSpec) => void;
  onRecordProvenance: (record: ProvenanceRecord) => void;
  sessions: AnalysisSession[];
  setSessions: React.Dispatch<React.SetStateAction<AnalysisSession[]>>;
  setActiveSessionId: (id: string) => void;
  onOpenStatistics: (sessionId: string) => void;
  currentUser: User;
  studyType: StudyType;
}

const STEP_ORDER: Array<{ key: StepKey; label: string }> = [
  { key: 'qc', label: 'Quality Check' },
  { key: 'cleaning', label: 'Auto Cleaning' },
  { key: 'mapping', label: 'AI Mapping Spec' },
  { key: 'transform', label: 'Standardize Data' },
  { key: 'plan', label: 'Protocol/SAP Plan' },
  { key: 'analysis', label: 'Multi-Analysis Execution' },
];

const defaultStepState = (): Record<StepKey, StepState> => ({
  qc: { status: 'PENDING', detail: 'Waiting' },
  cleaning: { status: 'PENDING', detail: 'Waiting' },
  mapping: { status: 'PENDING', detail: 'Waiting' },
  transform: { status: 'PENDING', detail: 'Waiting' },
  plan: { status: 'PENDING', detail: 'Waiting' },
  analysis: { status: 'PENDING', detail: 'Waiting' },
});

const normalize = (value: string) => value.trim().toLowerCase();
const baseName = (name: string) => name.replace(/\.[^/.]+$/, '');
const deriveSourceDomain = (name: string) => baseName(name).toUpperCase().replace(/[^A-Z0-9_]/g, '_');
const prettifyDatasetName = (name: string) => baseName(name).replace(/^raw_/i, '').replace(/^sdtm_/i, '').replace(/_/g, ' ');
const formatVariablesForDisplay = (left?: string, right?: string) => formatComparisonLabel(left, right);

const isIssueAutoFixable = (issue: QCIssue): boolean => {
  if (typeof issue.autoFixable === 'boolean') return issue.autoFixable;
  return !/missing critical columns|failed to parse dataset/i.test(issue.description);
};

type ResolvedMappingDecision = AutopilotMappingDecision;

const mergeMappings = (
  sourceColumns: string[],
  aiMappings: MappingSpec['mappings'],
  referenceMappings: MappingSpec['mappings']
) => {
  const sourceByNorm = new Map(sourceColumns.map((col) => [normalize(col), col]));

  const mapBySource = (rows: MappingSpec['mappings'], origin: ResolvedMappingDecision['origin']) => {
    const mapped = new Map<string, ResolvedMappingDecision>();
    rows.forEach((row) => {
      const source = sourceByNorm.get(normalize(row.sourceCol));
      if (!source || !row.targetCol?.trim()) return;
      mapped.set(normalize(source), {
        sourceCol: source,
        targetCol: row.targetCol.trim(),
        transformation: row.transformation?.trim() || '',
        origin,
      });
    });
    return mapped;
  };

  const referenceBySource = mapBySource(referenceMappings, 'REFERENCE');
  const aiBySource = mapBySource(aiMappings, 'AI');

  return sourceColumns.map<ResolvedMappingDecision>((sourceCol) => {
    const preferred = referenceBySource.get(normalize(sourceCol)) || aiBySource.get(normalize(sourceCol));
    return preferred
      ? { sourceCol, targetCol: preferred.targetCol, transformation: preferred.transformation || '', origin: preferred.origin }
      : { sourceCol, targetCol: sourceCol, transformation: '', origin: 'IDENTITY' };
  });
};

const stepStatusClass: Record<StepStatus, string> = {
  PENDING: 'bg-slate-100 text-slate-500 border-slate-200',
  RUNNING: 'bg-blue-50 text-blue-700 border-blue-200',
  DONE: 'bg-green-50 text-green-700 border-green-200',
  FAILED: 'bg-red-50 text-red-700 border-red-200',
  SKIPPED: 'bg-amber-50 text-amber-700 border-amber-200',
};

const StepIcon: React.FC<{ status: StepStatus }> = ({ status }) => {
  if (status === 'RUNNING') return <Loader2 className="w-4 h-4 animate-spin" />;
  if (status === 'DONE') return <CheckCircle2 className="w-4 h-4" />;
  if (status === 'FAILED') return <XCircle className="w-4 h-4" />;
  return <Clock3 className="w-4 h-4" />;
};

const planEntriesToTasks = (entries: AnalysisPlanEntry[]): AutopilotAnalysisTask[] =>
  entries.slice(0, 4).map((entry) => ({
    id: entry.id,
    label: entry.name,
    question: entry.rationale || entry.name,
    testType: entry.testType,
    var1: entry.var1,
    var2: entry.var2,
    covariates: entry.covariates,
    imputationMethod: entry.imputationMethod,
    applyPSM: entry.applyPSM,
    rationale: entry.rationale,
  }));

const formatTimestamp = (timestamp: string) =>
  new Date(timestamp).toLocaleString([], {
    month: 'short',
    day: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
  });

const formatMetricLabel = (value: string) => value.replace(/_/g, ' ');

const getModeLabel = (mode: AutopilotExecutionMode | null | undefined) => (mode === 'SINGLE' ? 'One question' : 'Analysis pack');
const getScopeLabel = (scope: AutopilotDataScope | null | undefined) =>
  scope === 'LINKED_WORKSPACE' ? 'Linked workspace' : 'Single dataset';
const getWorkflowLabel = (mode: UsageMode | null | undefined) => {
  if (mode === UsageMode.OFFICIAL) return 'Run Confirmed';
  if (mode === UsageMode.POST_HOC) return 'Post hoc';
  return 'Explore Fast';
};
const getWorkflowBadgeClass = (mode: UsageMode | null | undefined) => {
  if (mode === UsageMode.OFFICIAL) return 'border-emerald-200 bg-emerald-50 text-emerald-700';
  if (mode === UsageMode.POST_HOC) return 'border-amber-200 bg-amber-50 text-amber-700';
  return 'border-blue-200 bg-blue-50 text-blue-700';
};

const buildDefaultRunName = (
  mode: AutopilotExecutionMode,
  datasetName: string,
  isConfirmedRun: boolean,
  question?: string,
  scope: AutopilotDataScope = 'SINGLE_DATASET',
  sourceCount = 1
) => {
  const sourceLabel = prettifyDatasetName(datasetName);
  const linkedLabel =
    scope === 'LINKED_WORKSPACE'
      ? `${sourceLabel}${sourceCount > 1 ? ` + ${sourceCount - 1} linked` : ''}`
      : sourceLabel;
  if (mode === 'SINGLE') {
    return question?.trim() ? `Single: ${question.trim()}` : `Single Analysis - ${linkedLabel}`;
  }
  if (scope === 'LINKED_WORKSPACE') {
    return `Linked Analysis Pack - ${linkedLabel}`;
  }
  return isConfirmedRun ? `Run Confirmed - ${sourceLabel}` : `Analysis Pack - ${sourceLabel}`;
};

const renderTableCell = (value: string | number | undefined) => {
  if (value == null || value === '') return '—';
  return String(value);
};

const escapeHtml = (value: string) =>
  value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');

const slugifyFileName = (value: string) =>
  value
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '') || 'autopilot-report';

const renderHtmlDataTable = (table?: ResultTable) => {
  if (!table || table.rows.length === 0) return '';

  const header = table.columns
    .map(
      (column) =>
        `<th style="padding:12px 14px;text-align:left;font-size:11px;text-transform:uppercase;letter-spacing:0.08em;color:#64748b;border-bottom:1px solid #dbe3ec;background:#f8fafc;">${escapeHtml(
          formatMetricLabel(column)
        )}</th>`
    )
    .join('');

  const rows = table.rows
    .map(
      (row) => `<tr>${table.columns
        .map(
          (column) =>
            `<td style="padding:12px 14px;border-bottom:1px solid #edf2f7;color:#1f2937;vertical-align:top;">${escapeHtml(
              renderTableCell(row[column])
            )}</td>`
        )
        .join('')}</tr>`
    )
    .join('');

  return `
    <div style="margin-top:24px;border:1px solid #dbe3ec;border-radius:18px;overflow:hidden;background:#ffffff;">
      <div style="padding:14px 18px;border-bottom:1px solid #dbe3ec;background:#f8fafc;font-weight:700;color:#1f2937;">
        ${escapeHtml(table.title || 'Result Table')}
      </div>
      <div style="overflow:auto;">
        <table style="width:100%;border-collapse:collapse;font-size:14px;">
          <thead><tr>${header}</tr></thead>
          <tbody>${rows}</tbody>
        </table>
      </div>
    </div>
  `;
};

const buildMetricsMarkup = (metrics: Record<string, string | number>) =>
  Object.entries(metrics)
    .map(
      ([key, value]) => `
        <div style="border:1px solid #dbe3ec;border-radius:14px;background:#f8fafc;padding:14px 16px;">
          <div style="font-size:11px;text-transform:uppercase;letter-spacing:0.08em;color:#64748b;font-weight:700;">${escapeHtml(
            formatMetricLabel(key)
          )}</div>
          <div style="margin-top:6px;font-size:16px;font-weight:700;color:#1f2937;word-break:break-word;">${escapeHtml(
            String(value)
          )}</div>
        </div>
      `
    )
    .join('');

const renderReviewBundleMarkup = (review: AutopilotReviewBundle | null) => {
  if (!review) return '';

  const mappingRows =
    review.mapping?.decisions
      .slice(0, 20)
      .map(
        (decision) => `
          <tr>
            <td style="padding:10px 12px;border-bottom:1px solid #edf2f7;color:#1f2937;font-weight:600;">${escapeHtml(decision.sourceCol)}</td>
            <td style="padding:10px 12px;border-bottom:1px solid #edf2f7;color:#334155;">${escapeHtml(decision.targetCol)}</td>
            <td style="padding:10px 12px;border-bottom:1px solid #edf2f7;color:#334155;">${escapeHtml(decision.origin)}</td>
            <td style="padding:10px 12px;border-bottom:1px solid #edf2f7;color:#334155;">${escapeHtml(decision.transformation || 'Identity')}</td>
          </tr>
        `
      )
      .join('') || '';

  const planRows = review.analysisPlan.tasks
    .map(
      (task) => `
        <div style="border:1px solid #dbe3ec;border-radius:14px;background:#f8fafc;padding:14px 16px;margin-top:10px;">
          <div style="font-size:15px;font-weight:700;color:#1f2937;">${escapeHtml(task.question)}</div>
          <div style="margin-top:6px;font-size:12px;color:#64748b;">${escapeHtml(task.testType)} | ${escapeHtml(
        formatVariablesForDisplay(task.var1, task.var2)
      )}</div>
          ${task.rationale ? `<div style="margin-top:8px;font-size:14px;color:#334155;">${escapeHtml(task.rationale)}</div>` : ''}
        </div>
      `
    )
    .join('');

  return `
    <div style="margin-top:28px;border:1px solid #dbe3ec;border-radius:18px;background:#ffffff;padding:22px;">
      <div style="font-size:12px;text-transform:uppercase;letter-spacing:0.08em;color:#64748b;font-weight:700;">Review AI Decisions</div>

      <div style="margin-top:18px;border:1px solid #dbe3ec;border-radius:16px;padding:18px;background:#f8fafc;">
        <div style="display:flex;justify-content:space-between;gap:12px;align-items:flex-start;">
          <div>
            <div style="font-size:12px;text-transform:uppercase;letter-spacing:0.08em;color:#64748b;font-weight:700;">Workflow Classification</div>
            <div style="margin-top:8px;font-size:14px;color:#334155;">${escapeHtml(review.workflow.rationale)}</div>
          </div>
          <div style="padding:8px 12px;border-radius:999px;background:#eff6ff;border:1px solid #bfdbfe;color:#1d4ed8;font-size:11px;font-weight:700;text-transform:uppercase;letter-spacing:0.08em;">
            ${escapeHtml(getWorkflowLabel(review.workflow.usageMode))}
          </div>
        </div>
      </div>

      <div style="margin-top:18px;display:grid;grid-template-columns:repeat(auto-fit,minmax(180px,1fr));gap:12px;">
        <div style="border:1px solid #dbe3ec;border-radius:14px;background:#f8fafc;padding:14px 16px;">
          <div style="font-size:11px;text-transform:uppercase;letter-spacing:0.08em;color:#64748b;font-weight:700;">Source File</div>
          <div style="margin-top:6px;font-size:15px;font-weight:700;color:#1f2937;word-break:break-word;">${escapeHtml(review.qc.sourceFileName)}</div>
        </div>
        <div style="border:1px solid #dbe3ec;border-radius:14px;background:#f8fafc;padding:14px 16px;">
          <div style="font-size:11px;text-transform:uppercase;letter-spacing:0.08em;color:#64748b;font-weight:700;">QC Status</div>
          <div style="margin-top:6px;font-size:15px;font-weight:700;color:#1f2937;">${escapeHtml(review.qc.status)}</div>
        </div>
        <div style="border:1px solid #dbe3ec;border-radius:14px;background:#f8fafc;padding:14px 16px;">
          <div style="font-size:11px;text-transform:uppercase;letter-spacing:0.08em;color:#64748b;font-weight:700;">Issues Reviewed</div>
          <div style="margin-top:6px;font-size:15px;font-weight:700;color:#1f2937;">${review.qc.issueCount}</div>
        </div>
        <div style="border:1px solid #dbe3ec;border-radius:14px;background:#f8fafc;padding:14px 16px;">
          <div style="font-size:11px;text-transform:uppercase;letter-spacing:0.08em;color:#64748b;font-weight:700;">Auto-fixable Issues</div>
          <div style="margin-top:6px;font-size:15px;font-weight:700;color:#1f2937;">${review.qc.autoFixableIssueCount}</div>
        </div>
      </div>

      ${
        review.mapping
          ? `
        <div style="margin-top:18px;">
          <div style="font-size:12px;text-transform:uppercase;letter-spacing:0.08em;color:#64748b;font-weight:700;">Mapping Decisions</div>
          <div style="margin-top:6px;font-size:14px;color:#64748b;">${escapeHtml(
            `${review.mapping.sourceDomain} -> ${review.mapping.targetDomain} | ${review.mapping.mappedColumnCount} columns`
          )}</div>
          <div style="margin-top:10px;border:1px solid #dbe3ec;border-radius:16px;overflow:hidden;">
            <table style="width:100%;border-collapse:collapse;font-size:14px;">
              <thead>
                <tr>
                  <th style="padding:10px 12px;text-align:left;font-size:11px;text-transform:uppercase;letter-spacing:0.08em;color:#64748b;border-bottom:1px solid #dbe3ec;background:#f8fafc;">Source</th>
                  <th style="padding:10px 12px;text-align:left;font-size:11px;text-transform:uppercase;letter-spacing:0.08em;color:#64748b;border-bottom:1px solid #dbe3ec;background:#f8fafc;">Target</th>
                  <th style="padding:10px 12px;text-align:left;font-size:11px;text-transform:uppercase;letter-spacing:0.08em;color:#64748b;border-bottom:1px solid #dbe3ec;background:#f8fafc;">Origin</th>
                  <th style="padding:10px 12px;text-align:left;font-size:11px;text-transform:uppercase;letter-spacing:0.08em;color:#64748b;border-bottom:1px solid #dbe3ec;background:#f8fafc;">Transformation</th>
                </tr>
              </thead>
              <tbody>${mappingRows}</tbody>
            </table>
          </div>
          ${
            review.mapping.decisions.length > 20
              ? `<div style="margin-top:8px;font-size:12px;color:#64748b;">Showing 20 of ${review.mapping.decisions.length} mapping decisions.</div>`
              : ''
          }
        </div>
      `
          : ''
      }

      ${
        review.workspace
          ? `
        <div style="margin-top:18px;">
          <div style="font-size:12px;text-transform:uppercase;letter-spacing:0.08em;color:#64748b;font-weight:700;">Linked Workspace Preview</div>
          <div style="margin-top:6px;font-size:14px;color:#64748b;">Join key: ${escapeHtml(review.workspace.joinKey)} | ${
              review.workspace.rowCount
            } subjects | ${review.workspace.columnCount} columns</div>
        </div>
      `
          : ''
      }

      <div style="margin-top:18px;">
        <div style="font-size:12px;text-transform:uppercase;letter-spacing:0.08em;color:#64748b;font-weight:700;">Planned Analyses</div>
        ${planRows}
      </div>
    </div>
  `;
};

const buildPlotMarkup = (chartConfig: StatAnalysisResult['chartConfig'], plotId: string) => {
  const dataJson = JSON.stringify(chartConfig.data || []);
  const layoutJson = JSON.stringify({
    ...chartConfig.layout,
    paper_bgcolor: chartConfig.layout?.paper_bgcolor || '#ffffff',
    plot_bgcolor: chartConfig.layout?.plot_bgcolor || '#ffffff',
  });

  return `
    <div style="margin-top:24px;border:1px solid #dbe3ec;border-radius:18px;padding:16px;background:#ffffff;">
      <div id="${plotId}" style="width:100%;height:460px;"></div>
    </div>
    <script src="https://cdn.plot.ly/plotly-2.27.0.min.js"></script>
    <script>
      Plotly.newPlot('${plotId}', ${dataJson}, ${layoutJson}, { responsive: true, displayModeBar: false, displaylogo: false });
    </script>
  `;
};

export const Autopilot: React.FC<AutopilotProps> = ({
  files,
  onAddFile,
  onSaveSpec,
  onRecordProvenance,
  sessions,
  setSessions,
  setActiveSessionId,
  onOpenStatistics,
  currentUser,
  studyType,
}) => {
  const [selectedSourceId, setSelectedSourceId] = useState('');
  const [selectedReferenceId, setSelectedReferenceId] = useState('');
  const [selectedProtocolId, setSelectedProtocolId] = useState('');
  const [targetDomain, setTargetDomain] = useState('DM');
  const [experienceMode, setExperienceMode] = useState<ExperienceMode>('EXPLORE_FAST');
  const [analysisMode, setAnalysisMode] = useState<AutopilotExecutionMode>('PACK');
  const [analysisScope, setAnalysisScope] = useState<AutopilotDataScope>('SINGLE_DATASET');
  const [analysisQuestion, setAnalysisQuestion] = useState('');
  const [customSynonyms, setCustomSynonyms] = useState('');
  const [generateSasDraft, setGenerateSasDraft] = useState(false);
  const [selectedSupportingIds, setSelectedSupportingIds] = useState<string[]>([]);

  const [isRunning, setIsRunning] = useState(false);
  const [runError, setRunError] = useState<string | null>(null);
  const [runLog, setRunLog] = useState<string[]>([]);
  const [stepState, setStepState] = useState<Record<StepKey, StepState>>(defaultStepState());
  const [selectedRunId, setSelectedRunId] = useState('');
  const [selectedResultId, setSelectedResultId] = useState('');
  const [resultDetailView, setResultDetailView] = useState<ResultDetailView>('CHART');
  const [isEditingRunName, setIsEditingRunName] = useState(false);
  const [runNameDraft, setRunNameDraft] = useState('');
  const [renameError, setRenameError] = useState<string | null>(null);

  const sourceFiles = useMemo(
    () => files.filter((f) => f.type === DataType.RAW || f.type === DataType.STANDARDIZED || f.type === DataType.COHORT_DEF),
    [files]
  );
  const referenceFiles = useMemo(() => files.filter((f) => f.type === DataType.MAPPING), [files]);
  const protocolFiles = useMemo(() => files.filter((f) => f.type === DataType.DOCUMENT), [files]);

  const selectedSource = sourceFiles.find((f) => f.id === selectedSourceId);
  const selectedReference = referenceFiles.find((f) => f.id === selectedReferenceId);
  const selectedProtocol = protocolFiles.find((f) => f.id === selectedProtocolId);
  const supportingSourceFiles = useMemo(
    () => sourceFiles.filter((file) => file.id !== selectedSourceId),
    [sourceFiles, selectedSourceId]
  );
  const selectedSupportingFiles = supportingSourceFiles.filter((file) => selectedSupportingIds.includes(file.id));

  useEffect(() => {
    if (experienceMode !== 'RUN_CONFIRMED') return;
    if (analysisMode !== 'PACK') setAnalysisMode('PACK');
    if (analysisScope !== 'SINGLE_DATASET') setAnalysisScope('SINGLE_DATASET');
  }, [experienceMode, analysisMode, analysisScope]);

  const confirmedBlockingReason = useMemo(() => {
    if (experienceMode !== 'RUN_CONFIRMED') return null;
    if (!selectedProtocol) return 'Run Confirmed requires a Protocol or SAP document.';
    if (analysisScope !== 'SINGLE_DATASET') return 'Run Confirmed currently supports single-dataset protocol-driven runs only.';
    if (analysisMode !== 'PACK') return 'Run Confirmed only supports Analysis Pack mode.';
    return null;
  }, [experienceMode, selectedProtocol, analysisScope, analysisMode]);

  const runMode = useMemo(() => {
    if (experienceMode === 'RUN_CONFIRMED') {
      return {
        label: 'Run Confirmed pack',
        helper:
          'Controlled protocol/SAP-driven mode. Autopilot will extract pre-specified analyses, save them as reviewed sessions, and block free-form exploratory execution.',
        button: 'Run Confirmed Pack',
      };
    }
    if (analysisScope === 'LINKED_WORKSPACE') {
      if (analysisMode === 'SINGLE') {
        return {
          label: 'Linked one-question analysis',
          helper: 'Autopilot will build a subject-level workspace from the selected datasets and answer one focused cross-domain question.',
          button: 'Run Linked Analysis',
        };
      }
      return {
        label: 'Linked exploratory analysis pack',
        helper: 'Autopilot will join the selected datasets by subject, scan for cross-domain signals, and adjust p-values across the exploratory run.',
        button: 'Run Linked Analysis Pack',
      };
    }
    if (analysisMode === 'SINGLE') {
      return {
        label: 'Single targeted analysis',
        helper: 'Use one plain-language question when you want a single focused analysis instead of a saved pack.',
        button: 'Run One Analysis',
      };
    }
    if (selectedProtocol) {
      return {
        label: 'Protocol-driven analysis pack',
        helper: 'Autopilot will try to extract several pre-specified analyses from the selected document and save them together as one run.',
        button: 'Run Protocol Analysis Pack',
      };
    }
    return {
      label: 'Autopilot analysis pack',
      helper: 'Autopilot will choose several clinically relevant analyses and save them as one reusable run.',
      button: 'Run Analysis Pack',
    };
  }, [analysisMode, analysisScope, experienceMode, selectedProtocol]);

  const autopilotRuns = useMemo<AutopilotRunGroup[]>(() => {
    const grouped = new Map<string, AnalysisSession[]>();

    sessions
      .filter((session) => session.params.autopilotRunId || session.name.toLowerCase().includes('autopilot'))
      .forEach((session) => {
        const runId = session.params.autopilotRunId || `legacy-${session.id}`;
        const existing = grouped.get(runId);
        if (existing) existing.push(session);
        else grouped.set(runId, [session]);
      });

    return Array.from(grouped.entries())
      .map(([runId, runSessions]) => {
        const ordered = [...runSessions].sort((a, b) => {
          const indexDiff = (a.params.autopilotResultIndex ?? 999) - (b.params.autopilotResultIndex ?? 999);
          if (indexDiff !== 0) return indexDiff;
          return new Date(a.timestamp).getTime() - new Date(b.timestamp).getTime();
        });
        const byTime = [...runSessions].sort(
          (a, b) => new Date(b.timestamp).getTime() - new Date(a.timestamp).getTime()
        );
        const first = ordered[0];
        const latest = byTime[0];
        const mode = first.params.autopilotMode || (ordered.length > 1 ? 'PACK' : 'SINGLE');
        const sourceName = first.params.autopilotSourceName || first.params.fileName;
        const runName =
          first.params.autopilotRunName ||
          buildDefaultRunName(
            mode,
            sourceName,
            first.usageMode === UsageMode.OFFICIAL,
            first.params.autopilotQuestion || undefined,
            first.params.autopilotDataScope || 'SINGLE_DATASET',
            first.params.autopilotSourceNames?.length || 1
          );

        return {
          runId,
          runName,
          sessions: ordered,
          datasetName: sourceName,
          latestTimestamp: latest.timestamp,
          firstTimestamp: ordered[0].timestamp,
          analysisCount: ordered.length,
          modeLabel: getModeLabel(mode),
          scopeLabel: getScopeLabel(first.params.autopilotDataScope),
          workflowMode: first.usageMode,
          questionPreview: first.params.autopilotQuestion || first.name,
        };
      })
      .sort((a, b) => new Date(b.latestTimestamp).getTime() - new Date(a.latestTimestamp).getTime());
  }, [sessions]);

  const selectedRun = autopilotRuns.find((run) => run.runId === selectedRunId) || autopilotRuns[0] || null;
  const selectedRunResults = selectedRun?.sessions || [];
  const selectedResult = selectedRunResults.find((session) => session.id === selectedResultId) || selectedRunResults[0] || null;
  const activeResultTable = selectedResult?.tableConfig;
  const activeReview = selectedResult?.params.autopilotReview || null;

  const updateStep = (key: StepKey, status: StepStatus, detail: string) => {
    setStepState((prev) => ({ ...prev, [key]: { status, detail } }));
  };

  const appendLog = (line: string) => {
    const ts = new Date().toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second: '2-digit' });
    setRunLog((prev) => [...prev, `[${ts}] ${line}`]);
  };

  const buildDefaultQuestion = () =>
    studyType === StudyType.RWE
      ? 'Assess clinically relevant differences between cohorts.'
      : 'Run clinically meaningful baseline and safety analyses for this dataset.';

  useEffect(() => {
    if (isRunning) return;

    if (autopilotRuns.length === 0) {
      setSelectedRunId('');
      setSelectedResultId('');
      return;
    }

    setSelectedRunId((prev) => (autopilotRuns.some((run) => run.runId === prev) ? prev : autopilotRuns[0].runId));
  }, [autopilotRuns, isRunning]);

  useEffect(() => {
    if (!selectedRun) {
      setSelectedResultId('');
      setRunNameDraft('');
      setIsEditingRunName(false);
      return;
    }

    setSelectedResultId((prev) =>
      selectedRun.sessions.some((session) => session.id === prev) ? prev : selectedRun.sessions[0].id
    );
    setRunNameDraft(selectedRun.runName);
    setIsEditingRunName(false);
    setRenameError(null);
  }, [selectedRun]);

  useEffect(() => {
    setSelectedSupportingIds((prev) => prev.filter((id) => id !== selectedSourceId));
  }, [selectedSourceId]);

  const toggleSupportingFile = (fileId: string) => {
    setSelectedSupportingIds((prev) =>
      prev.includes(fileId) ? prev.filter((id) => id !== fileId) : [...prev, fileId]
    );
  };

  useEffect(() => {
    if (selectedResult?.tableConfig && resultDetailView === 'TABLE') return;
    if (!selectedResult?.tableConfig && resultDetailView === 'TABLE') {
      setResultDetailView('CHART');
    }
  }, [selectedResult, resultDetailView]);

  const handleSaveRunName = () => {
    if (!selectedRun) return;
    const trimmed = runNameDraft.trim();
    if (!trimmed) {
      setRenameError('Run name cannot be empty.');
      return;
    }

    setSessions((prev) =>
      prev.map((session) =>
        session.params.autopilotRunId === selectedRun.runId
          ? {
              ...session,
              params: {
                ...session.params,
                autopilotRunName: trimmed,
              },
            }
          : session
      )
    );

    onRecordProvenance({
      id: crypto.randomUUID(),
      timestamp: new Date().toISOString(),
      userId: currentUser.name,
      userRole: currentUser.role,
      actionType: ProvenanceType.STATISTICS,
      details: `Renamed Autopilot run to ${trimmed}.`,
      inputs: selectedRun.sessions.map((session) => session.id),
      outputs: selectedRun.sessions.map((session) => session.id),
    });

    setIsEditingRunName(false);
    setRenameError(null);
  };

  const downloadHtmlReport = (fileName: string, html: string) => {
    const blob = new Blob([html], { type: 'text/html;charset=utf-8' });
    const url = URL.createObjectURL(blob);
    const link = document.createElement('a');
    link.href = url;
    link.download = fileName;
    document.body.appendChild(link);
    link.click();
    document.body.removeChild(link);
    URL.revokeObjectURL(url);
  };

  const buildResultExportHtml = (run: AutopilotRunGroup, session: AnalysisSession) => {
    const title = `Evidence CoPilot | ${run.runName}`;
    const plotId = `plot-${session.id}`;
    const variables = formatVariablesForDisplay(session.params.var1, session.params.var2);
    const linkedSources = session.params.autopilotSourceNames?.length ? session.params.autopilotSourceNames.join(', ') : session.params.autopilotSourceName || '';

    return `
      <!DOCTYPE html>
      <html lang="en">
        <head>
          <meta charset="UTF-8" />
          <meta name="viewport" content="width=device-width, initial-scale=1.0" />
          <title>${escapeHtml(title)}</title>
          <style>
            body { margin: 0; background: #eef2f5; color: #18212b; font-family: Aptos, "Segoe UI", sans-serif; }
            .page { max-width: 1240px; margin: 0 auto; padding: 40px 32px 56px; }
            .brand { display: flex; align-items: center; gap: 18px; }
            .brand img { width: 280px; height: auto; display: block; }
            .hero { margin-top: 28px; background: #ffffff; border: 1px solid #d7dee7; border-radius: 24px; padding: 28px; box-shadow: 0 18px 50px rgba(15, 23, 42, 0.06); }
            .eyebrow { font-size: 11px; text-transform: uppercase; letter-spacing: 0.12em; color: #64748b; font-weight: 700; }
            .title { margin-top: 10px; font-size: 34px; line-height: 1.15; font-weight: 800; color: #0f172a; }
            .subtitle { margin-top: 10px; font-size: 15px; color: #475569; }
            .question { margin-top: 18px; border: 1px solid #dbeafe; background: #eff6ff; color: #1e3a8a; border-radius: 16px; padding: 16px 18px; font-size: 15px; }
            .section { margin-top: 22px; background: #ffffff; border: 1px solid #d7dee7; border-radius: 20px; padding: 22px; box-shadow: 0 10px 32px rgba(15, 23, 42, 0.05); }
            .section-title { font-size: 12px; text-transform: uppercase; letter-spacing: 0.08em; color: #64748b; font-weight: 700; margin-bottom: 14px; }
            .grid { display: grid; gap: 14px; }
            .grid.meta { grid-template-columns: repeat(auto-fit, minmax(200px, 1fr)); }
            .grid.summary { grid-template-columns: minmax(0, 1.5fr) minmax(280px, 0.9fr); align-items: start; }
            .card { border: 1px solid #dbe3ec; border-radius: 16px; background: #f8fafc; padding: 14px 16px; }
            .card-label { font-size: 11px; text-transform: uppercase; letter-spacing: 0.08em; color: #64748b; font-weight: 700; }
            .card-value { margin-top: 6px; font-size: 15px; line-height: 1.5; color: #1f2937; font-weight: 700; word-break: break-word; }
            .body-copy { font-size: 16px; line-height: 1.8; color: #1f2937; }
            .muted { color: #64748b; }
            .badge { display: inline-flex; padding: 8px 12px; border-radius: 999px; border: 1px solid #bfdbfe; background: #eff6ff; color: #1d4ed8; font-size: 11px; font-weight: 700; text-transform: uppercase; letter-spacing: 0.08em; }
            .footer { margin-top: 28px; border-top: 1px solid #d7dee7; padding-top: 18px; font-size: 12px; color: #94a3b8; text-align: center; }
            ul { margin: 0; padding-left: 20px; }
            li { margin-bottom: 8px; }
            @media print {
              body { background: #ffffff; }
              .page { padding: 16px; }
              .hero, .section { box-shadow: none; break-inside: avoid; }
            }
          </style>
        </head>
        <body>
          <div class="page">
            <div class="brand">
              <img src="${escapeHtml(`${window.location.origin}/ECP%20Logo.png`)}" alt="Evidence CoPilot" />
            </div>

            <div class="hero">
              <div class="eyebrow">Autopilot Result Export</div>
              <div class="title">${escapeHtml(run.runName)}</div>
              <div class="subtitle">${escapeHtml(session.params.testType)} | ${escapeHtml(variables)}</div>
              <div style="margin-top:16px;"><span class="badge">${escapeHtml(getWorkflowLabel(session.usageMode))}</span></div>
              ${
                session.params.autopilotQuestion
                  ? `<div class="question">${escapeHtml(session.params.autopilotQuestion)}</div>`
                  : ''
              }
            </div>

            <div class="section">
              <div class="section-title">Run Details</div>
              <div class="grid meta">
                <div class="card"><div class="card-label">Source Dataset</div><div class="card-value">${escapeHtml(
                  session.params.autopilotSourceName || run.datasetName
                )}</div></div>
                <div class="card"><div class="card-label">Scope</div><div class="card-value">${escapeHtml(
                  getScopeLabel(session.params.autopilotDataScope)
                )}</div></div>
                <div class="card"><div class="card-label">Saved</div><div class="card-value">${escapeHtml(
                  formatTimestamp(session.timestamp)
                )}</div></div>
                <div class="card"><div class="card-label">Standardized Dataset</div><div class="card-value">${escapeHtml(
                  session.params.fileName
                )}</div></div>
                ${
                  linkedSources
                    ? `<div class="card" style="grid-column:1/-1;"><div class="card-label">Linked Source Datasets</div><div class="card-value">${escapeHtml(
                        linkedSources
                      )}</div></div>`
                    : ''
                }
              </div>
            </div>

            ${
              session.chartConfig
                ? `<div class="section"><div class="section-title">Visualization</div>${buildPlotMarkup(session.chartConfig, plotId)}</div>`
                : ''
            }

            <div class="section">
              <div class="section-title">Summary</div>
              <div class="grid summary">
                <div class="card" style="background:#ffffff;">
                  <div class="card-label">Statistical Interpretation</div>
                  <div class="body-copy" style="margin-top:8px;">${escapeHtml(session.interpretation)}</div>
                </div>
                <div>
                  <div class="section-title" style="margin-bottom:10px;">Metrics</div>
                  <div class="grid meta">${buildMetricsMarkup(session.metrics)}</div>
                </div>
              </div>
            </div>

            ${
              session.aiCommentary
                ? `
              <div class="section">
                <div class="section-title">AI Clinical Commentary</div>
                <div class="body-copy">${escapeHtml(session.aiCommentary.summary)}</div>
                ${
                  session.aiCommentary.limitations.length
                    ? `<div style="margin-top:16px;"><div class="card-label">Limitations</div><ul style="margin-top:10px;" class="muted">${session.aiCommentary.limitations
                        .map((item) => `<li>${escapeHtml(item)}</li>`)
                        .join('')}</ul></div>`
                    : ''
                }
                ${
                  session.aiCommentary.caution
                    ? `<div style="margin-top:16px;border:1px solid #fde68a;background:#fffbeb;color:#92400e;border-radius:14px;padding:12px 14px;font-size:14px;">${escapeHtml(
                        session.aiCommentary.caution
                      )}</div>`
                    : ''
                }
              </div>
            `
                : ''
            }

            ${renderHtmlDataTable(session.tableConfig)}
            ${renderReviewBundleMarkup(session.params.autopilotReview || null)}

            <div class="footer">
              Exported from Evidence CoPilot on ${escapeHtml(new Date().toLocaleString())}
            </div>
          </div>
        </body>
      </html>
    `;
  };

  const buildRunExportHtml = (run: AutopilotRunGroup) => {
    const sessionMarkup = run.sessions
      .map((session, index) => {
        const variables = formatVariablesForDisplay(session.params.var1, session.params.var2);
        const keyMetrics = Object.entries(session.metrics)
          .slice(0, 4)
          .map(
            ([key, value]) => `
              <div style="border:1px solid #dbe3ec;border-radius:12px;background:#f8fafc;padding:10px 12px;">
                <div style="font-size:10px;text-transform:uppercase;letter-spacing:0.08em;color:#64748b;font-weight:700;">${escapeHtml(
                  formatMetricLabel(key)
                )}</div>
                <div style="margin-top:4px;font-size:14px;font-weight:700;color:#1f2937;">${escapeHtml(String(value))}</div>
              </div>
            `
          )
          .join('');

        return `
          <div style="border:1px solid #d7dee7;border-radius:18px;background:#ffffff;padding:20px;margin-top:18px;">
            <div style="display:flex;justify-content:space-between;gap:12px;align-items:flex-start;">
              <div>
                <div style="font-size:11px;text-transform:uppercase;letter-spacing:0.08em;color:#64748b;font-weight:700;">Analysis ${index + 1}</div>
                <div style="margin-top:8px;font-size:22px;line-height:1.3;font-weight:800;color:#0f172a;">${escapeHtml(
                  session.params.autopilotQuestion || session.name
                )}</div>
                <div style="margin-top:6px;font-size:14px;color:#64748b;">${escapeHtml(session.params.testType)} | ${escapeHtml(
          variables
        )}</div>
              </div>
              <div style="padding:8px 12px;border-radius:999px;background:#eff6ff;border:1px solid #bfdbfe;color:#1d4ed8;font-size:11px;font-weight:700;text-transform:uppercase;letter-spacing:0.08em;">
                ${escapeHtml(getWorkflowLabel(session.usageMode))}
              </div>
            </div>
            <div style="margin-top:16px;font-size:15px;line-height:1.75;color:#1f2937;">${escapeHtml(session.interpretation)}</div>
            <div style="margin-top:16px;display:grid;grid-template-columns:repeat(auto-fit,minmax(150px,1fr));gap:10px;">${keyMetrics}</div>
          </div>
        `;
      })
      .join('');

    return `
      <!DOCTYPE html>
      <html lang="en">
        <head>
          <meta charset="UTF-8" />
          <meta name="viewport" content="width=device-width, initial-scale=1.0" />
          <title>${escapeHtml(`Evidence CoPilot | ${run.runName}`)}</title>
          <style>
            body { margin:0; background:#eef2f5; color:#18212b; font-family:Aptos, "Segoe UI", sans-serif; }
            .page { max-width:1240px; margin:0 auto; padding:40px 32px 56px; }
            .hero, .section { background:#ffffff; border:1px solid #d7dee7; border-radius:22px; box-shadow:0 14px 40px rgba(15,23,42,0.05); }
            .hero { padding:28px; }
            .section { padding:24px; margin-top:22px; }
            .eyebrow { font-size:11px; text-transform:uppercase; letter-spacing:0.12em; color:#64748b; font-weight:700; }
            .title { margin-top:10px; font-size:36px; line-height:1.15; font-weight:800; color:#0f172a; }
            .subtitle { margin-top:10px; font-size:15px; color:#475569; }
            .brand img { width:280px; height:auto; display:block; }
            .grid { display:grid; grid-template-columns:repeat(auto-fit,minmax(220px,1fr)); gap:14px; margin-top:18px; }
            .card { border:1px solid #dbe3ec; border-radius:16px; background:#f8fafc; padding:14px 16px; }
            .card-label { font-size:11px; text-transform:uppercase; letter-spacing:0.08em; color:#64748b; font-weight:700; }
            .card-value { margin-top:6px; font-size:15px; font-weight:700; color:#1f2937; word-break:break-word; }
            .footer { margin-top:28px; border-top:1px solid #d7dee7; padding-top:18px; font-size:12px; color:#94a3b8; text-align:center; }
          </style>
        </head>
        <body>
          <div class="page">
            <div class="brand"><img src="${escapeHtml(`${window.location.origin}/ECP%20Logo.png`)}" alt="Evidence CoPilot" /></div>
            <div class="hero">
              <div class="eyebrow">Autopilot Run Export</div>
              <div class="title">${escapeHtml(run.runName)}</div>
              <div class="subtitle">${escapeHtml(run.modeLabel)} | ${escapeHtml(run.scopeLabel)} | ${escapeHtml(
      prettifyDatasetName(run.datasetName)
    )}</div>
              <div class="grid">
                <div class="card"><div class="card-label">Analyses</div><div class="card-value">${run.analysisCount}</div></div>
                <div class="card"><div class="card-label">Workflow</div><div class="card-value">${escapeHtml(
                  getWorkflowLabel(run.workflowMode)
                )}</div></div>
                <div class="card"><div class="card-label">Updated</div><div class="card-value">${escapeHtml(
                  formatTimestamp(run.latestTimestamp)
                )}</div></div>
                <div class="card"><div class="card-label">Question Preview</div><div class="card-value">${escapeHtml(
                  run.questionPreview
                )}</div></div>
              </div>
            </div>

            <div class="section">
              <div class="eyebrow">Saved Analyses</div>
              ${sessionMarkup}
            </div>

            <div class="footer">
              Exported from Evidence CoPilot on ${escapeHtml(new Date().toLocaleString())}
            </div>
          </div>
        </body>
      </html>
    `;
  };

  const handleExportSelectedResult = () => {
    if (!selectedRun || !selectedResult) return;
    const fileName = `${slugifyFileName(selectedRun.runName)}-${slugifyFileName(
      formatVariablesForDisplay(selectedResult.params.var1, selectedResult.params.var2) || selectedResult.id
    )}.html`;
    downloadHtmlReport(fileName, buildResultExportHtml(selectedRun, selectedResult));
  };

  const handleExportRun = () => {
    if (!selectedRun) return;
    const fileName = `${slugifyFileName(selectedRun.runName)}-run-summary.html`;
    downloadHtmlReport(fileName, buildRunExportHtml(selectedRun));
  };

  const renderResultTable = (table: ResultTable | undefined) => {
    if (!table || table.rows.length === 0) {
      return (
        <div className="rounded-2xl border border-dashed border-slate-200 bg-slate-50 p-8 text-center text-sm text-slate-500">
          No tabular summary is available for this result.
        </div>
      );
    }

    return (
      <div className="rounded-2xl border border-slate-200 bg-white overflow-hidden min-w-0">
        <div className="px-4 py-3 border-b border-slate-200 bg-slate-50">
          <div className="text-sm font-semibold text-slate-800">{table.title || 'Result Table'}</div>
        </div>
        <div className="overflow-x-auto">
          <table className="min-w-full text-sm">
            <thead className="bg-slate-50 border-b border-slate-200">
              <tr>
                {table.columns.map((column) => (
                  <th
                    key={column}
                    className="px-4 py-3 text-left text-[11px] uppercase tracking-wide font-semibold text-slate-500 whitespace-nowrap"
                  >
                    {formatMetricLabel(column)}
                  </th>
                ))}
              </tr>
            </thead>
            <tbody>
              {table.rows.map((row, rowIndex) => (
                <tr key={rowIndex} className="border-b border-slate-100 last:border-b-0">
                  {table.columns.map((column) => (
                    <td key={column} className="px-4 py-3 text-slate-700 align-top whitespace-pre-wrap">
                      {renderTableCell(row[column])}
                    </td>
                  ))}
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </div>
    );
  };

  const renderDecisionReview = (review: AutopilotReviewBundle | null) => {
    if (!review) {
      return (
        <div className="rounded-2xl border border-dashed border-slate-200 bg-slate-50 p-6 text-sm text-slate-500">
          No saved AI decision review is available for this result.
        </div>
      );
    }

    const mappingPreview = review.mapping?.decisions.slice(0, 12) || [];
    const workflowMode = review.workflow?.usageMode || UsageMode.EXPLORATORY;
    const workflowRationale =
      review.workflow?.rationale ||
      'This saved run was created before execution-path classification was added, so it defaults to Explore Fast review mode.';
    const workflowGuardrails =
      review.workflow?.guardrails ||
      ['Review the saved mappings, joins, and planned analyses before reusing this run in a formal workflow.'];

    return (
      <div className="space-y-4">
        <div className="rounded-2xl border border-slate-200 p-4 bg-white">
          <div className="flex items-start justify-between gap-3 mb-3">
            <div>
              <div className="text-xs uppercase tracking-wide text-slate-500 font-semibold">Workflow Classification</div>
              <div className="text-sm text-slate-500 mt-1">
                Autopilot stores whether this run was created as Explore Fast or Run Confirmed so users can review it in the right context.
              </div>
            </div>
            <span
              className={`inline-flex rounded-full border px-3 py-1 text-[11px] font-semibold uppercase tracking-wide ${getWorkflowBadgeClass(
                workflowMode
              )}`}
            >
              {getWorkflowLabel(workflowMode)}
            </span>
          </div>
          <div className="text-sm text-slate-800">{workflowRationale}</div>
          {workflowGuardrails.length > 0 && (
            <div className="mt-3 rounded-xl border border-slate-200 bg-slate-50 px-3 py-3">
              <div className="text-[11px] uppercase tracking-wide text-slate-500 font-semibold mb-2">Guardrails</div>
              <ul className="space-y-1 text-sm text-slate-700 list-disc pl-5">
                {workflowGuardrails.map((item, index) => (
                  <li key={index}>{item}</li>
                ))}
              </ul>
            </div>
          )}
        </div>

        <div className="rounded-2xl border border-slate-200 p-4 bg-white">
          <div className="text-xs uppercase tracking-wide text-slate-500 font-semibold mb-3">QC And Data Handling</div>
          <div className="grid grid-cols-1 md:grid-cols-2 xl:grid-cols-4 gap-3 text-sm">
            <div className="rounded-xl bg-slate-50 border border-slate-200 px-3 py-3">
              <div className="text-[11px] uppercase tracking-wide text-slate-500 font-semibold">Source File</div>
              <div className="mt-1 font-medium text-slate-800 break-words">{review.qc.sourceFileName}</div>
            </div>
            <div className="rounded-xl bg-slate-50 border border-slate-200 px-3 py-3">
              <div className="text-[11px] uppercase tracking-wide text-slate-500 font-semibold">QC Status</div>
              <div className="mt-1 font-medium text-slate-800">{review.qc.status}</div>
            </div>
            <div className="rounded-xl bg-slate-50 border border-slate-200 px-3 py-3">
              <div className="text-[11px] uppercase tracking-wide text-slate-500 font-semibold">Issues Reviewed</div>
              <div className="mt-1 font-medium text-slate-800">{review.qc.issueCount}</div>
            </div>
            <div className="rounded-xl bg-slate-50 border border-slate-200 px-3 py-3">
              <div className="text-[11px] uppercase tracking-wide text-slate-500 font-semibold">Auto-fixable Issues</div>
              <div className="mt-1 font-medium text-slate-800">{review.qc.autoFixableIssueCount}</div>
            </div>
          </div>
          {review.qc.autoFixSummary && (
            <div className="mt-3 rounded-xl border border-amber-200 bg-amber-50 px-3 py-2 text-sm text-amber-900">
              {review.qc.autoFixSummary}
            </div>
          )}
        </div>

        {review.mapping && (
          <div className="rounded-2xl border border-slate-200 p-4 bg-white">
            <div className="flex items-center justify-between gap-3 mb-3">
              <div>
                <div className="text-xs uppercase tracking-wide text-slate-500 font-semibold">Mapping Decisions</div>
                <div className="text-sm text-slate-500 mt-1">
                  {`${review.mapping.sourceDomain} -> ${review.mapping.targetDomain} | ${review.mapping.mappedColumnCount} columns`}
                </div>
              </div>
              <div className="text-xs font-semibold uppercase tracking-wide text-slate-500">
                {review.mapping.transformedColumnCount} transformed
              </div>
            </div>
            <div className="overflow-x-auto">
              <table className="min-w-full text-sm">
                <thead className="bg-slate-50 border-y border-slate-200">
                  <tr>
                    <th className="px-3 py-2 text-left text-[11px] uppercase tracking-wide font-semibold text-slate-500">Source</th>
                    <th className="px-3 py-2 text-left text-[11px] uppercase tracking-wide font-semibold text-slate-500">Target</th>
                    <th className="px-3 py-2 text-left text-[11px] uppercase tracking-wide font-semibold text-slate-500">Origin</th>
                    <th className="px-3 py-2 text-left text-[11px] uppercase tracking-wide font-semibold text-slate-500">Transformation</th>
                  </tr>
                </thead>
                <tbody>
                  {mappingPreview.map((decision, index) => (
                    <tr key={`${decision.sourceCol}-${index}`} className="border-b border-slate-100">
                      <td className="px-3 py-2 font-medium text-slate-800">{decision.sourceCol}</td>
                      <td className="px-3 py-2 text-slate-700">{decision.targetCol}</td>
                      <td className="px-3 py-2">
                        <span
                          className={`inline-flex rounded-full px-2 py-0.5 text-[11px] font-semibold ${
                            decision.origin === 'REFERENCE'
                              ? 'bg-emerald-50 text-emerald-700 border border-emerald-200'
                              : decision.origin === 'AI'
                              ? 'bg-indigo-50 text-indigo-700 border border-indigo-200'
                              : 'bg-slate-100 text-slate-600 border border-slate-200'
                          }`}
                        >
                          {decision.origin}
                        </span>
                      </td>
                      <td className="px-3 py-2 text-slate-700">{decision.transformation || 'Identity'}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
            {review.mapping.decisions.length > mappingPreview.length && (
              <div className="mt-2 text-xs text-slate-500">
                Showing {mappingPreview.length} of {review.mapping.decisions.length} mapping decisions.
              </div>
            )}
          </div>
        )}

        {review.workspace && (
          <div className="rounded-2xl border border-slate-200 p-4 bg-white">
            <div className="flex items-center justify-between gap-3 mb-3">
              <div>
                <div className="text-xs uppercase tracking-wide text-slate-500 font-semibold">Linked Workspace Preview</div>
                <div className="text-sm text-slate-500 mt-1">
                  Join key: {review.workspace.joinKey} | {review.workspace.rowCount} subjects | {review.workspace.columnCount} columns
                </div>
              </div>
              <div className="text-xs font-semibold uppercase tracking-wide text-slate-500">
                {review.workspace.sourceNames.length} dataset{review.workspace.sourceNames.length === 1 ? '' : 's'}
              </div>
            </div>
            <div className="grid grid-cols-1 md:grid-cols-2 gap-3 text-sm mb-3">
              <div className="rounded-xl bg-slate-50 border border-slate-200 px-3 py-3">
                <div className="text-[11px] uppercase tracking-wide text-slate-500 font-semibold">Included Datasets</div>
                <div className="mt-1 text-slate-800 break-words">{review.workspace.sourceNames.join(', ')}</div>
              </div>
              <div className="rounded-xl bg-slate-50 border border-slate-200 px-3 py-3">
                <div className="text-[11px] uppercase tracking-wide text-slate-500 font-semibold">Skipped Datasets</div>
                <div className="mt-1 text-slate-800 break-words">
                  {review.workspace.skippedFiles.length > 0 ? review.workspace.skippedFiles.join(', ') : 'None'}
                </div>
              </div>
            </div>
            {review.workspace.derivedColumns.length > 0 && (
              <div className="rounded-xl bg-slate-50 border border-slate-200 px-3 py-3 mb-3">
                <div className="text-[11px] uppercase tracking-wide text-slate-500 font-semibold">Derived Columns</div>
                <div className="mt-1 text-slate-800 break-words">
                  {review.workspace.derivedColumns.slice(0, 12).join(', ')}
                  {review.workspace.derivedColumns.length > 12 ? ` and ${review.workspace.derivedColumns.length - 12} more` : ''}
                </div>
              </div>
            )}
            {review.workspace.notes.length > 0 && (
              <div className="rounded-xl border border-indigo-100 bg-indigo-50 px-3 py-3 mb-3">
                <div className="text-[11px] uppercase tracking-wide text-indigo-700 font-semibold mb-1">Join Notes</div>
                <ul className="space-y-1 text-sm text-indigo-900 list-disc pl-5">
                  {review.workspace.notes.map((note, index) => (
                    <li key={index}>{note}</li>
                  ))}
                </ul>
              </div>
            )}
            {review.workspace.previewTable && renderResultTable(review.workspace.previewTable)}
          </div>
        )}

        {review.protocol && (
          <div className="rounded-2xl border border-slate-200 p-4 bg-white">
            <div className="text-xs uppercase tracking-wide text-slate-500 font-semibold mb-3">Protocol Or SAP Extraction</div>
            <div className="grid grid-cols-1 md:grid-cols-2 gap-3 text-sm mb-3">
              <div className="rounded-xl bg-slate-50 border border-slate-200 px-3 py-3">
                <div className="text-[11px] uppercase tracking-wide text-slate-500 font-semibold">Document</div>
                <div className="mt-1 font-medium text-slate-800 break-words">{review.protocol.documentName}</div>
              </div>
              <div className="rounded-xl bg-slate-50 border border-slate-200 px-3 py-3">
                <div className="text-[11px] uppercase tracking-wide text-slate-500 font-semibold">Extracted Items</div>
                <div className="mt-1 font-medium text-slate-800">{review.protocol.extractedPlanCount}</div>
              </div>
            </div>
            {review.protocol.notes.length > 0 && (
              <div className="rounded-xl border border-indigo-100 bg-indigo-50 px-3 py-3 mb-3">
                <div className="text-[11px] uppercase tracking-wide text-indigo-700 font-semibold mb-1">Extraction Notes</div>
                <ul className="space-y-1 text-sm text-indigo-900 list-disc pl-5">
                  {review.protocol.notes.map((note, index) => (
                    <li key={index}>{note}</li>
                  ))}
                </ul>
              </div>
            )}
            {review.protocol.planItems.length > 0 && (
              <div className="space-y-2">
                {review.protocol.planItems.map((item, index) => (
                  <div key={`${item.name}-${index}`} className="rounded-xl bg-slate-50 border border-slate-200 px-3 py-3">
                    <div className="text-sm font-semibold text-slate-800">{item.name}</div>
                    <div className="text-xs text-slate-500 mt-1">
                      {item.testType} | {formatVariablesForDisplay(item.var1, item.var2)}
                    </div>
                  </div>
                ))}
              </div>
            )}
          </div>
        )}

        <div className="rounded-2xl border border-slate-200 p-4 bg-white">
          <div className="flex items-center justify-between gap-3 mb-3">
            <div>
              <div className="text-xs uppercase tracking-wide text-slate-500 font-semibold">Planned Analyses</div>
              <div className="text-sm text-slate-500 mt-1">
                {getScopeLabel(review.analysisPlan.scope)} | {getModeLabel(review.analysisPlan.mode)}
              </div>
            </div>
            {review.analysisPlan.multiplicityMethod && (
              <div className="text-[11px] font-semibold uppercase tracking-wide text-amber-700 bg-amber-50 border border-amber-200 rounded-full px-2 py-1">
                {review.analysisPlan.multiplicityMethod}
              </div>
            )}
          </div>
          <div className="space-y-2">
            {review.analysisPlan.tasks.map((task, index) => (
              <div key={`${task.question}-${index}`} className="rounded-xl bg-slate-50 border border-slate-200 px-3 py-3">
                <div className="text-sm font-semibold text-slate-800">{task.question}</div>
                <div className="text-xs text-slate-500 mt-1">
                  {task.testType} | {formatVariablesForDisplay(task.var1, task.var2)}
                </div>
                {task.rationale && <div className="text-sm text-slate-600 mt-2">{task.rationale}</div>}
              </div>
            ))}
          </div>
        </div>
      </div>
    );
  };

  const runAutopilot = async () => {
    if (!selectedSource) {
      setRunError('Select a source dataset first.');
      return;
    }

    if (experienceMode === 'RUN_CONFIRMED' && confirmedBlockingReason) {
      setRunError(confirmedBlockingReason);
      return;
    }

    if (analysisScope === 'LINKED_WORKSPACE' && selectedSupportingFiles.length === 0) {
      setRunError('Select at least one supporting dataset for linked workspace mode.');
      return;
    }

    if (analysisMode === 'SINGLE' && !analysisQuestion.trim()) {
      setRunError('Enter a plain-language analysis question in Single Question mode.');
      return;
    }

    setRunError(null);
    setRunLog([]);
    setSelectedResultId('');
    setStepState(defaultStepState());
    setIsRunning(true);
    setIsEditingRunName(false);

    try {
      let workingFile = selectedSource;
      let transformedFile = selectedSource;
      let analysisFile = selectedSource;
      let mappingSpec: MappingSpec | null = null;
      let resolvedMappingDecisions: ResolvedMappingDecision[] = [];
      let extractedPlanEntries: AnalysisPlanEntry[] = [];
      let extractedPlanNotes: string[] = [];
      let linkedWorkspaceInfo:
        | LinkedWorkspaceBuildResult
        | null = null;
      let qcResultSummary: {
        status: 'PASS' | 'WARN' | 'FAIL' | 'PENDING';
        issueCount: number;
        autoFixableIssueCount: number;
        blockingIssueCount: number;
        autoFixSummary?: string;
      } | null = null;
      const customSynonymList = customSynonyms
        .split(',')
        .map((item) => item.trim().toLowerCase())
        .filter(Boolean);

      updateStep('qc', 'RUNNING', `Checking ${workingFile.name}`);
      appendLog(`Starting quality control on ${workingFile.name}.`);
      const qcResult = await runQualityCheck(workingFile);
      const blockingIssues = qcResult.issues.filter((issue) => issue.severity === 'HIGH' && !isIssueAutoFixable(issue));
      qcResultSummary = {
        status: qcResult.status,
        issueCount: qcResult.issues.length,
        autoFixableIssueCount: qcResult.issues.filter((issue) => isIssueAutoFixable(issue)).length,
        blockingIssueCount: blockingIssues.length,
      };
      if (blockingIssues.length > 0) {
        updateStep('qc', 'FAILED', blockingIssues[0].description);
        updateStep('cleaning', 'SKIPPED', 'Manual remediation required.');
        throw new Error(`Autopilot stopped due to non-auto-fixable issue: ${blockingIssues[0].description}`);
      }
      updateStep('qc', 'DONE', `${qcResult.status} (${qcResult.issues.length} issue(s))`);
      appendLog(`QC finished with status ${qcResult.status}.`);

      const autoFixableIssues = qcResult.issues.filter((issue) => isIssueAutoFixable(issue));
      if (autoFixableIssues.length > 0) {
        updateStep('cleaning', 'RUNNING', `Applying ${autoFixableIssues.length} issue fix(es)`);
        appendLog(`Generating cleaning suggestion for ${autoFixableIssues.length} fixable issue(s).`);
        const suggestion = await generateCleaningSuggestion(workingFile, autoFixableIssues);
        const cleanedContent = await applyCleaning(workingFile, suggestion.code);
        if (!cleanedContent.trim()) {
          updateStep('cleaning', 'FAILED', 'Cleaning returned empty dataset');
          throw new Error('Auto-cleaning removed all records. Review source data.');
        }
        const cleanedQc = await runQualityCheck({ ...workingFile, content: cleanedContent });
        const cleanedFile: ClinicalFile = {
          id: crypto.randomUUID(),
          name: `${baseName(workingFile.name)}_cleaned.csv`,
          type: workingFile.type,
          uploadDate: new Date().toISOString(),
          size: `${(cleanedContent.length / 1024).toFixed(1)} KB`,
          content: cleanedContent,
          qcStatus: cleanedQc.status,
          qcIssues: cleanedQc.issues,
          metadata: { ...(workingFile.metadata || {}), generatedBy: 'AUTOPILOT_CLEANING' },
        };
        onAddFile(cleanedFile);
        onRecordProvenance({
          id: crypto.randomUUID(),
          timestamp: new Date().toISOString(),
          userId: currentUser.name,
          userRole: currentUser.role,
          actionType: ProvenanceType.CLEANING,
          details: `Autopilot cleaned ${workingFile.name}.`,
          inputs: [workingFile.id],
          outputs: [cleanedFile.id],
        });
        workingFile = cleanedFile;
        qcResultSummary.autoFixSummary = `Autopilot applied cleaning to ${autoFixableIssues.length} fixable issue(s) and saved ${cleanedFile.name}.`;
        updateStep('cleaning', 'DONE', `Saved ${cleanedFile.name}`);
        appendLog(`Saved cleaned dataset as ${cleanedFile.name}.`);
      } else {
        updateStep('cleaning', 'SKIPPED', 'No auto-fixable issues detected');
      }

      updateStep('mapping', 'RUNNING', 'Building mapping specification');
      appendLog('Preparing mapping rules.');
      const { headers: sourceColumns } = parseCsv(workingFile.content);
      if (sourceColumns.length === 0) {
        updateStep('mapping', 'FAILED', 'No parsable columns in source dataset');
        throw new Error('Source dataset has no parsable columns for mapping.');
      }

      const parsedReference = selectedReference ? parseReferenceMapping(selectedReference) : null;
      if (selectedReference && !parsedReference) {
        appendLog(`Reference file ${selectedReference.name} could not be parsed. Continuing without it.`);
      } else if (parsedReference) {
        appendLog(`Loaded ${parsedReference.mappings.length} mapping row(s) from reference ${selectedReference?.name}.`);
      }

      let aiSuggestion: MappingSpec['mappings'] = [];
      try {
        const aiSpec = await generateMappingSuggestion(sourceColumns, targetDomain.trim().toUpperCase() || 'DM');
        aiSuggestion = aiSpec.mappings || [];
        appendLog(`AI suggested ${aiSuggestion.length} mapping row(s).`);
      } catch (e: any) {
        appendLog(`AI mapping unavailable (${e?.message || 'unknown'}). Falling back to deterministic identity mapping.`);
      }

      const merged = mergeMappings(sourceColumns, aiSuggestion, parsedReference?.mappings || []);
      resolvedMappingDecisions = merged;
      const nonIdentity = merged.filter((mapping) => normalize(mapping.sourceCol) !== normalize(mapping.targetCol)).length;
      mappingSpec = {
        id: crypto.randomUUID(),
        sourceDomain: deriveSourceDomain(workingFile.name),
        targetDomain: targetDomain.trim().toUpperCase() || parsedReference?.targetDomain || 'DM',
        mappings: merged.map(({ sourceCol, targetCol, transformation }) => ({ sourceCol, targetCol, transformation })),
      };
      onSaveSpec(mappingSpec);
      updateStep('mapping', 'DONE', `${merged.length} columns mapped (${nonIdentity} transformed)`);
      appendLog(`Saved mapping spec ${mappingSpec.sourceDomain} -> ${mappingSpec.targetDomain}.`);

      updateStep('transform', 'RUNNING', 'Generating ETL code and transforming');
      appendLog('Generating ETL script and running deterministic transformation.');
      const etlScript = await generateETLScript(workingFile, mappingSpec);
      const transformedCsv = await runTransformation(workingFile, mappingSpec, etlScript);
      const parsedTransformed = parseCsv(transformedCsv);
      if (parsedTransformed.headers.length === 0 || parsedTransformed.rows.length === 0) {
        updateStep('transform', 'FAILED', 'Transformation produced empty output');
        throw new Error('Transformation produced no usable rows.');
      }
      const standardizedFile: ClinicalFile = {
        id: crypto.randomUUID(),
        name: `sdtm_${mappingSpec.targetDomain.toLowerCase()}_${Date.now()}.csv`,
        type: DataType.STANDARDIZED,
        uploadDate: new Date().toISOString(),
        size: `${(transformedCsv.length / 1024).toFixed(1)} KB`,
        content: transformedCsv,
        metadata: { generatedBy: 'AUTOPILOT_TRANSFORMATION', mappingSpecId: mappingSpec.id },
      };
      onAddFile(standardizedFile);
      onRecordProvenance({
        id: crypto.randomUUID(),
        timestamp: new Date().toISOString(),
        userId: currentUser.name,
        userRole: currentUser.role,
        actionType: ProvenanceType.TRANSFORMATION,
        details: `Autopilot transformed ${workingFile.name} using ${mappingSpec.sourceDomain} -> ${mappingSpec.targetDomain}.`,
        inputs: [workingFile.id, mappingSpec.id],
        outputs: [standardizedFile.id],
      });
      transformedFile = standardizedFile;
      analysisFile = standardizedFile;
      updateStep('transform', 'DONE', `${parsedTransformed.rows.length} rows, ${parsedTransformed.headers.length} columns`);
      appendLog(`Standardized dataset saved as ${standardizedFile.name}.`);

      if (analysisScope === 'LINKED_WORKSPACE') {
        updateStep('transform', 'RUNNING', 'Building linked analysis workspace');
        appendLog(`Building linked analysis workspace with ${selectedSupportingFiles.length} supporting dataset(s).`);
        linkedWorkspaceInfo = buildLinkedAnalysisWorkspace(transformedFile, selectedSupportingFiles, customSynonymList);
        if (linkedWorkspaceInfo.sourceNames.length < 2) {
          updateStep('transform', 'FAILED', 'No supporting datasets could be linked by subject');
          throw new Error('Linked workspace mode requires at least one supporting dataset with a shared subject identifier.');
        }

        analysisFile = linkedWorkspaceInfo.workspaceFile;
        onAddFile(analysisFile);
        onRecordProvenance({
          id: crypto.randomUUID(),
          timestamp: new Date().toISOString(),
          userId: currentUser.name,
          userRole: currentUser.role,
          actionType: ProvenanceType.TRANSFORMATION,
          details: `Autopilot built linked workspace ${analysisFile.name} from ${linkedWorkspaceInfo.sourceNames.join(', ')}.`,
          inputs: [transformedFile.id, ...selectedSupportingFiles.map((file) => file.id)],
          outputs: [analysisFile.id],
        });
        linkedWorkspaceInfo.notes.forEach((note) => appendLog(note));
        updateStep(
          'transform',
          'DONE',
          `Linked workspace: ${linkedWorkspaceInfo.sourceNames.length} datasets, ${parseCsv(analysisFile.content).rows.length} subjects`
        );
        appendLog(`Linked workspace saved as ${analysisFile.name}.`);
      }

      if (analysisMode === 'PACK' && selectedProtocol) {
        updateStep('plan', 'RUNNING', `Extracting analysis plan from ${selectedProtocol.name}`);
        appendLog(`Extracting pre-specified analysis from ${selectedProtocol.name}.`);
        const extracted = await extractPreSpecifiedAnalysisPlan(selectedProtocol, analysisFile);
        extractedPlanEntries = extracted.plan;
        extractedPlanNotes = extracted.notes;
        updateStep(
          'plan',
          'DONE',
          extracted.plan.length > 0
            ? `Extracted ${extracted.plan.length} plan item(s)`
            : 'No explicit plan item matched dataset columns'
        );
        if (extracted.notes.length > 0) {
          appendLog(`Plan notes: ${extracted.notes.join(' | ')}`);
        }
        if (experienceMode === 'RUN_CONFIRMED' && extracted.plan.length === 0) {
          updateStep('plan', 'FAILED', 'No extractable pre-specified analysis matched this dataset');
          throw new Error(
            'Run Confirmed requires at least one extractable pre-specified analysis item from the selected Protocol/SAP.'
          );
        }
      } else {
        updateStep('plan', 'SKIPPED', analysisMode === 'SINGLE' ? 'Single Question mode selected' : 'No Protocol/SAP selected');
      }

      updateStep('analysis', 'RUNNING', 'Selecting clinically meaningful analyses');
      let tasks: AutopilotAnalysisTask[] = [];
      if (analysisMode === 'PACK' && extractedPlanEntries.length > 0) {
        tasks = planEntriesToTasks(extractedPlanEntries);
      } else if (analysisMode === 'SINGLE') {
        const planned = planAnalysisFromQuestion(analysisFile, analysisQuestion, customSynonymList);
        tasks = [
          {
            id: crypto.randomUUID(),
            label: `${planned.testType}: ${planned.var1} vs ${planned.var2}`,
            question: analysisQuestion.trim(),
            testType: planned.testType,
            var1: planned.var1,
            var2: planned.var2,
            concept: planned.concept,
            rationale: planned.explanation,
          },
        ];
      } else if (analysisScope === 'LINKED_WORKSPACE') {
        tasks = buildExploratorySignalTasks(analysisFile);
      } else {
        tasks = buildAutopilotAnalysisSuite(analysisFile, customSynonymList);
      }

      if (tasks.length === 0) {
        updateStep('analysis', 'FAILED', 'No valid analyses could be planned');
        throw new Error('Autopilot could not derive any useful analyses from the selected dataset.');
      }

      appendLog(`Prepared ${tasks.length} clinically relevant analysis question(s).`);
      const usageModeForRun = experienceMode === 'RUN_CONFIRMED' ? UsageMode.OFFICIAL : UsageMode.EXPLORATORY;
      const runId = crypto.randomUUID();
      const runName = buildDefaultRunName(
        analysisMode,
        selectedSource.name,
        experienceMode === 'RUN_CONFIRMED',
        analysisMode === 'SINGLE' ? analysisQuestion : undefined,
        analysisScope,
        analysisScope === 'LINKED_WORKSPACE' ? linkedWorkspaceInfo?.sourceNames.length || 1 : 1
      );
      const createdSessions: AnalysisSession[] = [];
      const contextDocs = selectedProtocol ? [selectedProtocol] : [];

      for (let index = 0; index < tasks.length; index += 1) {
        const task = tasks[index];
        appendLog(`Running analysis ${index + 1}/${tasks.length}: ${task.question}`);
        try {
          const generatedCode = await generateStatisticalCode(
            analysisFile,
            task.testType,
            task.var1,
            task.var2,
            contextDocs,
            task.covariates || [],
            task.imputationMethod || 'None',
            Boolean(task.applyPSM)
          );

          let sasCode = '';
          if (generateSasDraft) {
            sasCode = await generateSASCode(
              analysisFile,
              task.testType,
              task.var1,
              task.var2,
              generatedCode,
              task.covariates || [],
              task.imputationMethod || 'None',
              Boolean(task.applyPSM)
            );
          }

          const result = await executeStatisticalCode(
            generatedCode,
            analysisFile,
            task.testType,
            task.var1,
            task.var2,
            task.concept || null
          );
          const enrichedResult: StatAnalysisResult = { ...result, sasCode: sasCode || undefined };

          createdSessions.push({
            id: crypto.randomUUID(),
            timestamp: new Date().toISOString(),
            name: `Autopilot - ${task.label}`,
            usageMode: usageModeForRun,
            params: {
              fileId: analysisFile.id,
              fileName: analysisFile.name,
              testType: task.testType,
              var1: task.var1,
              var2: task.var2,
              covariates: task.covariates,
              imputationMethod: task.imputationMethod,
              applyPSM: task.applyPSM,
              concept: task.concept || null,
              contextDocIds: contextDocs.map((doc) => doc.id),
              selectedPlanDocId: selectedProtocol?.id || null,
              preSpecifiedPlan: extractedPlanEntries,
              preSpecifiedPlanNotes: extractedPlanNotes,
              enforcePreSpecifiedPlan: usageModeForRun === UsageMode.OFFICIAL && extractedPlanEntries.length > 0,
              sourceWorkflow: 'AUTOPILOT',
              preSpecifiedPlanId: extractedPlanEntries[index]?.id || null,
              autopilotRunId: runId,
              autopilotRunName: runName,
              autopilotMode: analysisMode,
              autopilotSourceName: selectedSource.name,
              autopilotSourceNames:
                analysisScope === 'LINKED_WORKSPACE'
                  ? linkedWorkspaceInfo?.sourceNames || [selectedSource.name]
                  : [selectedSource.name],
              autopilotQuestion: task.question,
              autopilotResultIndex: index,
              autopilotDataScope: analysisScope,
              autopilotWorkspaceFileId: analysisScope === 'LINKED_WORKSPACE' ? analysisFile.id : null,
              autopilotWorkspaceFileName: analysisScope === 'LINKED_WORKSPACE' ? analysisFile.name : null,
            },
            ...enrichedResult,
          });
        } catch (e: any) {
          appendLog(`Skipped analysis ${index + 1}: ${e?.message || 'Unknown execution error'}`);
        }
      }

      if (createdSessions.length === 0) {
        updateStep('analysis', 'FAILED', 'All planned analyses failed');
        throw new Error('Autopilot could not complete any planned analysis successfully.');
      }

      const reviewBundle: AutopilotReviewBundle = {
        workflow: {
          usageMode: usageModeForRun,
          rationale:
            usageModeForRun === UsageMode.OFFICIAL
              ? `Autopilot classified this run as Run Confirmed because it was executed in protocol-driven analysis-pack mode with ${extractedPlanEntries.length} extracted plan item(s).`
              : analysisScope === 'LINKED_WORKSPACE'
              ? 'Autopilot classified this run as Explore Fast because linked-workspace signal search is hypothesis-generating and may surface cross-domain associations that require follow-up.'
              : 'Autopilot classified this run as Explore Fast because it was generated from dataset structure or a free-text question rather than a locked pre-specified analysis plan.',
          guardrails:
            usageModeForRun === UsageMode.OFFICIAL
              ? [
                  'Treat extracted Protocol/SAP items as reviewed execution instructions and document any deviation before using this run externally.',
                  'Promote these saved sessions into Statistical Analysis when you need final sign-off or downstream reporting.',
                ]
              : [
                  'Explore Fast results are hypothesis-generating and should be validated before external reporting.',
                  analysisScope === 'LINKED_WORKSPACE'
                    ? 'Multiple cross-domain hypotheses can inflate false positives; adjusted p-values are shown where applicable.'
                    : 'Single-dataset exploratory findings should be promoted into Statistical Analysis for controlled reruns when needed.',
                ],
        },
        qc: {
          sourceFileName: selectedSource.name,
          status: qcResultSummary?.status || 'PENDING',
          issueCount: qcResultSummary?.issueCount || 0,
          autoFixableIssueCount: qcResultSummary?.autoFixableIssueCount || 0,
          blockingIssueCount: qcResultSummary?.blockingIssueCount || 0,
          autoFixSummary: qcResultSummary?.autoFixSummary,
        },
        mapping: mappingSpec
          ? {
              sourceDomain: mappingSpec.sourceDomain,
              targetDomain: mappingSpec.targetDomain,
              mappedColumnCount: resolvedMappingDecisions.length,
              transformedColumnCount: resolvedMappingDecisions.filter(
                (mapping) => normalize(mapping.sourceCol) !== normalize(mapping.targetCol)
              ).length,
              decisions: resolvedMappingDecisions,
            }
          : undefined,
        protocol: selectedProtocol
          ? {
              documentName: selectedProtocol.name,
              extractedPlanCount: extractedPlanEntries.length,
              notes:
                extractedPlanNotes.length > 0
                  ? extractedPlanNotes
                  : extractedPlanEntries.length > 0
                  ? [`Applied ${extractedPlanEntries.length} extracted plan item(s).`]
                  : ['No protocol/SAP analysis item could be matched to dataset columns.'],
              planItems: extractedPlanEntries.map((entry) => ({
                name: entry.name,
                testType: entry.testType,
                var1: entry.var1,
                var2: entry.var2,
              })),
            }
          : undefined,
        workspace: linkedWorkspaceInfo
          ? {
              joinKey: linkedWorkspaceInfo.joinKey,
              sourceNames: linkedWorkspaceInfo.sourceNames,
              skippedFiles: linkedWorkspaceInfo.skippedFiles,
              rowCount: linkedWorkspaceInfo.rowCount,
              columnCount: linkedWorkspaceInfo.columnCount,
              derivedColumns: linkedWorkspaceInfo.derivedColumns,
              notes: linkedWorkspaceInfo.notes,
              previewTable: linkedWorkspaceInfo.previewTable,
            }
          : undefined,
        analysisPlan: {
          mode: analysisMode,
          scope: analysisScope,
          multiplicityMethod: analysisScope === 'LINKED_WORKSPACE' && createdSessions.length > 1 ? 'Benjamini-Hochberg FDR' : undefined,
          tasks: tasks.map((task) => ({
            question: task.question,
            testType: task.testType,
            var1: task.var1,
            var2: task.var2,
            rationale: task.rationale,
          })),
        },
      };

      const adjustedSessions =
        analysisScope === 'LINKED_WORKSPACE' && createdSessions.length > 1
          ? applyBenjaminiHochbergAdjustments(createdSessions)
          : createdSessions;

      const finalSessions = await Promise.all(
        adjustedSessions.map(async (session) => ({
          ...session,
          params: {
            ...session.params,
            autopilotReview: reviewBundle,
          },
          aiCommentary: await generateClinicalCommentary(session, {
            question: session.params.autopilotQuestion || '',
            dataScope: analysisScope,
            sourceNames:
              analysisScope === 'LINKED_WORKSPACE'
                ? linkedWorkspaceInfo?.sourceNames || [selectedSource.name]
                : [selectedSource.name],
            sourceDatasetName: selectedSource.name,
            var1: session.params.var1,
            var2: session.params.var2,
            testType: session.params.testType,
          }),
        }))
      );

      setSessions((prev) => [...finalSessions.slice().reverse(), ...prev]);
      setActiveSessionId(finalSessions[0].id);
      setSelectedRunId(runId);
      setSelectedResultId(finalSessions[0].id);
      setResultDetailView('CHART');
      setRunNameDraft(runName);

      onRecordProvenance({
        id: crypto.randomUUID(),
        timestamp: new Date().toISOString(),
        userId: currentUser.name,
        userRole: currentUser.role,
        actionType: ProvenanceType.STATISTICS,
        details: `Autopilot ran ${finalSessions.length} analysis(es) on ${analysisFile.name}${analysisScope === 'LINKED_WORKSPACE' ? ' using a linked workspace' : ''}.`,
        inputs: [
          selectedSource.id,
          analysisFile.id,
          ...(analysisScope === 'LINKED_WORKSPACE' ? selectedSupportingFiles.map((file) => file.id) : []),
          ...(selectedProtocol ? [selectedProtocol.id] : []),
          ...(selectedReference ? [selectedReference.id] : []),
        ],
        outputs: finalSessions.map((session) => session.id),
      });

      updateStep('analysis', 'DONE', `${finalSessions.length} of ${tasks.length} analyses completed`);
      if (analysisScope === 'LINKED_WORKSPACE' && finalSessions.some((session) => session.metrics.adjusted_p_value)) {
        appendLog('Applied Benjamini-Hochberg FDR adjustment across exploratory linked-workspace results.');
      }
      appendLog(`Autopilot completed successfully. ${finalSessions.length} analysis session(s) saved.`);
    } catch (e: any) {
      const message = e?.message || 'Autopilot failed.';
      appendLog(`ERROR: ${message}`);
      setRunError(message);
    } finally {
      setIsRunning(false);
    }
  };

  return (
    <div className="p-8 h-full overflow-y-auto bg-slate-50">
      <div className="mb-6">
        <h2 className="text-2xl font-bold text-slate-800 flex items-center">
          <Bot className="w-6 h-6 mr-3 text-indigo-600" />
          AI Autopilot
        </h2>
        <p className="text-slate-500">
          Use Explore Fast for low-friction signal finding. Use Run Confirmed when you need a protocol-driven pack with tighter execution guardrails.
        </p>
      </div>

      <div className="space-y-6">
        <div className="grid grid-cols-1 xl:grid-cols-[320px_minmax(0,1fr)] 2xl:grid-cols-[340px_minmax(0,1fr)] gap-6 items-start">
          <div className="space-y-6">
          <div className="bg-white border border-slate-200 rounded-2xl p-5 shadow-sm space-y-4">
            <div>
              <h3 className="font-bold text-slate-800">Configuration</h3>
              <p className="text-sm text-slate-500 mt-1">Autopilot saves each completed analysis as a normal Statistical Analysis session.</p>
            </div>

            <div>
              <div className="text-xs font-semibold uppercase tracking-wide text-slate-500 mb-2">Execution Path</div>
              <div className="inline-flex w-full rounded-xl border border-slate-200 bg-slate-100 p-1">
                <button
                  onClick={() => setExperienceMode('EXPLORE_FAST')}
                  className={`flex-1 rounded-lg px-3 py-2 text-sm font-semibold transition-colors ${
                    experienceMode === 'EXPLORE_FAST' ? 'bg-white text-slate-900 shadow-sm' : 'text-slate-500 hover:text-slate-700'
                  }`}
                >
                  Explore Fast
                </button>
                <button
                  onClick={() => setExperienceMode('RUN_CONFIRMED')}
                  className={`flex-1 rounded-lg px-3 py-2 text-sm font-semibold transition-colors ${
                    experienceMode === 'RUN_CONFIRMED' ? 'bg-white text-slate-900 shadow-sm' : 'text-slate-500 hover:text-slate-700'
                  }`}
                >
                  Run Confirmed
                </button>
              </div>
            </div>

            <div>
              <div className="text-xs font-semibold uppercase tracking-wide text-slate-500 mb-2">Analysis Scope</div>
              <div className="inline-flex w-full rounded-xl border border-slate-200 bg-slate-100 p-1">
                <button
                  onClick={() => setAnalysisScope('SINGLE_DATASET')}
                  className={`flex-1 rounded-lg px-3 py-2 text-sm font-semibold transition-colors ${
                    analysisScope === 'SINGLE_DATASET' ? 'bg-white text-slate-900 shadow-sm' : 'text-slate-500 hover:text-slate-700'
                  }`}
                >
                  Single Dataset
                </button>
                <button
                  onClick={() => setAnalysisScope('LINKED_WORKSPACE')}
                  disabled={experienceMode === 'RUN_CONFIRMED'}
                  className={`flex-1 rounded-lg px-3 py-2 text-sm font-semibold transition-colors ${
                    analysisScope === 'LINKED_WORKSPACE' ? 'bg-white text-slate-900 shadow-sm' : 'text-slate-500 hover:text-slate-700'
                  } ${experienceMode === 'RUN_CONFIRMED' ? 'cursor-not-allowed opacity-50' : ''}`}
                >
                  Linked Workspace
                </button>
              </div>
            </div>

            <div>
              <div className="text-xs font-semibold uppercase tracking-wide text-slate-500 mb-2">Execution Mode</div>
              <div className="inline-flex w-full rounded-xl border border-slate-200 bg-slate-100 p-1">
                <button
                  onClick={() => setAnalysisMode('PACK')}
                  className={`flex-1 rounded-lg px-3 py-2 text-sm font-semibold transition-colors ${
                    analysisMode === 'PACK' ? 'bg-white text-slate-900 shadow-sm' : 'text-slate-500 hover:text-slate-700'
                  }`}
                >
                  Analysis Pack
                </button>
                <button
                  onClick={() => setAnalysisMode('SINGLE')}
                  disabled={experienceMode === 'RUN_CONFIRMED'}
                  className={`flex-1 rounded-lg px-3 py-2 text-sm font-semibold transition-colors ${
                    analysisMode === 'SINGLE' ? 'bg-white text-slate-900 shadow-sm' : 'text-slate-500 hover:text-slate-700'
                  } ${experienceMode === 'RUN_CONFIRMED' ? 'cursor-not-allowed opacity-50' : ''}`}
                >
                  One Question
                </button>
              </div>
            </div>

            {experienceMode === 'RUN_CONFIRMED' ? (
              <div className="rounded-xl border border-emerald-200 bg-emerald-50 p-4">
                <div className="text-xs font-semibold uppercase tracking-wide text-emerald-700 mb-1">Run Confirmed Checklist</div>
                <div className="text-sm font-semibold text-slate-800">{runMode.label}</div>
                <div className="text-sm text-slate-600 mt-1">{runMode.helper}</div>
                <ul className="mt-3 space-y-2 text-sm text-slate-700">
                  <li className="flex items-start gap-2">
                    <span className={`mt-0.5 h-2.5 w-2.5 rounded-full ${selectedProtocol ? 'bg-emerald-500' : 'bg-slate-300'}`} />
                    <span>{selectedProtocol ? `Protocol selected: ${selectedProtocol.name}` : 'Select a Protocol or SAP document.'}</span>
                  </li>
                  <li className="flex items-start gap-2">
                    <span className={`mt-0.5 h-2.5 w-2.5 rounded-full ${analysisMode === 'PACK' ? 'bg-emerald-500' : 'bg-slate-300'}`} />
                    <span>Run Confirmed uses Analysis Pack only.</span>
                  </li>
                  <li className="flex items-start gap-2">
                    <span className={`mt-0.5 h-2.5 w-2.5 rounded-full ${analysisScope === 'SINGLE_DATASET' ? 'bg-emerald-500' : 'bg-slate-300'}`} />
                    <span>Run Confirmed currently supports single-dataset protocol-driven runs.</span>
                  </li>
                </ul>
                {confirmedBlockingReason && (
                  <div className="mt-3 rounded-lg border border-amber-200 bg-amber-50 px-3 py-2 text-sm text-amber-900">
                    {confirmedBlockingReason}
                  </div>
                )}
              </div>
            ) : (
              <div className="rounded-xl border border-indigo-100 bg-indigo-50 p-4">
                <div className="text-xs font-semibold uppercase tracking-wide text-indigo-600 mb-1">Explore Fast</div>
                <div className="text-sm font-semibold text-slate-800">{runMode.label}</div>
                <div className="text-sm text-slate-600 mt-1">{runMode.helper}</div>
              </div>
            )}

            <div>
              <label className="block text-xs font-semibold text-slate-500 uppercase mb-2">Source Dataset</label>
              <select
                value={selectedSourceId}
                onChange={(e) => setSelectedSourceId(e.target.value)}
                className="w-full p-2.5 rounded-lg border border-slate-300 bg-slate-50 text-sm"
              >
                <option value="">-- Select dataset --</option>
                {sourceFiles.map((file) => (
                  <option key={file.id} value={file.id}>
                    {file.name} ({file.type})
                  </option>
                ))}
              </select>
            </div>

            {analysisScope === 'LINKED_WORKSPACE' && (
              <div>
                <label className="block text-xs font-semibold text-slate-500 uppercase mb-2">Supporting Datasets</label>
                <div className="rounded-xl border border-slate-200 bg-slate-50 max-h-52 overflow-y-auto divide-y divide-slate-200">
                  {supportingSourceFiles.length === 0 ? (
                    <div className="p-3 text-sm text-slate-500">Choose a source dataset first to unlock supporting datasets.</div>
                  ) : (
                    supportingSourceFiles.map((file) => (
                      <label key={file.id} className="flex items-start gap-3 p-3 cursor-pointer hover:bg-white">
                        <input
                          type="checkbox"
                          checked={selectedSupportingIds.includes(file.id)}
                          onChange={() => toggleSupportingFile(file.id)}
                          className="mt-1 rounded border-slate-300 text-indigo-600 focus:ring-indigo-500"
                        />
                        <div className="min-w-0">
                          <div className="text-sm font-medium text-slate-800 break-words">{file.name}</div>
                          <div className="text-xs text-slate-500">{file.type}</div>
                        </div>
                      </label>
                    ))
                  )}
                </div>
                <div className="mt-2 text-xs text-slate-500">
                  Linked workspace mode creates a subject-level analysis table using shared subject identifiers such as `USUBJID`.
                </div>
              </div>
            )}

            <div>
              <label className="block text-xs font-semibold text-slate-500 uppercase mb-2">Reference Mapping (Optional)</label>
              <select
                value={selectedReferenceId}
                onChange={(e) => setSelectedReferenceId(e.target.value)}
                className="w-full p-2.5 rounded-lg border border-slate-300 bg-slate-50 text-sm"
              >
                <option value="">-- None --</option>
                {referenceFiles.map((file) => (
                  <option key={file.id} value={file.id}>
                    {file.name}
                  </option>
                ))}
              </select>
            </div>

            <div>
              <label className="block text-xs font-semibold text-slate-500 uppercase mb-2">
                Protocol/SAP {experienceMode === 'RUN_CONFIRMED' ? '(Required)' : '(Optional)'}
              </label>
              <select
                value={selectedProtocolId}
                onChange={(e) => setSelectedProtocolId(e.target.value)}
                className="w-full p-2.5 rounded-lg border border-slate-300 bg-slate-50 text-sm"
              >
                <option value="">-- None --</option>
                {protocolFiles.map((file) => (
                  <option key={file.id} value={file.id}>
                    {file.name}
                  </option>
                ))}
              </select>
            </div>

            <div>
              <label className="block text-xs font-semibold text-slate-500 uppercase mb-2">Target Domain</label>
              <input
                type="text"
                value={targetDomain}
                onChange={(e) => setTargetDomain(e.target.value.toUpperCase())}
                className="w-full p-2.5 rounded-lg border border-slate-300 bg-slate-50 text-sm font-mono"
                placeholder="DM"
              />
            </div>

            {analysisMode === 'SINGLE' ? (
              <div>
                <label className="block text-xs font-semibold text-slate-500 uppercase mb-2">Analysis Question</label>
                <textarea
                  value={analysisQuestion}
                  onChange={(e) => setAnalysisQuestion(e.target.value)}
                  rows={4}
                  className="w-full p-2.5 rounded-lg border border-slate-300 bg-slate-50 text-sm"
                  placeholder={`Example: ${buildDefaultQuestion()}`}
                />
              </div>
            ) : (
              <div className="rounded-xl border border-slate-200 bg-slate-50 p-4 text-sm text-slate-600">
                Leave Autopilot in pack mode when you want several analyses created and saved together, similar to a mini workbench.
              </div>
            )}

            <div>
              <label className="block text-xs font-semibold text-slate-500 uppercase mb-2">Synonyms (Optional)</label>
              <input
                value={customSynonyms}
                onChange={(e) => setCustomSynonyms(e.target.value)}
                className="w-full p-2.5 rounded-lg border border-slate-300 bg-slate-50 text-sm"
                placeholder="rash, dermatitis, erythema"
              />
            </div>

            <label className="flex items-center space-x-2 cursor-pointer">
              <input
                type="checkbox"
                checked={generateSasDraft}
                onChange={(e) => setGenerateSasDraft(e.target.checked)}
                className="rounded border-slate-300 text-indigo-600 focus:ring-indigo-500"
              />
              <span className="text-sm text-slate-600">Generate SAS validation draft</span>
            </label>

            <button
              onClick={runAutopilot}
              disabled={
                isRunning ||
                !selectedSource ||
                (analysisScope === 'LINKED_WORKSPACE' && selectedSupportingFiles.length === 0) ||
                Boolean(confirmedBlockingReason)
              }
              className={`w-full py-3 rounded-xl font-bold text-white flex items-center justify-center ${
                isRunning ||
                !selectedSource ||
                (analysisScope === 'LINKED_WORKSPACE' && selectedSupportingFiles.length === 0) ||
                Boolean(confirmedBlockingReason)
                  ? 'bg-slate-300 cursor-not-allowed'
                  : 'bg-indigo-600 hover:bg-indigo-700'
              }`}
            >
              {isRunning ? <Loader2 className="w-4 h-4 mr-2 animate-spin" /> : <Play className="w-4 h-4 mr-2" />}
              {isRunning ? 'Running Autopilot...' : runMode.button}
            </button>
          </div>

          <div className="bg-white border border-slate-200 rounded-2xl p-5 shadow-sm">
            <div className="flex items-center justify-between mb-3">
              <h3 className="font-bold text-slate-800 flex items-center">
                <FolderOpen className="w-4 h-4 mr-2 text-indigo-600" />
                Saved Runs
              </h3>
              <span className="text-xs font-semibold text-slate-500 uppercase tracking-wide">
                {autopilotRuns.length} run{autopilotRuns.length === 1 ? '' : 's'}
              </span>
            </div>
            <div className="space-y-2 max-h-[32rem] overflow-y-auto pr-1">
              {autopilotRuns.length === 0 && (
                <div className="rounded-xl border border-dashed border-slate-200 bg-slate-50 p-4 text-sm text-slate-500">
                  Run Autopilot once and the pack will stay here like a saved workspace.
                </div>
              )}
              {autopilotRuns.map((run) => (
                <button
                  key={run.runId}
                  onClick={() => setSelectedRunId(run.runId)}
                  className={`w-full text-left rounded-xl border p-3 transition-colors ${
                    selectedRun?.runId === run.runId
                      ? 'border-indigo-300 bg-indigo-50'
                      : 'border-slate-200 bg-white hover:bg-slate-50'
                  }`}
                >
                  <div className="flex items-center justify-between gap-3">
                    <div className="text-sm font-semibold text-slate-800 truncate">{run.runName}</div>
                    <span className="text-[11px] font-semibold uppercase tracking-wide text-slate-500 shrink-0">
                      {run.analysisCount} analysis{run.analysisCount === 1 ? '' : 'es'}
                    </span>
                  </div>
                  <div className="text-xs text-slate-500 mt-1">{run.modeLabel} | {run.scopeLabel} | {prettifyDatasetName(run.datasetName)}</div>
                  <div className="text-xs text-slate-600 mt-2 line-clamp-2">{run.questionPreview}</div>
                  <div className="text-[11px] text-slate-400 mt-2">Updated {formatTimestamp(run.latestTimestamp)}</div>
                </button>
              ))}
            </div>
          </div>
          </div>

          <div className="space-y-6 min-w-0">
          <div className="bg-white border border-slate-200 rounded-2xl p-5 shadow-sm">
            <h3 className="font-bold text-slate-800 mb-4 flex items-center">
              <Sparkles className="w-4 h-4 mr-2 text-indigo-600" />
              Workflow Status
            </h3>
            <div className="grid grid-cols-1 md:grid-cols-2 gap-3">
              {STEP_ORDER.map((step) => (
                <div
                  key={step.key}
                  className={`border rounded-xl px-3 py-2 text-sm ${stepStatusClass[stepState[step.key].status]}`}
                >
                  <div className="flex items-center justify-between">
                    <span className="font-semibold">{step.label}</span>
                    <StepIcon status={stepState[step.key].status} />
                  </div>
                  <div className="text-xs mt-1 opacity-90">{stepState[step.key].detail}</div>
                </div>
              ))}
            </div>
            {runError && (
              <div className="mt-4 border border-red-200 bg-red-50 text-red-700 rounded-xl p-3 text-sm">
                {runError}
              </div>
            )}
          </div>

          <div className="bg-[#111827] border border-slate-700 rounded-2xl overflow-hidden shadow-sm">
            <div className="px-4 py-3 border-b border-slate-700 text-slate-200 text-sm font-semibold flex items-center">
              <FileText className="w-4 h-4 mr-2" />
              Autopilot Log
            </div>
            <div className="p-4 h-56 overflow-y-auto font-mono text-xs text-slate-300 space-y-1">
              {runLog.length === 0 && <div className="text-slate-500">No execution logs yet.</div>}
              {runLog.map((line, idx) => (
                <div key={idx}>{line}</div>
              ))}
            </div>
          </div>
          </div>
        </div>

        <div className="bg-white border border-slate-200 rounded-2xl p-5 shadow-sm min-w-0">
            <div className="flex flex-col md:flex-row md:items-center md:justify-between gap-3 mb-5">
              <div>
                <h3 className="font-bold text-slate-800 flex items-center">
                  <BarChart3 className="w-4 h-4 mr-2 text-indigo-600" />
                  Autopilot Workspace
                </h3>
                <p className="text-sm text-slate-500 mt-1">
                  Browse saved runs first, then compare the analyses inside the selected run.
                </p>
              </div>
              <div className="text-xs font-semibold uppercase tracking-wide text-slate-500">
                {sessions.filter((session) => session.params.autopilotRunId).length} saved autopilot session{sessions.filter((session) => session.params.autopilotRunId).length === 1 ? '' : 's'}
              </div>
            </div>

            {selectedRun && selectedResult ? (
              <div className="space-y-5 min-w-0">
                <div className="grid grid-cols-1 md:grid-cols-3 gap-3">
                  <div className="rounded-xl border border-slate-200 bg-slate-50 px-4 py-3 md:col-span-2">
                    <div className="text-[11px] uppercase tracking-wide text-slate-500 font-semibold mb-2">Run Name</div>
                    {isEditingRunName ? (
                      <div className="space-y-2">
                        <div className="flex flex-col sm:flex-row gap-2">
                          <input
                            value={runNameDraft}
                            onChange={(e) => setRunNameDraft(e.target.value)}
                            className="flex-1 rounded-lg border border-slate-300 bg-white px-3 py-2 text-sm text-slate-800"
                            placeholder="Enter run name"
                          />
                          <button
                            onClick={handleSaveRunName}
                            className="inline-flex items-center justify-center rounded-lg bg-indigo-600 px-3 py-2 text-sm font-semibold text-white hover:bg-indigo-700"
                          >
                            <Save className="w-4 h-4 mr-2" />
                            Save
                          </button>
                          <button
                            onClick={() => {
                              setRunNameDraft(selectedRun.runName);
                              setIsEditingRunName(false);
                              setRenameError(null);
                            }}
                            className="inline-flex items-center justify-center rounded-lg border border-slate-300 bg-white px-3 py-2 text-sm font-semibold text-slate-700 hover:bg-slate-50"
                          >
                            <X className="w-4 h-4 mr-2" />
                            Cancel
                          </button>
                        </div>
                        {renameError && <div className="text-sm text-red-600">{renameError}</div>}
                      </div>
                    ) : (
                      <div className="flex items-center justify-between gap-3">
                        <div className="text-lg font-semibold text-slate-800 break-words">{selectedRun.runName}</div>
                        <button
                          onClick={() => setIsEditingRunName(true)}
                          className="inline-flex items-center justify-center rounded-lg border border-slate-300 bg-white px-3 py-2 text-sm font-semibold text-slate-700 hover:bg-slate-50 shrink-0"
                        >
                          <PencilLine className="w-4 h-4 mr-2" />
                          Rename
                        </button>
                      </div>
                    )}
                  </div>
                  <div className="rounded-xl border border-slate-200 bg-slate-50 px-4 py-3">
                    <div className="text-[11px] uppercase tracking-wide text-slate-500 font-semibold">Run Type</div>
                    <div className="text-sm font-semibold text-slate-800 mt-1">{selectedRun.modeLabel}</div>
                    <div className="text-sm text-slate-500 mt-1">{selectedRun.scopeLabel}</div>
                    <div className="text-sm text-slate-500 mt-2">Updated {formatTimestamp(selectedRun.latestTimestamp)}</div>
                    <div className="mt-3">
                      <span
                        className={`inline-flex rounded-full border px-2.5 py-1 text-[11px] font-semibold uppercase tracking-wide ${getWorkflowBadgeClass(
                          selectedRun.workflowMode
                        )}`}
                      >
                        {getWorkflowLabel(selectedRun.workflowMode)}
                      </span>
                    </div>
                  </div>
                </div>

                <div className="rounded-2xl border border-slate-200 bg-slate-50 p-4">
                  <div className="flex items-center justify-between mb-3">
                    <div>
                      <div className="text-sm font-semibold text-slate-800">Analyses in This Run</div>
                      <div className="text-sm text-slate-500">Select one result to review in detail below.</div>
                    </div>
                    <div className="text-xs font-semibold uppercase tracking-wide text-slate-500">
                      {selectedRun.analysisCount} saved result{selectedRun.analysisCount === 1 ? '' : 's'}
                    </div>
                  </div>
                  <div className="grid grid-cols-1 xl:grid-cols-2 gap-3">
                    {selectedRunResults.map((session, index) => (
                      <button
                        key={session.id}
                        onClick={() => {
                          setSelectedResultId(session.id);
                          setResultDetailView('CHART');
                        }}
                        className={`w-full text-left p-4 rounded-xl border transition-colors ${
                          selectedResult.id === session.id
                            ? 'border-indigo-300 bg-indigo-50'
                            : 'border-slate-200 bg-white hover:bg-slate-50'
                        }`}
                      >
                        <div className="flex items-start justify-between gap-3">
                          <div>
                            <div className="text-[11px] uppercase tracking-wide font-semibold text-slate-500 mb-1">
                              Analysis {index + 1}
                            </div>
                            <div className="text-sm font-semibold text-slate-800 leading-6">
                              {session.params.autopilotQuestion || formatVariablesForDisplay(session.params.var1, session.params.var2) || session.name}
                            </div>
                          </div>
                          <div className="text-[11px] font-semibold uppercase tracking-wide text-slate-500 shrink-0">
                            {session.params.testType}
                          </div>
                        </div>
                        <div className="text-xs text-slate-500 mt-2">
                          {formatVariablesForDisplay(session.params.var1, session.params.var2)}
                        </div>
                      </button>
                    ))}
                  </div>
                </div>

                <div className="border border-slate-200 rounded-2xl p-5 min-w-0 bg-white">
                  <div className="flex flex-col 2xl:flex-row 2xl:items-start 2xl:justify-between gap-4 mb-4">
                    <div className="min-w-0">
                      <div className="text-xs uppercase tracking-wide text-slate-500 font-semibold mb-2">Selected Result</div>
                      <div className="text-2xl font-bold text-slate-800 break-words">
                        {`Autopilot - ${selectedResult.params.testType}: ${formatVariablesForDisplay(selectedResult.params.var1, selectedResult.params.var2)}`}
                      </div>
                      <div className="text-sm text-slate-500 mt-1">
                        {selectedResult.params.testType} | {formatVariablesForDisplay(selectedResult.params.var1, selectedResult.params.var2)}
                      </div>
                      <div className="mt-3">
                        <span
                          className={`inline-flex rounded-full border px-2.5 py-1 text-[11px] font-semibold uppercase tracking-wide ${getWorkflowBadgeClass(
                            selectedResult.usageMode
                          )}`}
                        >
                          {getWorkflowLabel(selectedResult.usageMode)}
                        </span>
                      </div>
                      {selectedResult.params.autopilotQuestion && (
                        <div className="mt-3 rounded-xl bg-indigo-50 border border-indigo-100 p-3 text-sm text-indigo-950 max-w-3xl">
                          {selectedResult.params.autopilotQuestion}
                        </div>
                      )}
                    </div>
                    <div className="flex flex-col sm:flex-row gap-2 shrink-0">
                      <div className="inline-flex rounded-xl border border-slate-200 bg-slate-100 p-1">
                        <button
                          onClick={() => setResultDetailView('CHART')}
                          className={`inline-flex items-center rounded-lg px-3 py-2 text-sm font-semibold ${
                            resultDetailView === 'CHART' ? 'bg-white text-slate-900 shadow-sm' : 'text-slate-500'
                          }`}
                        >
                          <BarChart3 className="w-4 h-4 mr-2" />
                          Chart
                        </button>
                        <button
                          onClick={() => setResultDetailView('TABLE')}
                          disabled={!activeResultTable}
                          className={`inline-flex items-center rounded-lg px-3 py-2 text-sm font-semibold ${
                            resultDetailView === 'TABLE' ? 'bg-white text-slate-900 shadow-sm' : 'text-slate-500'
                          } ${!activeResultTable ? 'cursor-not-allowed opacity-50' : ''}`}
                        >
                          <Table2 className="w-4 h-4 mr-2" />
                          Table
                        </button>
                      </div>
                      <button
                        onClick={handleExportSelectedResult}
                        className="inline-flex items-center justify-center px-4 py-2 rounded-xl border border-slate-200 bg-white text-sm font-semibold text-slate-700 hover:bg-slate-50"
                      >
                        <Download className="w-4 h-4 mr-2" />
                        Export Result
                      </button>
                      <button
                        onClick={handleExportRun}
                        className="inline-flex items-center justify-center px-4 py-2 rounded-xl border border-slate-200 bg-white text-sm font-semibold text-slate-700 hover:bg-slate-50"
                      >
                        <FileText className="w-4 h-4 mr-2" />
                        Export Run
                      </button>
                      <button
                        onClick={() => onOpenStatistics(selectedResult.id)}
                        className="inline-flex items-center justify-center px-4 py-2 rounded-xl border border-slate-200 bg-white text-sm font-semibold text-slate-700 hover:bg-slate-50"
                      >
                        <ExternalLink className="w-4 h-4 mr-2" />
                        Promote to Statistical Workbench
                      </button>
                    </div>
                  </div>

                  <div className="min-w-0">
                    {resultDetailView === 'CHART' ? (
                      <div className="rounded-2xl border border-slate-200 bg-slate-50 p-3 min-w-0">
                        <Chart
                          data={selectedResult.chartConfig.data}
                          layout={selectedResult.chartConfig.layout}
                          className="h-[36rem] min-h-[36rem] 2xl:h-[40rem] 2xl:min-h-[40rem]"
                        />
                      </div>
                    ) : (
                      renderResultTable(activeResultTable)
                    )}
                  </div>

                  <div className="grid grid-cols-1 2xl:grid-cols-2 gap-4 mt-4 min-w-0 items-start">
                    <div className="rounded-2xl border border-slate-200 p-4 bg-white">
                      <div className="text-xs uppercase tracking-wide text-slate-500 font-semibold mb-2">Statistical Interpretation</div>
                      <div className="text-base leading-7 text-slate-800">{selectedResult.interpretation}</div>
                    </div>

                    {selectedResult.aiCommentary ? (
                      <div className="rounded-2xl border border-indigo-100 p-4 bg-indigo-50/60">
                        <div className="flex items-center justify-between gap-3 mb-2">
                          <div className="text-xs uppercase tracking-wide text-indigo-700 font-semibold">AI Clinical Commentary</div>
                          <div className="text-[11px] font-semibold uppercase tracking-wide text-indigo-600">
                            {selectedResult.aiCommentary.source === 'AI' ? 'AI generated' : 'Fallback summary'}
                          </div>
                        </div>
                        <div className="text-base leading-7 text-slate-800">{selectedResult.aiCommentary.summary}</div>
                        {selectedResult.aiCommentary.limitations.length > 0 && (
                          <div className="mt-3">
                            <div className="text-xs uppercase tracking-wide text-slate-500 font-semibold mb-2">Limitations</div>
                            <ul className="space-y-2 text-sm text-slate-700 list-disc pl-5">
                              {selectedResult.aiCommentary.limitations.map((item, index) => (
                                <li key={index}>{item}</li>
                              ))}
                            </ul>
                          </div>
                        )}
                        {selectedResult.aiCommentary.caution && (
                          <div className="mt-3 rounded-xl border border-amber-200 bg-amber-50 px-3 py-2 text-sm text-amber-900">
                            {selectedResult.aiCommentary.caution}
                          </div>
                        )}
                      </div>
                    ) : (
                      <div className="rounded-2xl border border-dashed border-slate-200 p-4 bg-slate-50 text-sm text-slate-500">
                        No AI clinical commentary is available for this result.
                      </div>
                    )}
                  </div>

                  <div className="grid grid-cols-1 xl:grid-cols-[minmax(0,1fr)_340px] gap-4 mt-4 min-w-0 items-start">
                    <div className="space-y-4 min-w-0">
                      <div className="rounded-2xl border border-slate-200 p-4 bg-white">
                        <div className="text-xs uppercase tracking-wide text-slate-500 font-semibold mb-3">Metrics</div>
                        <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
                          {Object.entries(selectedResult.metrics).map(([key, value]) => (
                            <div key={key} className="rounded-xl border border-slate-200 bg-slate-50 px-3 py-3">
                              <div className="text-[11px] uppercase tracking-wide text-slate-500 font-semibold">
                                {formatMetricLabel(key)}
                              </div>
                              <div className="text-sm font-semibold text-slate-800 mt-1 break-words">{String(value)}</div>
                            </div>
                          ))}
                        </div>
                      </div>
                    </div>

                    <div className="space-y-4">
                      <div className="rounded-2xl border border-slate-200 p-4 bg-white">
                        <div className="text-xs uppercase tracking-wide text-slate-500 font-semibold mb-3">Run Details</div>
                        <div className="grid grid-cols-1 gap-3 text-sm text-slate-700">
                          <div className="rounded-xl bg-slate-50 border border-slate-200 px-3 py-3">
                            <div className="text-[11px] uppercase tracking-wide text-slate-500 font-semibold">Run Name</div>
                            <div className="mt-1 font-medium text-slate-800 break-words">{selectedRun.runName}</div>
                          </div>
                          <div className="rounded-xl bg-slate-50 border border-slate-200 px-3 py-3">
                            <div className="text-[11px] uppercase tracking-wide text-slate-500 font-semibold">Source Dataset</div>
                            <div className="mt-1 font-medium text-slate-800 break-all">
                              {selectedResult.params.autopilotSourceName || selectedRun.datasetName}
                            </div>
                          </div>
                          <div className="rounded-xl bg-slate-50 border border-slate-200 px-3 py-3">
                            <div className="text-[11px] uppercase tracking-wide text-slate-500 font-semibold">Scope</div>
                            <div className="mt-1 font-medium text-slate-800">{getScopeLabel(selectedResult.params.autopilotDataScope)}</div>
                          </div>
                          <div className="rounded-xl bg-slate-50 border border-slate-200 px-3 py-3">
                            <div className="text-[11px] uppercase tracking-wide text-slate-500 font-semibold">Standardized Dataset</div>
                            <div className="mt-1 font-medium text-slate-800 break-all">{selectedResult.params.fileName}</div>
                          </div>
                          <div className="rounded-xl bg-slate-50 border border-slate-200 px-3 py-3">
                            <div className="text-[11px] uppercase tracking-wide text-slate-500 font-semibold">Saved</div>
                            <div className="mt-1 font-medium text-slate-800">{formatTimestamp(selectedResult.timestamp)}</div>
                          </div>
                          <div className="rounded-xl bg-slate-50 border border-slate-200 px-3 py-3">
                            <div className="text-[11px] uppercase tracking-wide text-slate-500 font-semibold">Variables</div>
                            <div className="mt-1 font-medium text-slate-800 break-words">
                              {formatVariablesForDisplay(selectedResult.params.var1, selectedResult.params.var2)}
                            </div>
                          </div>
                          {selectedResult.params.autopilotSourceNames && selectedResult.params.autopilotSourceNames.length > 1 && (
                            <div className="rounded-xl bg-slate-50 border border-slate-200 px-3 py-3">
                              <div className="text-[11px] uppercase tracking-wide text-slate-500 font-semibold">Linked Source Datasets</div>
                              <div className="mt-1 font-medium text-slate-800 break-words">
                                {selectedResult.params.autopilotSourceNames.join(', ')}
                              </div>
                            </div>
                          )}
                        </div>
                      </div>
                    </div>
                  </div>

                  <div className="rounded-2xl border border-slate-200 p-4 bg-slate-50 mt-4">
                    <div className="text-xs uppercase tracking-wide text-slate-500 font-semibold mb-3">Review AI Decisions</div>
                    {renderDecisionReview(activeReview)}
                  </div>
                </div>
              </div>
            ) : (
              <div className="rounded-2xl border border-dashed border-slate-200 bg-slate-50 p-8 text-center">
                <div className="text-lg font-semibold text-slate-800">No saved Autopilot run yet</div>
                <div className="text-sm text-slate-500 mt-2 max-w-2xl mx-auto">
                  The easiest path is: choose Explore Fast for rapid signal finding or Run Confirmed for protocol-driven execution, then review the saved run here and reopen any result later.
                </div>
              </div>
            )}
        </div>
      </div>
    </div>
  );
};
