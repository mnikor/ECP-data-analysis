import React, { useState, useMemo, useEffect } from 'react';
import { Filter, Play, Save, Users, Funnel, Plus, Trash2, Database, Code, Sparkles, Layers } from 'lucide-react';
import { ClinicalFile, DataType, User, ProvenanceRecord, ProvenanceType, CohortFilter, AttritionStep } from '../types';
import { extractCohortFiltersFromProtocol, generateCohortSQL } from '../services/geminiService';
import { Chart } from './Chart';
import { CsvRow, matchesFilter, parseCsv, stringifyCsv } from '../utils/dataProcessing';

interface CohortBuilderProps {
  files: ClinicalFile[];
  onAddFile: (file: ClinicalFile) => void;
  onRecordProvenance: (record: ProvenanceRecord) => void;
  currentUser: User;
}

export const CohortBuilder: React.FC<CohortBuilderProps> = ({ files, onAddFile, onRecordProvenance, currentUser }) => {
  const [selectedFileId, setSelectedFileId] = useState<string>('');
  const [protocolFileId, setProtocolFileId] = useState<string>('');
  const [filters, setFilters] = useState<CohortFilter[]>([]);
  const [cohortName, setCohortName] = useState('');
  const [attritionData, setAttritionData] = useState<AttritionStep[]>([]);
  const [generatedSQL, setGeneratedSQL] = useState<string>('');
  const [protocolNotes, setProtocolNotes] = useState<string[]>([]);
  const [filteredResult, setFilteredResult] = useState<{ headers: string[]; rows: CsvRow[] } | null>(null);
  const [isProcessing, setIsProcessing] = useState(false);
  const [isApplyingProtocol, setIsApplyingProtocol] = useState(false);
  const [isPreCohortedMode, setIsPreCohortedMode] = useState(false);
  const [cohortColumn, setCohortColumn] = useState('');
  const [selectedExistingCohortValue, setSelectedExistingCohortValue] = useState<string>('ALL');
  const [activeTab, setActiveTab] = useState<'FUNNEL' | 'SQL'>('FUNNEL');

  const sourceFiles = files.filter(
    f => f.type === DataType.RAW || f.type === DataType.STANDARDIZED || f.type === DataType.COHORT_DEF
  );
  const docFiles = files.filter((f) => f.type === DataType.DOCUMENT);
  const selectedFile = sourceFiles.find(f => f.id === selectedFileId);
  const selectedProtocol = docFiles.find((d) => d.id === protocolFileId);

  const parsedSelected = useMemo(() => {
    if (!selectedFile || !selectedFile.content) return null;
    try {
      return parseCsv(selectedFile.content);
    } catch {
      return null;
    }
  }, [selectedFile]);
  const columns = parsedSelected?.headers || [];
  const rows = parsedSelected?.rows || [];

  const cohortCandidateColumns = useMemo(() => {
    return columns.filter((col) => /(cohort|group|arm|strata|stratum|segment|population)/i.test(col));
  }, [columns]);

  const cohortValues = useMemo(() => {
    if (!cohortColumn || rows.length === 0) return [];
    return Array.from(new Set(rows.map((r) => (r[cohortColumn] || '').trim()).filter(Boolean))).sort();
  }, [rows, cohortColumn]);

  useEffect(() => {
    if (cohortCandidateColumns.length > 0 && !cohortCandidateColumns.includes(cohortColumn)) {
      setCohortColumn(cohortCandidateColumns[0]);
    }
    if (cohortCandidateColumns.length === 0) setCohortColumn('');
    setSelectedExistingCohortValue('ALL');
  }, [selectedFileId, cohortCandidateColumns, cohortColumn]);

  const saveCohortFile = (
    baseName: string,
    headers: string[],
    cohortRows: CsvRow[],
    description: string,
    metadata: Record<string, unknown>
  ) => {
    const cohortContent = stringifyCsv(headers, cohortRows);
    const newFileId = crypto.randomUUID();
    const finalCount = cohortRows.length;

    const newFile: ClinicalFile = {
      id: newFileId,
      name: `${baseName.replace(/\s+/g, '_')}_N${finalCount}.csv`,
      type: DataType.COHORT_DEF,
      uploadDate: new Date().toISOString(),
      size: `${(cohortContent.length / 1024).toFixed(1)} KB`,
      content: cohortContent,
      qcStatus: 'PASS',
      metadata
    };

    onAddFile(newFile);
    onRecordProvenance({
      id: crypto.randomUUID(),
      timestamp: new Date().toISOString(),
      userId: currentUser.name,
      userRole: currentUser.role,
      actionType: ProvenanceType.COHORT_CREATION,
      details: description,
      inputs: [selectedFileId],
      outputs: [newFileId]
    });
  };

  const handleApplyProtocol = async () => {
    if (!selectedProtocol || columns.length === 0) return;
    setIsApplyingProtocol(true);
    try {
      const result = await extractCohortFiltersFromProtocol(selectedProtocol, columns);
      setProtocolNotes(result.notes);
      if (result.filters.length === 0) return;
      setFilters((prev) => {
        const merged = [...prev, ...result.filters];
        return merged.filter(
          (f, idx, arr) => arr.findIndex((x) => x.field === f.field && x.operator === f.operator && x.value === f.value) === idx
        );
      });
    } finally {
      setIsApplyingProtocol(false);
    }
  };

  const addFilter = () => {
    setFilters([...filters, {
        id: crypto.randomUUID(),
        field: columns[0] || '',
        operator: 'EQUALS',
        value: '',
        description: 'New Filter Criteria'
    }]);
  };

  const removeFilter = (id: string) => {
    setFilters(filters.filter(f => f.id !== id));
  };

  const updateFilter = (id: string, key: keyof CohortFilter, val: string) => {
    setFilters(filters.map(f => f.id === id ? { ...f, [key]: val } : f));
  };

  const handleRegisterExistingCohorts = () => {
    if (!parsedSelected || !selectedFile) return;

    if (cohortColumn && selectedExistingCohortValue === 'ALL') {
      if (cohortValues.length === 0) {
        alert('No cohort values found in selected column.');
        return;
      }
      cohortValues.forEach((value) => {
        const cohortRows = rows.filter((r) => (r[cohortColumn] || '').trim() === value);
        const safeValue = value.replace(/[^a-zA-Z0-9_-]/g, '_');
        saveCohortFile(
          `${cohortName || selectedFile.name.replace(/\.[^/.]+$/, '')}_${safeValue}`,
          columns,
          cohortRows,
          `Registered pre-defined cohort '${value}' from ${selectedFile.name} (N=${cohortRows.length}).`,
          {
            sourceType: 'PREDEFINED',
            cohortColumn,
            cohortValue: value,
            sourceDataset: selectedFile.name
          }
        );
      });
      alert(`Registered ${cohortValues.length} predefined cohorts from column '${cohortColumn}'.`);
      return;
    }

    const cohortRows =
      cohortColumn && selectedExistingCohortValue !== 'ALL'
        ? rows.filter((r) => (r[cohortColumn] || '').trim() === selectedExistingCohortValue)
        : rows;
    const defaultName =
      cohortColumn && selectedExistingCohortValue !== 'ALL'
        ? `${cohortName || selectedFile.name.replace(/\.[^/.]+$/, '')}_${selectedExistingCohortValue}`
        : `${cohortName || selectedFile.name.replace(/\.[^/.]+$/, '')}_as_is`;

    saveCohortFile(
      defaultName,
      columns,
      cohortRows,
      `Registered pre-defined cohort from ${selectedFile.name} (N=${cohortRows.length}).`,
      {
        sourceType: 'PREDEFINED',
        cohortColumn: cohortColumn || null,
        cohortValue: cohortColumn ? selectedExistingCohortValue : null,
        sourceDataset: selectedFile.name
      }
    );
    alert('Pre-defined cohort registered for analysis.');
  };

  const handleRunCohort = async () => {
      if (!selectedFile || !selectedFile.content) return;
      setIsProcessing(true);
      setFilteredResult(null);

      try {
        // Generate SQL
        const sql = await generateCohortSQL(selectedFile, filters);
        setGeneratedSQL(sql);
        const { headers, rows } = parsedSelected || parseCsv(selectedFile.content);
        const initialCount = rows.length;
        let currentRows = rows;
        const steps: AttritionStep[] = [];

        steps.push({
            stepName: 'Initial Population',
            inputCount: initialCount,
            excludedCount: 0,
            remainingCount: initialCount,
            reason: 'All records from source'
        });

        filters.forEach((filter, idx) => {
          const before = currentRows.length;
          const afterRows = currentRows.filter((row) => matchesFilter(row, filter));
          const excluded = before - afterRows.length;

          steps.push({
              stepName: `Filter ${idx + 1}: ${filter.field} ${filter.operator} ${filter.value}`,
              inputCount: before,
              excludedCount: excluded,
              remainingCount: afterRows.length,
              reason: `Did not meet criteria: ${filter.description}`
          });
          currentRows = afterRows;
        });

        setAttritionData(steps);
        setFilteredResult({ headers, rows: currentRows });
      } finally {
        setIsProcessing(false);
      }
  };

  const handleSaveCohort = () => {
      if (!cohortName) {
          alert("Please name your cohort.");
          return;
      }
      if (attritionData.length === 0) return;

      const finalCount = attritionData[attritionData.length - 1].remainingCount;
      const description = `RWE Cohort '${cohortName}' (N=${finalCount}). Source: ${selectedFile?.name}`;
      const resultHeaders = filteredResult?.headers || columns;
      const resultRows = filteredResult?.rows || rows;

      saveCohortFile(cohortName, resultHeaders, resultRows, description, {
        sourceType: 'FILTERED',
        cohortFilters: filters,
        protocolFileId: protocolFileId || null,
      });

      alert("Cohort saved successfully! It is now available for Statistical Analysis.");
  };

  // Prepare Funnel Chart
  const chartData = useMemo(() => {
      if (attritionData.length === 0) return { data: [], layout: {} };

      return {
          data: [{
              type: 'funnel',
              y: attritionData.map(s => s.stepName),
              x: attritionData.map(s => s.remainingCount),
              textinfo: "value+percent initial",
              marker: {
                  color: ["#6366f1", "#818cf8", "#a5b4fc", "#c7d2fe", "#e0e7ff"]
              }
          }],
          layout: {
              title: 'Attrition Funnel (PRISMA)',
              margin: { l: 250 },
              height: 400
          }
      };
  }, [attritionData]);

  return (
    <div className="p-8 h-full flex flex-col bg-slate-50">
      <div className="mb-6 flex justify-between items-end">
        <div>
           <h2 className="text-2xl font-bold text-slate-800 flex items-center">
             <Filter className="w-6 h-6 mr-3 text-purple-600" />
             RWE Cohort Builder
           </h2>
           <p className="text-slate-500">Define inclusion/exclusion criteria to select study populations from real-world data.</p>
        </div>
      </div>

      <div className="grid grid-cols-1 lg:grid-cols-3 gap-8 flex-1">
          {/* Left: Configuration */}
          <div className="bg-white p-6 rounded-xl border border-slate-200 shadow-sm flex flex-col">
              <h3 className="font-bold text-slate-800 mb-4 flex items-center">
                  <Users className="w-5 h-5 mr-2 text-slate-500" />
                  Population Definition
              </h3>
              
              <div className="space-y-4 mb-6">
                  <div>
                      <label className="block text-xs font-semibold text-slate-500 uppercase mb-2">1. Source Data</label>
                      <select 
                        value={selectedFileId}
                        onChange={(e) => setSelectedFileId(e.target.value)}
                        className="w-full p-2.5 border border-slate-300 rounded-lg focus:ring-2 focus:ring-purple-500 outline-none text-sm bg-slate-50"
                      >
                          <option value="">-- Select Real-World Dataset --</option>
                          {sourceFiles.map(f => (
                              <option key={f.id} value={f.id}>{f.name} ({f.size})</option>
                          ))}
                      </select>
                  </div>

                  <div>
                      <label className="block text-xs font-semibold text-slate-500 uppercase mb-2">2. Protocol (Optional)</label>
                      <select
                        value={protocolFileId}
                        onChange={(e) => setProtocolFileId(e.target.value)}
                        className="w-full p-2.5 border border-slate-300 rounded-lg focus:ring-2 focus:ring-purple-500 outline-none text-sm bg-slate-50"
                      >
                          <option value="">-- Select Protocol/SAP Document --</option>
                          {docFiles.map((f) => (
                              <option key={f.id} value={f.id}>{f.name}</option>
                          ))}
                      </select>
                      <button
                        onClick={handleApplyProtocol}
                        disabled={!selectedProtocol || columns.length === 0 || isApplyingProtocol}
                        className={`mt-2 w-full py-2 rounded text-xs font-bold flex items-center justify-center ${
                          !selectedProtocol || columns.length === 0 || isApplyingProtocol
                            ? 'bg-slate-100 text-slate-400 cursor-not-allowed'
                            : 'bg-indigo-600 text-white hover:bg-indigo-700'
                        }`}
                      >
                        <Sparkles className="w-3 h-3 mr-2" />
                        {isApplyingProtocol ? 'Extracting Criteria...' : 'Apply Protocol Criteria'}
                      </button>
                      {protocolNotes.length > 0 && (
                        <div className="mt-2 p-2 border border-indigo-100 bg-indigo-50 rounded text-[11px] text-indigo-800">
                          {protocolNotes.map((note, idx) => (
                            <div key={idx}>- {note}</div>
                          ))}
                        </div>
                      )}
                  </div>

                  <div className="pt-2 border-t border-slate-100">
                    <label className="flex items-center space-x-2 cursor-pointer">
                      <input
                        type="checkbox"
                        checked={isPreCohortedMode}
                        onChange={(e) => setIsPreCohortedMode(e.target.checked)}
                        className="rounded border-slate-300 text-purple-600 focus:ring-purple-500"
                      />
                      <span className="text-xs font-semibold text-slate-600 uppercase">Dataset Already Cohorted (Prospective NIS)</span>
                    </label>
                    {isPreCohortedMode && (
                      <div className="mt-3 space-y-2">
                        <label className="block text-xs font-semibold text-slate-500 uppercase">Cohort Column (Optional)</label>
                        <select
                          value={cohortColumn}
                          onChange={(e) => setCohortColumn(e.target.value)}
                          className="w-full p-2 border border-slate-300 rounded text-xs bg-slate-50"
                        >
                          <option value="">-- No Cohort Column (single provided cohort) --</option>
                          {columns.map((c) => (
                            <option key={c} value={c}>{c}</option>
                          ))}
                        </select>
                        {cohortColumn && (
                          <select
                            value={selectedExistingCohortValue}
                            onChange={(e) => setSelectedExistingCohortValue(e.target.value)}
                            className="w-full p-2 border border-slate-300 rounded text-xs bg-slate-50"
                          >
                            <option value="ALL">All values (create one cohort per value)</option>
                            {cohortValues.map((value) => (
                              <option key={value} value={value}>{value}</option>
                            ))}
                          </select>
                        )}
                        <button
                          onClick={handleRegisterExistingCohorts}
                          disabled={!selectedFileId}
                          className={`w-full py-2 rounded text-xs font-bold flex items-center justify-center ${
                            !selectedFileId
                              ? 'bg-slate-100 text-slate-400 cursor-not-allowed'
                              : 'bg-sky-600 text-white hover:bg-sky-700'
                          }`}
                        >
                          <Layers className="w-3 h-3 mr-2" />
                          Register Existing Cohort(s)
                        </button>
                      </div>
                    )}
                  </div>
              </div>

              <div className="flex-1 overflow-y-auto mb-4">
                  <div className="flex justify-between items-center mb-2">
                      <label className="block text-xs font-semibold text-slate-500 uppercase">3. Inclusion/Exclusion Criteria</label>
                      <button 
                        onClick={addFilter} 
                        disabled={!selectedFileId || isPreCohortedMode}
                        className={`text-xs flex items-center font-bold transition-colors ${!selectedFileId ? 'text-slate-300 cursor-not-allowed' : 'text-purple-600 hover:text-purple-700'}`}
                      >
                          <Plus className="w-3 h-3 mr-1" /> Add Rule
                      </button>
                  </div>
                  
                  <div className="space-y-3">
                      {isPreCohortedMode && (
                          <div className="text-center p-4 border-2 border-dashed border-sky-200 bg-sky-50 rounded-lg text-sky-700 text-xs">
                              Pre-cohorted mode is active. Manual filters are optional and can be skipped.
                          </div>
                      )}
                      {filters.map((filter, idx) => (
                          <div key={filter.id} className="p-3 bg-slate-50 border border-slate-200 rounded-lg group">
                              <div className="flex justify-between mb-2">
                                  <span className="text-xs font-bold text-slate-400">Step {idx + 1}</span>
                                  <button onClick={() => removeFilter(filter.id)} className="text-slate-300 hover:text-red-500">
                                      <Trash2 className="w-3 h-3" />
                                  </button>
                              </div>
                              <div className="grid grid-cols-3 gap-2 mb-2">
                                  <select 
                                    className="text-xs border rounded p-1"
                                    value={filter.field}
                                    onChange={(e) => updateFilter(filter.id, 'field', e.target.value)}
                                  >
                                      {columns.map(c => <option key={c} value={c}>{c}</option>)}
                                  </select>
                                  <select 
                                    className="text-xs border rounded p-1"
                                    value={filter.operator}
                                    onChange={(e) => updateFilter(filter.id, 'operator', e.target.value as any)}
                                  >
                                      <option value="EQUALS">=</option>
                                      <option value="NOT_EQUALS">!=</option>
                                      <option value="GREATER_THAN">&gt;</option>
                                      <option value="LESS_THAN">&lt;</option>
                                      <option value="GREATER_OR_EQUAL">&gt;=</option>
                                      <option value="LESS_OR_EQUAL">&lt;=</option>
                                      <option value="CONTAINS">Contains</option>
                                  </select>
                                  <input 
                                    className="text-xs border rounded p-1"
                                    placeholder="Value"
                                    value={filter.value}
                                    onChange={(e) => updateFilter(filter.id, 'value', e.target.value)}
                                  />
                              </div>
                              <input 
                                className="w-full text-xs border-b border-dashed border-slate-300 bg-transparent outline-none text-slate-500 placeholder:italic"
                                placeholder="Description (e.g. Exclude pediatric patients)"
                                value={filter.description}
                                onChange={(e) => updateFilter(filter.id, 'description', e.target.value)}
                              />
                          </div>
                      ))}
                      {filters.length === 0 && (
                          <div className="text-center p-4 border-2 border-dashed border-slate-200 rounded-lg text-slate-400 text-sm">
                              No filters applied. Entire population selected.
                          </div>
                      )}
                  </div>
              </div>

              <button
                onClick={handleRunCohort}
                disabled={isProcessing || !selectedFileId || isPreCohortedMode}
                className={`w-full py-3 rounded-lg font-bold flex items-center justify-center shadow-md transition-all ${
                    isProcessing || !selectedFileId || isPreCohortedMode
                    ? 'bg-slate-200 text-slate-400 cursor-not-allowed' 
                    : 'bg-purple-600 text-white hover:bg-purple-700 hover:shadow-lg'
                }`}
              >
                {isProcessing ? <Play className="w-5 h-5 mr-2 animate-spin" /> : <Funnel className="w-5 h-5 mr-2" />}
                {isProcessing ? 'Filtering Data...' : (isPreCohortedMode ? 'Use Register Existing Cohort(s)' : 'Run Filter Logic')}
              </button>
          </div>

          {/* Right: Visualization & Save */}
          <div className="lg:col-span-2 flex flex-col h-full min-h-[600px]">
              {attritionData.length > 0 ? (
                  <div className="flex flex-col h-full space-y-4">
                      {/* Tabs */}
                      <div className="flex space-x-2">
                         <button
                           onClick={() => setActiveTab('FUNNEL')}
                           className={`px-4 py-2 rounded-lg text-sm font-semibold transition-colors flex items-center ${
                               activeTab === 'FUNNEL' ? 'bg-slate-800 text-white shadow-sm' : 'bg-white text-slate-500 hover:bg-slate-100'
                           }`}
                         >
                            <Funnel className="w-4 h-4 mr-2" />
                            Attrition Funnel
                         </button>
                         <button
                           onClick={() => setActiveTab('SQL')}
                           className={`px-4 py-2 rounded-lg text-sm font-semibold transition-colors flex items-center ${
                               activeTab === 'SQL' ? 'bg-slate-800 text-white shadow-sm' : 'bg-white text-slate-500 hover:bg-slate-100'
                           }`}
                         >
                            <Database className="w-4 h-4 mr-2" />
                            Generated SQL
                         </button>
                      </div>

                      {activeTab === 'FUNNEL' ? (
                          <>
                            <div className="bg-white p-6 rounded-xl border border-slate-200 shadow-sm">
                                 <Chart data={chartData.data} layout={chartData.layout} />
                            </div>

                            <div className="bg-white p-6 rounded-xl border border-slate-200 shadow-sm flex-1 flex flex-col">
                                <h3 className="font-bold text-slate-800 mb-4">Step-by-Step Attrition Table</h3>
                                <div className="overflow-x-auto flex-1">
                                    <table className="w-full text-sm text-left">
                                        <thead className="bg-slate-50 text-slate-500 font-semibold border-b border-slate-200">
                                            <tr>
                                                <th className="px-4 py-2">Step</th>
                                                <th className="px-4 py-2 text-right">Input</th>
                                                <th className="px-4 py-2 text-right text-red-600">Excluded</th>
                                                <th className="px-4 py-2 text-right text-green-600">Remaining</th>
                                                <th className="px-4 py-2">Reason</th>
                                            </tr>
                                        </thead>
                                        <tbody className="divide-y divide-slate-100">
                                            {attritionData.map((step, i) => (
                                                <tr key={i}>
                                                    <td className="px-4 py-2 font-medium">{step.stepName}</td>
                                                    <td className="px-4 py-2 text-right text-slate-600">{step.inputCount}</td>
                                                    <td className="px-4 py-2 text-right text-red-500">-{step.excludedCount}</td>
                                                    <td className="px-4 py-2 text-right font-bold text-green-700">{step.remainingCount}</td>
                                                    <td className="px-4 py-2 text-slate-500 italic text-xs">{step.reason}</td>
                                                </tr>
                                            ))}
                                        </tbody>
                                    </table>
                                </div>

                                <div className="mt-6 pt-6 border-t border-slate-200 flex items-end justify-between shrink-0">
                                    <div className="w-full max-w-sm">
                                        <label className="block text-xs font-semibold text-slate-500 uppercase mb-2">Cohort Name</label>
                                        <input 
                                            className="w-full p-2 border border-slate-300 rounded focus:ring-2 focus:ring-purple-500 outline-none"
                                            placeholder="e.g. Type2_Diabetes_Male_Over50"
                                            value={cohortName}
                                            onChange={(e) => setCohortName(e.target.value)}
                                        />
                                    </div>
                                    <button
                                        onClick={handleSaveCohort}
                                        className="px-6 py-2.5 bg-green-600 text-white rounded-lg font-bold hover:bg-green-700 shadow-sm flex items-center"
                                    >
                                        <Save className="w-4 h-4 mr-2" />
                                        Save Cohort for Analysis
                                    </button>
                                </div>
                            </div>
                          </>
                      ) : (
                          <div className="bg-[#1e1e1e] rounded-xl shadow-lg border border-slate-600 flex flex-col flex-1 overflow-hidden">
                              <div className="bg-[#2d2d2d] px-4 py-3 border-b border-[#3e3e3e] flex justify-between items-center">
                                  <div className="flex items-center space-x-2">
                                      <div className="w-3 h-3 rounded-full bg-red-500" />
                                      <div className="w-3 h-3 rounded-full bg-yellow-500" />
                                      <div className="w-3 h-3 rounded-full bg-green-500" />
                                  </div>
                                  <span className="text-xs font-mono text-slate-400 flex items-center">
                                      <Code className="w-3 h-3 mr-1" /> cohort_extraction.sql
                                  </span>
                              </div>
                              <div className="flex-1 p-6 font-mono text-sm overflow-y-auto">
                                  <pre className="text-blue-300 whitespace-pre-wrap">{generatedSQL}</pre>
                              </div>
                          </div>
                      )}
                  </div>
              ) : (
                  <div className="h-full flex flex-col items-center justify-center border-2 border-dashed border-slate-300 rounded-xl text-slate-400">
                      <Funnel className="w-16 h-16 mb-4 opacity-20" />
                      <p className="font-medium">Define rules and run logic to visualize cohort attrition.</p>
                  </div>
              )}
          </div>
      </div>
    </div>
  );
};
