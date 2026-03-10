import React, { useState } from 'react';
import { Play, CheckCircle, Clock, AlertCircle, FileOutput, ArrowRight, Database, Settings, Download, FileCode, Code, ShieldCheck, X } from 'lucide-react';
import { TransformationRun, ProvenanceType, ProvenanceRecord, ClinicalFile, MappingSpec, DataType, User } from '../types';
import { runTransformation, generateETLScript } from '../services/geminiService';

interface PipelineProps {
  files: ClinicalFile[];
  mappingSpecs: MappingSpec[];
  onAddFile: (file: ClinicalFile) => void;
  onRecordProvenance: (record: ProvenanceRecord) => void;
  currentUser: User;
}

export const Pipeline: React.FC<PipelineProps> = ({ files, mappingSpecs, onAddFile, onRecordProvenance, currentUser }) => {
  const signatureRequired = false; // Prototype mode: auth/signature deferred
  const [selectedSpecId, setSelectedSpecId] = useState<string>('');
  const [selectedFileId, setSelectedFileId] = useState<string>('');
  const [isRunning, setIsRunning] = useState(false);
  const [executionLog, setExecutionLog] = useState<string[]>([]);
  const [resultFileId, setResultFileId] = useState<string | null>(null);
  
  // Script State
  const [generatedScript, setGeneratedScript] = useState<string>('');
  const [activeTab, setActiveTab] = useState<'LOG' | 'CODE'>('LOG');

  // GxP State
  const [showSignModal, setShowSignModal] = useState(false);
  const [signature, setSignature] = useState('');
  const [signError, setSignError] = useState('');

  const rawFiles = files.filter(f => f.type === DataType.RAW);
  const selectedSpec = mappingSpecs.find(s => s.id === selectedSpecId);
  const selectedFile = rawFiles.find(f => f.id === selectedFileId);

  const log = (message: string) => {
    setExecutionLog(prev => [...prev, `[${new Date().toLocaleTimeString()}] ${message}`]);
  };

  const executeTransformation = async (signatureText?: string) => {
    if (!selectedSpec || !selectedFile) return;

    setIsRunning(true);
    setResultFileId(null);
    setActiveTab('LOG');

    if (signatureText) {
      log(`Digital Signature Verified: ${signatureText}`);
    } else {
      log(`Prototype mode active: digital signature deferred.`);
    }
    log(`Executing transformation on data (deterministic engine)...`);

    try {
      // Step 3: Transformation (Execution via Script)
      // Pass the script to ensure consistency between code and execution
      const transformedCsv = await runTransformation(selectedFile, selectedSpec, generatedScript);
      
      if (!transformedCsv || transformedCsv.split('\n').length < 2) {
          throw new Error("Transformation returned empty or invalid result (no data rows).");
      }
      log(`Transformation executed. Rows generated: ${transformedCsv.split('\n').length - 1}`);

      // Step 4: Output Generation
      log(`Creating standardized dataset...`);
      const newFileId = crypto.randomUUID();
      const newFileName = `sdtm_${selectedSpec.targetDomain.toLowerCase()}_${new Date().getTime()}.csv`;
      
      const newFile: ClinicalFile = {
          id: newFileId,
          name: newFileName,
          type: DataType.STANDARDIZED,
          uploadDate: new Date().toISOString(),
          size: `${(transformedCsv.length / 1024).toFixed(1)} KB`,
          content: transformedCsv
      };

      onAddFile(newFile);
      setResultFileId(newFileId);
      log(`Saved output file: ${newFileName}`);

      // Step 5: Provenance with Signature
      onRecordProvenance({
        id: crypto.randomUUID(),
        timestamp: new Date().toISOString(),
        userId: currentUser.name,
        actionType: ProvenanceType.TRANSFORMATION,
        details: `Transformed ${selectedFile.name} to ${selectedSpec.targetDomain}`,
        inputs: [selectedFile.id, selectedSpec.id],
        outputs: [newFileId],
        signature: signatureText || 'Deferred (prototype mode)'
      });

      log(`Pipeline completed successfully.`);

    } catch (error: any) {
      log(`ERROR: ${error.message || 'Pipeline failed'}`);
      console.error(error);
    } finally {
      setIsRunning(false);
    }
  };

  const handleRunClick = async () => {
      if (!selectedSpec || !selectedFile) return;
      
      setIsRunning(true);
      setExecutionLog([]);
      log(`Initiating Pipeline...`);
      log(`Generating Validation Code...`);
      
      const script = await generateETLScript(selectedFile, selectedSpec);
      setGeneratedScript(script);
      log(`Script generated.`);
      setIsRunning(false);

      if (signatureRequired) {
        log(`Pending review and signature.`);
        setShowSignModal(true);
        return;
      }

      await executeTransformation();
  };

  const handleExecuteWithSignature = async () => {
    if (signature !== currentUser.name) {
        setSignError("Signature does not match your username.");
        return;
    }
    setShowSignModal(false);
    await executeTransformation(`Electronically Signed by ${currentUser.name} (${currentUser.role}) at ${new Date().toISOString()}`);
  };

  const downloadResult = () => {
    const file = files.find(f => f.id === resultFileId);
    if (!file || !file.content) return;
    const blob = new Blob([file.content], { type: 'text/csv' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = file.name;
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
    URL.revokeObjectURL(url);
  };

  const downloadScript = () => {
    if (!generatedScript) return;
    const blob = new Blob([generatedScript], { type: 'text/x-python' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `etl_${selectedSpec?.targetDomain.toLowerCase() || 'script'}.py`;
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
    URL.revokeObjectURL(url);
  };

  return (
    <div className="p-8 h-full flex flex-col bg-slate-50 relative">
      <div className="mb-6">
        <h2 className="text-2xl font-bold text-slate-800">Transformation Pipeline</h2>
        <p className="text-slate-500">Orchestrate data flow from Raw to Analysis Ready</p>
      </div>

      <div className="grid grid-cols-1 lg:grid-cols-3 gap-8 flex-1">
          {/* Configuration Panel */}
          <div className="bg-white border border-slate-200 rounded-xl p-6 shadow-sm h-fit">
              <h3 className="text-lg font-bold text-slate-800 mb-6 flex items-center">
                  <Settings className="w-5 h-5 mr-2 text-slate-500" />
                  Configuration
              </h3>

              <div className="space-y-6">
                  <div>
                      <label className="block text-sm font-semibold text-slate-700 mb-2">1. Select Mapping Spec</label>
                      <select 
                        value={selectedSpecId}
                        onChange={(e) => setSelectedSpecId(e.target.value)}
                        className="w-full p-2.5 border border-slate-300 rounded-lg focus:ring-2 focus:ring-medical-500 outline-none text-sm bg-slate-50"
                      >
                          <option value="">-- Choose Specification --</option>
                          {mappingSpecs.map(s => (
                              <option key={s.id} value={s.id}>{s.sourceDomain} → {s.targetDomain}</option>
                          ))}
                      </select>
                      {mappingSpecs.length === 0 && (
                          <p className="text-xs text-orange-500 mt-1">No specs available. Create one in Mapping tab.</p>
                      )}
                  </div>

                  <div className="flex justify-center">
                      <ArrowRight className="text-slate-300 transform rotate-90 lg:rotate-0" />
                  </div>

                  <div>
                      <label className="block text-sm font-semibold text-slate-700 mb-2">2. Select Input Raw File</label>
                      <select 
                        value={selectedFileId}
                        onChange={(e) => setSelectedFileId(e.target.value)}
                        className="w-full p-2.5 border border-slate-300 rounded-lg focus:ring-2 focus:ring-medical-500 outline-none text-sm bg-slate-50"
                      >
                          <option value="">-- Choose Raw Dataset --</option>
                          {rawFiles.map(f => (
                              <option key={f.id} value={f.id}>{f.name} ({f.size})</option>
                          ))}
                      </select>
                  </div>

                  <button
                    onClick={handleRunClick}
                    disabled={isRunning || !selectedSpecId || !selectedFileId}
                    className={`w-full py-3 rounded-lg font-bold flex items-center justify-center shadow-md transition-all mt-4 ${
                        isRunning || !selectedSpecId || !selectedFileId
                        ? 'bg-slate-200 text-slate-400 cursor-not-allowed' 
                        : 'bg-green-600 text-white hover:bg-green-700 hover:shadow-lg'
                    }`}
                    >
                    {isRunning ? <Clock className="w-5 h-5 mr-2 animate-spin" /> : <Play className="w-5 h-5 mr-2" />}
                    {isRunning ? 'Running Transformation...' : (signatureRequired ? 'Review & Run' : 'Review & Run (Prototype)')}
                  </button>
                  {!signatureRequired && (
                    <p className="text-[11px] text-slate-500 mt-2">
                      Prototype mode: digital signature enforcement is deferred for capability testing.
                    </p>
                  )}
              </div>

              {/* Spec Preview */}
              {selectedSpec && (
                  <div className="mt-8 p-4 bg-slate-50 rounded-lg border border-slate-200 text-xs">
                      <h4 className="font-semibold text-slate-600 mb-2 uppercase">Mapping Preview</h4>
                      <ul className="space-y-1 text-slate-500 font-mono">
                          {selectedSpec.mappings.slice(0, 5).map((m, i) => (
                              <li key={i} className="flex justify-between">
                                  <span>{m.sourceCol || '?'}</span>
                                  <ArrowRight className="w-3 h-3 mx-2" />
                                  <span className="text-slate-800">{m.targetCol}</span>
                              </li>
                          ))}
                          {selectedSpec.mappings.length > 5 && <li>...</li>}
                      </ul>
                  </div>
              )}
          </div>

          {/* Execution Log & Code */}
          <div className="lg:col-span-2 flex flex-col h-full min-h-[500px]">
              {/* Tab Header */}
              <div className="flex space-x-2 mb-2">
                 <button
                   onClick={() => setActiveTab('LOG')}
                   className={`px-4 py-2 rounded-lg text-sm font-semibold transition-colors ${
                       activeTab === 'LOG' ? 'bg-slate-800 text-white shadow-sm' : 'bg-white text-slate-500 hover:bg-slate-100'
                   }`}
                 >
                    Execution Log
                 </button>
                 <button
                   onClick={() => setActiveTab('CODE')}
                   disabled={!generatedScript}
                   className={`px-4 py-2 rounded-lg text-sm font-semibold transition-colors flex items-center ${
                       activeTab === 'CODE' 
                       ? 'bg-slate-800 text-white shadow-sm' 
                       : (generatedScript ? 'bg-white text-slate-500 hover:bg-slate-100' : 'bg-slate-50 text-slate-300 cursor-not-allowed')
                   }`}
                 >
                    <Code className="w-4 h-4 mr-2" />
                    Code Preview
                 </button>
              </div>

              <div className="bg-[#1e1e1e] rounded-xl shadow-lg border border-slate-600 flex flex-col flex-1 overflow-hidden">
                  <div className="bg-[#2d2d2d] px-4 py-3 border-b border-[#3e3e3e] flex justify-between items-center">
                      <div className="flex items-center space-x-2">
                          <div className="w-3 h-3 rounded-full bg-red-500" />
                          <div className="w-3 h-3 rounded-full bg-yellow-500" />
                          <div className="w-3 h-3 rounded-full bg-green-500" />
                      </div>
                      <span className="text-xs font-mono text-slate-400">
                          {activeTab === 'LOG' ? 'pipeline_execution.log' : 'transformation_script.py'}
                      </span>
                  </div>
                  
                  <div className="flex-1 p-6 font-mono text-sm overflow-y-auto space-y-2 relative">
                      {activeTab === 'LOG' && (
                          <div className="text-green-400">
                                {executionLog.length === 0 && !isRunning && (
                                    <span className="text-slate-600">Waiting for job configuration...</span>
                                )}
                                {executionLog.map((line, i) => (
                                    <div key={i} className="break-all">{line}</div>
                                ))}
                                {isRunning && (
                                    <div className="animate-pulse">_</div>
                                )}
                          </div>
                      )}
                      
                      {activeTab === 'CODE' && generatedScript && (
                          <pre className="text-blue-300 whitespace-pre-wrap">{generatedScript}</pre>
                      )}
                  </div>
              </div>

              {/* Actions Footer */}
              <div className="flex space-x-4 mt-4">
                  {generatedScript && (
                      <button 
                        onClick={downloadScript}
                        className="flex-1 px-4 py-3 bg-white border border-blue-300 text-blue-700 rounded-xl hover:bg-blue-50 text-sm font-bold flex items-center justify-center transition-colors shadow-sm animate-fadeIn"
                      >
                         <FileCode className="w-5 h-5 mr-2" />
                         Download Script (.py)
                      </button>
                  )}
                  {resultFileId && (
                      <button 
                        onClick={downloadResult}
                        className="flex-1 px-4 py-3 bg-white border border-green-300 text-green-700 rounded-xl hover:bg-green-100 text-sm font-bold flex items-center justify-center transition-colors shadow-sm animate-fadeIn"
                      >
                         <Download className="w-5 h-5 mr-2" />
                         Download Result (.csv)
                      </button>
                  )}
              </div>
          </div>
      </div>

      {/* Signature Modal */}
      {signatureRequired && showSignModal && (
          <div className="absolute inset-0 z-50 bg-slate-900/50 backdrop-blur-sm flex items-center justify-center p-4">
              <div className="bg-white rounded-2xl shadow-2xl w-full max-w-lg p-8 animate-fadeIn">
                  <div className="flex justify-between items-start mb-6">
                      <h3 className="text-xl font-bold text-slate-800 flex items-center">
                          <ShieldCheck className="w-6 h-6 mr-2 text-medical-600" />
                          Electronic Signature Required
                      </h3>
                      <button onClick={() => setShowSignModal(false)} className="text-slate-400 hover:text-slate-600">
                          <X className="w-6 h-6" />
                      </button>
                  </div>
                  
                  <div className="bg-yellow-50 border border-yellow-200 rounded-lg p-4 mb-6 text-sm text-yellow-800">
                      <strong>21 CFR Part 11 Warning:</strong> By signing this record, you certify that the generated code has been reviewed and is safe to execute on the clinical dataset.
                  </div>

                  <div className="mb-6">
                      <div className="bg-slate-100 rounded-lg p-3 font-mono text-xs text-slate-600 mb-4 h-32 overflow-y-auto">
                          {generatedScript}
                      </div>

                      <label className="block text-sm font-bold text-slate-700 mb-2">
                          Type your username ("{currentUser.name}") to sign:
                      </label>
                      <input 
                          type="text" 
                          value={signature}
                          onChange={(e) => setSignature(e.target.value)}
                          placeholder={currentUser.name}
                          className="w-full p-3 border border-slate-300 rounded-lg focus:ring-2 focus:ring-medical-500 outline-none font-medium"
                      />
                      {signError && <p className="text-red-500 text-xs mt-1">{signError}</p>}
                  </div>

                  <div className="flex justify-end space-x-3">
                      <button 
                        onClick={() => setShowSignModal(false)}
                        className="px-4 py-2 text-slate-600 font-medium hover:bg-slate-100 rounded-lg"
                      >
                          Cancel
                      </button>
                      <button 
                        onClick={handleExecuteWithSignature}
                        disabled={!signature}
                        className="px-6 py-2 bg-medical-600 text-white font-bold rounded-lg hover:bg-medical-700 disabled:opacity-50 disabled:cursor-not-allowed shadow-lg"
                      >
                          Sign & Execute
                      </button>
                  </div>
              </div>
          </div>
      )}
    </div>
  );
};
