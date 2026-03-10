import React, { useMemo, useState } from 'react';
import { createPortal } from 'react-dom';
import { Upload, FileText, Database, Code, Trash2, Activity, AlertTriangle, CheckCircle, XCircle, Eye, Loader2, Sparkles, ArrowRight, Play, AlertCircle, CheckSquare, Square, FileSearch, X, Info, Download, Maximize2, Minimize2 } from 'lucide-react';
import { ClinicalFile, DataType, QCStatus, QCIssue, CleaningSuggestion } from '../types';
import { runQualityCheck, generateCleaningSuggestion, applyCleaning } from '../services/geminiService';
import { parseCsv } from '../utils/dataProcessing';
import { buildWorkbookSheetPreviews, planWorkbookImport, type WorkbookImportMode, type WorkbookSheetPreview } from '../utils/workbookImport';

// Declare XLSX and PDFJS for TypeScript
declare global {
  interface Window {
    XLSX: any;
    pdfjsLib: any;
  }
}

interface IngestionProps {
  files: ClinicalFile[];
  onAddFile: (file: ClinicalFile) => void;
  onRemoveFile: (id: string) => void;
}

const isQcApplicableType = (type: DataType): boolean =>
  type === DataType.RAW || type === DataType.STANDARDIZED || type === DataType.COHORT_DEF;

const resolveUploadType = (
  fileName: string,
  selectedTab: DataType
): { resolvedType: DataType; notice: string | null } => {
  const lower = fileName.toLowerCase();
  const isPdf = lower.endsWith('.pdf');
  const looksLikeStudyDoc = /(protocol|sap|analysis plan|charter|report)/i.test(lower);

  if (isPdf || looksLikeStudyDoc) {
    if (selectedTab !== DataType.DOCUMENT) {
      return {
        resolvedType: DataType.DOCUMENT,
        notice: `${fileName} was classified as Document based on file type/name.`,
      };
    }
    return { resolvedType: DataType.DOCUMENT, notice: null };
  }

  return { resolvedType: selectedTab, notice: null };
};

// Helper to extract row indices from QC issues
const getAffectedRowIndices = (issues: QCIssue[] | undefined): Map<number, 'HIGH' | 'MEDIUM' | 'LOW'> => {
  const map = new Map<number, 'HIGH' | 'MEDIUM' | 'LOW'>();
  if (!issues) return map;

  issues.forEach(issue => {
    if (!issue.affectedRows) return;
    const matches = issue.affectedRows.match(/\d+/g);
    if (matches) {
      matches.forEach(m => {
        const rowNum = parseInt(m, 10);
        const currentSev = map.get(rowNum);
        if (!currentSev) {
            map.set(rowNum, issue.severity);
        } else if (issue.severity === 'HIGH') {
            map.set(rowNum, 'HIGH');
        } else if (issue.severity === 'MEDIUM' && currentSev === 'LOW') {
            map.set(rowNum, 'MEDIUM');
        }
      });
    }
  });
  return map;
};

const isIssueAutoFixable = (issue: QCIssue): boolean => {
  if (typeof issue.autoFixable === 'boolean') return issue.autoFixable;
  return !/missing critical columns|failed to parse dataset/i.test(issue.description);
};

export const Ingestion: React.FC<IngestionProps> = ({ files, onAddFile, onRemoveFile }) => {
  const [activeTab, setActiveTab] = useState<DataType>(DataType.RAW);
  const [dragActive, setDragActive] = useState(false);
  const [processingId, setProcessingId] = useState<string | null>(null);
  const [parseError, setParseError] = useState<string | null>(null);
  const [uploadNotice, setUploadNotice] = useState<string | null>(null);
  const [isParsing, setIsParsing] = useState(false);
  
  // QC Modal State
  const [qcModalOpen, setQcModalOpen] = useState(false);
  const [selectedQCFile, setSelectedQCFile] = useState<ClinicalFile | null>(null);

  // Preview Modal State
  const [previewFile, setPreviewFile] = useState<ClinicalFile | null>(null);
  const [isPreviewMaximized, setIsPreviewMaximized] = useState(false);

  // Workbook Import State
  const [workbookModalOpen, setWorkbookModalOpen] = useState(false);
  const [pendingWorkbookName, setPendingWorkbookName] = useState<string | null>(null);
  const [pendingWorkbookType, setPendingWorkbookType] = useState<DataType | null>(null);
  const [pendingWorkbookSheets, setPendingWorkbookSheets] = useState<WorkbookSheetPreview[]>([]);
  const [selectedWorkbookSheetIds, setSelectedWorkbookSheetIds] = useState<Set<string>>(new Set());
  const [workbookImportMode, setWorkbookImportMode] = useState<WorkbookImportMode>('SEPARATE');

  // Remediation State
  const [selectedIssueIndices, setSelectedIssueIndices] = useState<Set<number>>(new Set());
  const [isFixing, setIsFixing] = useState(false);
  const [cleaningProposal, setCleaningProposal] = useState<CleaningSuggestion | null>(null);
  
  // Granular Apply Status
  const [applyStage, setApplyStage] = useState<string>('');
  const [applyError, setApplyError] = useState<string | null>(null);
  const [fixNotice, setFixNotice] = useState<string | null>(null);

  const selectedIssues = selectedQCFile?.qcIssues?.filter((_, idx) => selectedIssueIndices.has(idx)) || [];
  const workbookMergeAllowed =
    pendingWorkbookType === DataType.RAW ||
    pendingWorkbookType === DataType.STANDARDIZED ||
    pendingWorkbookType === DataType.COHORT_DEF;
  const workbookImportPlan = useMemo(
    () =>
      pendingWorkbookName && pendingWorkbookType
        ? planWorkbookImport(
            pendingWorkbookName,
            pendingWorkbookSheets,
            Array.from(selectedWorkbookSheetIds),
            workbookMergeAllowed ? workbookImportMode : 'SEPARATE',
            pendingWorkbookType
          )
        : null,
    [pendingWorkbookName, pendingWorkbookType, pendingWorkbookSheets, selectedWorkbookSheetIds, workbookImportMode, workbookMergeAllowed]
  );
  const tabConfig: Array<{ type: DataType; label: string }> = [
    { type: DataType.RAW, label: 'Raw' },
    { type: DataType.MAPPING, label: 'Reference' },
    { type: DataType.STANDARDIZED, label: 'Standardized' },
    { type: DataType.DOCUMENT, label: 'Document' },
  ];

  const handleDrag = (e: React.DragEvent) => {
    e.preventDefault();
    e.stopPropagation();
    if (e.type === "dragenter" || e.type === "dragover") {
      setDragActive(true);
    } else if (e.type === "dragleave") {
      setDragActive(false);
    }
  };

  const handleDrop = (e: React.DragEvent) => {
    e.preventDefault();
    e.stopPropagation();
    setDragActive(false);
    if (e.dataTransfer.files && e.dataTransfer.files.length > 0) {
      (Array.from(e.dataTransfer.files) as File[]).forEach(file => handleFile(file));
    }
  };

  const handleChange = (e: React.ChangeEvent<HTMLInputElement>) => {
    e.preventDefault();
    if (e.target.files && e.target.files.length > 0) {
      (Array.from(e.target.files) as File[]).forEach(file => handleFile(file));
    }
  };

  const extractPdfText = async (file: File): Promise<string> => {
    if (!window.pdfjsLib) throw new Error("PDF Library failed to load. Please check your internet connection or disable ad blockers.");
    const arrayBuffer = await file.arrayBuffer();
    const pdf = await window.pdfjsLib.getDocument({ data: arrayBuffer }).promise;
    let fullText = "";
    
    // Limit to first 20 pages for demo performance
    const maxPages = Math.min(pdf.numPages, 20);
    
    for (let i = 1; i <= maxPages; i++) {
      const page = await pdf.getPage(i);
      const textContent = await page.getTextContent();
      const pageText = textContent.items.map((item: any) => item.str).join(" ");
      fullText += `--- Page ${i} ---\n${pageText}\n\n`;
    }
    return fullText;
  };

  const resetWorkbookImport = () => {
    setWorkbookModalOpen(false);
    setPendingWorkbookName(null);
    setPendingWorkbookType(null);
    setPendingWorkbookSheets([]);
    setSelectedWorkbookSheetIds(new Set());
    setWorkbookImportMode('SEPARATE');
  };

  const toggleWorkbookSheetSelection = (sheetId: string) => {
    setSelectedWorkbookSheetIds((prev) => {
      const next = new Set(prev);
      if (next.has(sheetId)) next.delete(sheetId);
      else next.add(sheetId);
      return next;
    });
  };

  const toggleAllWorkbookSheets = () => {
    if (pendingWorkbookSheets.length === 0) return;
    const allSelected = pendingWorkbookSheets.every((sheet) => selectedWorkbookSheetIds.has(sheet.id));
    setSelectedWorkbookSheetIds(allSelected ? new Set() : new Set(pendingWorkbookSheets.map((sheet) => sheet.id)));
  };

  const commitWorkbookImport = () => {
    if (!pendingWorkbookType || !workbookImportPlan || workbookImportPlan.outputs.length === 0) return;

    workbookImportPlan.outputs.forEach((output) => {
      const qcApplicable = isQcApplicableType(pendingWorkbookType);
      const newFile: ClinicalFile = {
        id: crypto.randomUUID(),
        name: output.name,
        type: pendingWorkbookType,
        uploadDate: new Date().toISOString(),
        size: `${(output.content.length / 1024).toFixed(1)} KB`,
        content: output.content,
        metadata: {
          ...(output.metadata || {}),
          qcApplicable,
          workbookSource: pendingWorkbookName,
          workbookSelectedSheetCount: workbookImportPlan.selectedSheetCount,
        },
      };
      onAddFile(newFile);
    });

    setUploadNotice(
      `Imported ${workbookImportPlan.outputCount} dataset${workbookImportPlan.outputCount === 1 ? '' : 's'} from ${pendingWorkbookName} using ${
        workbookImportPlan.mode === 'MERGE_SIMILAR' && workbookMergeAllowed ? 'Merge Similar Sheets' : 'Separate Sheets'
      } mode.`
    );
    resetWorkbookImport();
  };

  const handleFile = async (file: File) => {
    setParseError(null);
    setUploadNotice(null);
    setIsParsing(true);
    const fileName = file.name.toLowerCase();
    let content = "";
    let processedName = file.name;
    let importedMetadata: Record<string, unknown> = {};
    const { resolvedType, notice } = resolveUploadType(file.name, activeTab);

    try {
        // CASE 1: Excel Files (.xlsx, .xls)
        if (fileName.endsWith('.xlsx') || fileName.endsWith('.xls')) {
            if (!window.XLSX) {
                throw new Error("Excel parser failed to load. Please check your internet connection or disable ad blockers.");
            }
            const data = await file.arrayBuffer();
            const workbook = window.XLSX.read(data, { type: 'array' });
            const previews = buildWorkbookSheetPreviews(
              workbook.SheetNames.map((sheetName: string) => ({
                sheetName,
                csvContent: window.XLSX.utils.sheet_to_csv(workbook.Sheets[sheetName]),
              }))
            );

            if (previews.length === 0) {
              throw new Error('Workbook does not contain any non-empty sheets.');
            }

            if (previews.length === 1) {
              const singlePlan = planWorkbookImport(file.name, previews, [previews[0].id], 'SEPARATE', resolvedType);
              const output = singlePlan.outputs[0];
              content = output.content;
              processedName = output.name;
              importedMetadata = output.metadata || {};
            } else {
              setPendingWorkbookName(file.name);
              setPendingWorkbookType(resolvedType);
              setPendingWorkbookSheets(previews);
              setSelectedWorkbookSheetIds(new Set(previews.map((sheet) => sheet.id)));
              setWorkbookImportMode('SEPARATE');
              setWorkbookModalOpen(true);
              if (notice) setUploadNotice(notice);
              return;
            }
        } 
        // CASE 2: JSON Files
        else if (fileName.endsWith('.json')) {
            const text = await file.text();
            try {
                const json = JSON.parse(text);
                if (Array.isArray(json)) {
                    content = "JSON Content Converted"; // Placeholder, logic in previous version
                    // Simple CSV converter
                    const keys = Object.keys(json[0]);
                    content = [keys.join(","), ...json.map((o: any) => keys.map(k => o[k]).join(","))].join("\n");
                    processedName = file.name.replace('.json', '.csv');
                } else {
                    content = text; 
                }
            } catch (e) {
                throw new Error("Invalid JSON file");
            }
        }
        // CASE 3: PDF Files
        else if (fileName.endsWith('.pdf')) {
            content = await extractPdfText(file);
        }
        // CASE 4: Text/CSV
        else {
            content = await file.text();
        }

        if (!content) throw new Error("File appears empty");

        const fileId = crypto.randomUUID();
        const qcApplicable = isQcApplicableType(resolvedType);
        const newFile: ClinicalFile = {
            id: fileId,
            name: processedName,
            type: resolvedType,
            uploadDate: new Date().toISOString(),
            size: `${(file.size / 1024).toFixed(1)} KB`,
            content: content,
            metadata: { qcApplicable, ...importedMetadata }
        };

        onAddFile(newFile);
        if (notice) setUploadNotice(notice);

    } catch (err: any) {
        console.error(err);
        setParseError(`Failed to process file: ${err.message}`);
    } finally {
        setIsParsing(false);
    }
  };

  const handleManualQC = async (file: ClinicalFile) => {
      setProcessingId(file.id);
      try {
          const qcResult = await runQualityCheck(file);
          onRemoveFile(file.id);
          const updatedFile = { ...file, qcStatus: qcResult.status, qcIssues: qcResult.issues };
          onAddFile(updatedFile);

          if (qcResult.status !== 'PASS') {
              openQCReport(updatedFile);
          }
      } catch (err) {
          console.error("QC failed", err);
      } finally {
          setProcessingId(null);
      }
  };

  const handleDownload = (e: React.MouseEvent, file: ClinicalFile) => {
    e.stopPropagation();
    if (!file.content) return;
    const blob = new Blob([file.content], { type: 'text/plain' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = file.name;
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
    URL.revokeObjectURL(url);
  };

  const openQCReport = (file: ClinicalFile) => {
      setSelectedQCFile(file);
      setCleaningProposal(null);
      setApplyStage('');
      setApplyError(null);
      setFixNotice(null);
      const initialSelection = new Set<number>();
      file.qcIssues?.forEach((issue, idx) => {
        if (issue.severity === 'HIGH' && isIssueAutoFixable(issue)) initialSelection.add(idx);
      });
      setSelectedIssueIndices(initialSelection);
      setQcModalOpen(true);
  };

  const toggleIssueSelection = (index: number) => {
    const newSet = new Set(selectedIssueIndices);
    if (newSet.has(index)) {
        newSet.delete(index);
    } else {
        newSet.add(index);
    }
    setSelectedIssueIndices(newSet);
  };

  const toggleSelectAll = () => {
    if (!selectedQCFile?.qcIssues) return;
    const autoFixableIndices = selectedQCFile.qcIssues
      .map((issue, idx) => (isIssueAutoFixable(issue) ? idx : -1))
      .filter((idx) => idx >= 0);
    const allAutoFixableSelected =
      autoFixableIndices.length > 0 && autoFixableIndices.every((idx) => selectedIssueIndices.has(idx));

    if (allAutoFixableSelected) {
        setSelectedIssueIndices(new Set());
    } else {
        const all = new Set<number>();
        autoFixableIndices.forEach((i) => all.add(i));
        setSelectedIssueIndices(all);
    }
  };

  const handleGenerateFix = async () => {
    if (!selectedQCFile || !selectedQCFile.qcIssues) return;
    if (selectedIssues.length === 0) return;
    const autoFixableSelected = selectedIssues.filter(isIssueAutoFixable);
    const manualSelected = selectedIssues.filter((issue) => !isIssueAutoFixable(issue));
    if (autoFixableSelected.length === 0) {
      setFixNotice(null);
      setApplyError('Selected issues are structural/manual and cannot be auto-fixed. Please remap or re-ingest the source data.');
      return;
    }
    setIsFixing(true);
    setApplyError(null);
    setFixNotice(
      manualSelected.length > 0
        ? `${manualSelected.length} selected issue(s) require manual remediation and will be excluded from auto-fix.`
        : null
    );
    try {
      const proposal = await generateCleaningSuggestion(selectedQCFile, autoFixableSelected);
      setCleaningProposal(proposal);
    } catch (e) {
      console.error("Failed to generate fix", e);
      setApplyError("Failed to generate correction plan. Please try again.");
    } finally {
      setIsFixing(false);
    }
  };

  const handleApplyFix = async () => {
    if (!selectedQCFile || !cleaningProposal) return;
    setApplyError(null);
    setFixNotice(null);
    setApplyStage('Initializing environment...');
    try {
      setApplyStage('Applying deterministic cleaning rules...');
      const newContent = await applyCleaning(selectedQCFile, cleaningProposal.code);
      if (!newContent || newContent.length < 10) throw new Error("Generated content was empty.");

      setApplyStage('Creating versioned dataset...');
      const nameParts = selectedQCFile.name.split('.');
      const ext = nameParts.pop();
      const baseName = nameParts.join('.');
      const newFileName = `${baseName}_v2_cleaned.${ext}`;

      const newFile: ClinicalFile = {
        id: crypto.randomUUID(),
        name: newFileName,
        type: selectedQCFile.type,
        uploadDate: new Date().toISOString(),
        size: selectedQCFile.size,
        content: newContent,
        qcStatus: 'PENDING'
      };

      onAddFile(newFile);
      setApplyStage('Validating new dataset structure...');
      const qcResult = await runQualityCheck(newFile);
      onRemoveFile(newFile.id);
      const validatedFile = { ...newFile, qcStatus: qcResult.status, qcIssues: qcResult.issues };
      onAddFile(validatedFile);

      setApplyStage('Finalizing...');
      await new Promise(r => setTimeout(r, 600));
      setSelectedQCFile(validatedFile);
      setCleaningProposal(null); 
      const initialSelection = new Set<number>();
      validatedFile.qcIssues?.forEach((issue, idx) => {
        if (issue.severity === 'HIGH') initialSelection.add(idx);
      });
      setSelectedIssueIndices(initialSelection);

    } catch (e: any) {
      console.error("Apply failed", e);
      setApplyError(e.message || "An error occurred while applying the fix.");
    } finally {
      setApplyStage('');
    }
  };

  const parsePreviewData = (content: string) => {
    try {
      const { headers, rows } = parseCsv(content);
      return { headers, rows: rows.map((row) => headers.map((h) => row[h] ?? '')) };
    } catch {
      const lines = content.trim().split('\n');
      if (lines.length === 0) return { headers: [], rows: [] };
      const headers = lines[0].split(',').map(h => h.trim());
      const rows = lines.slice(1).map(line => line.split(',').map(c => c.trim()));
      return { headers, rows };
    }
  };

  const filteredFiles = files.filter(f => f.type === activeTab);

  const getQCBadge = (file: ClinicalFile) => {
      const qcApplicable = file.metadata?.qcApplicable !== undefined
        ? Boolean(file.metadata?.qcApplicable)
        : isQcApplicableType(file.type);
      if (!qcApplicable) {
          return <span className="flex items-center text-slate-500 bg-slate-50 px-2 py-0.5 rounded text-xs font-bold border border-slate-200">N/A</span>;
      }
      if (processingId === file.id) {
          return <span className="flex items-center text-sky-600 bg-sky-50 px-2 py-0.5 rounded text-xs font-bold border border-sky-200"><Loader2 className="w-3 h-3 mr-1 animate-spin"/> RUNNING</span>;
      }
      const status = file.qcStatus;
      switch (status) {
          case 'PASS': return <span className="flex items-center text-green-600 bg-green-50 px-2 py-0.5 rounded text-xs font-bold border border-green-200"><CheckCircle className="w-3 h-3 mr-1"/> PASS</span>;
          case 'WARN': return <span className="flex items-center text-yellow-600 bg-yellow-50 px-2 py-0.5 rounded text-xs font-bold border border-yellow-200"><AlertTriangle className="w-3 h-3 mr-1"/> WARN</span>;
          case 'FAIL': return <span className="flex items-center text-red-600 bg-red-50 px-2 py-0.5 rounded text-xs font-bold border border-red-200"><XCircle className="w-3 h-3 mr-1"/> FAIL</span>;
          default: return <span className="flex items-center text-slate-500 bg-slate-50 px-2 py-0.5 rounded text-xs font-bold border border-slate-200"><Square className="w-3 h-3 mr-1"/> NOT RUN</span>;
      }
  };

  return (
    <div className="p-6 h-full flex flex-col space-y-6 relative">
      <div className="flex justify-between items-center">
        <h2 className="text-2xl font-bold text-slate-800">Data Ingestion</h2>
        <div className="flex space-x-2 bg-slate-100 p-1 rounded-lg">
          {tabConfig.map(({ type, label }) => (
            <button
              key={type}
              onClick={() => setActiveTab(type)}
              type="button"
              className={`px-4 py-2 rounded-md text-sm font-medium transition-colors ${
                activeTab === type ? 'bg-white text-medical-600 shadow-sm' : 'text-slate-500 hover:text-slate-700'
              }`}
            >
              {label}
            </button>
          ))}
        </div>
      </div>

      {activeTab === DataType.MAPPING && (
          <div className="bg-blue-50 border border-blue-200 text-blue-900 px-4 py-3 rounded-lg text-sm flex items-start">
              <Info className="w-5 h-5 mr-2 mt-0.5 text-blue-600" />
              <div>
                  <p className="font-semibold">Reference artifacts only</p>
                  <p className="text-xs mt-1">
                      Use this tab to store external mapping files (legacy JSON specs, codelists, data dictionaries).
                      Build executable transformation rules in <strong>Mapping Specs (SDTM)</strong> from the left menu.
                  </p>
              </div>
          </div>
      )}

      {parseError && (
          <div className="bg-red-50 border border-red-200 text-red-700 px-4 py-3 rounded-lg flex items-center">
              <AlertCircle className="w-5 h-5 mr-2" />
              {parseError}
          </div>
      )}

      {uploadNotice && (
          <div className="bg-blue-50 border border-blue-200 text-blue-700 px-4 py-3 rounded-lg flex items-center">
              <Info className="w-5 h-5 mr-2" />
              {uploadNotice}
          </div>
      )}

      <div 
        className={`border-2 border-dashed rounded-xl p-10 flex flex-col items-center justify-center transition-colors ${
          dragActive ? 'border-medical-500 bg-medical-50' : 'border-slate-300 hover:border-slate-400'
        }`}
        onDragEnter={handleDrag}
        onDragLeave={handleDrag}
        onDragOver={handleDrag}
        onDrop={handleDrop}
      >
        {isParsing ? (
           <Loader2 className="w-12 h-12 text-medical-500 animate-spin mb-4" />
        ) : (
           <Upload className="w-12 h-12 text-slate-400 mb-4" />
        )}
        <p className="text-slate-600 mb-2 font-medium">
            {isParsing ? "Parsing file content..." : "Drag and drop your files here"}
        </p>
        <p className="text-slate-400 text-sm mb-6">
          {activeTab === DataType.MAPPING
            ? 'Supports CSV/JSON/Excel mapping references (legacy specs, dictionaries, codelists)'
            : 'Supports CSV, JSON, Excel (.xlsx), PDF (Protocols)'}
        </p>
        <input 
          type="file" 
          id="file-upload" 
          className="hidden" 
          multiple
          onChange={handleChange}
          disabled={isParsing}
        />
        <label 
          htmlFor="file-upload" 
          className={`px-6 py-2 bg-medical-600 text-white rounded-lg hover:bg-medical-500 cursor-pointer font-medium ${isParsing ? 'opacity-50 cursor-not-allowed' : ''}`}
        >
          Select Files
        </label>
      </div>

      <div className="flex-1 overflow-auto">
        <h3 className="text-lg font-semibold text-slate-800 mb-4">Uploaded Files ({filteredFiles.length})</h3>
        <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-4">
          {filteredFiles.map((file) => (
            <div key={file.id} className="bg-white border border-slate-200 rounded-lg p-4 shadow-sm hover:shadow-md transition-shadow relative group">
              <div className="absolute top-2 right-2 flex space-x-1 bg-white border border-slate-200 rounded-lg shadow-sm p-1 z-10">
                <button 
                  onClick={(e) => handleDownload(e, file)}
                  type="button"
                  className="p-1.5 text-slate-500 hover:text-medical-600 hover:bg-slate-50 rounded"
                  title="Download File"
                >
                  <Download className="w-4 h-4" />
                </button>
                <button 
                  onClick={() => { setPreviewFile(file); setIsPreviewMaximized(false); }}
                  type="button"
                  className="p-1.5 text-slate-500 hover:text-medical-600 hover:bg-slate-50 rounded"
                  title="Preview Content"
                >
                  <FileSearch className="w-4 h-4" />
                </button>
                <button 
                  onClick={() => onRemoveFile(file.id)}
                  type="button"
                  className="p-1.5 text-slate-500 hover:text-red-500 hover:bg-red-50 rounded"
                  title="Remove File"
                >
                  <Trash2 className="w-4 h-4" />
                </button>
              </div>

              <div className="flex items-center space-x-3 mb-3">
                <div className={`p-2 rounded-lg ${
                  file.type === DataType.RAW ? 'bg-orange-100 text-orange-600' :
                  file.type === DataType.DOCUMENT ? 'bg-blue-100 text-blue-600' :
                  file.type === DataType.MAPPING ? 'bg-purple-100 text-purple-600' :
                  'bg-green-100 text-green-600'
                }`}>
                  {file.type === DataType.DOCUMENT ? <FileText className="w-6 h-6" /> :
                   file.type === DataType.MAPPING ? <Code className="w-6 h-6" /> :
                   <Database className="w-6 h-6" />}
                </div>
                <div className="overflow-hidden">
                  <h4 className="font-medium text-slate-900 truncate pr-16" title={file.name}>{file.name}</h4>
                  <p className="text-xs text-slate-500">{file.size} • {new Date(file.uploadDate).toLocaleDateString()}</p>
                </div>
              </div>
              <div className="flex justify-between items-center mt-2 pt-2 border-t border-slate-50">
                 <div className="flex items-center space-x-2">
                     {getQCBadge(file)}
                 </div>
                 <div className="flex items-center space-x-2">
                     {(file.metadata?.qcApplicable ?? isQcApplicableType(file.type)) && (
                         <button 
                             onClick={() => handleManualQC(file)}
                             disabled={processingId === file.id}
                             className="text-xs px-2 py-1 bg-medical-50 text-medical-600 rounded hover:bg-medical-100 font-medium disabled:opacity-50"
                         >
                             {processingId === file.id ? 'Running...' : (file.qcStatus ? 'Re-run QC' : 'Run QC')}
                         </button>
                     )}
                     {(file.metadata?.qcApplicable ?? isQcApplicableType(file.type)) && (file.qcStatus === 'WARN' || file.qcStatus === 'FAIL') && (
                         <button 
                            onClick={() => openQCReport(file)}
                            type="button"
                            className="text-xs text-medical-600 hover:underline flex items-center font-medium"
                         >
                             <Eye className="w-3 h-3 mr-1" /> Report
                         </button>
                     )}
                 </div>
              </div>
            </div>
          ))}
          {filteredFiles.length === 0 && (
            <div className="col-span-full text-center py-12 text-slate-400">
              No files uploaded for this category yet.
            </div>
          )}
        </div>
      </div>
      
      {/* Workbook Import Modal */}
      {workbookModalOpen && pendingWorkbookName && createPortal(
        <div className="fixed inset-0 bg-black/60 flex items-center justify-center p-4" style={{ zIndex: 9999 }}>
          <div className="bg-white rounded-xl shadow-2xl w-full max-w-6xl max-h-[90vh] flex flex-col animate-fadeIn overflow-hidden">
            <div className="flex items-start justify-between p-6 border-b border-slate-200">
              <div>
                <h3 className="text-xl font-bold text-slate-800">Workbook Import Review</h3>
                <p className="text-sm text-slate-500 mt-1">
                  {pendingWorkbookName} contains {pendingWorkbookSheets.length} non-empty sheet{pendingWorkbookSheets.length === 1 ? '' : 's'}.
                  Choose which tabs to import and whether similar sheets should be harmonized.
                </p>
              </div>
              <button onClick={resetWorkbookImport} type="button" className="p-2 hover:bg-slate-100 rounded-full">
                <XCircle className="w-6 h-6 text-slate-400" />
              </button>
            </div>

            <div className="flex-1 overflow-y-auto p-6 bg-slate-50">
              <div className="grid grid-cols-1 xl:grid-cols-[minmax(0,1fr)_320px] gap-6">
                <div className="space-y-4">
                  <div className="bg-white rounded-xl border border-slate-200 p-4">
                    <div className="flex flex-col md:flex-row md:items-center md:justify-between gap-3 mb-4">
                      <div>
                        <div className="text-xs uppercase tracking-wide font-semibold text-slate-500">Import Mode</div>
                        <div className="text-sm text-slate-600 mt-1">
                          Separate sheets keeps each tab as its own dataset. Merge similar sheets combines matching tabs and adds `SOURCE_SHEET` and `LINE_OF_THERAPY` where helpful.
                        </div>
                      </div>
                      <div className="inline-flex rounded-xl border border-slate-200 bg-slate-100 p-1">
                        <button
                          type="button"
                          onClick={() => setWorkbookImportMode('SEPARATE')}
                          className={`rounded-lg px-3 py-2 text-sm font-semibold ${
                            workbookImportMode === 'SEPARATE' ? 'bg-white text-slate-900 shadow-sm' : 'text-slate-500'
                          }`}
                        >
                          Separate Sheets
                        </button>
                        <button
                          type="button"
                          onClick={() => workbookMergeAllowed && setWorkbookImportMode('MERGE_SIMILAR')}
                          disabled={!workbookMergeAllowed}
                          className={`rounded-lg px-3 py-2 text-sm font-semibold ${
                            workbookImportMode === 'MERGE_SIMILAR' ? 'bg-white text-slate-900 shadow-sm' : 'text-slate-500'
                          } ${!workbookMergeAllowed ? 'cursor-not-allowed opacity-40' : ''}`}
                        >
                          Merge Similar Sheets
                        </button>
                      </div>
                    </div>
                    {!workbookMergeAllowed && (
                      <div className="rounded-lg border border-amber-200 bg-amber-50 px-3 py-2 text-sm text-amber-900">
                        Merge mode is only available for data tabs. Reference and document imports stay as separate sheets.
                      </div>
                    )}
                  </div>

                  <div className="bg-white rounded-xl border border-slate-200 overflow-hidden">
                    <div className="flex items-center justify-between p-4 border-b border-slate-200">
                      <div>
                        <div className="text-sm font-semibold text-slate-800">Workbook Sheets</div>
                        <div className="text-sm text-slate-500">Review sheet structure before importing.</div>
                      </div>
                      <button onClick={toggleAllWorkbookSheets} type="button" className="text-xs font-medium text-medical-600 hover:underline">
                        {pendingWorkbookSheets.every((sheet) => selectedWorkbookSheetIds.has(sheet.id)) ? 'Deselect all' : 'Select all'}
                      </button>
                    </div>
                    <div className="divide-y divide-slate-200">
                      {pendingWorkbookSheets.map((sheet) => (
                        <label key={sheet.id} className="flex items-start gap-4 p-4 hover:bg-slate-50 cursor-pointer">
                          <input
                            type="checkbox"
                            checked={selectedWorkbookSheetIds.has(sheet.id)}
                            onChange={() => toggleWorkbookSheetSelection(sheet.id)}
                            className="mt-1 rounded border-slate-300 text-medical-600 focus:ring-medical-500"
                          />
                          <div className="min-w-0 flex-1">
                            <div className="flex flex-col lg:flex-row lg:items-start lg:justify-between gap-3">
                              <div className="min-w-0">
                                <div className="text-sm font-semibold text-slate-800 break-words">{sheet.sheetName}</div>
                                <div className="text-xs text-slate-500 mt-1">
                                  {sheet.rowCount} rows • {sheet.columnCount} columns • {sheet.domainHint}
                                </div>
                              </div>
                              <div className="flex flex-wrap gap-2 text-[11px] uppercase tracking-wide font-semibold">
                                {sheet.lineOfTherapy && (
                                  <span className="inline-flex rounded-full border border-indigo-200 bg-indigo-50 px-2 py-1 text-indigo-700">
                                    {sheet.lineOfTherapy}
                                  </span>
                                )}
                                {sheet.keyColumns.slice(0, 2).map((keyColumn) => (
                                  <span key={keyColumn} className="inline-flex rounded-full border border-slate-200 bg-slate-100 px-2 py-1 text-slate-600">
                                    {keyColumn}
                                  </span>
                                ))}
                              </div>
                            </div>
                            <div className="mt-3 grid grid-cols-1 lg:grid-cols-[minmax(0,1fr)_220px] gap-3">
                              <div className="rounded-lg border border-slate-200 bg-slate-50 px-3 py-2">
                                <div className="text-[11px] uppercase tracking-wide font-semibold text-slate-500 mb-1">Columns</div>
                                <div className="text-sm text-slate-700 break-words">
                                  {sheet.sampleHeaders.join(', ')}
                                  {sheet.headers.length > sheet.sampleHeaders.length ? ` and ${sheet.headers.length - sheet.sampleHeaders.length} more` : ''}
                                </div>
                              </div>
                              <div className="rounded-lg border border-slate-200 bg-slate-50 px-3 py-2">
                                <div className="text-[11px] uppercase tracking-wide font-semibold text-slate-500 mb-1">Join Readiness</div>
                                <div className="text-sm text-slate-700 break-words">
                                  {sheet.keyColumns.length > 0 ? sheet.keyColumns.join(', ') : 'No obvious join key detected'}
                                </div>
                              </div>
                            </div>
                          </div>
                        </label>
                      ))}
                    </div>
                  </div>
                </div>

                <div className="bg-white rounded-xl border border-slate-200 p-4 h-fit sticky top-0">
                  <div className="text-sm font-semibold text-slate-800">Import Plan</div>
                  <div className="text-sm text-slate-500 mt-1">
                    {workbookImportPlan?.selectedSheetCount || 0} sheet{workbookImportPlan?.selectedSheetCount === 1 ? '' : 's'} selected
                  </div>

                  <div className="mt-4 rounded-xl border border-slate-200 bg-slate-50 p-3">
                    <div className="text-[11px] uppercase tracking-wide font-semibold text-slate-500">Outputs</div>
                    <div className="text-2xl font-bold text-slate-800 mt-1">{workbookImportPlan?.outputCount || 0}</div>
                    <div className="text-sm text-slate-500 mt-1">
                      {workbookImportPlan?.mode === 'MERGE_SIMILAR' && workbookMergeAllowed ? 'Merged where structures matched' : 'One dataset per selected sheet'}
                    </div>
                  </div>

                  <div className="mt-4 space-y-3 max-h-[28rem] overflow-y-auto pr-1">
                    {workbookImportPlan?.outputs.length ? (
                      workbookImportPlan.outputs.map((output) => (
                        <div key={output.name} className="rounded-xl border border-slate-200 bg-white p-3">
                          <div className="text-sm font-semibold text-slate-800 break-words">{output.name}</div>
                          <div className="text-xs text-slate-500 mt-1">
                            {output.rowCount} rows • {output.columnCount} columns
                          </div>
                          <div className="flex items-center text-xs text-slate-500 mt-2">
                            <ArrowRight className="w-3.5 h-3.5 mr-1 text-slate-400" />
                            {output.sourceSheetNames.join(', ')}
                          </div>
                        </div>
                      ))
                    ) : (
                      <div className="rounded-xl border border-dashed border-slate-200 bg-slate-50 p-4 text-sm text-slate-500">
                        Select at least one sheet to build an import plan.
                      </div>
                    )}
                  </div>
                </div>
              </div>
            </div>

            <div className="p-6 border-t border-slate-200 bg-white flex justify-end gap-3">
              <button
                onClick={resetWorkbookImport}
                type="button"
                className="px-4 py-2 bg-white border border-slate-300 text-slate-700 rounded-lg hover:bg-slate-50 font-medium transition-colors"
              >
                Cancel
              </button>
              <button
                onClick={commitWorkbookImport}
                type="button"
                disabled={!workbookImportPlan || workbookImportPlan.outputs.length === 0}
                className={`px-4 py-2 rounded-lg font-medium transition-colors flex items-center ${
                  !workbookImportPlan || workbookImportPlan.outputs.length === 0
                    ? 'bg-slate-300 text-white cursor-not-allowed'
                    : 'bg-medical-600 text-white hover:bg-medical-700'
                }`}
              >
                <Upload className="w-4 h-4 mr-2" />
                Import {workbookImportPlan?.outputCount || 0} Dataset{workbookImportPlan?.outputCount === 1 ? '' : 's'}
              </button>
            </div>
          </div>
        </div>,
        document.body
      )}

      {/* Preview Modal using Portal */}
      {previewFile && createPortal(
        <div 
            className={`fixed inset-0 bg-black/60 flex items-center justify-center animate-fadeIn ${isPreviewMaximized ? 'p-0' : 'p-4'}`} 
            style={{zIndex: 9999}} 
        >
            <div className={`bg-white shadow-2xl flex flex-col overflow-hidden transition-all duration-300 ${
                isPreviewMaximized 
                ? 'w-full h-full rounded-none' 
                : 'w-full max-w-5xl h-[85vh] rounded-xl'
            }`}>
                <div className="flex justify-between items-center p-4 border-b border-slate-200 bg-slate-50 shrink-0">
                    <div className="flex items-center space-x-3">
                        <div className={`p-2 rounded-lg ${
                          previewFile.type === DataType.RAW ? 'bg-orange-100 text-orange-600' :
                          previewFile.type === DataType.DOCUMENT ? 'bg-blue-100 text-blue-600' :
                          'bg-green-100 text-green-600'
                        }`}>
                            <FileSearch className="w-5 h-5" />
                        </div>
                        <div>
                            <h3 className="font-bold text-slate-800">{previewFile.name}</h3>
                            <p className="text-xs text-slate-500 uppercase tracking-wider">{previewFile.type} • {previewFile.size}</p>
                        </div>
                    </div>
                    <div className="flex items-center space-x-2">
                        <button
                            onClick={() => setIsPreviewMaximized(!isPreviewMaximized)}
                            type="button"
                            className="p-2 hover:bg-slate-200 rounded-full transition-colors"
                            title={isPreviewMaximized ? "Minimize" : "Maximize"}
                        >
                            {isPreviewMaximized ? <Minimize2 className="w-5 h-5 text-slate-500" /> : <Maximize2 className="w-5 h-5 text-slate-500" />}
                        </button>
                        <button 
                            onClick={() => setPreviewFile(null)} 
                            type="button"
                            className="p-2 hover:bg-slate-200 rounded-full transition-colors"
                        >
                            <X className="w-6 h-6 text-slate-500" />
                        </button>
                    </div>
                </div>
                
                <div className="flex-1 overflow-auto p-0 bg-slate-50/50">
                    {(previewFile.type === DataType.RAW || previewFile.type === DataType.STANDARDIZED) && previewFile.content ? (
                        <div className="inline-block min-w-full align-middle">
                           {(() => {
                               const { headers, rows } = parsePreviewData(previewFile.content);
                               const affectedRowsMap = getAffectedRowIndices(previewFile.qcIssues);

                               return (
                                   <table className="min-w-full divide-y divide-slate-200 border-separate border-spacing-0">
                                       <thead className="bg-slate-100 sticky top-0 z-10">
                                           <tr>
                                               <th scope="col" className="sticky top-0 left-0 z-20 w-12 px-3 py-3 text-left text-xs font-medium text-slate-400 uppercase tracking-wider bg-slate-100 border-b border-r border-slate-200 shadow-sm">
                                                   #
                                               </th>
                                               {headers.map((h, i) => (
                                                   <th key={i} scope="col" className="px-6 py-3 text-left text-xs font-bold text-slate-600 uppercase tracking-wider border-b border-slate-200 whitespace-nowrap">
                                                       {h}
                                                   </th>
                                               ))}
                                           </tr>
                                       </thead>
                                       <tbody className="bg-white divide-y divide-slate-100">
                                           {rows.map((row, rowIdx) => {
                                               const issueSeverity = affectedRowsMap.get(rowIdx + 1);
                                               let rowClass = "hover:bg-slate-50";
                                               let indexCellClass = "text-slate-400 bg-slate-50";
                                               
                                               if (issueSeverity === 'HIGH') {
                                                   rowClass = "bg-red-50 hover:bg-red-100";
                                                   indexCellClass = "text-red-600 bg-red-50 font-bold";
                                               } else if (issueSeverity === 'MEDIUM') {
                                                   rowClass = "bg-yellow-50 hover:bg-yellow-100";
                                                   indexCellClass = "text-yellow-600 bg-yellow-50 font-bold";
                                               } else if (issueSeverity === 'LOW') {
                                                   rowClass = "bg-blue-50 hover:bg-blue-100";
                                                   indexCellClass = "text-blue-600 bg-blue-50 font-bold";
                                               }

                                               return (
                                                   <tr key={rowIdx} className={rowClass}>
                                                       <td className={`sticky left-0 z-10 px-3 py-2 whitespace-nowrap text-xs font-mono border-r border-slate-200 text-center ${indexCellClass}`}>
                                                           {issueSeverity && (
                                                              <div className="absolute left-1 top-2.5">
                                                                <AlertCircle className="w-3 h-3" />
                                                              </div>
                                                           )}
                                                           {rowIdx + 1}
                                                       </td>
                                                       {row.map((cell, cellIdx) => (
                                                           <td key={cellIdx} className="px-6 py-2 whitespace-nowrap text-sm text-slate-700">
                                                               {cell}
                                                           </td>
                                                       ))}
                                                   </tr>
                                               );
                                           })}
                                       </tbody>
                                   </table>
                               );
                           })()}
                        </div>
                    ) : (
                        <div className="p-8 h-full">
                            <div className="bg-white border border-slate-200 rounded-lg p-6 shadow-sm min-h-full font-serif text-slate-800 leading-relaxed whitespace-pre-wrap">
                                {previewFile.content || "No content available to preview."}
                            </div>
                        </div>
                    )}
                </div>
            </div>
        </div>,
        document.body
      )}

      {/* QC Modal using Portal */}
      {qcModalOpen && selectedQCFile && createPortal(
          <div className="fixed inset-0 bg-black/60 flex items-center justify-center p-4" style={{zIndex: 9999}}>
              <div className="bg-white rounded-xl shadow-2xl w-full max-w-3xl max-h-[90vh] flex flex-col animate-fadeIn">
                  <div className="flex items-center justify-between p-6 border-b border-slate-200">
                      <div>
                          <h3 className="text-xl font-bold text-slate-800">Quality Control Report</h3>
                          <p className="text-sm text-slate-500">File: {selectedQCFile.name}</p>
                      </div>
                      <div className="flex items-center space-x-2">
                        <button 
                            onClick={() => { setPreviewFile(selectedQCFile); setIsPreviewMaximized(false); }}
                            type="button"
                            className="flex items-center px-3 py-1.5 bg-slate-100 hover:bg-slate-200 text-slate-700 rounded-lg text-sm font-medium transition-colors"
                        >
                            <FileSearch className="w-4 h-4 mr-2" />
                            View Data
                        </button>
                        <button onClick={() => setQcModalOpen(false)} type="button" className="p-2 hover:bg-slate-100 rounded-full">
                            <XCircle className="w-6 h-6 text-slate-400" />
                        </button>
                      </div>
                  </div>
                  
                  <div className="flex-1 overflow-y-auto p-6">
                      <div className={`mb-6 p-4 rounded-lg flex items-start ${
                          selectedQCFile.qcStatus === 'FAIL' ? 'bg-red-50 border border-red-200 text-red-900' :
                          selectedQCFile.qcStatus === 'WARN' ? 'bg-yellow-50 border border-yellow-200 text-yellow-900' :
                          'bg-green-50 border border-green-200 text-green-900'
                      }`}>
                          {selectedQCFile.qcStatus === 'FAIL' ? <AlertTriangle className="w-6 h-6 mr-3 flex-shrink-0" /> :
                           selectedQCFile.qcStatus === 'WARN' ? <AlertTriangle className="w-6 h-6 mr-3 flex-shrink-0" /> :
                           <CheckCircle className="w-6 h-6 mr-3 flex-shrink-0" />}
                          <div>
                              <h4 className="font-bold mb-1">Status: {selectedQCFile.qcStatus}</h4>
                              <p className="text-sm">
                                  {selectedQCFile.qcStatus === 'FAIL' ? 'Critical quality issues detected.' :
                                   selectedQCFile.qcStatus === 'WARN' ? 'Minor issues detected.' :
                                   'Data structure appears valid.'}
                              </p>
                          </div>
                      </div>

                          {(!cleaningProposal) && (
                        <>
                          <div className="flex justify-between items-center mb-3">
                              <h4 className="font-semibold text-slate-800">Detected Issues</h4>
                              {selectedQCFile.qcIssues && selectedQCFile.qcIssues.length > 0 && (
                                  <button onClick={toggleSelectAll} type="button" className="text-xs text-medical-600 font-medium hover:underline">
                                      {selectedIssueIndices.size === selectedQCFile.qcIssues.filter(isIssueAutoFixable).length ? 'Deselect All' : 'Select All'}
                                  </button>
                              )}
                          </div>
                          
                          {selectedQCFile.qcIssues && selectedQCFile.qcIssues.length > 0 ? (
                              <div className="space-y-3">
                                  {selectedQCFile.qcIssues.map((issue, idx) => (
                                      (() => {
                                        const autoFixable = isIssueAutoFixable(issue);
                                        return (
                                      <div 
                                        key={idx} 
                                        className={`flex items-start p-3 rounded border transition-colors ${autoFixable ? 'cursor-pointer' : 'cursor-not-allowed'} ${
                                            selectedIssueIndices.has(idx)
                                              ? 'bg-blue-50 border-blue-200'
                                              : autoFixable
                                                ? 'bg-slate-50 border-slate-200 opacity-60 hover:opacity-100'
                                                : 'bg-amber-50 border-amber-200 opacity-80'
                                        }`}
                                        onClick={() => {
                                          if (autoFixable) toggleIssueSelection(idx);
                                        }}
                                      >
                                          <div className="mr-3 pt-0.5">
                                              {selectedIssueIndices.has(idx) && autoFixable
                                                ? <CheckSquare className="w-5 h-5 text-medical-600" />
                                                : <Square className={`w-5 h-5 ${autoFixable ? 'text-slate-400' : 'text-amber-500'}`} />
                                              }
                                          </div>
                                          <span className={`text-xs font-bold px-2 py-0.5 rounded uppercase mr-3 mt-0.5 h-fit ${
                                              issue.severity === 'HIGH' ? 'bg-red-100 text-red-700' :
                                              issue.severity === 'MEDIUM' ? 'bg-yellow-100 text-yellow-700' :
                                              'bg-blue-100 text-blue-700'
                                          }`}>
                                              {issue.severity}
                                          </span>
                                          <div className="flex-1">
                                              <p className={`text-sm font-medium ${selectedIssueIndices.has(idx) ? 'text-slate-900' : 'text-slate-500'}`}>
                                                  {issue.description}
                                              </p>
                                              {!autoFixable && (
                                                  <p className="text-xs text-amber-700 mt-1 font-medium">
                                                      Manual fix required. {issue.remediationHint || 'Auto-fix is disabled for this issue type.'}
                                                  </p>
                                              )}
                                              {issue.affectedRows && (
                                                  <p className="text-xs text-slate-400 mt-1 font-mono">Affected: {issue.affectedRows}</p>
                                              )}
                                          </div>
                                      </div>
                                        );
                                      })()
                                  ))}
                              </div>
                          ) : (
                              <p className="text-slate-400 italic">No specific issues listed.</p>
                          )}
                          {applyError && (
                              <div className="mt-4 p-3 bg-amber-50 border border-amber-200 rounded-lg flex items-start">
                                  <Info className="w-5 h-5 text-amber-600 mr-3 mt-0.5" />
                                  <p className="text-xs text-amber-900">{applyError}</p>
                              </div>
                          )}
                          {fixNotice && (
                              <div className="mt-4 p-3 bg-blue-50 border border-blue-200 rounded-lg flex items-start">
                                  <Info className="w-5 h-5 text-blue-600 mr-3 mt-0.5" />
                                  <p className="text-xs text-blue-900">{fixNotice}</p>
                              </div>
                          )}
                        </>
                      )}

                      {cleaningProposal && (
                        <div className="mt-2 animate-fadeIn">
                           <div className="bg-slate-50 p-4 rounded-lg border border-slate-200 mb-4">
                              <p className="text-sm text-slate-800 leading-relaxed">{cleaningProposal.explanation}</p>
                           </div>
                           <div className="bg-[#1e1e1e] rounded-lg overflow-hidden border border-slate-300">
                              <pre className="p-4 text-xs font-mono text-slate-300 overflow-x-auto">
                                {cleaningProposal.code}
                              </pre>
                           </div>
                           {applyError && (
                               <div className="mt-4 p-3 bg-red-50 border border-red-100 rounded-lg flex items-center">
                                   <AlertCircle className="w-5 h-5 text-red-600 mr-3" />
                                   <p className="text-xs text-red-800"><strong>Error:</strong> {applyError}</p>
                               </div>
                           )}
                           {fixNotice && (
                               <div className="mt-4 p-3 bg-blue-50 border border-blue-100 rounded-lg flex items-center">
                                   <Info className="w-5 h-5 text-blue-600 mr-3" />
                                   <p className="text-xs text-blue-800">{fixNotice}</p>
                               </div>
                           )}
                        </div>
                      )}
                  </div>

                  <div className="p-6 border-t border-slate-200 bg-slate-50 rounded-b-xl flex justify-between items-center">
                      <div className="flex space-x-3 ml-auto">
                          <button 
                              onClick={() => setQcModalOpen(false)}
                              type="button"
                              className="px-4 py-2 bg-white border border-slate-300 text-slate-700 rounded-lg hover:bg-slate-50 font-medium transition-colors"
                          >
                              {cleaningProposal ? 'Cancel' : 'Close'}
                          </button>
                          
                          {selectedQCFile.qcStatus !== 'PASS' && !cleaningProposal && (
                            <button 
                                onClick={handleGenerateFix}
                                type="button"
                                disabled={isFixing || selectedIssueIndices.size === 0}
                                className={`px-4 py-2 text-white rounded-lg font-medium transition-colors flex items-center shadow-sm ${
                                    isFixing || selectedIssueIndices.size === 0 
                                    ? 'bg-medical-400 cursor-not-allowed opacity-70' 
                                    : 'bg-medical-600 hover:bg-medical-700'
                                }`}
                            >
                                {isFixing ? <Loader2 className="w-4 h-4 mr-2 animate-spin" /> : <Sparkles className="w-4 h-4 mr-2" />}
                                {isFixing ? 'Generating Plan...' : `Fix Selected (${selectedIssueIndices.size})`}
                            </button>
                          )}

                          {cleaningProposal && (
                             <button 
                                onClick={handleApplyFix}
                                type="button"
                                disabled={!!applyStage}
                                className="px-4 py-2 bg-green-600 text-white hover:bg-green-700 rounded-lg font-medium transition-colors flex items-center shadow-sm"
                             >
                                {applyStage ? <Loader2 className="w-4 h-4 mr-2 animate-spin" /> : <Play className="w-4 h-4 mr-2" />}
                                {applyStage ? applyStage : (applyError ? 'Retry Fix' : 'Run Fix & Verify')}
                             </button>
                          )}
                      </div>
                  </div>
              </div>
          </div>,
          document.body
      )}
    </div>
  );
};
