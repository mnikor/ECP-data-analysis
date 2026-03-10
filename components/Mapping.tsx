import React, { useState, useMemo } from 'react';
import { ArrowRight, Wand2, Save, FileSpreadsheet, AlertCircle } from 'lucide-react';
import { MappingSpec, ClinicalFile, DataType } from '../types';
import { generateMappingSuggestion } from '../services/geminiService';
import { parseCsv } from '../utils/dataProcessing';
import { parseReferenceMapping } from '../utils/mappingReference';

interface MappingProps {
  files: ClinicalFile[];
  onSaveSpec: (spec: MappingSpec) => void;
}

export const Mapping: React.FC<MappingProps> = ({ files, onSaveSpec }) => {
  const [selectedFileId, setSelectedFileId] = useState<string>('');
  const [selectedReferenceId, setSelectedReferenceId] = useState<string>('');
  const [sourceDomain, setSourceDomain] = useState('RAW_DOMAIN');
  const [targetDomain, setTargetDomain] = useState('DM');
  const [mappings, setMappings] = useState<{ sourceCol: string; targetCol: string; transformation?: string }[]>([
    { sourceCol: '', targetCol: '', transformation: '' }
  ]);
  const [isSuggesting, setIsSuggesting] = useState(false);

  const rawFiles = files.filter(f => f.type === DataType.RAW);
  const referenceFiles = files.filter(f => f.type === DataType.MAPPING);
  const selectedFile = rawFiles.find(f => f.id === selectedFileId);
  const selectedReference = referenceFiles.find(f => f.id === selectedReferenceId);

  // Parse columns from the selected file content
  const sourceColumns = useMemo(() => {
    if (!selectedFile || !selectedFile.content) return [];
    try {
      return parseCsv(selectedFile.content).headers;
    } catch {
      return [];
    }
  }, [selectedFile]);

  // Update Source Domain Name automatically when file is selected
  const handleFileSelect = (e: React.ChangeEvent<HTMLSelectElement>) => {
      const fileId = e.target.value;
      setSelectedFileId(fileId);
      const file = rawFiles.find(f => f.id === fileId);
      if (file) {
          const name = file.name.split('.')[0].toUpperCase();
          setSourceDomain(name);
      }
  };

  const handleAddRow = () => {
    setMappings([...mappings, { sourceCol: '', targetCol: '', transformation: '' }]);
  };

  const updateMapping = (index: number, field: string, value: string) => {
    const newMappings = [...mappings];
    // @ts-ignore
    newMappings[index][field] = value;
    setMappings(newMappings);
  };

  const handleSuggest = async () => {
    if (!selectedFileId) {
        alert("Please select a Source Raw File first.");
        return;
    }
    if (sourceColumns.length === 0) {
        alert("Could not read columns from the selected file.");
        return;
    }

    setIsSuggesting(true);
    
    try {
      // Use REAL columns from the file
      const suggestion = await generateMappingSuggestion(sourceColumns, targetDomain);
      if (suggestion.mappings && suggestion.mappings.length > 0) {
        setMappings(suggestion.mappings);
      } else {
        alert("AI could not generate confident mappings. Please try a different target domain.");
      }
    } catch (e) {
      console.error(e);
      alert("Failed to generate suggestions. Check API connection.");
    } finally {
      setIsSuggesting(false);
    }
  };

  const handleSave = () => {
    if (!sourceDomain || !targetDomain) {
        alert("Please define Source and Target domains.");
        return;
    }
    
    const validMappings = mappings.filter(m => m.sourceCol && m.targetCol);
    if (validMappings.length === 0) {
        alert("Please define at least one valid mapping row (both Source and Target columns must be filled).");
        return;
    }

    onSaveSpec({
      id: crypto.randomUUID(),
      sourceDomain,
      targetDomain,
      mappings: validMappings
    });
    alert("Mapping Specification Saved Successfully!");
  };

  const handleLoadReference = () => {
    if (!selectedReference) {
      alert('Select a reference mapping file first.');
      return;
    }

    const imported = parseReferenceMapping(selectedReference);
    if (!imported) {
      alert('Could not parse reference mapping file. Expected JSON with mappings[] or CSV with source/target columns.');
      return;
    }

    setSourceDomain(imported.sourceDomain || sourceDomain);
    setTargetDomain(imported.targetDomain || targetDomain);
    setMappings(imported.mappings.length > 0 ? imported.mappings : mappings);
    if (imported.mode === 'IDENTITY') {
      alert(
        `Loaded ${imported.mappings.length} rows from ${selectedReference.name} using dictionary bootstrap (${imported.sourceHeader} -> same target). Review targets and click Save Spec.`
      );
      return;
    }
    alert(
      `Loaded ${imported.mappings.length} mapping rows from ${selectedReference.name}${
        imported.sourceHeader && imported.targetHeader ? ` (${imported.sourceHeader} -> ${imported.targetHeader})` : ''
      }. Review and click Save Spec.`
    );
  };

  return (
    <div className="p-6 max-w-5xl mx-auto h-full overflow-y-auto">
      <div className="flex justify-between items-center mb-6">
        <div>
          <h2 className="text-2xl font-bold text-slate-800">Mapping Specification</h2>
          <p className="text-slate-500 text-sm">Define transformations from Raw to Standardized domains</p>
        </div>
        <div className="flex space-x-3">
          <button 
            onClick={handleSuggest}
            disabled={isSuggesting || !selectedFileId}
            className={`flex items-center px-4 py-2 rounded-lg transition-colors shadow-sm ${
                isSuggesting || !selectedFileId 
                ? 'bg-indigo-50 text-indigo-300 cursor-not-allowed' 
                : 'bg-indigo-100 text-indigo-700 hover:bg-indigo-200'
            }`}
          >
            <Wand2 className={`w-4 h-4 mr-2 ${isSuggesting ? 'animate-spin' : ''}`} />
            {isSuggesting ? 'Analyzing Columns...' : 'AI Auto-Map'}
          </button>
          <button 
            onClick={handleSave}
            className="flex items-center px-4 py-2 bg-medical-600 text-white rounded-lg hover:bg-medical-700 transition-colors shadow-sm"
          >
            <Save className="w-4 h-4 mr-2" />
            Save Spec
          </button>
        </div>
      </div>

      <div className="grid grid-cols-1 lg:grid-cols-3 gap-6 mb-6">
          {/* Configuration Panel */}
          <div className="bg-white p-4 rounded-xl shadow-sm border border-slate-200 space-y-4">
              <div>
                <label className="block text-xs font-semibold text-slate-500 uppercase mb-2">0. Import Reference Mapping (Optional)</label>
                <div className="grid grid-cols-1 md:grid-cols-3 gap-2">
                    <select
                        value={selectedReferenceId}
                        onChange={(e) => setSelectedReferenceId(e.target.value)}
                        className="md:col-span-2 p-2.5 border border-slate-300 rounded-lg focus:ring-2 focus:ring-medical-500 outline-none bg-slate-50 text-sm"
                    >
                        <option value="">-- Choose Reference File --</option>
                        {referenceFiles.map((f) => (
                            <option key={f.id} value={f.id}>{f.name}</option>
                        ))}
                    </select>
                    <button
                        onClick={handleLoadReference}
                        disabled={!selectedReferenceId}
                        className={`px-3 py-2 rounded-lg text-sm font-medium ${
                            !selectedReferenceId
                              ? 'bg-slate-100 text-slate-400 cursor-not-allowed'
                              : 'bg-indigo-600 text-white hover:bg-indigo-700'
                        }`}
                    >
                        Load Reference
                    </button>
                </div>
                {referenceFiles.length === 0 && (
                    <div className="flex items-center mt-2 text-xs text-slate-500 bg-slate-50 p-2 rounded border border-slate-200">
                        <AlertCircle className="w-3 h-3 mr-1" />
                        No reference files found. Upload them in Ingestion &gt; Reference.
                    </div>
                )}
              </div>

              <div>
                <label className="block text-xs font-semibold text-slate-500 uppercase mb-2">1. Select Source File</label>
                <div className="relative">
                    <select 
                        value={selectedFileId}
                        onChange={handleFileSelect}
                        className="w-full p-2.5 border border-slate-300 rounded-lg focus:ring-2 focus:ring-medical-500 outline-none appearance-none bg-slate-50 text-sm"
                    >
                        <option value="">-- Choose Raw Dataset --</option>
                        {rawFiles.map(f => (
                            <option key={f.id} value={f.id}>{f.name}</option>
                        ))}
                    </select>
                    <FileSpreadsheet className="absolute right-3 top-3 w-4 h-4 text-slate-400 pointer-events-none" />
                </div>
                {rawFiles.length === 0 && (
                    <div className="flex items-center mt-2 text-xs text-orange-600 bg-orange-50 p-2 rounded">
                        <AlertCircle className="w-3 h-3 mr-1" />
                        No raw files found. Upload in Ingestion tab.
                    </div>
                )}
              </div>

              <div>
                <label className="block text-xs font-semibold text-slate-500 uppercase mb-2">2. Verify Domain Names</label>
                <div className="space-y-3">
                    <div>
                        <span className="text-[10px] text-slate-400 uppercase">Source Domain</span>
                        <input 
                          value={sourceDomain}
                          onChange={(e) => setSourceDomain(e.target.value)}
                          className="w-full p-2 border border-slate-300 rounded focus:ring-2 focus:ring-medical-500 outline-none text-sm font-mono" 
                        />
                    </div>
                    <div>
                         <span className="text-[10px] text-slate-400 uppercase">Target Domain (CDISC)</span>
                        <input 
                          value={targetDomain}
                          onChange={(e) => setTargetDomain(e.target.value)}
                          className="w-full p-2 border border-slate-300 rounded focus:ring-2 focus:ring-medical-500 outline-none text-sm font-mono" 
                        />
                    </div>
                </div>
              </div>

              {sourceColumns.length > 0 && (
                  <div className="pt-2 border-t border-slate-100">
                      <span className="text-[10px] font-bold text-slate-400 uppercase">Available Columns</span>
                      <div className="flex flex-wrap gap-1 mt-2">
                          {sourceColumns.map(c => (
                              <span key={c} className="px-2 py-1 bg-slate-100 text-slate-600 text-xs rounded border border-slate-200">
                                  {c}
                              </span>
                          ))}
                      </div>
                  </div>
              )}
          </div>

          {/* Mapping Table */}
          <div className="lg:col-span-2 bg-white rounded-xl shadow-sm border border-slate-200 overflow-hidden flex flex-col">
            <div className="p-0 flex-1 overflow-x-auto">
              <table className="w-full text-left text-sm">
                <thead className="bg-slate-50 text-slate-500 font-semibold border-b border-slate-200">
                  <tr>
                    <th className="px-4 py-3 w-1/3">Source Column</th>
                    <th className="px-2 py-3 w-8"></th>
                    <th className="px-4 py-3 w-1/3">Target Column</th>
                    <th className="px-4 py-3">Transformation</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-slate-100">
                  {mappings.map((row, i) => (
                    <tr key={i} className="group hover:bg-slate-50 transition-colors">
                      <td className="px-4 py-2">
                         {/* If we have source columns, make this a dropdown, otherwise text */}
                         {sourceColumns.length > 0 ? (
                             <select
                                value={row.sourceCol}
                                onChange={(e) => updateMapping(i, 'sourceCol', e.target.value)}
                                className="w-full bg-transparent border-b border-transparent focus:border-medical-500 outline-none py-1 text-slate-700"
                             >
                                 <option value="">- Select -</option>
                                 {sourceColumns.map(c => <option key={c} value={c}>{c}</option>)}
                             </select>
                         ) : (
                            <input 
                              value={row.sourceCol}
                              onChange={(e) => updateMapping(i, 'sourceCol', e.target.value)}
                              className="w-full bg-transparent border-b border-transparent focus:border-medical-500 outline-none py-1"
                              placeholder="e.g. SUBJID"
                            />
                         )}
                      </td>
                      <td className="px-2 py-2 text-center text-slate-300">
                        <ArrowRight className="w-4 h-4 mx-auto" />
                      </td>
                      <td className="px-4 py-2">
                        <input 
                          value={row.targetCol}
                          onChange={(e) => updateMapping(i, 'targetCol', e.target.value)}
                          className="w-full bg-transparent border-b border-transparent focus:border-medical-500 outline-none py-1 font-mono text-medical-700 font-medium"
                          placeholder="e.g. USUBJID"
                        />
                      </td>
                      <td className="px-4 py-2">
                        <input 
                          value={row.transformation}
                          onChange={(e) => updateMapping(i, 'transformation', e.target.value)}
                          className="w-full bg-transparent border-b border-transparent focus:border-medical-500 outline-none py-1 text-slate-500 text-xs italic"
                          placeholder="Transformation logic..."
                        />
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
            <button 
                onClick={handleAddRow}
                className="w-full py-3 text-center text-slate-500 hover:text-medical-600 hover:bg-slate-50 font-medium border-t border-slate-100 transition-colors text-sm"
            >
                + Add Mapping Rule
            </button>
          </div>
      </div>
    </div>
  );
};
