import React, { useMemo, useState } from 'react';
import { Users, FileWarning, Database, Activity, Clock, FileCheck, AlertTriangle, FileText, HeartPulse, Layout, Filter, Globe, MessageSquareText, Bot, BarChart2, ArrowRight, FileInput, CheckCircle2, Lock } from 'lucide-react';
import { ClinicalFile, ProvenanceRecord, DataType, User, StudyType } from '../types';
import { Chart } from './Chart';

interface DashboardProps {
  files: ClinicalFile[];
  provenance: ProvenanceRecord[];
  onNavigate: (view: any) => void;
  currentUser?: User;
  studyType: StudyType;
}

export const Dashboard: React.FC<DashboardProps> = ({ files, provenance, onNavigate, currentUser, studyType }) => {
  const [viewMode, setViewMode] = useState<'OPS' | 'CLINICAL'>('OPS');
  const studyTypeLabel = studyType === StudyType.RCT ? 'Clinical Trial' : 'Real-World Evidence';
  const isQcApplicable = (file: ClinicalFile) =>
    file.metadata?.qcApplicable !== undefined
      ? Boolean(file.metadata?.qcApplicable)
      : file.type === DataType.RAW || file.type === DataType.STANDARDIZED || file.type === DataType.COHORT_DEF;

  // 1. Calculate Metrics
  const metrics = useMemo(() => {
    let subjectCount = 0;
    let aeCount = 0;
    let seriousAE = 0;
    let totalIssues = 0;
    let qcFailures = 0;
    let ingestionEvents = provenance.filter(p => p.actionType === 'INGESTION').length;
    let cohortEvents = provenance.filter(p => p.actionType === 'COHORT_CREATION').length;
    let uniqueStudies = new Set(files.map(f => f.studyId).filter(Boolean)).size;
    
    files.forEach(f => {
      if (!isQcApplicable(f)) return;
      if (f.qcIssues) totalIssues += f.qcIssues.length;
      if (f.qcStatus === 'FAIL' || f.qcStatus === 'WARN') qcFailures++;
      
      if (f.content && f.type !== DataType.DOCUMENT) {
        const lines = f.content.trim().split('\n');
        if (lines.length > 1) {
            // Check for DM or Demographics
            if (f.name.toLowerCase().includes('dm') || f.name.toLowerCase().includes('demo')) {
                subjectCount += (lines.length - 1);
            }
            // Check for AE
            if (f.name.toLowerCase().includes('ae') || f.name.toLowerCase().includes('adverse')) {
                const count = lines.length - 1;
                aeCount += count;
                // Fake serious calc based on data snippet presence
                seriousAE += Math.floor(count * 0.15); 
            }
        }
      }
    });

    return { subjectCount, aeCount, totalIssues, seriousAE, qcFailures, ingestionEvents, cohortEvents, uniqueStudies };
  }, [files, provenance]);

  // 2. Prepare Charts
  const chartConfig = useMemo(() => {
    if (viewMode === 'OPS') {
        const counts = { PASS: 0, WARN: 0, FAIL: 0, PENDING: 0 };
        files.forEach(f => {
            if (!isQcApplicable(f)) return;
            if (f.qcStatus) counts[f.qcStatus]++;
            else counts.PENDING++;
        });

        return {
            data: [{
                values: [counts.PASS, counts.WARN, counts.FAIL],
                labels: ['Pass', 'Warning', 'Fail'],
                type: 'pie',
                marker: { colors: ['#22c55e', '#eab308', '#ef4444'] },
                hole: 0.4,
                textinfo: 'label+value',
                showlegend: true
            }],
            layout: { 
                height: 300, 
                margin: { t: 20, b: 20, l: 20, r: 20 },
                showlegend: true,
                legend: { orientation: 'h', y: -0.1 }
            }
        };
    } else {
        // Clinical View: Adverse Events by Body System (Mock)
        return {
            data: [{
                x: ['Cardiac', 'Gastro', 'Nervous', 'Skin', 'General'],
                y: [metrics.aeCount * 0.1, metrics.aeCount * 0.4, metrics.aeCount * 0.2, metrics.aeCount * 0.1, metrics.aeCount * 0.2],
                type: 'bar',
            marker: { color: studyType === StudyType.RCT ? '#3385d7' : '#d97706' }
            }],
            layout: {
                height: 300,
                margin: { t: 20, b: 40, l: 40, r: 20 },
                xaxis: { title: 'System Organ Class' },
                yaxis: { title: 'Event Count' }
            }
        };
    }
  }, [files, viewMode, metrics, studyType]);

  const MetricCard = ({ title, value, icon: Icon, color, subtext }: any) => (
    <div className="bg-white p-6 rounded-xl border border-slate-200 shadow-sm flex items-start space-x-4">
      <div className={`p-3 rounded-lg ${color} bg-opacity-10 text-opacity-100`}>
        <Icon className={`w-6 h-6 ${color.replace('bg-', 'text-')}`} />
      </div>
      <div>
        <p className="text-sm font-medium text-slate-500">{title}</p>
        <h3 className="text-2xl font-bold text-slate-800 mt-1">{value}</h3>
        {subtext && <p className="text-xs text-slate-400 mt-1">{subtext}</p>}
      </div>
    </div>
  );

  const analysisReadyFileCount = useMemo(
    () =>
      files.filter(
        (file) =>
          (file.type === DataType.RAW || file.type === DataType.STANDARDIZED || file.type === DataType.COHORT_DEF) &&
          Boolean(file.content?.trim())
      ).length,
    [files]
  );
  const hasAnalysisReadyData = analysisReadyFileCount > 0;

  const firstStepCard = {
    title: 'Ingestion & QC',
    helper: 'Start here',
    description:
      'Upload datasets, run quality checks, and establish the files that the scientific workflows can actually use.',
    cta: hasAnalysisReadyData ? 'Review Data Ops' : 'Start Ingestion',
    view: 'INGESTION',
    icon: FileInput,
    accent: 'border-emerald-200 bg-emerald-50 text-emerald-700',
    button: 'bg-medical-600 hover:bg-medical-700',
    status: hasAnalysisReadyData
      ? `${analysisReadyFileCount} analysis-ready file${analysisReadyFileCount === 1 ? '' : 's'} detected`
      : 'No analysis-ready datasets yet',
  } as const;

  const workflowCards = [
    {
      title: 'AI Chat',
      helper: 'Help me understand what to do and what happened',
      description: 'Use after ingestion when you are unsure which dataset, workflow, or result matters. Best for explanation, comparison, and next-step guidance.',
      cta: 'Open AI Chat',
      view: 'ANALYSIS',
      icon: MessageSquareText,
      accent: 'border-slate-200 bg-white text-slate-700',
      button: 'bg-medical-600 hover:bg-medical-700',
    },
    {
      title: 'Autopilot',
      helper: 'Do work for me',
      description: 'Best for fast first-pass analysis packs, exploratory scans, and linked-workspace signal finding with minimal setup.',
      cta: 'Open Autopilot',
      view: 'AUTOPILOT',
      icon: Bot,
      accent: 'border-medical-200 bg-medical-50 text-medical-700',
      button: 'bg-medical-600 hover:bg-medical-700',
    },
    {
      title: 'Statistical Analysis',
      helper: 'Let me control the work',
      description: 'Best for controlled reruns, variable selection, code review, and Run Confirmed execution against a reviewed plan.',
      cta: 'Open Statistics',
      view: 'STATISTICS',
      icon: BarChart2,
      accent: 'border-amber-200 bg-amber-50 text-amber-800',
      button: 'bg-medical-600 hover:bg-medical-700',
    },
  ] as const;
  const FirstStepIcon = firstStepCard.icon;

  return (
    <div className="p-8 h-full overflow-y-auto bg-brand-shell">
      {/* Header */}
      <div className="flex flex-col md:flex-row md:items-center justify-between mb-8">
        <div>
          <h2 className="text-2xl font-bold text-slate-800 flex items-center">
            <Layout className="w-6 h-6 mr-3 text-slate-700" />
            Study Dashboard
            <span className={`ml-3 px-2 py-0.5 rounded text-xs font-bold border ${
                studyType === StudyType.RCT ? 'bg-medical-50 text-medical-700 border-medical-200' : 'bg-amber-50 text-amber-800 border-amber-200'
            }`}>
                {studyTypeLabel}
            </span>
            {metrics.uniqueStudies > 1 && (
              <span className="ml-2 px-2 py-0.5 rounded text-xs font-bold border bg-indigo-50 text-indigo-700 border-indigo-200 flex items-center">
                <Globe className="w-3 h-3 mr-1" />
                CROSS-TRIAL ({metrics.uniqueStudies} STUDIES)
              </span>
            )}
          </h2>
          <p className="text-slate-500">
             Welcome back, {currentUser?.name}. 
             {viewMode === 'OPS' ? ' Monitoring Data Quality & Pipelines.' : ' Reviewing Clinical Safety & Efficacy.'}
          </p>
        </div>
        
        <div className="flex bg-white rounded-lg p-1 border border-slate-200 shadow-sm mt-4 md:mt-0">
            <button
                onClick={() => setViewMode('OPS')}
                className={`px-4 py-2 rounded-md text-sm font-bold flex items-center transition-all ${
                    viewMode === 'OPS' 
                    ? 'bg-slate-100 text-slate-800 shadow-inner' 
                    : 'text-slate-400 hover:text-slate-600'
                }`}
            >
                <Database className="w-4 h-4 mr-2" />
                Data Ops
            </button>
            <div className="w-px bg-slate-200 mx-1 my-1"></div>
            <button
                onClick={() => setViewMode('CLINICAL')}
                className={`px-4 py-2 rounded-md text-sm font-bold flex items-center transition-all ${
                    viewMode === 'CLINICAL' 
                    ? 'bg-medical-50 text-medical-700 shadow-inner' 
                    : 'text-slate-400 hover:text-slate-600'
                }`}
            >
                <HeartPulse className="w-4 h-4 mr-2" />
                Scientific
            </button>
        </div>
      </div>

      {/* Metrics Grid - DYNAMIC BASED ON STUDY TYPE */}
      <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-4 gap-6 mb-8 animate-fadeIn">
        {viewMode === 'OPS' ? (
            <>
                <MetricCard 
                    title="Total Files" 
                    value={files.length} 
                    icon={FileText} 
                    color="bg-blue-500 text-blue-600" 
                    subtext={`${metrics.ingestionEvents} ingestions tracked`}
                />
                <MetricCard 
                    title="QC Issues" 
                    value={metrics.totalIssues} 
                    icon={FileWarning} 
                    color="bg-orange-500 text-orange-600" 
                    subtext={`${metrics.qcFailures} files require attention`}
                />
                
                {/* DYNAMIC CARD 3 */}
                {studyType === StudyType.RCT ? (
                     <MetricCard 
                        title="ETL Pipelines" 
                        value={provenance.filter(p => p.actionType === 'TRANSFORMATION').length} 
                        icon={Activity} 
                        color="bg-green-500 text-green-600" 
                        subtext="SDTM Conversions"
                    />
                ) : (
                    <MetricCard 
                        title="Cohorts Built" 
                        value={metrics.cohortEvents} 
                        icon={Filter} 
                        color="bg-purple-500 text-purple-600" 
                        subtext="Filters applied"
                    />
                )}

                <MetricCard 
                    title="Validation Rate" 
                    value="92%" 
                    icon={FileCheck} 
                    color="bg-slate-500 text-slate-600" 
                    subtext="18/20 Files Validated"
                />
            </>
        ) : (
            <>
                <MetricCard 
                    title={studyType === StudyType.RCT ? "Enrolled Subjects" : "Total Lives"} 
                    value={metrics.subjectCount} 
                    icon={Users} 
                    color="bg-indigo-500 text-indigo-600" 
                    subtext={studyType === StudyType.RCT ? "Across 3 sites" : "Real-World Data"}
                />
                <MetricCard 
                    title="Total AEs" 
                    value={metrics.aeCount} 
                    icon={Activity} 
                    color="bg-yellow-500 text-yellow-600" 
                    subtext="Events Reported"
                />
                <MetricCard 
                    title="Serious AEs" 
                    value={metrics.seriousAE} 
                    icon={AlertTriangle} 
                    color="bg-red-500 text-red-600" 
                    subtext="Requires Expedited Reporting"
                />
                <MetricCard 
                    title={studyType === StudyType.RCT ? "Avg. Time on Study" : "Data Sources"} 
                    value={studyType === StudyType.RCT ? "42 Days" : "5 Registries"} 
                    icon={studyType === StudyType.RCT ? Clock : Globe} 
                    color="bg-teal-500 text-teal-600" 
                    subtext={studyType === StudyType.RCT ? "Cohort 1" : "Harmonized"}
                />
            </>
        )}
      </div>

      <div className="mb-8 bg-white border border-slate-200 rounded-2xl p-6 shadow-sm">
        <div className="flex flex-col lg:flex-row lg:items-end lg:justify-between gap-4 mb-5">
          <div>
            <div className="text-xs font-semibold uppercase tracking-wide text-slate-500 mb-2">Workflow Guide</div>
            <h3 className="text-xl font-bold text-slate-800">
              {hasAnalysisReadyData ? 'Follow the workflow in the right order' : 'Start with data ingestion'}
            </h3>
            <p className="text-sm text-slate-500 mt-1 max-w-3xl">
              {hasAnalysisReadyData
                ? 'Begin with Ingestion & QC to confirm usable data, then use AI Chat for orientation, Autopilot for a first-pass analysis pack, and Statistical Analysis for controlled reruns or confirmed execution.'
                : 'No scientific workflow is meaningful until datasets are uploaded and checked. Start with Ingestion & QC, then move into AI Chat, Autopilot, or Statistical Analysis once data is ready.'}
            </p>
          </div>
          <div className="rounded-xl border border-slate-200 bg-slate-50 px-4 py-3 text-sm text-slate-600 max-w-lg">
            Recommended order: <span className="font-semibold text-slate-800">Ingestion & QC</span> first,
            then <span className="font-semibold text-slate-800">AI Chat</span> to orient,
            then <span className="font-semibold text-slate-800">Autopilot</span> for a first pass,
            then <span className="font-semibold text-slate-800">Statistical Analysis</span> when you need reviewable control.
          </div>
        </div>

        <div className="grid grid-cols-1 xl:grid-cols-4 gap-4">
          <div className="rounded-2xl border border-slate-200 bg-slate-50 p-5 flex flex-col">
            <div className={`inline-flex items-center rounded-full border px-3 py-1 text-[11px] font-semibold uppercase tracking-wide ${firstStepCard.accent}`}>
              <FirstStepIcon className="w-3.5 h-3.5 mr-2" />
              Step 1 · {firstStepCard.title}
            </div>
            <div className="mt-4 text-lg font-bold text-slate-800">{firstStepCard.helper}</div>
            <p className="mt-2 text-sm leading-6 text-slate-600 flex-1">{firstStepCard.description}</p>
            <div className="mt-4 inline-flex items-center rounded-full border border-slate-200 bg-white px-3 py-1 text-[11px] font-semibold uppercase tracking-wide text-slate-600">
              {hasAnalysisReadyData ? <CheckCircle2 className="w-3.5 h-3.5 mr-2 text-emerald-600" /> : <Lock className="w-3.5 h-3.5 mr-2 text-slate-400" />}
              {firstStepCard.status}
            </div>
            <button
              onClick={() => onNavigate(firstStepCard.view as any)}
              className={`mt-5 inline-flex items-center justify-center rounded-xl px-4 py-3 text-sm font-semibold text-white transition-colors ${firstStepCard.button}`}
            >
              {firstStepCard.cta}
              <ArrowRight className="w-4 h-4 ml-2" />
            </button>
          </div>

          {workflowCards.map((card) => {
            const Icon = card.icon;
            const isLocked = !hasAnalysisReadyData;
            return (
              <div key={card.title} className={`rounded-2xl border p-5 flex flex-col ${isLocked ? 'border-slate-200 bg-slate-100/80' : 'border-slate-200 bg-slate-50'}`}>
                <div className={`inline-flex items-center rounded-full border px-3 py-1 text-[11px] font-semibold uppercase tracking-wide ${card.accent}`}>
                  <Icon className="w-3.5 h-3.5 mr-2" />
                  Step 2 · {card.title}
                </div>
                <div className="mt-4 text-lg font-bold text-slate-800">{card.helper}</div>
                <p className="mt-2 text-sm leading-6 text-slate-600 flex-1">
                  {isLocked ? 'Upload and QC at least one dataset first. This workflow becomes useful only after data ingestion.' : card.description}
                </p>
                <div className="mt-4 inline-flex items-center rounded-full border border-slate-200 bg-white px-3 py-1 text-[11px] font-semibold uppercase tracking-wide text-slate-600">
                  {isLocked ? (
                    <>
                      <Lock className="w-3.5 h-3.5 mr-2 text-slate-400" />
                      Requires Ingestion & QC
                    </>
                  ) : (
                    <>
                      <CheckCircle2 className="w-3.5 h-3.5 mr-2 text-emerald-600" />
                      Ready to use
                    </>
                  )}
                </div>
                <button
                  onClick={() => onNavigate((isLocked ? 'INGESTION' : card.view) as any)}
                  className={`mt-5 inline-flex items-center justify-center rounded-xl px-4 py-3 text-sm font-semibold text-white transition-colors ${
                    isLocked ? 'bg-slate-400 hover:bg-slate-500' : card.button
                  }`}
                >
                  {isLocked ? 'Go to Ingestion & QC' : card.cta}
                  <ArrowRight className="w-4 h-4 ml-2" />
                </button>
              </div>
            );
          })}
        </div>
      </div>

      {/* Charts Section */}
      <div className="grid grid-cols-1 lg:grid-cols-3 gap-8">
          <div className="lg:col-span-2 bg-white p-6 rounded-xl border border-slate-200 shadow-sm">
              <h3 className="font-bold text-slate-800 mb-4">
                  {viewMode === 'OPS' ? 'Data Quality Overview' : (studyType === StudyType.RCT ? 'Safety Signals Overview' : 'Real-World Outcomes')}
              </h3>
              <div className="h-64 w-full">
                  <Chart data={chartConfig.data} layout={chartConfig.layout} />
              </div>
          </div>

          <div className="bg-white p-6 rounded-xl border border-slate-200 shadow-sm">
              <h3 className="font-bold text-slate-800 mb-4">
                  {viewMode === 'OPS' ? 'Recent Activity' : 'Key Findings'}
              </h3>
              <div className="space-y-4 max-h-[300px] overflow-y-auto pr-2">
                  {viewMode === 'OPS' ? (
                      provenance.slice().reverse().slice(0, 5).map((rec, i) => (
                          <div key={i} className="flex items-start pb-3 border-b border-slate-50 last:border-0">
                              <div className={`mt-1 w-2 h-2 rounded-full mr-3 ${
                                  rec.actionType === 'INGESTION' ? 'bg-blue-400' : 
                                  rec.actionType === 'TRANSFORMATION' ? 'bg-green-400' : 
                                  rec.actionType === 'COHORT_CREATION' ? 'bg-amber-400' :
                                  'bg-slate-400'
                              }`} />
                              <div>
                                  <p className="text-sm font-medium text-slate-700">{rec.actionType}</p>
                                  <p className="text-xs text-slate-500 truncate w-40">{rec.details}</p>
                                  <p className="text-[10px] text-slate-400 mt-1">{new Date(rec.timestamp).toLocaleTimeString()}</p>
                              </div>
                          </div>
                      ))
                  ) : (
                      <ul className="space-y-3">
                          <li className="p-3 bg-red-50 rounded-lg border border-red-100">
                              <div className="flex items-center text-red-700 text-xs font-bold uppercase mb-1">
                                  <AlertTriangle className="w-3 h-3 mr-1" /> Safety Alert
                              </div>
                              <p className="text-sm text-slate-700">Abnormal LFTs detected in Site 002 (Subject 002-105).</p>
                          </li>
                          <li className="p-3 bg-medical-50 rounded-lg border border-medical-100">
                              <div className="flex items-center text-medical-700 text-xs font-bold uppercase mb-1">
                                  <Activity className="w-3 h-3 mr-1" /> Insight
                              </div>
                              <p className="text-sm text-slate-700">Enrollment rate for Females is 15% lower than Protocol target.</p>
                          </li>
                          <li className="p-3 bg-green-50 rounded-lg border border-green-100">
                              <div className="flex items-center text-green-700 text-xs font-bold uppercase mb-1">
                                  <FileCheck className="w-3 h-3 mr-1" /> Review
                              </div>
                              <p className="text-sm text-slate-700">Bias Audit for 'Oncology Cohort A' Passed with score 92.</p>
                          </li>
                      </ul>
                  )}
              </div>
          </div>
      </div>
    </div>
  );
};
