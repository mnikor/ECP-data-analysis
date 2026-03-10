import React, { useState } from 'react';
import { History, Search, Code, FileText, Activity, Download, ShieldCheck, Fingerprint, Trash2, AlertOctagon, Filter, X, FlaskConical, Map as MapIcon } from 'lucide-react';
import { ProvenanceRecord, ProvenanceType } from '../types';

interface ProvenanceProps {
  records: ProvenanceRecord[];
}

export const Provenance: React.FC<ProvenanceProps> = ({ records }) => {
  const [filterRiskOnly, setFilterRiskOnly] = useState(false);
  const [searchTerm, setSearchTerm] = useState('');

  const filteredRecords = records.filter(rec => {
      const matchesSearch = rec.id.includes(searchTerm) || rec.details.toLowerCase().includes(searchTerm.toLowerCase()) || rec.userId.toLowerCase().includes(searchTerm.toLowerCase());
      
      if (!matchesSearch) return false;

      if (filterRiskOnly) {
          // Show Deletions (Real), or critical errors. Ignore 'DISCARD' as it's sandbox.
          return rec.actionType === ProvenanceType.DELETION || rec.details.includes('FAIL') || rec.details.includes('Error');
      }

      return true;
  });

  const exportAuditLog = () => {
    if (records.length === 0) return;

    // Convert records to CSV
    const headers = ['Timestamp', 'RunID', 'User', 'Role', 'Type', 'Details', 'Signature', 'SHA256_Hash'];
    const rows = records.map(rec => [
        rec.timestamp,
        rec.id,
        rec.userId,
        rec.userRole || 'N/A',
        rec.actionType,
        `"${rec.details.replace(/"/g, '""')}"`, // Escape quotes
        `"${rec.signature || ''}"`,
        rec.hash || ''
    ]);

    const csvContent = [
        headers.join(','),
        ...rows.map(row => row.join(','))
    ].join('\n');

    const blob = new Blob([csvContent], { type: 'text/csv' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `audit_trail_${new Date().toISOString().split('T')[0]}.csv`;
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
    URL.revokeObjectURL(url);
  };

  return (
    <div className="p-6 h-full flex flex-col">
      <div className="flex justify-between items-end mb-6">
        <div>
          <h2 className="text-2xl font-bold text-slate-800">Provenance Registry</h2>
          <p className="text-slate-500">Complete, tamper-evident audit trail of all ingestion, transformation, and analysis events.</p>
        </div>
        <div className="flex space-x-3 items-center">
             
             {/* Risk Filter Toggle */}
             <button
                onClick={() => setFilterRiskOnly(!filterRiskOnly)}
                className={`flex items-center px-3 py-2 rounded-lg text-sm font-medium transition-colors border ${
                    filterRiskOnly 
                    ? 'bg-red-50 text-red-700 border-red-200 shadow-inner' 
                    : 'bg-white text-slate-600 border-slate-300 hover:bg-slate-50'
                }`}
             >
                {filterRiskOnly ? <AlertOctagon className="w-4 h-4 mr-2" /> : <Filter className="w-4 h-4 mr-2" />}
                {filterRiskOnly ? 'Risk Events Only' : 'Filter Risks'}
                {filterRiskOnly && <X className="w-3 h-3 ml-2 text-red-400" />}
             </button>

             <div className="h-6 w-px bg-slate-300 mx-1"></div>

             <div className="relative">
                <Search className="absolute left-3 top-1/2 transform -translate-y-1/2 text-slate-400 w-4 h-4" />
                <input 
                    type="text" 
                    placeholder="Search User, ID, Details..." 
                    value={searchTerm}
                    onChange={(e) => setSearchTerm(e.target.value)}
                    className="pl-10 pr-4 py-2 border border-slate-300 rounded-lg text-sm focus:ring-2 focus:ring-medical-500 outline-none w-64"
                />
             </div>
             <button 
                onClick={exportAuditLog}
                disabled={records.length === 0}
                className="flex items-center px-4 py-2 bg-white border border-slate-300 text-slate-700 rounded-lg hover:bg-slate-50 font-medium transition-colors shadow-sm disabled:opacity-50"
             >
                <Download className="w-4 h-4 mr-2" />
                Export Log
             </button>
        </div>
      </div>

      <div className="bg-white border border-slate-200 rounded-xl shadow-sm overflow-hidden flex-1 flex flex-col">
        <div className="overflow-x-auto">
          <table className="w-full text-left text-sm whitespace-nowrap">
            <thead className="bg-slate-50 text-slate-500 font-semibold border-b border-slate-200">
              <tr>
                <th className="px-6 py-4">Timestamp</th>
                <th className="px-6 py-4">User / Role</th>
                <th className="px-6 py-4">Action</th>
                <th className="px-6 py-4">Details</th>
                <th className="px-6 py-4">Verification</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-slate-100">
              {filteredRecords.slice().reverse().map((rec) => (
                <tr key={rec.id} className={`transition-colors ${
                    rec.actionType === ProvenanceType.DELETION ? 'bg-red-50 hover:bg-red-100' : 
                    rec.actionType === ProvenanceType.SANDBOX_DISCARD ? 'bg-slate-50 text-slate-400' :
                    'hover:bg-slate-50'
                }`}>
                  <td className="px-6 py-3">
                    <div className="text-slate-600 font-mono text-xs">{new Date(rec.timestamp).toLocaleString()}</div>
                    <div className="text-slate-300 font-mono text-[10px] mt-0.5">{rec.id.split('-')[0]}</div>
                  </td>
                  <td className="px-6 py-3">
                    <div className="text-slate-800 font-bold">{rec.userId}</div>
                    <div className="text-slate-400 text-xs uppercase">{rec.userRole || 'SYSTEM'}</div>
                  </td>
                  <td className="px-6 py-3">
                    <span className={`inline-flex items-center px-2 py-1 rounded text-xs font-medium ${
                      rec.actionType === ProvenanceType.ANALYSIS ? 'bg-purple-100 text-purple-700' :
                      rec.actionType === ProvenanceType.MAPPING_SPEC ? 'bg-indigo-100 text-indigo-700' :
                      rec.actionType === ProvenanceType.TRANSFORMATION ? 'bg-green-100 text-green-700' :
                      rec.actionType === ProvenanceType.DELETION ? 'bg-red-100 text-red-700 border border-red-200' :
                      rec.actionType === ProvenanceType.SANDBOX_DISCARD ? 'bg-slate-200 text-slate-500' :
                      'bg-orange-100 text-orange-700'
                    }`}>
                      {rec.actionType === ProvenanceType.ANALYSIS && <Activity className="w-3 h-3 mr-1" />}
                      {rec.actionType === ProvenanceType.MAPPING_SPEC && <MapIcon className="w-3 h-3 mr-1" />}
                      {rec.actionType === ProvenanceType.TRANSFORMATION && <Code className="w-3 h-3 mr-1" />}
                      {rec.actionType === ProvenanceType.INGESTION && <FileText className="w-3 h-3 mr-1" />}
                      {rec.actionType === ProvenanceType.DELETION && <Trash2 className="w-3 h-3 mr-1" />}
                      {rec.actionType === ProvenanceType.SANDBOX_DISCARD && <FlaskConical className="w-3 h-3 mr-1" />}
                      {rec.actionType}
                    </span>
                  </td>
                  <td className={`px-6 py-3 max-w-xs truncate ${rec.actionType === ProvenanceType.SANDBOX_DISCARD ? 'text-slate-400' : 'text-slate-600'}`} title={rec.details}>
                    {rec.actionType === ProvenanceType.DELETION && (
                        <AlertOctagon className="w-4 h-4 text-red-500 inline mr-2" />
                    )}
                    <span className={rec.actionType === ProvenanceType.DELETION ? 'font-bold text-red-800' : ''}>
                        {rec.details}
                    </span>
                  </td>
                  <td className="px-6 py-3">
                     <div className="flex flex-col space-y-1">
                        {rec.signature ? (
                            <div className="flex items-center text-green-600 text-xs font-bold" title={rec.signature}>
                                <ShieldCheck className="w-3 h-3 mr-1" /> Signed
                            </div>
                        ) : (
                            <div className="text-slate-300 text-xs italic">Unsigned</div>
                        )}
                        {rec.hash && (
                             <div className="flex items-center text-slate-400 text-[10px] font-mono" title={`SHA-256: ${rec.hash}`}>
                                <Fingerprint className="w-3 h-3 mr-1" /> {rec.hash.substring(0, 10)}...
                            </div>
                        )}
                     </div>
                  </td>
                </tr>
              ))}
              {filteredRecords.length === 0 && (
                <tr>
                    <td colSpan={5} className="px-6 py-12 text-center text-slate-400 italic">
                        {filterRiskOnly ? 'No high-risk events detected.' : 'No history found.'}
                    </td>
                </tr>
              )}
            </tbody>
          </table>
        </div>
      </div>
    </div>
  );
};
