import React, { useState, useMemo, useEffect } from 'react';
import { Calculator, BarChart3, AlertCircle, Play, Code, ArrowLeft, Terminal, CheckCircle2, Plus, History, Trash2, ChevronRight, Layout, Sparkles, Lightbulb, Download, FileJson, FileType, ChevronDown, FileText, BookOpen, FlaskConical, ShieldAlert, Lock, Unlock, Microscope, Copy, Check, Globe, ArrowRight, Settings } from 'lucide-react';
import { AnalysisConcept, AnalysisPlanEntry, ClinicalFile, DataType, StatTestType, StatAnalysisResult, ProvenanceRecord, ProvenanceType, StatAnalysisStep, AnalysisSession, StatSuggestion, User, UsageMode, StudyType } from '../types';
import { extractPreSpecifiedAnalysisPlan, generateStatisticalCode, executeStatisticalCode, generateStatisticalSuggestions, generateSASCode } from '../services/geminiService';
import { Chart } from './Chart';
import { parseCsv } from '../utils/dataProcessing';
import { planAnalysisFromQuestion } from '../utils/queryPlanner';

interface StatisticsProps {
  files: ClinicalFile[];
  onRecordProvenance: (record: ProvenanceRecord) => void;
  sessions: AnalysisSession[];
  setSessions: React.Dispatch<React.SetStateAction<AnalysisSession[]>>;
  activeSessionId: string;
  setActiveSessionId: (id: string) => void;
  currentUser: User;
  studyType: StudyType;
}

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
    .replace(/^-+|-+$/g, '') || 'statistical-analysis-report';

const renderHtmlTable = (table?: StatAnalysisResult['tableConfig']) => {
  if (!table || table.rows.length === 0) return '';

  const header = table.columns
    .map(
      (column) =>
        `<th style="padding:12px 14px;text-align:left;font-size:11px;text-transform:uppercase;letter-spacing:0.08em;color:#64748b;border-bottom:1px solid #dbe3ec;background:#f8fafc;">${escapeHtml(
          column.replace(/_/g, ' ')
        )}</th>`
    )
    .join('');

  const rows = table.rows
    .map(
      (row) => `<tr>${table.columns
        .map((column) => {
          const value = row[column];
          return `<td style="padding:12px 14px;border-bottom:1px solid #edf2f7;color:#1f2937;vertical-align:top;">${escapeHtml(
            value == null || value === '' ? '—' : String(value)
          )}</td>`;
        })
        .join('')}</tr>`
    )
    .join('');

  return `
    <div class="section">
      <div class="section-title">${escapeHtml(table.title || 'Result Table')}</div>
      <div style="overflow:auto;border:1px solid #dbe3ec;border-radius:16px;">
        <table style="width:100%;border-collapse:collapse;font-size:14px;">
          <thead><tr>${header}</tr></thead>
          <tbody>${rows}</tbody>
        </table>
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
    <div class="section">
      <div class="section-title">Visualization</div>
      <div style="border:1px solid #dbe3ec;border-radius:18px;padding:18px;background:#fff;">
        <div id="${plotId}" style="width:100%;height:460px;"></div>
      </div>
    </div>
    <script src="https://cdn.plot.ly/plotly-2.27.0.min.js"></script>
    <script>
      Plotly.newPlot('${plotId}', ${dataJson}, ${layoutJson}, { responsive: true, displayModeBar: false, displaylogo: false });
    </script>
  `;
};

const normalizeFieldKey = (value: string) => value.toLowerCase().replace(/[^a-z0-9]+/g, '');

const toNumber = (value?: string | null): number | null => {
  if (value == null) return null;
  const trimmed = value.trim();
  if (!trimmed) return null;
  const parsed = Number(trimmed);
  return Number.isFinite(parsed) ? parsed : null;
};

const countDistinctNonEmpty = (values: string[]) => new Set(values.map((value) => value.trim()).filter(Boolean)).size;

const isLikelyIdentifierColumn = (rows: Record<string, string>[], column: string): boolean => {
  const sample = rows.slice(0, 300).map((row) => (row[column] || '').trim()).filter(Boolean);
  if (sample.length === 0) return false;
  const distinct = new Set(sample);
  if (distinct.size >= Math.floor(sample.length * 0.95)) return true;
  const normalized = normalizeFieldKey(column);
  return ['usubjid', 'subjid', 'subjectid', 'subjectnum', 'recordid'].some((hint) => normalized.includes(hint));
};

const isLikelyNumericColumn = (rows: Record<string, string>[], column: string): boolean => {
  const sample = rows.slice(0, 300).map((row) => (row[column] || '').trim()).filter(Boolean);
  if (sample.length === 0) return false;
  const numericCount = sample.filter((value) => toNumber(value) != null).length;
  return numericCount >= Math.max(3, Math.floor(sample.length * 0.75));
};

const parseEventObserved = (rawValue: string, censorColumn: string): boolean | null => {
  const value = rawValue.trim().toLowerCase();
  if (!value) return null;

  const usesCensorCoding = /cnsr|censor/.test(censorColumn.toLowerCase());

  if (['0', '0.0', 'n', 'no', 'false'].includes(value)) return usesCensorCoding ? true : false;
  if (['1', '1.0', 'y', 'yes', 'true'].includes(value)) return usesCensorCoding ? false : true;
  if (['event', 'death', 'dead', 'progressed', 'progression', 'failure'].some((token) => value.includes(token))) {
    return true;
  }
  if (['censored', 'alive', 'ongoing', 'no event'].some((token) => value.includes(token))) {
    return false;
  }

  return null;
};

type SurvivalPreflight = {
  recommendedGroupVar: string | null;
  recommendedTimeVar: string | null;
  censorColumn: string | null;
  recommendedValidRows: number;
  currentValidRows: number;
  recommendedGroupCount: number;
  currentGroupCount: number;
};

const SURVIVAL_GROUP_HINTS = ['TRT01A', 'TRTA', 'TRT01P', 'ACTARM', 'ARM', 'TREATMENT_ARM', 'TRT_ARM'];
const SURVIVAL_TIME_HINTS = ['AVAL', 'TIME', 'OS', 'PFS', 'TTE', 'DURATION', 'DAY', 'MONTH'];
const SURVIVAL_CENSOR_HINTS = ['CNSR', 'CENSOR', 'CENSORING', 'EVENT', 'EVENTFL', 'STATUS', 'DEATH', 'DEATHFL'];

const chooseHeaderByHints = (headers: string[], hints: string[]): string | null => {
  const normalizedHeaders = headers.map((header) => ({
    raw: header,
    normalized: normalizeFieldKey(header),
  }));

  for (const hint of hints) {
    const normalizedHint = normalizeFieldKey(hint);
    const exact = normalizedHeaders.find((header) => header.normalized === normalizedHint);
    if (exact) return exact.raw;
    const partial = normalizedHeaders.find((header) => header.normalized.includes(normalizedHint));
    if (partial) return partial.raw;
  }

  return null;
};

const countValidSurvivalRows = (
  rows: Record<string, string>[],
  groupVar: string | null,
  timeVar: string | null,
  censorColumn: string | null
) => {
  if (!groupVar || !timeVar || !censorColumn) return 0;
  return rows.reduce((count, row) => {
    const group = (row[groupVar] || '').trim();
    const time = toNumber(row[timeVar]);
    const eventObserved = parseEventObserved(row[censorColumn] || '', censorColumn);
    return group && time != null && time >= 0 && eventObserved != null ? count + 1 : count;
  }, 0);
};

const buildSurvivalPreflight = (
  headers: string[],
  rows: Record<string, string>[],
  currentGroupVar: string,
  currentTimeVar: string
): SurvivalPreflight | null => {
  if (headers.length === 0 || rows.length === 0) return null;

  const censorColumn = chooseHeaderByHints(headers, SURVIVAL_CENSOR_HINTS);
  const categoricalCandidates = headers.filter((header) => {
    if (header === currentTimeVar) return false;
    if (isLikelyIdentifierColumn(rows, header)) return false;
    if (isLikelyNumericColumn(rows, header)) return false;
    const distinct = countDistinctNonEmpty(rows.map((row) => row[header] || ''));
    return distinct >= 2 && distinct <= 12;
  });
  const numericCandidates = headers.filter((header) => {
    if (header === currentGroupVar) return false;
    if (isLikelyIdentifierColumn(rows, header)) return false;
    return isLikelyNumericColumn(rows, header);
  });

  const recommendedGroupVar =
    chooseHeaderByHints(categoricalCandidates, SURVIVAL_GROUP_HINTS) || categoricalCandidates[0] || null;
  const recommendedTimeVar =
    chooseHeaderByHints(numericCandidates, SURVIVAL_TIME_HINTS) || numericCandidates[0] || null;

  const recommendedValidRows = countValidSurvivalRows(rows, recommendedGroupVar, recommendedTimeVar, censorColumn);
  const currentValidRows = countValidSurvivalRows(rows, currentGroupVar || null, currentTimeVar || null, censorColumn);
  const recommendedGroupCount = recommendedGroupVar
    ? countDistinctNonEmpty(rows.map((row) => row[recommendedGroupVar] || ''))
    : 0;
  const currentGroupCount = currentGroupVar
    ? countDistinctNonEmpty(rows.map((row) => row[currentGroupVar] || ''))
    : 0;

  return {
    recommendedGroupVar,
    recommendedTimeVar,
    censorColumn,
    recommendedValidRows,
    currentValidRows,
    recommendedGroupCount,
    currentGroupCount,
  };
};

export const Statistics: React.FC<StatisticsProps> = ({ files, onRecordProvenance, sessions, setSessions, activeSessionId, setActiveSessionId, currentUser, studyType }) => {
  // Wizard State (for 'NEW' session)
  const [step, setStep] = useState<StatAnalysisStep>(StatAnalysisStep.CONFIGURATION);
  const [selectedFileId, setSelectedFileId] = useState<string>('');
  const [selectedContextIds, setSelectedContextIds] = useState<Set<string>>(new Set()); 
  const [testType, setTestType] = useState<StatTestType>(StatTestType.T_TEST);
  const [variable1, setVariable1] = useState('');
  const [variable2, setVariable2] = useState('');
  const [errorMsg, setErrorMsg] = useState<string | null>(null);
  const [analysisQuestion, setAnalysisQuestion] = useState('');
  const [customSynonymsInput, setCustomSynonymsInput] = useState('');
  const [wizardExplanation, setWizardExplanation] = useState('');
  const [analysisConcept, setAnalysisConcept] = useState<AnalysisConcept | null>(null);
  const [isPlanning, setIsPlanning] = useState(false);
  const [selectedPlanDocId, setSelectedPlanDocId] = useState('');
  const [preSpecifiedPlan, setPreSpecifiedPlan] = useState<AnalysisPlanEntry[]>([]);
  const [planNotes, setPlanNotes] = useState<string[]>([]);
  const [isExtractingPlan, setIsExtractingPlan] = useState(false);
  const [enforcePreSpecifiedPlan, setEnforcePreSpecifiedPlan] = useState(false);
  const [activePlanId, setActivePlanId] = useState<string | null>(null);
  const [draftSeedSession, setDraftSeedSession] = useState<AnalysisSession | null>(null);
  const [draftSourceSessionId, setDraftSourceSessionId] = useState<string | null>(null);

  // Execution Path State
  const [usageMode, setUsageMode] = useState<UsageMode>(UsageMode.EXPLORATORY);

  // Suggestion State
  const [suggestions, setSuggestions] = useState<StatSuggestion[]>([]);
  const [isSuggesting, setIsSuggesting] = useState(false);

  // Execution State
  const [generatedCode, setGeneratedCode] = useState<string>('');
  const [sasCode, setSasCode] = useState<string>(''); // SAS Code State
  const [activeCodeTab, setActiveCodeTab] = useState<'PYTHON' | 'SAS'>('PYTHON');
  const [isGenerating, setIsGenerating] = useState(false);
  const [isGeneratingSas, setIsGeneratingSas] = useState(false);
  const [isRunning, setIsRunning] = useState(false);
  const [result, setResult] = useState<StatAnalysisResult | null>(null);

  // Advanced Adjustments State
  const [covariates, setCovariates] = useState<string[]>([]);
  const [imputationMethod, setImputationMethod] = useState<string>('None');
  const [applyPSM, setApplyPSM] = useState<boolean>(false);

  // Load Active Session
  const activeSession = useMemo(() => sessions.find(s => s.id === activeSessionId), [sessions, activeSessionId]);
  const rawFiles = useMemo(() => files.filter(f => f.type === DataType.RAW || f.type === DataType.STANDARDIZED || f.type === DataType.COHORT_DEF), [files]);
  const docFiles = useMemo(() => files.filter(f => f.type === DataType.DOCUMENT), [files]);
  const selectedFile = rawFiles.find(f => f.id === selectedFileId);
  const selectedPlanDoc = docFiles.find(d => d.id === selectedPlanDocId);
  const canRunAnalysis = Boolean(selectedFile && generatedCode.trim());
  const selectedFileData = useMemo(() => {
    if (!selectedFile?.content) return { headers: [] as string[], rows: [] as Record<string, string>[] };
    try {
      return parseCsv(selectedFile.content);
    } catch {
      return { headers: [] as string[], rows: [] as Record<string, string>[] };
    }
  }, [selectedFile]);

  const buildPlanEntriesFromReview = (session: AnalysisSession): AnalysisPlanEntry[] => {
    if (session.params.preSpecifiedPlan && session.params.preSpecifiedPlan.length > 0) {
      return session.params.preSpecifiedPlan;
    }

    const protocolItems = session.params.autopilotReview?.protocol?.planItems || [];
    return protocolItems.map((item, index) => ({
      id:
        session.params.preSpecifiedPlanId &&
        item.testType === session.params.testType &&
        item.var1 === session.params.var1 &&
        item.var2 === session.params.var2
          ? session.params.preSpecifiedPlanId
          : `${session.id}-plan-${index}`,
      name: item.name,
      testType: item.testType,
      var1: item.var1,
      var2: item.var2,
    }));
  };

  const applySessionToWorkbench = (
    session: AnalysisSession,
    options: { openStep: StatAnalysisStep; editableDraft?: boolean } = {
      openStep: StatAnalysisStep.RESULTS,
      editableDraft: false,
    }
  ) => {
    const restoredPlan = buildPlanEntriesFromReview(session);
    const restoredContextIds = new Set(session.params.contextDocIds || []);

    if (session.params.selectedPlanDocId) {
      restoredContextIds.add(session.params.selectedPlanDocId);
    }

    setSelectedFileId(session.params.fileId);
    setSelectedContextIds(restoredContextIds);
    setSelectedPlanDocId(session.params.selectedPlanDocId || '');
    setPreSpecifiedPlan(restoredPlan);
    setPlanNotes(session.params.preSpecifiedPlanNotes || session.params.autopilotReview?.protocol?.notes || []);
    setEnforcePreSpecifiedPlan(
      typeof session.params.enforcePreSpecifiedPlan === 'boolean'
        ? session.params.enforcePreSpecifiedPlan
        : session.usageMode === UsageMode.OFFICIAL
    );
    setActivePlanId(
      session.params.preSpecifiedPlanId ||
        (restoredPlan.length > 0 ? restoredPlan[0].id : null)
    );
    setUsageMode(session.usageMode);
    setTestType(session.params.testType);
    setVariable1(session.params.var1);
    setVariable2(session.params.var2);
    setCovariates(session.params.covariates || []);
    setImputationMethod(session.params.imputationMethod || 'None');
    setApplyPSM(Boolean(session.params.applyPSM));
    setAnalysisConcept(session.params.concept || null);
    setAnalysisQuestion(session.params.autopilotQuestion || '');
    setCustomSynonymsInput('');
    setWizardExplanation(
      options.editableDraft
        ? `Editable draft created from ${session.name}. The original saved result remains unchanged in history.`
        : session.params.sourceWorkflow === 'AUTOPILOT'
        ? 'Promoted from Autopilot. Review the generated result, then create an editable draft if you need to refine or rerun it.'
        : ''
    );
    setGeneratedCode(session.executedCode);
    setSasCode(session.sasCode || '');
    setResult(options.openStep === StatAnalysisStep.RESULTS ? session : null);
    setStep(options.openStep);
    setActiveCodeTab('PYTHON');
    setSuggestions([]);
    setErrorMsg(null);
  };

  useEffect(() => {
    if (activeSessionId === 'NEW') {
      if (draftSeedSession) {
        applySessionToWorkbench(draftSeedSession, {
          openStep: StatAnalysisStep.CONFIGURATION,
          editableDraft: true,
        });
        setDraftSeedSession(null);
      } else {
        resetWizard();
      }
    } else if (activeSession) {
      applySessionToWorkbench(activeSession, { openStep: StatAnalysisStep.RESULTS });
    }
  }, [activeSessionId, activeSession, draftSeedSession]);

  useEffect(() => {
    if (usageMode === UsageMode.OFFICIAL) {
      setEnforcePreSpecifiedPlan(true);
    }
  }, [usageMode]);

  const resetWizard = () => {
    setStep(StatAnalysisStep.CONFIGURATION);
    setSelectedFileId('');
    setTestType(StatTestType.T_TEST);
    setVariable1('');
    setVariable2('');
    setGeneratedCode('');
    setSasCode('');
    setResult(null);
    setSuggestions([]);
    setUsageMode(UsageMode.EXPLORATORY);
    setActiveCodeTab('PYTHON');
    setCovariates([]);
    setImputationMethod('None');
    setApplyPSM(false);
    setAnalysisQuestion('');
    setCustomSynonymsInput('');
    setWizardExplanation('');
    setAnalysisConcept(null);
    setSelectedContextIds(new Set());
    setSelectedPlanDocId('');
    setPreSpecifiedPlan([]);
    setPlanNotes([]);
    setEnforcePreSpecifiedPlan(false);
    setActivePlanId(null);
    setErrorMsg(null);
    setDraftSourceSessionId(null);
  };

  const handleCreateEditableDraft = () => {
    if (!activeSession) return;
    setDraftSourceSessionId(activeSession.id);
    setDraftSeedSession(activeSession);
    setActiveSessionId('NEW');
  };

  const downloadHtmlReport = (fileName: string, html: string) => {
    const blob = new Blob([html], { type: 'text/html;charset=utf-8' });
    const url = URL.createObjectURL(blob);
    const anchor = document.createElement('a');
    anchor.href = url;
    anchor.download = fileName;
    document.body.appendChild(anchor);
    anchor.click();
    document.body.removeChild(anchor);
    URL.revokeObjectURL(url);
  };

  const buildStatisticalReportHtml = () => {
    if (!result) return '';

    const sessionName =
      activeSession?.name ||
      `${testType} - ${variable1}${variable2 ? ` vs ${variable2}` : ''}`;
    const plotId = `statistics-plot-${activeSession?.id || 'current'}`;
    const metricsMarkup = Object.entries(result.metrics)
      .map(
        ([key, value]) => `
          <div class="metric-card">
            <div class="metric-label">${escapeHtml(key.replace(/_/g, ' '))}</div>
            <div class="metric-value">${escapeHtml(String(value))}</div>
          </div>
        `
      )
      .join('');
    const contextDocNames = docFiles
      .filter((doc) => selectedContextIds.has(doc.id))
      .map((doc) => doc.name);

    return `<!DOCTYPE html>
<html lang="en">
  <head>
    <meta charset="UTF-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1.0" />
    <title>${escapeHtml(sessionName)}</title>
    <style>
      body { margin:0; font-family: Inter, Arial, sans-serif; background:#f8fafc; color:#0f172a; }
      .page { max-width: 1180px; margin: 0 auto; padding: 32px 24px 48px; }
      .hero { background:#ffffff; border:1px solid #dbe3ec; border-radius:24px; padding:28px; }
      .brand { display:flex; align-items:flex-start; justify-content:space-between; gap:24px; }
      .brand img { width: 220px; height: auto; }
      .badge { display:inline-flex; align-items:center; border-radius:999px; padding:8px 12px; font-size:11px; font-weight:700; text-transform:uppercase; letter-spacing:0.08em; border:1px solid #bfdbfe; color:#1d4ed8; background:#eff6ff; }
      .subtitle { margin-top:10px; font-size:16px; color:#64748b; }
      .question { margin-top:16px; background:#eef2ff; border:1px solid #c7d2fe; color:#312e81; padding:14px 16px; border-radius:16px; font-size:15px; }
      .section { margin-top:24px; }
      .section-title { font-size:12px; font-weight:800; text-transform:uppercase; letter-spacing:0.08em; color:#64748b; margin-bottom:12px; }
      .grid { display:grid; gap:16px; }
      .grid.two { grid-template-columns: repeat(auto-fit, minmax(280px, 1fr)); }
      .grid.meta { grid-template-columns: repeat(auto-fit, minmax(180px, 1fr)); }
      .card { background:#ffffff; border:1px solid #dbe3ec; border-radius:20px; padding:22px; }
      .metric-card { border:1px solid #dbe3ec; border-radius:14px; background:#f8fafc; padding:14px 16px; }
      .metric-label { font-size:11px; text-transform:uppercase; letter-spacing:0.08em; color:#64748b; font-weight:700; }
      .metric-value { margin-top:6px; font-size:16px; font-weight:700; color:#1f2937; word-break:break-word; }
      .body-copy { font-size:15px; line-height:1.8; color:#1f2937; }
      .muted { color:#64748b; }
      .code-panel { background:#0f172a; color:#e2e8f0; border-radius:18px; overflow:hidden; }
      .code-header { padding:12px 16px; border-bottom:1px solid #1e293b; display:flex; justify-content:space-between; align-items:center; font-size:12px; font-weight:700; text-transform:uppercase; letter-spacing:0.08em; }
      .code-body { padding:16px; max-height:460px; overflow:auto; font-size:12px; line-height:1.7; font-family: ui-monospace, SFMono-Regular, Menlo, monospace; white-space:pre-wrap; }
      .note { margin-top:12px; border-radius:14px; padding:14px 16px; border:1px solid #fcd34d; background:#fffbeb; color:#92400e; font-size:14px; }
      .footer { margin-top:28px; font-size:12px; color:#94a3b8; text-align:center; }
      @media print { body { background:#fff; } .page { max-width:none; padding: 12mm; } }
    </style>
  </head>
  <body>
    <div class="page">
      <div class="hero">
        <div class="brand">
          <img src="${window.location.origin}/ECP%20Logo.png" alt="Evidence CoPilot logo" />
          <div style="text-align:right;">
            <div class="badge">${escapeHtml(usageMode === UsageMode.OFFICIAL ? 'Run Confirmed' : 'Explore Fast')}</div>
            <div class="subtitle">${escapeHtml(testType)} | ${escapeHtml(variable1)} vs ${escapeHtml(variable2)}</div>
          </div>
        </div>
        <h1 style="margin:20px 0 0;font-size:34px;line-height:1.2;">${escapeHtml(sessionName)}</h1>
        <div class="subtitle">${escapeHtml(selectedFile?.name || activeSession?.params.fileName || 'Unknown dataset')}</div>
        ${
          analysisQuestion.trim()
            ? `<div class="question">${escapeHtml(analysisQuestion.trim())}</div>`
            : ''
        }
      </div>

      ${buildPlotMarkup(result.chartConfig, plotId)}

      <div class="section grid two">
        <div class="card" style="background:#eef2ff;border-color:#c7d2fe;">
          <div class="section-title" style="color:#4338ca;">Clinical Interpretation</div>
          <div class="body-copy">${escapeHtml(result.interpretation)}</div>
        </div>
        <div class="card">
          <div style="display:flex;justify-content:space-between;gap:12px;align-items:flex-start;">
            <div class="section-title" style="margin-bottom:0;">AI Clinical Commentary</div>
            ${
              result.aiCommentary
                ? `<div class="badge" style="padding:6px 10px;">${escapeHtml(result.aiCommentary.source === 'AI' ? 'AI generated' : 'Fallback')}</div>`
                : ''
            }
          </div>
          ${
            result.aiCommentary
              ? `
                <div class="body-copy" style="margin-top:10px;">${escapeHtml(result.aiCommentary.summary)}</div>
                ${
                  result.aiCommentary.limitations.length > 0
                    ? `<div style="margin-top:16px;">
                        <div class="section-title" style="margin-bottom:8px;">Limitations</div>
                        <ul class="muted" style="margin:0;padding-left:18px;line-height:1.8;">
                          ${result.aiCommentary.limitations.map((item) => `<li>${escapeHtml(item)}</li>`).join('')}
                        </ul>
                      </div>`
                    : ''
                }
                ${
                  result.aiCommentary.caution
                    ? `<div class="note">${escapeHtml(result.aiCommentary.caution)}</div>`
                    : ''
                }
              `
              : `<div class="body-copy" style="margin-top:10px;">No AI clinical commentary is available for this result.</div>`
          }
        </div>
      </div>

      <div class="section grid two">
        <div class="card">
          <div class="section-title">Calculated Metrics</div>
          <div class="grid meta">${metricsMarkup}</div>
        </div>
        <div class="card">
          <div class="section-title">Run Details</div>
          <div class="grid meta">
            <div class="metric-card"><div class="metric-label">Dataset</div><div class="metric-value">${escapeHtml(
              selectedFile?.name || activeSession?.params.fileName || 'Unknown'
            )}</div></div>
            <div class="metric-card"><div class="metric-label">Variables</div><div class="metric-value">${escapeHtml(
              `${variable1} vs ${variable2}`
            )}</div></div>
            <div class="metric-card"><div class="metric-label">Saved</div><div class="metric-value">${escapeHtml(
              activeSession ? new Date(activeSession.timestamp).toLocaleString() : 'Current session'
            )}</div></div>
            ${
              selectedPlanDoc
                ? `<div class="metric-card"><div class="metric-label">Protocol / SAP</div><div class="metric-value">${escapeHtml(
                    selectedPlanDoc.name
                  )}</div></div>`
                : ''
            }
            ${
              contextDocNames.length > 0
                ? `<div class="metric-card"><div class="metric-label">Context Documents</div><div class="metric-value">${escapeHtml(
                    contextDocNames.join(', ')
                  )}</div></div>`
                : ''
            }
          </div>
        </div>
      </div>

      ${renderHtmlTable(result.tableConfig)}

      <div class="section code-panel">
        <div class="code-header">
          <span>Source Code</span>
          <span>${result.sasCode ? 'Python + SAS' : 'Python Executed'}</span>
        </div>
        <div class="code-body">${
          result.sasCode
            ? `SAS Validation Code:\n${escapeHtml(result.sasCode)}\n\n`
            : ''
        }Python Execution Code:\n${escapeHtml(result.executedCode)}</div>
      </div>

      <div class="footer">Generated by Evidence CoPilot | Shared HTML report</div>
    </div>
  </body>
</html>`;
  };

  const handleExportHtml = () => {
    if (!result) return;
    const sessionName =
      activeSession?.name ||
      `${testType} - ${variable1}${variable2 ? ` vs ${variable2}` : ''}`;
    const fileName = `${slugifyFileName(sessionName)}.html`;
    downloadHtmlReport(fileName, buildStatisticalReportHtml());
  };

  const availableColumns = useMemo(() => selectedFileData.headers, [selectedFileData]);
  const survivalPreflight = useMemo(() => {
    if (testType !== StatTestType.KAPLAN_MEIER && testType !== StatTestType.COX_PH) return null;
    return buildSurvivalPreflight(selectedFileData.headers, selectedFileData.rows, variable1, variable2);
  }, [selectedFileData, testType, variable1, variable2]);

  const toggleContextDoc = (id: string) => {
    const newSet = new Set(selectedContextIds);
    if (newSet.has(id)) newSet.delete(id);
    else newSet.add(id);
    setSelectedContextIds(newSet);
  };

  const handleGenerateSuggestions = async () => {
    if (!selectedFile) return;
    setIsSuggesting(true);
    
    // Add a timeout to prevent hanging indefinitely
    const timeoutPromise = new Promise<StatSuggestion[]>((_, reject) => {
        setTimeout(() => reject(new Error("Suggestion request timed out")), 180000);
    });

    try {
        const suggs = await Promise.race([
            generateStatisticalSuggestions(selectedFile),
            timeoutPromise
        ]);
        setSuggestions(suggs);
    } catch (e: any) {
        console.error("Suggestion error:", e);
        setErrorMsg(e.message || "AI Suggestion timed out or failed. Please select variables manually.");
    } finally {
        setIsSuggesting(false);
    }
  };

  const applySuggestion = (s: StatSuggestion) => {
      setTestType(s.testType);
      setVariable1(s.var1);
      setVariable2(s.var2);
      setAnalysisConcept(null);
      setActivePlanId(null);
      setWizardExplanation(`Applied AI suggestion: ${s.reason}`);
  };

  const handleAutoPlanFromQuestion = async () => {
    if (!selectedFile) {
      setErrorMsg('Select a dataset first.');
      return;
    }
    if (!analysisQuestion.trim()) {
      setErrorMsg('Enter an analysis question in plain language.');
      return;
    }

    setIsPlanning(true);
    setErrorMsg(null);
    try {
      const customSynonyms = customSynonymsInput
        .split(',')
        .map((s) => s.trim().toLowerCase())
        .filter(Boolean);

      const plan = planAnalysisFromQuestion(selectedFile, analysisQuestion, customSynonyms);
      setTestType(plan.testType);
      setVariable1(plan.var1);
      setVariable2(plan.var2);
      setAnalysisConcept(plan.concept);
      setActivePlanId(null);
      setWizardExplanation(plan.explanation);
    } catch (e: any) {
      setErrorMsg(e.message || 'Failed to auto-configure analysis from the question.');
    } finally {
      setIsPlanning(false);
    }
  };

  const handleExtractPreSpecifiedPlan = async () => {
    if (!selectedFile) {
      setErrorMsg('Select a dataset before extracting pre-specified analysis plan.');
      return;
    }
    if (!selectedPlanDoc) {
      setErrorMsg('Select a Protocol/SAP document first.');
      return;
    }

    setIsExtractingPlan(true);
    setErrorMsg(null);
    try {
      const result = await extractPreSpecifiedAnalysisPlan(selectedPlanDoc, selectedFile);
      setPreSpecifiedPlan(result.plan);
      setPlanNotes(result.notes);
      if (result.plan.length > 0) {
        const first = result.plan[0];
        setActivePlanId(first.id);
        setTestType(first.testType);
        setVariable1(first.var1);
        setVariable2(first.var2);
        setCovariates(first.covariates || []);
        if (first.imputationMethod) setImputationMethod(first.imputationMethod);
        if (typeof first.applyPSM === 'boolean') setApplyPSM(first.applyPSM);
        setEnforcePreSpecifiedPlan(true);
        setWizardExplanation(`Loaded ${result.plan.length} pre-specified analysis item(s) from ${selectedPlanDoc.name}.`);
      }
    } catch (e: any) {
      setErrorMsg(e.message || 'Failed to extract pre-specified analysis plan from document.');
    } finally {
      setIsExtractingPlan(false);
    }
  };

  const applyPreSpecifiedEntry = (entry: AnalysisPlanEntry) => {
    setTestType(entry.testType);
    setVariable1(entry.var1);
    setVariable2(entry.var2);
    setCovariates(entry.covariates || []);
    if (entry.imputationMethod) setImputationMethod(entry.imputationMethod);
    if (typeof entry.applyPSM === 'boolean') setApplyPSM(entry.applyPSM);
    setActivePlanId(entry.id);
    setAnalysisConcept(null);
    setWizardExplanation(`Applied pre-specified analysis: ${entry.name}`);
  };

  function doesCurrentConfigMatchPlan() {
    if (preSpecifiedPlan.length === 0) return true;
    return preSpecifiedPlan.some((entry) => {
      const sameCore =
        entry.testType === testType &&
        entry.var1 === variable1 &&
        entry.var2 === variable2;
      if (!sameCore) return false;
      if (entry.covariates && entry.covariates.length > 0) {
        if (!entry.covariates.every((cov) => covariates.includes(cov))) return false;
      }
      if (entry.imputationMethod && entry.imputationMethod !== imputationMethod) return false;
      if (typeof entry.applyPSM === 'boolean' && entry.applyPSM !== applyPSM) return false;
      return true;
    });
  }

  const applyDetectedSurvivalSetup = () => {
    if (!survivalPreflight?.recommendedGroupVar || !survivalPreflight.recommendedTimeVar) return;
    setVariable1(survivalPreflight.recommendedGroupVar);
    setVariable2(survivalPreflight.recommendedTimeVar);
    setAnalysisConcept(null);
    setActivePlanId(null);
    setWizardExplanation(
      `Detected survival-ready setup: group ${survivalPreflight.recommendedGroupVar}, time ${survivalPreflight.recommendedTimeVar}, censoring ${survivalPreflight.censorColumn || 'not found'}.`
    );
    setErrorMsg(null);
  };

  const confirmedBlockingReason = useMemo(() => {
    if (usageMode !== UsageMode.OFFICIAL) return null;
    if (!selectedPlanDoc) return 'Run Confirmed requires a selected Protocol or SAP document.';
    if (preSpecifiedPlan.length === 0) return 'Run Confirmed requires an extracted pre-specified analysis plan.';
    if (!activePlanId) return 'Run Confirmed requires one extracted plan item to be selected.';
    if (!enforcePreSpecifiedPlan) return 'Run Confirmed requires pre-specified plan enforcement to remain enabled.';
    if (!doesCurrentConfigMatchPlan()) {
      return 'Run Confirmed requires the current configuration to match the selected extracted plan item.';
    }
    return null;
  }, [
    usageMode,
    selectedPlanDoc,
    preSpecifiedPlan,
    activePlanId,
    enforcePreSpecifiedPlan,
    testType,
    variable1,
    variable2,
    covariates,
    imputationMethod,
    applyPSM,
  ]);

  const handleGenerateCode = async () => {
    if (!selectedFile || availableColumns.length === 0) {
      setErrorMsg("Please select a valid file and both analysis variables.");
      return;
    }
    let effectiveVar1 = variable1;
    let effectiveVar2 = variable2;
    if (testType === StatTestType.KAPLAN_MEIER || testType === StatTestType.COX_PH) {
      if (survivalPreflight?.recommendedValidRows && survivalPreflight.recommendedValidRows >= 3) {
        const selectionLooksInvalid =
          !effectiveVar1 ||
          !effectiveVar2 ||
          survivalPreflight.currentValidRows < 3 ||
          survivalPreflight.currentGroupCount < 2;
        if (selectionLooksInvalid && survivalPreflight.recommendedGroupVar && survivalPreflight.recommendedTimeVar) {
          effectiveVar1 = survivalPreflight.recommendedGroupVar;
          effectiveVar2 = survivalPreflight.recommendedTimeVar;
          setVariable1(effectiveVar1);
          setVariable2(effectiveVar2);
          setWizardExplanation(
            `Auto-corrected the survival configuration to use ${effectiveVar1} as the group and ${effectiveVar2} as the time variable with censoring from ${survivalPreflight.censorColumn}.`
          );
        }
      }
      if (!effectiveVar1 || !effectiveVar2) {
        setErrorMsg('Select a survival group and time variable, or use the detected survival setup.');
        return;
      }
    } else if (!effectiveVar1 || !effectiveVar2) {
      setErrorMsg("Please select a valid file and both analysis variables.");
      return;
    }
    if (usageMode === UsageMode.OFFICIAL && confirmedBlockingReason) {
      setErrorMsg(confirmedBlockingReason);
      return;
    }
    if (enforcePreSpecifiedPlan && preSpecifiedPlan.length > 0 && !doesCurrentConfigMatchPlan()) {
      setErrorMsg('Current configuration is outside the extracted pre-specified analysis plan. Disable enforcement or apply a listed plan item.');
      return;
    }
    setIsGenerating(true);
    setErrorMsg(null);
    
    const timeoutPromise = new Promise<string>((_, reject) => {
        setTimeout(() => reject(new Error("Code generation timed out")), 120000);
    });

    try {
      const contextDocs = docFiles.filter(d => selectedContextIds.has(d.id));
      const code = await Promise.race([
          generateStatisticalCode(selectedFile, testType, effectiveVar1, effectiveVar2, contextDocs, covariates, imputationMethod, applyPSM),
          timeoutPromise
      ]);
      setGeneratedCode(code);
      setStep(StatAnalysisStep.CODE_REVIEW);
      setActiveCodeTab('PYTHON');
    } catch (e: any) {
      setErrorMsg(e.message || "Failed to generate code.");
    } finally {
      setIsGenerating(false);
    }
  };

  const handleGenerateSAS = async () => {
      if (!selectedFile || !generatedCode) return;
      setIsGeneratingSas(true);
      
      const timeoutPromise = new Promise<string>((_, reject) => {
          setTimeout(() => reject(new Error("SAS generation timed out")), 120000);
      });

      try {
          const sas = await Promise.race([
              generateSASCode(selectedFile, testType, variable1, variable2, generatedCode, covariates, imputationMethod, applyPSM),
              timeoutPromise
          ]);
          setSasCode(sas);
      } catch (e: any) {
          console.error(e);
          setErrorMsg(e.message || "Failed to generate SAS code.");
      } finally {
          setIsGeneratingSas(false);
      }
  };

  const handleRunAnalysis = async () => {
    setErrorMsg(null);
    if (!selectedFile) {
      setErrorMsg('Selected dataset is missing. Go back and reselect the dataset before execution.');
      return;
    }
    if (!generatedCode.trim()) {
      setErrorMsg('No executable Python code found. Generate code first.');
      return;
    }
    if (usageMode === UsageMode.OFFICIAL && confirmedBlockingReason) {
      setErrorMsg(confirmedBlockingReason);
      return;
    }
    if (enforcePreSpecifiedPlan && preSpecifiedPlan.length > 0 && !doesCurrentConfigMatchPlan()) {
      setErrorMsg('Execution blocked: configuration does not match extracted pre-specified analysis plan.');
      return;
    }
    if (testType === StatTestType.KAPLAN_MEIER || testType === StatTestType.COX_PH) {
      const needsCorrection =
        !variable1 ||
        !variable2 ||
        (survivalPreflight && (survivalPreflight.currentValidRows < 3 || survivalPreflight.currentGroupCount < 2));
      if (needsCorrection && survivalPreflight?.recommendedValidRows && survivalPreflight.recommendedValidRows >= 3 && survivalPreflight.recommendedGroupVar && survivalPreflight.recommendedTimeVar) {
        setVariable1(survivalPreflight.recommendedGroupVar);
        setVariable2(survivalPreflight.recommendedTimeVar);
        setWizardExplanation(
          `Detected survival-ready setup: ${survivalPreflight.recommendedGroupVar} as group, ${survivalPreflight.recommendedTimeVar} as time, censoring from ${survivalPreflight.censorColumn}. Regenerate code before execution so the preview matches the executed analysis.`
        );
        setErrorMsg(
          `Updated the survival variables to ${survivalPreflight.recommendedGroupVar} and ${survivalPreflight.recommendedTimeVar}. Regenerate code before running the analysis.`
        );
        setStep(StatAnalysisStep.CONFIGURATION);
        return;
      }
    }
    setIsRunning(true);
    
    const timeoutPromise = new Promise<StatAnalysisResult>((_, reject) => {
        setTimeout(() => reject(new Error("Analysis execution timed out")), 180000);
    });

    try {
      const res = await Promise.race([
          executeStatisticalCode(generatedCode, selectedFile, testType, variable1, variable2, analysisConcept),
          timeoutPromise
      ]);
      if (res) {
        const enrichedResult = { ...res, sasCode }; // Attach SAS code if generated
        setResult(enrichedResult);
        setStep(StatAnalysisStep.RESULTS);

        // Save Session
        const newSession: AnalysisSession = {
          id: crypto.randomUUID(),
          timestamp: new Date().toISOString(),
          name: analysisConcept
            ? `${testType} - ${analysisConcept.label} by ${variable1}`
            : `${testType} - ${variable1} vs ${variable2 || 'None'}`,
          usageMode: usageMode,
          params: {
            fileId: selectedFileId,
            fileName: selectedFile.name,
            testType,
            var1: variable1,
            var2: variable2,
            covariates,
            imputationMethod,
            applyPSM,
            concept: analysisConcept,
            contextDocIds: Array.from(selectedContextIds),
            selectedPlanDocId: selectedPlanDocId || null,
            preSpecifiedPlan,
            preSpecifiedPlanNotes: planNotes,
            enforcePreSpecifiedPlan,
            sourceWorkflow: 'STATISTICS',
            sourceSessionId: draftSourceSessionId || (activeSessionId !== 'NEW' ? activeSessionId : null),
            preSpecifiedPlanId: activePlanId,
          },
          ...enrichedResult
        };
        setSessions(prev => [newSession, ...prev]);
        setActiveSessionId(newSession.id);
        setDraftSourceSessionId(null);

        // Provenance
        onRecordProvenance({
          id: crypto.randomUUID(),
          timestamp: new Date().toISOString(),
          userId: currentUser.name,
          userRole: currentUser.role,
          actionType: ProvenanceType.STATISTICS,
          details: `Ran ${testType}${analysisConcept ? ` (${analysisConcept.label})` : ''}. Mode: ${usageMode}. Result: ${res.interpretation.substring(0, 50)}...`,
          inputs: [selectedFileId, ...Array.from(selectedContextIds)],
          outputs: []
        });
      }
    } catch (e: any) {
      setErrorMsg(e?.message || "Analysis execution failed.");
    } finally {
      setIsRunning(false);
    }
  };

  const handleDeleteSession = (e: React.MouseEvent, id: string) => {
      e.stopPropagation();
      setSessions(prev => prev.filter(s => s.id !== id));
      if (activeSessionId === id) setActiveSessionId('NEW');
  };

  return (
    <div className="flex h-full bg-slate-50">
      {/* Sidebar History */}
      <div className="w-64 bg-white border-r border-slate-200 flex flex-col">
        <div className="p-4 border-b border-slate-200">
           <button 
             onClick={() => setActiveSessionId('NEW')}
             className="w-full flex items-center justify-center space-x-2 bg-medical-600 text-white py-2.5 rounded-lg hover:bg-medical-700 transition-colors shadow-sm font-medium"
           >
             <Plus className="w-4 h-4" />
             <span>New Analysis</span>
           </button>
        </div>
        <div className="flex-1 overflow-y-auto p-2 space-y-1">
           {sessions.length === 0 && (
             <div className="text-center p-4 text-slate-400 text-sm italic">No analysis history</div>
           )}
           {sessions.map(s => (
             <div 
               key={s.id}
               onClick={() => setActiveSessionId(s.id)}
               className={`group flex items-center justify-between p-3 rounded-lg cursor-pointer transition-all ${
                 activeSessionId === s.id ? 'bg-medical-50 text-medical-700 border border-medical-200' : 'hover:bg-slate-50 text-slate-600 border border-transparent'
               }`}
             >
               <div className="overflow-hidden">
                 <div className="font-medium text-sm truncate">{s.name}</div>
                 <div className="text-xs opacity-70 flex items-center mt-1">
                    <History className="w-3 h-3 mr-1" />
                    {new Date(s.timestamp).toLocaleDateString()}
                 </div>
               </div>
               <button 
                  onClick={(e) => handleDeleteSession(e, s.id)}
                  className="p-1.5 opacity-0 group-hover:opacity-100 hover:bg-red-50 hover:text-red-600 rounded transition-all"
               >
                 <Trash2 className="w-3 h-3" />
               </button>
             </div>
           ))}
        </div>
      </div>

      {/* Main Content Area */}
      <div className="flex-1 overflow-hidden flex flex-col">
        {step === StatAnalysisStep.CONFIGURATION && (
          <div className="flex-1 overflow-y-auto p-8 animate-fadeIn">
             <div className="max-w-4xl mx-auto">
                <div className="mb-8">
                  <h2 className="text-2xl font-bold text-slate-800 flex items-center">
                    <Calculator className="w-6 h-6 mr-3 text-medical-600" />
                    Statistical Configuration
                  </h2>
                  <p className="text-slate-500">Define your test parameters, select data, and choose the right execution path.</p>
                </div>

                {errorMsg && (
                   <div className="mb-6 bg-red-50 text-red-700 p-4 rounded-lg flex items-center border border-red-200">
                     <AlertCircle className="w-5 h-5 mr-3" />
                     {errorMsg}
                   </div>
                )}

                <div className="grid grid-cols-1 lg:grid-cols-3 gap-8">
                   <div className="lg:col-span-2 space-y-6">
                      {/* Step 1: Data Selection */}
                      <div className="bg-white p-6 rounded-xl border border-slate-200 shadow-sm">
                         <h3 className="font-bold text-slate-800 mb-4 flex items-center">
                            <div className="w-6 h-6 rounded-full bg-slate-100 text-slate-500 flex items-center justify-center text-xs mr-3">1</div>
                            Data Source
                         </h3>
                         <div className="space-y-4">
                            <div>
                              <label className="block text-sm font-semibold text-slate-700 mb-2">Select Dataset (Raw, Standardized, or Cohort)</label>
                              <select 
                                value={selectedFileId}
                                onChange={(e) => {
                                  setSelectedFileId(e.target.value);
                                  setAnalysisConcept(null);
                                  setWizardExplanation('');
                                  setVariable1('');
                                  setVariable2('');
                                  setSelectedPlanDocId('');
                                  setPreSpecifiedPlan([]);
                                  setPlanNotes([]);
                                  setEnforcePreSpecifiedPlan(false);
                                  setActivePlanId(null);
                                }}
                                className="w-full p-2.5 border border-slate-300 rounded-lg focus:ring-2 focus:ring-medical-500 outline-none bg-slate-50 text-sm"
                              >
                                <option value="">-- Choose File --</option>
                                {rawFiles.map(f => (
                                  <option key={f.id} value={f.id}>{f.name}</option>
                                ))}
                              </select>
                            </div>
                         </div>
                      </div>

                      {/* Step 2: Protocol Context */}
                      <div className="bg-white p-6 rounded-xl border border-slate-200 shadow-sm">
                          <h3 className="font-bold text-slate-800 mb-4 flex items-center">
                            <div className="w-6 h-6 rounded-full bg-slate-100 text-slate-500 flex items-center justify-center text-xs mr-3">2</div>
                            Protocol Context (RAG)
                         </h3>
                         <p className="text-xs text-slate-500 mb-3">Select documents to ground the code generation (e.g. SAP rules, Exclusion criteria).</p>
                         <div className="max-h-40 overflow-y-auto space-y-2 border border-slate-100 rounded-lg p-2 bg-slate-50">
                            {docFiles.length === 0 && <span className="text-xs text-slate-400 italic">No documents uploaded.</span>}
                            {docFiles.map(doc => (
                                <div 
                                    key={doc.id} 
                                    onClick={() => toggleContextDoc(doc.id)}
                                    className={`flex items-center p-2 rounded cursor-pointer transition-colors ${selectedContextIds.has(doc.id) ? 'bg-indigo-50 border border-indigo-200' : 'hover:bg-white border border-transparent'}`}
                                >
                                    <div className={`w-4 h-4 rounded border mr-3 flex items-center justify-center ${selectedContextIds.has(doc.id) ? 'bg-indigo-600 border-indigo-600' : 'bg-white border-slate-300'}`}>
                                        {selectedContextIds.has(doc.id) && <Check className="w-3 h-3 text-white" />}
                                    </div>
                                    <FileText className="w-4 h-4 text-slate-400 mr-2" />
                                    <span className={`text-sm ${selectedContextIds.has(doc.id) ? 'text-indigo-900 font-medium' : 'text-slate-600'}`}>{doc.name}</span>
                                </div>
                            ))}
                         </div>

                         <div className="mt-4 p-3 border border-emerald-100 rounded-lg bg-emerald-50">
                            <label className="block text-[11px] font-semibold text-emerald-800 uppercase mb-2">
                              Pre-Specified Analysis Plan (Protocol/SAP)
                            </label>
                            <div className="grid grid-cols-1 md:grid-cols-3 gap-2">
                              <select
                                value={selectedPlanDocId}
                                onChange={(e) => setSelectedPlanDocId(e.target.value)}
                                className="md:col-span-2 p-2 border border-emerald-200 rounded text-xs bg-white focus:ring-2 focus:ring-emerald-400 outline-none"
                              >
                                <option value="">-- Select Protocol/SAP Document --</option>
                                {docFiles.map((doc) => (
                                  <option key={doc.id} value={doc.id}>{doc.name}</option>
                                ))}
                              </select>
                              <button
                                onClick={handleExtractPreSpecifiedPlan}
                                disabled={!selectedPlanDoc || !selectedFile || isExtractingPlan}
                                className={`px-3 py-2 rounded text-xs font-bold ${
                                  !selectedPlanDoc || !selectedFile || isExtractingPlan
                                    ? 'bg-slate-200 text-slate-400 cursor-not-allowed'
                                    : 'bg-emerald-600 text-white hover:bg-emerald-700'
                                }`}
                              >
                                {isExtractingPlan ? 'Extracting...' : 'Extract Plan'}
                              </button>
                            </div>

                            <div className="mt-2 flex items-center justify-between">
                              <label className="flex items-center space-x-2 text-xs text-emerald-900 font-medium cursor-pointer">
                                <input
                                  type="checkbox"
                                  checked={enforcePreSpecifiedPlan}
                                  onChange={(e) => setEnforcePreSpecifiedPlan(e.target.checked)}
                                  disabled={preSpecifiedPlan.length === 0 || usageMode === UsageMode.OFFICIAL}
                                  className="rounded border-emerald-300 text-emerald-600 focus:ring-emerald-500"
                                />
                                <span>{usageMode === UsageMode.OFFICIAL ? 'Pre-specified plan enforcement is required in Run Confirmed' : 'Enforce pre-specified plan'}</span>
                              </label>
                              <span className="text-[11px] text-emerald-700">
                                {preSpecifiedPlan.length} item(s)
                              </span>
                            </div>

                            {planNotes.length > 0 && (
                              <div className="mt-2 text-[11px] text-emerald-800 space-y-1">
                                {planNotes.map((note, idx) => (
                                  <div key={idx}>- {note}</div>
                                ))}
                              </div>
                            )}

                            {preSpecifiedPlan.length > 0 && (
                              <div className="mt-3 max-h-40 overflow-y-auto space-y-2">
                                {preSpecifiedPlan.map((entry) => (
                                  <button
                                    key={entry.id}
                                    onClick={() => applyPreSpecifiedEntry(entry)}
                                    className={`w-full text-left p-2 rounded border text-xs transition-colors ${
                                      activePlanId === entry.id
                                        ? 'bg-white border-emerald-400 text-emerald-900'
                                        : 'bg-white border-emerald-200 text-slate-700 hover:border-emerald-300'
                                    }`}
                                  >
                                    <div className="font-semibold">{entry.name}</div>
                                    <div className="mt-1">
                                      {entry.testType}: {entry.var1} vs {entry.var2}
                                    </div>
                                    {entry.rationale && <div className="mt-1 text-[11px] text-slate-500">{entry.rationale}</div>}
                                  </button>
                                ))}
                              </div>
                            )}
                         </div>
                      </div>

                      {/* Step 3: Test Config */}
                      <div className="bg-white p-6 rounded-xl border border-slate-200 shadow-sm relative overflow-hidden">
                         {isSuggesting && <div className="absolute inset-0 bg-white/80 z-10 flex items-center justify-center"><Sparkles className="w-8 h-8 text-indigo-500 animate-pulse" /></div>}
                         <div className="flex justify-between items-center mb-4">
                            <h3 className="font-bold text-slate-800 flex items-center">
                                <div className="w-6 h-6 rounded-full bg-slate-100 text-slate-500 flex items-center justify-center text-xs mr-3">3</div>
                                Analysis Definition
                            </h3>
                            <button 
                                onClick={handleGenerateSuggestions}
                                disabled={!selectedFileId || isSuggesting || usageMode === UsageMode.OFFICIAL}
                                className={`text-xs px-3 py-1.5 rounded-full font-medium transition-colors flex items-center ${
                                  !selectedFileId || isSuggesting || usageMode === UsageMode.OFFICIAL
                                    ? 'bg-slate-100 text-slate-400 cursor-not-allowed'
                                    : 'bg-indigo-50 text-indigo-600 hover:bg-indigo-100'
                                }`}
                            >
                                <Lightbulb className="w-3 h-3 mr-1" />
                                AI Suggest
                            </button>
                         </div>

                         <div className="mb-5 p-4 rounded-lg border border-blue-100 bg-blue-50">
                            <label className="block text-xs font-semibold text-blue-800 uppercase mb-2">
                              Ask In Plain Language
                            </label>
                            {usageMode === UsageMode.OFFICIAL && (
                              <div className="mb-3 rounded-lg border border-amber-200 bg-amber-50 px-3 py-2 text-xs text-amber-900">
                                Run Confirmed does not use free-text planning. Extract and apply a pre-specified analysis item from the Protocol/SAP instead.
                              </div>
                            )}
                            <textarea
                              value={analysisQuestion}
                              onChange={(e) => setAnalysisQuestion(e.target.value)}
                              placeholder="Example: Compare skin rash incidence between treatment arms, including dermatitis and erythema."
                              disabled={usageMode === UsageMode.OFFICIAL}
                              className="w-full p-2.5 border border-blue-200 rounded-lg focus:ring-2 focus:ring-blue-400 outline-none text-sm bg-white disabled:bg-slate-100 disabled:text-slate-400"
                              rows={2}
                            />
                            <div className="mt-2 grid grid-cols-1 md:grid-cols-3 gap-2">
                              <input
                                value={customSynonymsInput}
                                onChange={(e) => setCustomSynonymsInput(e.target.value)}
                                placeholder="Optional synonyms (comma separated)"
                                disabled={usageMode === UsageMode.OFFICIAL}
                                className="md:col-span-2 p-2 border border-blue-200 rounded focus:ring-2 focus:ring-blue-400 outline-none text-xs bg-white disabled:bg-slate-100 disabled:text-slate-400"
                              />
                              <button
                                onClick={handleAutoPlanFromQuestion}
                                disabled={usageMode === UsageMode.OFFICIAL || !selectedFileId || !analysisQuestion.trim() || isPlanning}
                                className={`px-3 py-2 rounded text-xs font-bold transition-colors ${
                                  usageMode === UsageMode.OFFICIAL || !selectedFileId || !analysisQuestion.trim() || isPlanning
                                    ? 'bg-slate-200 text-slate-400 cursor-not-allowed'
                                    : 'bg-blue-600 text-white hover:bg-blue-700'
                                }`}
                              >
                                {isPlanning ? 'Planning...' : 'Auto Configure'}
                              </button>
                            </div>
                            {wizardExplanation && (
                              <p className="mt-3 text-xs text-blue-900">{wizardExplanation}</p>
                            )}
                            {analysisConcept && (
                              <div className="mt-3 p-2 bg-white border border-blue-200 rounded">
                                <p className="text-[11px] font-semibold text-blue-900">
                                  Concept detected: {analysisConcept.label} (source: {analysisConcept.sourceColumn})
                                </p>
                                <p className="text-[11px] text-blue-700 mt-1">
                                  Synonyms used: {analysisConcept.terms.join(', ')}
                                </p>
                                {analysisConcept.matchCounts && Object.keys(analysisConcept.matchCounts).length > 0 && (
                                  <p className="text-[11px] text-blue-700 mt-1">
                                    Dataset matches: {Object.entries(analysisConcept.matchCounts).map(([term, count]) => `${term}(${count})`).join(', ')}
                                  </p>
                                )}
                              </div>
                            )}
                         </div>
                         
                         <div className="grid grid-cols-2 gap-4">
                            <div className="col-span-2">
                               <label className="block text-xs font-semibold text-slate-500 uppercase mb-1">Statistical Test</label>
                               <select 
                                 value={testType}
                                onChange={(e) => {
                                  setTestType(e.target.value as StatTestType);
                                  setAnalysisConcept(null);
                                  setActivePlanId(null);
                                }}
                                 className="w-full p-2 border border-slate-300 rounded focus:ring-2 focus:ring-medical-500 outline-none text-sm"
                               >
                                 {Object.values(StatTestType).map(t => <option key={t} value={t}>{t}</option>)}
                               </select>
                            </div>
                            <div>
                               <label className="block text-xs font-semibold text-slate-500 uppercase mb-1">
                                 {testType === StatTestType.KAPLAN_MEIER || testType === StatTestType.COX_PH
                                   ? 'Variable 1 (Group/Covariate)'
                                   : 'Variable 1 (Group/X)'}
                               </label>
                               <select 
                                 value={variable1}
                                 onChange={(e) => {
                                   setVariable1(e.target.value);
                                   setAnalysisConcept(null);
                                   setActivePlanId(null);
                                 }}
                                 className="w-full p-2 border border-slate-300 rounded focus:ring-2 focus:ring-medical-500 outline-none text-sm"
                               >
                                 <option value="">- Select -</option>
                                 {availableColumns.map(c => <option key={c} value={c}>{c}</option>)}
                               </select>
                            </div>
                            <div>
                               <label className="block text-xs font-semibold text-slate-500 uppercase mb-1">
                                 {testType === StatTestType.CHI_SQUARE
                                   ? 'Variable 2 (Outcome/Event Column)'
                                   : testType === StatTestType.KAPLAN_MEIER || testType === StatTestType.COX_PH
                                     ? 'Variable 2 (Time Variable)'
                                     : 'Variable 2 (Outcome/Y)'}
                               </label>
                               <select 
                                 value={variable2}
                                 onChange={(e) => {
                                   setVariable2(e.target.value);
                                   setAnalysisConcept(null);
                                   setActivePlanId(null);
                                 }}
                                 className="w-full p-2 border border-slate-300 rounded focus:ring-2 focus:ring-medical-500 outline-none text-sm"
                               >
                                 <option value="">- Select -</option>
                                 {availableColumns.map(c => <option key={c} value={c}>{c}</option>)}
                               </select>
                               {(testType === StatTestType.KAPLAN_MEIER || testType === StatTestType.COX_PH) && (
                                 <p className="mt-1 text-[10px] text-slate-500">
                                   Censoring is auto-detected from columns like <span className="font-semibold">CNSR</span>, <span className="font-semibold">STATUS</span>, or <span className="font-semibold">EVENT</span>.
                                 </p>
                               )}
                            </div>
                         </div>

                         {(testType === StatTestType.KAPLAN_MEIER || testType === StatTestType.COX_PH) && survivalPreflight && (
                           <div
                             className={`mt-4 rounded-lg border p-3 ${
                               survivalPreflight.recommendedValidRows >= 3 && survivalPreflight.recommendedGroupCount >= 2
                                 ? survivalPreflight.currentValidRows >= 3 && survivalPreflight.currentGroupCount >= 2
                                   ? 'border-emerald-200 bg-emerald-50'
                                   : 'border-amber-200 bg-amber-50'
                                 : 'border-red-200 bg-red-50'
                             }`}
                           >
                             <div className="flex flex-col gap-3 md:flex-row md:items-start md:justify-between">
                               <div className="text-sm">
                                 <div className="font-semibold text-slate-800">Detected survival setup</div>
                                 <div className="mt-1 text-slate-700">
                                   Group: <span className="font-semibold">{survivalPreflight.recommendedGroupVar || 'Not detected'}</span>
                                   {' '}| Time: <span className="font-semibold">{survivalPreflight.recommendedTimeVar || 'Not detected'}</span>
                                   {' '}| Censoring: <span className="font-semibold">{survivalPreflight.censorColumn || 'Not detected'}</span>
                                 </div>
                                 <div className="mt-1 text-xs text-slate-600">
                                   Valid rows: {survivalPreflight.recommendedValidRows} | Groups: {survivalPreflight.recommendedGroupCount}
                                   {variable1 || variable2 ? ` | Current selection valid rows: ${survivalPreflight.currentValidRows}` : ''}
                                 </div>
                                 {survivalPreflight.currentValidRows < 3 || survivalPreflight.currentGroupCount < 2 ? (
                                   <div className="mt-2 text-xs font-medium text-amber-800">
                                     The current selection does not provide enough valid rows for survival analysis. Use the detected setup to run Kaplan-Meier or Cox on this dataset.
                                   </div>
                                 ) : (
                                   <div className="mt-2 text-xs font-medium text-emerald-800">
                                     The current selection looks valid for survival analysis.
                                   </div>
                                 )}
                               </div>
                               {survivalPreflight.recommendedGroupVar && survivalPreflight.recommendedTimeVar && survivalPreflight.recommendedValidRows >= 3 && survivalPreflight.recommendedGroupCount >= 2 && (
                                 <button
                                   onClick={applyDetectedSurvivalSetup}
                                   type="button"
                                   className="inline-flex items-center justify-center rounded-lg border border-medical-200 bg-white px-3 py-2 text-xs font-bold text-medical-700 hover:bg-medical-50"
                                 >
                                   Use detected survival setup
                                 </button>
                               )}
                             </div>
                           </div>
                         )}

                         {/* Advanced Adjustments Section */}
                         {studyType === StudyType.RWE && (
                             <div className="mt-6 pt-4 border-t border-slate-200">
                                 <h4 className="text-sm font-semibold text-slate-800 mb-3 flex items-center">
                                     <Settings className="w-4 h-4 mr-2 text-slate-500" />
                                     Advanced Adjustments (RWE)
                                 </h4>
                                 <div className="space-y-4">
                                     <div>
                                         <label className="block text-xs font-semibold text-slate-500 uppercase mb-1">Covariates (Confounders)</label>
                                         <select 
                                             multiple
                                             value={covariates}
                                             onChange={(e) => {
                                                 const options = Array.from(e.target.selectedOptions, (option: HTMLOptionElement) => option.value);
                                                 setCovariates(options);
                                             }}
                                             className="w-full p-2 border border-slate-300 rounded focus:ring-2 focus:ring-medical-500 outline-none text-sm h-24"
                                         >
                                             {availableColumns.map(c => <option key={c} value={c}>{c}</option>)}
                                         </select>
                                         <p className="text-[10px] text-slate-400 mt-1">Hold Ctrl/Cmd to select multiple.</p>
                                     </div>
                                     <div className="grid grid-cols-2 gap-4">
                                         <div>
                                             <label className="block text-xs font-semibold text-slate-500 uppercase mb-1">Missing Data Imputation</label>
                                             <select 
                                                 value={imputationMethod}
                                                 onChange={(e) => setImputationMethod(e.target.value)}
                                                 className="w-full p-2 border border-slate-300 rounded focus:ring-2 focus:ring-medical-500 outline-none text-sm"
                                             >
                                                 <option value="None">None (Drop Missing)</option>
                                                 <option value="Mean/Mode Imputation">Mean/Mode Imputation</option>
                                                 <option value="Multiple Imputation (MICE)">Multiple Imputation (MICE)</option>
                                                 <option value="Last Observation Carried Forward (LOCF)">LOCF</option>
                                             </select>
                                         </div>
                                         <div className="flex items-end pb-1">
                                             <label className="flex items-center space-x-2 cursor-pointer">
                                                 <input 
                                                     type="checkbox" 
                                                     checked={applyPSM}
                                                     onChange={(e) => setApplyPSM(e.target.checked)}
                                                     className="rounded border-slate-300 text-medical-600 focus:ring-medical-500"
                                                 />
                                                 <span className="text-sm font-medium text-slate-700">Apply Propensity Score Matching (PSM)</span>
                                             </label>
                                         </div>
                                     </div>
                                 </div>
                             </div>
                         )}
                         
                         {/* Suggestions Display */}
                         {suggestions.length > 0 && (
                             <div className="mt-4 bg-indigo-50 rounded-lg p-3 border border-indigo-100">
                                 <p className="text-xs font-bold text-indigo-700 mb-2 uppercase flex items-center"><Sparkles className="w-3 h-3 mr-1"/> Recommended</p>
                                 <div className="space-y-2">
                                     {suggestions.map((s, idx) => (
                                         <button key={idx} onClick={() => applySuggestion(s)} className="w-full text-left p-2 bg-white rounded border border-indigo-100 hover:border-indigo-300 text-xs flex justify-between items-center group transition-all">
                                             <span className="font-medium text-slate-700">{s.testType}: {s.var1} vs {s.var2}</span>
                                             <ArrowRight className="w-3 h-3 text-indigo-400 opacity-0 group-hover:opacity-100 transition-opacity" />
                                         </button>
                                     ))}
                                 </div>
                             </div>
                         )}
                      </div>
                   </div>

                   <div className="space-y-6">
                       {/* Usage Mode Card */}
                       <div className="bg-white p-6 rounded-xl border border-slate-200 shadow-sm">
                           <h3 className="font-bold text-slate-800 mb-4">Execution Path</h3>
                           <div className="space-y-3">
                               <button 
                                 onClick={() => setUsageMode(UsageMode.EXPLORATORY)}
                                 className={`w-full p-3 rounded-lg border text-left transition-all ${usageMode === UsageMode.EXPLORATORY ? 'bg-blue-50 border-blue-500 ring-1 ring-blue-500' : 'bg-white border-slate-200 hover:bg-slate-50'}`}
                               >
                                   <div className="flex items-center mb-1">
                                       <FlaskConical className={`w-4 h-4 mr-2 ${usageMode === UsageMode.EXPLORATORY ? 'text-blue-600' : 'text-slate-400'}`} />
                                       <span className={`font-bold text-sm ${usageMode === UsageMode.EXPLORATORY ? 'text-blue-800' : 'text-slate-700'}`}>Explore Fast</span>
                                   </div>
                                   <p className="text-xs text-slate-500">Low-friction mode for fast iteration, hypothesis generation, and analyst-led exploration.</p>
                               </button>

                               <button 
                                 onClick={() => setUsageMode(UsageMode.OFFICIAL)}
                                 className={`w-full p-3 rounded-lg border text-left transition-all ${usageMode === UsageMode.OFFICIAL ? 'bg-green-50 border-green-500 ring-1 ring-green-500' : 'bg-white border-slate-200 hover:bg-slate-50'}`}
                               >
                                   <div className="flex items-center mb-1">
                                       <ShieldAlert className={`w-4 h-4 mr-2 ${usageMode === UsageMode.OFFICIAL ? 'text-green-600' : 'text-slate-400'}`} />
                                       <span className={`font-bold text-sm ${usageMode === UsageMode.OFFICIAL ? 'text-green-800' : 'text-slate-700'}`}>Run Confirmed</span>
                                   </div>
                                   <p className="text-xs text-slate-500">Controlled mode for pre-specified analyses. Requires a reviewed Protocol/SAP plan before execution.</p>
                               </button>
                           </div>

                           {usageMode === UsageMode.OFFICIAL && (
                             <div className="mt-4 rounded-xl border border-emerald-200 bg-emerald-50 p-4">
                               <div className="text-[11px] font-semibold uppercase tracking-wide text-emerald-700 mb-2">Run Confirmed Checklist</div>
                               <ul className="space-y-2 text-sm text-slate-700">
                                 <li className="flex items-start gap-2">
                                   <span className={`mt-0.5 h-2.5 w-2.5 rounded-full ${selectedPlanDoc ? 'bg-emerald-500' : 'bg-slate-300'}`} />
                                   <span>{selectedPlanDoc ? `Protocol selected: ${selectedPlanDoc.name}` : 'Select a Protocol or SAP document.'}</span>
                                 </li>
                                 <li className="flex items-start gap-2">
                                   <span className={`mt-0.5 h-2.5 w-2.5 rounded-full ${preSpecifiedPlan.length > 0 ? 'bg-emerald-500' : 'bg-slate-300'}`} />
                                   <span>{preSpecifiedPlan.length > 0 ? `${preSpecifiedPlan.length} extracted plan item(s) loaded.` : 'Extract a pre-specified analysis plan.'}</span>
                                 </li>
                                 <li className="flex items-start gap-2">
                                   <span className={`mt-0.5 h-2.5 w-2.5 rounded-full ${activePlanId ? 'bg-emerald-500' : 'bg-slate-300'}`} />
                                   <span>{activePlanId ? 'A pre-specified plan item is selected.' : 'Select one extracted plan item.'}</span>
                                 </li>
                                 <li className="flex items-start gap-2">
                                   <span className={`mt-0.5 h-2.5 w-2.5 rounded-full ${enforcePreSpecifiedPlan ? 'bg-emerald-500' : 'bg-slate-300'}`} />
                                   <span>Keep pre-specified plan enforcement enabled.</span>
                                 </li>
                               </ul>
                               {confirmedBlockingReason && (
                                 <div className="mt-3 rounded-lg border border-amber-200 bg-amber-50 px-3 py-2 text-sm text-amber-900">
                                   {confirmedBlockingReason}
                                 </div>
                               )}
                             </div>
                           )}
                       </div>

                       <button
                         onClick={handleGenerateCode}
                         disabled={isGenerating || !selectedFileId || !variable1 || !variable2 || availableColumns.length === 0 || Boolean(confirmedBlockingReason)}
                         className={`w-full py-4 rounded-xl font-bold flex items-center justify-center shadow-lg transition-all text-sm ${
                             isGenerating || !selectedFileId || !variable1 || !variable2 || availableColumns.length === 0 || Boolean(confirmedBlockingReason)
                             ? 'bg-slate-800 text-slate-500 cursor-not-allowed'
                             : 'bg-medical-600 text-white hover:bg-medical-700 hover:shadow-xl'
                         }`}
                       >
                         {isGenerating ? <Layout className="w-5 h-5 mr-2 animate-spin" /> : <Code className="w-5 h-5 mr-2" />}
                         {isGenerating ? 'Drafting Code...' : usageMode === UsageMode.OFFICIAL ? 'Generate Confirmed Code' : 'Generate Analysis Code'}
                       </button>
                   </div>
                </div>
             </div>
          </div>
        )}

        {/* STEP 2: CODE REVIEW (PYTHON & SAS) */}
        {step === StatAnalysisStep.CODE_REVIEW && (
           <div className="flex-1 flex flex-col h-full bg-[#1e1e1e]">
               {/* Header Toolbar */}
               <div className="px-6 py-4 bg-[#252526] border-b border-[#3e3e3e] flex justify-between items-center">
                   <div className="flex items-center">
                       <button onClick={() => setStep(StatAnalysisStep.CONFIGURATION)} className="text-slate-400 hover:text-white mr-4">
                           <ArrowLeft className="w-5 h-5" />
                       </button>
                       <div>
                           <h3 className="text-white font-bold flex items-center text-sm">
                               <Terminal className="w-4 h-4 mr-2 text-blue-400" />
                               Review & Execute
                           </h3>
                           <p className="text-[#a0a0a0] text-xs">Review the generated Python code or translate to SAS.</p>
                       </div>
                   </div>
                   
                   <div className="flex items-center space-x-4">
                       <div className="flex bg-[#333] rounded p-1">
                           <button 
                             onClick={() => setActiveCodeTab('PYTHON')}
                             className={`px-3 py-1.5 rounded text-xs font-bold transition-all ${activeCodeTab === 'PYTHON' ? 'bg-blue-600 text-white' : 'text-slate-400 hover:text-white'}`}
                           >
                             Python (Execution)
                           </button>
                           <button 
                             onClick={() => setActiveCodeTab('SAS')}
                             className={`px-3 py-1.5 rounded text-xs font-bold transition-all ${activeCodeTab === 'SAS' ? 'bg-orange-600 text-white' : 'text-slate-400 hover:text-white'}`}
                           >
                             SAS (Validation)
                           </button>
                       </div>

                       <button 
                          onClick={handleRunAnalysis}
                          disabled={isRunning || !canRunAnalysis || Boolean(confirmedBlockingReason)}
                          className={`px-6 py-2 rounded font-bold text-sm flex items-center transition-all ${
                              isRunning || !canRunAnalysis || Boolean(confirmedBlockingReason)
                                ? 'bg-green-800/60 text-green-200/70 cursor-not-allowed'
                                : 'bg-green-600 hover:bg-green-500 text-white'
                          }`}
                       >
                           {isRunning ? <Play className="w-4 h-4 mr-2 animate-spin" /> : <Play className="w-4 h-4 mr-2" />}
                           {isRunning ? 'Executing...' : usageMode === UsageMode.OFFICIAL ? 'Run Confirmed Analysis' : 'Run Analysis'}
                       </button>
                   </div>
               </div>

               {errorMsg && (
                 <div className="mx-6 mt-4 bg-red-900/40 text-red-200 p-3 rounded border border-red-800 flex items-start">
                   <AlertCircle className="w-4 h-4 mr-2 mt-0.5 shrink-0" />
                   <span className="text-xs">{errorMsg}</span>
                 </div>
               )}

               {usageMode === UsageMode.OFFICIAL && (
                 <div
                   className={`mx-6 mt-4 p-3 rounded border flex items-start ${
                     confirmedBlockingReason
                       ? 'bg-amber-900/30 text-amber-100 border-amber-700'
                       : 'bg-emerald-900/30 text-emerald-100 border-emerald-700'
                   }`}
                 >
                   <ShieldAlert className="w-4 h-4 mr-2 mt-0.5 shrink-0" />
                   <span className="text-xs">
                     {confirmedBlockingReason
                       ? confirmedBlockingReason
                       : 'Run Confirmed is active. This execution is locked to the selected pre-specified analysis item.'}
                   </span>
                 </div>
               )}

               {/* Editor Area */}
               <div className="flex-1 flex overflow-hidden">
                   {/* Line Numbers (Fake) */}
                   <div className="w-12 bg-[#1e1e1e] border-r border-[#333] text-[#666] text-right pr-3 pt-4 text-xs font-mono select-none hidden md:block">
                       {Array.from({length: 20}).map((_, i) => <div key={i}>{i+1}</div>)}
                   </div>

                   {/* Code Content */}
                   <div className="flex-1 overflow-auto p-4 font-mono text-sm">
                       {activeCodeTab === 'PYTHON' ? (
                           <textarea 
                             value={generatedCode}
                             onChange={(e) => setGeneratedCode(e.target.value)}
                             className="w-full h-full bg-transparent text-[#d4d4d4] outline-none resize-none"
                             spellCheck={false}
                           />
                       ) : (
                           // SAS View
                           <div className="h-full flex flex-col">
                               {sasCode ? (
                                   <textarea 
                                     value={sasCode}
                                     onChange={(e) => setSasCode(e.target.value)}
                                     className="w-full h-full bg-transparent text-[#d4d4d4] outline-none resize-none"
                                     spellCheck={false}
                                   />
                               ) : (
                                   <div className="flex-1 flex flex-col items-center justify-center text-[#666]">
                                       <Globe className="w-16 h-16 mb-4 opacity-20" />
                                       <p className="mb-6 max-w-md text-center">
                                           Generate SAS code (SAS 9.4+ compatible) equivalent to the current Python logic for regulatory validation.
                                       </p>
                                       <button 
                                         onClick={handleGenerateSAS}
                                         disabled={isGeneratingSas}
                                         className="px-6 py-3 bg-orange-700 hover:bg-orange-600 text-white rounded font-bold transition-colors flex items-center"
                                       >
                                           {isGeneratingSas ? <Sparkles className="w-4 h-4 mr-2 animate-spin" /> : <Code className="w-4 h-4 mr-2" />}
                                           Generate SAS Translation
                                       </button>
                                   </div>
                               )}
                           </div>
                       )}
                   </div>
               </div>
           </div>
        )}

        {/* STEP 3: RESULTS */}
        {step === StatAnalysisStep.RESULTS && result && (
            <div className="flex-1 overflow-y-auto p-8 animate-fadeIn">
                <div className="max-w-6xl mx-auto">
                    {/* Header */}
                    <div className="flex justify-between items-start mb-8">
                        <div>
                             <div className="flex items-center space-x-3 mb-2">
                                <button onClick={() => setStep(StatAnalysisStep.CODE_REVIEW)} className="text-slate-400 hover:text-slate-600">
                                    <ArrowLeft className="w-5 h-5" />
                                </button>
                                <h2 className="text-2xl font-bold text-slate-800">Analysis Results</h2>
                                {usageMode === UsageMode.OFFICIAL && (
                                    <span className="px-2 py-0.5 bg-green-100 text-green-800 text-xs font-bold rounded border border-green-200 flex items-center">
                                        <Lock className="w-3 h-3 mr-1" /> Run Confirmed
                                    </span>
                                )}
                             </div>
                             <p className="text-slate-500">{activeSession?.name}</p>
                        </div>
                        <div className="flex flex-wrap gap-3">
                            <button
                                onClick={handleExportHtml}
                                className="inline-flex items-center justify-center rounded-xl border border-slate-200 bg-white px-4 py-2 text-sm font-semibold text-slate-700 hover:bg-slate-50"
                            >
                                <Download className="w-4 h-4 mr-2" />
                                Export HTML
                            </button>
                        </div>
                    </div>

                    {activeSession?.params.autopilotRunId && (
                        <div className="mb-6 rounded-2xl border border-indigo-200 bg-indigo-50 p-5">
                            <div className="flex flex-col lg:flex-row lg:items-start lg:justify-between gap-4">
                                <div className="min-w-0">
                                    <div className="text-[11px] font-semibold uppercase tracking-wide text-indigo-700 mb-1">
                                        Promoted From Autopilot
                                    </div>
                                    <div className="text-lg font-semibold text-slate-900">
                                        This result came from the Autopilot workspace and is now open in the Statistical Analysis workbench.
                                    </div>
                                    <div className="mt-2 text-sm text-slate-700 leading-6">
                                        Use this view when you want tighter control: inspect the generated code, switch execution path, restore protocol-plan context, or create an editable draft for reruns without changing the original Autopilot result.
                                    </div>
                                    <div className="mt-3 flex flex-wrap gap-2 text-xs text-slate-600">
                                        <span className="rounded-full border border-indigo-200 bg-white px-2.5 py-1 font-semibold">
                                            Run: {activeSession.params.autopilotRunName || activeSession.name}
                                        </span>
                                        {activeSession.params.selectedPlanDocId && (
                                            <span className="rounded-full border border-emerald-200 bg-white px-2.5 py-1 font-semibold">
                                                Protocol context restored
                                            </span>
                                        )}
                                        {activeSession.params.autopilotSourceNames && activeSession.params.autopilotSourceNames.length > 1 && (
                                            <span className="rounded-full border border-slate-200 bg-white px-2.5 py-1 font-semibold">
                                                Linked sources: {activeSession.params.autopilotSourceNames.length}
                                            </span>
                                        )}
                                    </div>
                                </div>
                                <button
                                    onClick={handleCreateEditableDraft}
                                    className="inline-flex items-center justify-center rounded-xl border border-indigo-300 bg-white px-4 py-2 text-sm font-semibold text-indigo-700 hover:bg-indigo-100 shrink-0"
                                >
                                    <Copy className="w-4 h-4 mr-2" />
                                    Create Editable Draft
                                </button>
                            </div>
                        </div>
                    )}
                    
                    <div className="space-y-6">
                        <div className="bg-white p-6 rounded-xl border border-slate-200 shadow-sm">
                            <h3 className="font-bold text-slate-800 mb-4 flex items-center">
                                <BarChart3 className="w-5 h-5 mr-2 text-purple-500" />
                                Visualization
                            </h3>
                            <div className="min-h-[460px]">
                                <Chart data={result.chartConfig.data} layout={result.chartConfig.layout} />
                            </div>
                            <p className="text-center text-xs text-slate-400 mt-4">
                                Figure 1. {activeSession?.name}
                            </p>
                        </div>

                        <div className="grid grid-cols-1 xl:grid-cols-2 gap-6">
                            <div className="bg-indigo-50 p-6 rounded-xl border border-indigo-100 shadow-sm">
                                <h3 className="font-bold text-indigo-900 mb-3 flex items-center">
                                    <Lightbulb className="w-5 h-5 mr-2" />
                                    Clinical Interpretation
                                </h3>
                                <p className="text-indigo-800 text-sm leading-relaxed">
                                    {result.interpretation}
                                </p>
                            </div>

                            {result.aiCommentary ? (
                                <div className="bg-white p-6 rounded-xl border border-slate-200 shadow-sm">
                                    <div className="flex items-center justify-between gap-3 mb-3">
                                        <h3 className="font-bold text-slate-800 flex items-center">
                                            <Sparkles className="w-5 h-5 mr-2 text-indigo-500" />
                                            AI Clinical Commentary
                                        </h3>
                                        <span className="px-2 py-0.5 bg-indigo-50 text-indigo-700 text-[10px] rounded border border-indigo-100 uppercase font-bold">
                                            {result.aiCommentary.source === 'AI' ? 'AI generated' : 'Fallback'}
                                        </span>
                                    </div>
                                    <p className="text-slate-700 text-sm leading-relaxed">
                                        {result.aiCommentary.summary}
                                    </p>
                                    {result.aiCommentary.limitations.length > 0 && (
                                        <div className="mt-4">
                                            <p className="text-xs font-bold uppercase text-slate-500 mb-2">Limitations</p>
                                            <ul className="list-disc pl-5 space-y-1 text-sm text-slate-600">
                                                {result.aiCommentary.limitations.map((item, index) => (
                                                    <li key={index}>{item}</li>
                                                ))}
                                            </ul>
                                        </div>
                                    )}
                                    {result.aiCommentary.caution && (
                                        <div className="mt-4 rounded-lg border border-amber-200 bg-amber-50 px-3 py-2 text-sm text-amber-900">
                                            {result.aiCommentary.caution}
                                        </div>
                                    )}
                                </div>
                            ) : (
                                <div className="bg-slate-50 p-6 rounded-xl border border-dashed border-slate-200 shadow-sm text-sm text-slate-500">
                                    No AI clinical commentary is available for this result.
                                </div>
                            )}
                        </div>

                        <div className="grid grid-cols-1 xl:grid-cols-[minmax(0,1fr)_340px] gap-6">
                            <div className="bg-white p-6 rounded-xl border border-slate-200 shadow-sm">
                                <h3 className="font-bold text-slate-800 mb-4 flex items-center">
                                    <Calculator className="w-5 h-5 mr-2 text-blue-500" />
                                    Calculated Metrics
                                </h3>
                                <div className="grid grid-cols-1 md:grid-cols-2 xl:grid-cols-3 gap-3">
                                    {Object.entries(result.metrics).map(([key, val]) => (
                                        <div key={key} className="rounded-xl border border-slate-200 bg-slate-50 px-4 py-3">
                                            <div className="text-[11px] uppercase tracking-wide font-semibold text-slate-500">{key.replace(/_/g, ' ')}</div>
                                            <div className="mt-1 text-sm font-bold text-slate-800 font-mono break-words">{val}</div>
                                        </div>
                                    ))}
                                </div>
                            </div>

                            <div className="bg-white p-6 rounded-xl border border-slate-200 shadow-sm">
                                <h3 className="font-bold text-slate-800 mb-4">Run Details</h3>
                                <div className="space-y-3 text-sm text-slate-700">
                                    <div className="rounded-xl border border-slate-200 bg-slate-50 px-4 py-3">
                                        <div className="text-[11px] uppercase tracking-wide font-semibold text-slate-500">Analysis</div>
                                        <div className="mt-1 font-medium text-slate-800 break-words">{activeSession?.name}</div>
                                    </div>
                                    <div className="rounded-xl border border-slate-200 bg-slate-50 px-4 py-3">
                                        <div className="text-[11px] uppercase tracking-wide font-semibold text-slate-500">Dataset</div>
                                        <div className="mt-1 font-medium text-slate-800 break-all">{activeSession?.params.fileName}</div>
                                    </div>
                                    <div className="rounded-xl border border-slate-200 bg-slate-50 px-4 py-3">
                                        <div className="text-[11px] uppercase tracking-wide font-semibold text-slate-500">Variables</div>
                                        <div className="mt-1 font-medium text-slate-800 break-words">{variable1} vs {variable2}</div>
                                    </div>
                                    <div className="rounded-xl border border-slate-200 bg-slate-50 px-4 py-3">
                                        <div className="text-[11px] uppercase tracking-wide font-semibold text-slate-500">Saved</div>
                                        <div className="mt-1 font-medium text-slate-800">
                                            {activeSession ? new Date(activeSession.timestamp).toLocaleString() : 'Current session'}
                                        </div>
                                    </div>
                                </div>
                            </div>
                        </div>

                        <div className="bg-slate-900 rounded-xl overflow-hidden shadow-sm">
                            <div className="bg-slate-800 px-4 py-2 border-b border-slate-700 flex justify-between items-center">
                                <span className="text-slate-400 text-xs font-bold uppercase">Source Code</span>
                                <div className="flex space-x-2">
                                    {result.sasCode && (
                                        <span className="px-2 py-0.5 bg-orange-900 text-orange-200 text-[10px] rounded border border-orange-700">SAS Available</span>
                                    )}
                                    <span className="px-2 py-0.5 bg-blue-900 text-blue-200 text-[10px] rounded border border-blue-700">Python Executed</span>
                                </div>
                            </div>
                            <div className="max-h-60 overflow-auto p-4">
                                 {result.sasCode && (
                                     <div className="mb-4">
                                         <p className="text-xs text-orange-400 mb-1 font-bold">SAS Validation Code:</p>
                                         <pre className="font-mono text-xs text-orange-100 opacity-80 whitespace-pre-wrap">{result.sasCode}</pre>
                                     </div>
                                 )}
                                 <p className="text-xs text-blue-400 mb-1 font-bold">Python Execution Code:</p>
                                 <pre className="font-mono text-xs text-slate-300 whitespace-pre-wrap">{result.executedCode}</pre>
                            </div>
                        </div>
                    </div>
                </div>
            </div>
        )}
      </div>
    </div>
  );
};
