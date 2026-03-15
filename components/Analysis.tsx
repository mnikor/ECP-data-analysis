import React, { useState, useRef, useEffect, useMemo } from 'react';
import { Send, Bot, User, FileText, CheckSquare, Search, BookOpen, Lightbulb, TrendingUp, AlertTriangle, Sparkles, Download, GitMerge, Users, Activity } from 'lucide-react';
import { ClinicalFile, DataType, ChatMessage, AnalysisMode, ProvenanceRecord, ProvenanceType } from '../types';
import { generateAnalysis } from '../services/geminiService';
import { Chart } from './Chart';
import { buildChatQuickActions, ChatQuickActionIcon } from '../utils/chatQuickActions';

interface AnalysisProps {
  files: ClinicalFile[];
  onRecordProvenance: (record: ProvenanceRecord) => void;
  messages: ChatMessage[];
  setMessages: React.Dispatch<React.SetStateAction<ChatMessage[]>>;
}

const QUICK_ACTION_ICONS: Record<ChatQuickActionIcon, React.ComponentType<{ className?: string }>> = {
  OVERVIEW: Lightbulb,
  PROTOCOL: FileText,
  SAFETY: AlertTriangle,
  LABS: TrendingUp,
  EXPOSURE: TrendingUp,
  BIOMARKER: Sparkles,
  LINKED: GitMerge,
  DEMOGRAPHICS: Users,
  TIME_TO_EVENT: Activity,
};

const INLINE_TOKEN_REGEX = /(\*\*[^*]+\*\*|`[^`]+`)/g;

const renderInlineTokens = (text: string): React.ReactNode[] =>
  text.split(INLINE_TOKEN_REGEX).filter(Boolean).map((token, index) => {
    if (token.startsWith('**') && token.endsWith('**')) {
      return <strong key={index} className="font-semibold text-slate-900">{token.slice(2, -2)}</strong>;
    }
    if (token.startsWith('`') && token.endsWith('`')) {
      return <code key={index} className="rounded bg-slate-100 px-1.5 py-0.5 text-[0.92em] text-slate-700">{token.slice(1, -1)}</code>;
    }
    return token;
  });

const escapeHtml = (text: string): string =>
  text
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');

const formatInlineHtml = (text: string): string =>
  escapeHtml(text).replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>').replace(/`([^`]+)`/g, '<code>$1</code>');

const renderFormattedMessage = (content: string): React.ReactNode[] => {
  const lines = content.split('\n');
  const blocks: React.ReactNode[] = [];
  let i = 0;

  while (i < lines.length) {
    const line = lines[i].trim();

    if (!line) {
      i += 1;
      continue;
    }

    const headingMatch = line.match(/^(#{1,4})\s+(.*)$/);
    if (headingMatch) {
      const level = Math.min(headingMatch[1].length, 4);
      const headingText = headingMatch[2].trim();
      const className =
        level === 1 ? 'text-xl font-bold text-slate-900 mt-1' :
        level === 2 ? 'text-lg font-bold text-slate-900 mt-1' :
        'text-base font-semibold text-slate-900 mt-1';
      blocks.push(
        <div key={`heading-${i}`} className={className}>
          {renderInlineTokens(headingText)}
        </div>
      );
      i += 1;
      continue;
    }

    if (/^[-*]\s+/.test(line)) {
      const items: string[] = [];
      while (i < lines.length) {
        const current = lines[i].trim();
        if (!current) break;
        const bulletMatch = current.match(/^[-*]\s+(.*)$/);
        if (bulletMatch) {
          items.push(bulletMatch[1]);
          i += 1;
          continue;
        }
        if (items.length > 0) {
          items[items.length - 1] += ` ${current}`;
          i += 1;
          continue;
        }
        break;
      }

      blocks.push(
        <ul key={`list-${i}`} className="my-3 list-disc space-y-2 pl-5 text-sm text-slate-800">
          {items.map((item, index) => (
            <li key={index} className="leading-relaxed">{renderInlineTokens(item)}</li>
          ))}
        </ul>
      );
      continue;
    }

    const paragraphLines: string[] = [line];
    i += 1;
    while (i < lines.length) {
      const current = lines[i].trim();
      if (!current) {
        i += 1;
        break;
      }
      if (/^(#{1,4})\s+/.test(current) || /^[-*]\s+/.test(current)) break;
      paragraphLines.push(current);
      i += 1;
    }

    blocks.push(
      <p key={`paragraph-${i}`} className="my-3 text-sm leading-relaxed text-slate-800">
        {renderInlineTokens(paragraphLines.join(' '))}
      </p>
    );
  }

  return blocks;
};

const formatMessageAsHtml = (content: string): string => {
  const lines = content.split('\n');
  const htmlBlocks: string[] = [];
  let i = 0;

  while (i < lines.length) {
    const line = lines[i].trim();

    if (!line) {
      i += 1;
      continue;
    }

    const headingMatch = line.match(/^(#{1,4})\s+(.*)$/);
    if (headingMatch) {
      const level = Math.min(headingMatch[1].length + 1, 5);
      htmlBlocks.push(`<h${level}>${formatInlineHtml(headingMatch[2].trim())}</h${level}>`);
      i += 1;
      continue;
    }

    if (/^[-*]\s+/.test(line)) {
      const items: string[] = [];
      while (i < lines.length) {
        const current = lines[i].trim();
        if (!current) break;
        const bulletMatch = current.match(/^[-*]\s+(.*)$/);
        if (bulletMatch) {
          items.push(bulletMatch[1]);
          i += 1;
          continue;
        }
        if (items.length > 0) {
          items[items.length - 1] += ` ${current}`;
          i += 1;
          continue;
        }
        break;
      }
      htmlBlocks.push(`<ul>${items.map((item) => `<li>${formatInlineHtml(item)}</li>`).join('')}</ul>`);
      continue;
    }

    const paragraphLines: string[] = [line];
    i += 1;
    while (i < lines.length) {
      const current = lines[i].trim();
      if (!current) {
        i += 1;
        break;
      }
      if (/^(#{1,4})\s+/.test(current) || /^[-*]\s+/.test(current)) break;
      paragraphLines.push(current);
      i += 1;
    }

    htmlBlocks.push(`<p>${formatInlineHtml(paragraphLines.join(' '))}</p>`);
  }

  return htmlBlocks.join('');
};

export const Analysis: React.FC<AnalysisProps> = ({ files, onRecordProvenance, messages, setMessages }) => {
  const [input, setInput] = useState('');
  const [isLoading, setIsLoading] = useState(false);
  const [mode, setMode] = useState<AnalysisMode>(AnalysisMode.RAG);
  const [selectedFileIds, setSelectedFileIds] = useState<Set<string>>(new Set());
  
  const messagesEndRef = useRef<HTMLDivElement>(null);
  const docs = useMemo(
    () => files.filter(f => f.type === DataType.DOCUMENT || f.type === DataType.RAW || f.type === DataType.STANDARDIZED),
    [files]
  );

  const scrollToBottom = () => {
    messagesEndRef.current?.scrollIntoView({ behavior: "smooth" });
  };

  const selectedContextFiles = useMemo(
    () => files.filter((f) => selectedFileIds.has(f.id)),
    [files, selectedFileIds]
  );
  const quickActions = useMemo(
    () => buildChatQuickActions(selectedContextFiles, docs),
    [selectedContextFiles, docs]
  );
  const inputPlaceholder = useMemo(() => {
    if (selectedContextFiles.length === 0) {
      return 'Select one or more sources, then ask what they can support or which workflow to use next...';
    }
    if (selectedContextFiles.some((file) => file.type === DataType.DOCUMENT)) {
      return 'Ask what the selected protocol or SAP requires, whether the data supports it, or what to review next...';
    }
    return 'Ask about the selected sources, realistic analyses, joins, safety findings, or what deserves follow-up...';
  }, [selectedContextFiles]);

  useEffect(() => {
    scrollToBottom();
  }, [messages, isLoading]);

  const toggleFileSelection = (id: string) => {
    const newSet = new Set(selectedFileIds);
    if (newSet.has(id)) {
      newSet.delete(id);
    } else {
      newSet.add(id);
    }
    setSelectedFileIds(newSet);
  };

  const handleSend = async (textOverride?: string) => {
    const textToSend = textOverride || input;
    if (!textToSend.trim() || isLoading) return;

    const userMsg: ChatMessage = {
      id: crypto.randomUUID(),
      role: 'user',
      content: textToSend,
      timestamp: new Date().toISOString()
    };

    setMessages(prev => [...prev, userMsg]);
    setInput('');
    setIsLoading(true);

    const contextFiles = selectedContextFiles;
    
    // Record provenance start
    const provId = crypto.randomUUID();
    onRecordProvenance({
      id: provId,
      timestamp: new Date().toISOString(),
      userId: 'current_user',
      actionType: ProvenanceType.ANALYSIS,
      details: `Query: ${textToSend.substring(0, 50)}... | Mode: ${mode}`,
      inputs: Array.from(selectedFileIds)
    });

    const response = await generateAnalysis(textToSend, contextFiles, mode, messages);

    const aiMsg: ChatMessage = {
      id: crypto.randomUUID(),
      role: 'model',
      content: response.answer,
      timestamp: new Date().toISOString(),
      chartConfig: response.chartConfig,
      tableConfig: response.tableConfig,
      keyInsights: response.keyInsights
    };

    setMessages(prev => [...prev, aiMsg]);
    setIsLoading(false);
  };

  const handleKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault();
      handleSend();
    }
  };

  const exportMessage = (msg: ChatMessage, index: number) => {
      // Find the user query that triggered this, if possible (usually the previous message)
      const prevMsg = index > 0 ? messages[index - 1] : null;
      const userQuery = prevMsg?.role === 'user' ? prevMsg.content : "N/A";

      // Create a nice HTML wrapper for the AI response
      const chartScript = msg.chartConfig ? `
          <div id="chartDiv" style="width:100%; height:500px; margin-top:20px; border:1px solid #eee; border-radius:8px;"></div>
          <script>
            var data = ${JSON.stringify(msg.chartConfig.data)};
            var layout = ${JSON.stringify(msg.chartConfig.layout)};
            // Ensure layout fits container
            layout.autosize = true;
            Plotly.newPlot('chartDiv', data, layout);
          </script>
      ` : '';

      const resultTable = msg.tableConfig ? `
          <div style="margin-top:30px;">
            <span class="label" style="display:block; margin-bottom:10px;">Result Table</span>
            <div style="overflow:auto; border:1px solid #e2e8f0; border-radius:8px;">
              <table style="width:100%; border-collapse:collapse; font-size:0.95em;">
                <thead>
                  <tr>
                    ${msg.tableConfig.columns.map((column) => `<th style="text-align:left; padding:12px; background:#f8fafc; border-bottom:1px solid #e2e8f0;">${escapeHtml(column)}</th>`).join('')}
                  </tr>
                </thead>
                <tbody>
                  ${msg.tableConfig.rows.map((row) => `
                    <tr>
                      ${msg.tableConfig!.columns.map((column) => `<td style="padding:12px; border-bottom:1px solid #f1f5f9;">${escapeHtml(String(row[column] ?? ''))}</td>`).join('')}
                    </tr>
                  `).join('')}
                </tbody>
              </table>
            </div>
          </div>
      ` : '';

      const content = `
        <!DOCTYPE html>
        <html>
        <head>
          <title>AI Analysis Report</title>
          <script src="https://cdn.plot.ly/plotly-2.27.0.min.js"></script>
          <style>
            body { font-family: -apple-system, system-ui, sans-serif; max-width: 900px; margin: 40px auto; line-height: 1.6; color: #1e293b; }
            h1 { color: #0f172a; border-bottom: 2px solid #e2e8f0; padding-bottom: 10px; margin-bottom: 30px; }
            .meta { background: #f8fafc; padding: 15px; border-radius: 8px; border: 1px solid #e2e8f0; margin-bottom: 30px; font-size: 0.9em; }
            .label { font-weight: bold; color: #64748b; text-transform: uppercase; font-size: 0.75em; letter-spacing: 0.05em; }
            .query-box { background: #f0f9ff; padding: 15px; border-left: 4px solid #0ea5e9; margin-bottom: 30px; font-style: italic; }
            .content { font-size: 1.05em; }
            .content h2, .content h3, .content h4, .content h5 { color: #0f172a; margin: 1.1em 0 0.45em; line-height: 1.25; }
            .content h2 { font-size: 1.35em; }
            .content h3 { font-size: 1.15em; }
            .content h4, .content h5 { font-size: 1.05em; }
            .content p { margin: 0 0 1em; }
            .content ul { margin: 0 0 1em 1.25em; padding: 0; }
            .content li { margin-bottom: 0.4em; }
            .content code { background: #f1f5f9; padding: 0.1em 0.35em; border-radius: 4px; font-family: ui-monospace, SFMono-Regular, monospace; font-size: 0.92em; }
            .insight-box { margin-top: 30px; background: #eef2ff; border: 1px solid #c7d2fe; border-radius: 8px; padding: 20px; }
            .insight-box h3 { margin-top: 0; color: #4338ca; font-size: 1.1em; display: flex; align-items: center; }
            ul { margin: 0; padding-left: 20px; }
            li { margin-bottom: 8px; }
            strong { color: #334155; }
          </style>
        </head>
        <body>
          <h1>AI Analysis Report</h1>
          
          <div class="meta">
            <div><span class="label">Date:</span> ${new Date(msg.timestamp).toLocaleString()}</div>
            <div><span class="label">Report ID:</span> ${msg.id.split('-')[0]}</div>
          </div>

          <div><span class="label">User Query</span></div>
          <div class="query-box">"${userQuery}"</div>
          
          <div><span class="label">Analysis Result</span></div>
          <div class="content">${formatMessageAsHtml(msg.content)}</div>

          ${msg.keyInsights ? `
            <div class="insight-box">
                <h3>💡 Key Clinical Insights</h3>
                <ul>${msg.keyInsights.map(i => `<li>${i}</li>`).join('')}</ul>
            </div>
          ` : ''}

          ${msg.chartConfig ? `<div><span class="label" style="display:block; margin-top:30px;">Visual Data</span></div>` : ''}
          ${chartScript}
          ${resultTable}
          
          <div style="margin-top: 50px; border-top: 1px solid #e2e8f0; padding-top: 20px; color: #94a3b8; font-size: 0.8em; text-align: center;">
             Generated by Evidence CoPilot
          </div>
        </body>
        </html>
      `;

      const blob = new Blob([content], { type: 'text/html' });
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url;
      a.download = `ai_report_${msg.id.substring(0,6)}.html`;
      document.body.appendChild(a);
      a.click();
      document.body.removeChild(a);
      URL.revokeObjectURL(url);
  };

  return (
    <div className="flex h-full bg-white">
      {/* Sidebar: Context Manager */}
      <div className="w-80 border-r border-slate-200 flex flex-col bg-slate-50">
        <div className="p-4 border-b border-slate-200">
          <h3 className="font-semibold text-slate-800 flex items-center">
            <BookOpen className="w-4 h-4 mr-2" /> Context Manager
          </h3>
        </div>
        
        <div className="p-4 border-b border-slate-200 bg-white">
          <div className="flex space-x-2 bg-slate-100 p-1 rounded-lg mb-4">
             <button
               onClick={() => setMode(AnalysisMode.RAG)}
               className={`flex-1 flex items-center justify-center px-2 py-1.5 rounded text-xs font-medium transition-colors ${
                 mode === AnalysisMode.RAG ? 'bg-white text-medical-600 shadow-sm' : 'text-slate-500'
               }`}
             >
               <Search className="w-3 h-3 mr-1" /> RAG (Search)
             </button>
             <button
               onClick={() => setMode(AnalysisMode.STUFFING)}
               className={`flex-1 flex items-center justify-center px-2 py-1.5 rounded text-xs font-medium transition-colors ${
                 mode === AnalysisMode.STUFFING ? 'bg-white text-medical-600 shadow-sm' : 'text-slate-500'
               }`}
             >
               <FileText className="w-3 h-3 mr-1" /> Stuffing (Select)
             </button>
          </div>
          <p className="text-xs text-slate-500">
            {mode === AnalysisMode.RAG 
              ? "Automatically retrieves relevant chunks from all selected documents." 
              : "Injects full content of selected documents into the prompt window."}
          </p>
        </div>

        <div className="flex-1 overflow-y-auto p-4 space-y-2">
          <div className="text-xs font-semibold text-slate-400 uppercase tracking-wider mb-2">Available Sources</div>
          {docs.map(doc => (
            <div 
              key={doc.id} 
              onClick={() => toggleFileSelection(doc.id)}
              className={`flex items-start space-x-3 p-2 rounded cursor-pointer transition-colors ${
                selectedFileIds.has(doc.id) ? 'bg-medical-50 border border-medical-200' : 'hover:bg-slate-100 border border-transparent'
              }`}
            >
              <div className={`mt-0.5 w-4 h-4 border rounded flex items-center justify-center transition-colors ${
                selectedFileIds.has(doc.id) ? 'bg-medical-600 border-medical-600' : 'border-slate-300 bg-white'
              }`}>
                {selectedFileIds.has(doc.id) && <CheckSquare className="w-3 h-3 text-white" />}
              </div>
              <div className="flex-1 overflow-hidden">
                <div className="text-sm font-medium text-slate-700 truncate">{doc.name}</div>
                <div className="text-xs text-slate-500">{doc.type} • {doc.size}</div>
              </div>
            </div>
          ))}
          {docs.length === 0 && <div className="text-sm text-slate-400 italic">No documents available. Upload in Ingestion tab.</div>}
        </div>
      </div>

      {/* Main Chat Area */}
      <div className="flex-1 flex flex-col">
        <div className="flex-1 overflow-y-auto p-6 space-y-6">
          {messages.map((msg, index) => (
            <div key={msg.id} className={`flex ${msg.role === 'user' ? 'justify-end' : 'justify-start'}`}>
              <div className={`max-w-3xl flex items-start space-x-3 ${msg.role === 'user' ? 'flex-row-reverse space-x-reverse' : ''}`}>
                <div className={`w-8 h-8 rounded-full flex items-center justify-center flex-shrink-0 ${
                  msg.role === 'user' ? 'bg-slate-700 text-white' : 'bg-medical-600 text-white'
                }`}>
                  {msg.role === 'user' ? <User className="w-5 h-5" /> : <Bot className="w-5 h-5" />}
                </div>
                <div className={`p-4 rounded-2xl w-full ${
                  msg.role === 'user' 
                    ? 'bg-slate-100 text-slate-800 rounded-tr-none' 
                    : 'bg-white border border-slate-200 text-slate-800 rounded-tl-none shadow-sm'
                }`}>
                  <div className="text-sm leading-relaxed font-sans">{renderFormattedMessage(msg.content)}</div>
                  
                  {/* Chart Rendering */}
                  {msg.chartConfig && (
                    <div className="mt-4 mb-4">
                      <Chart data={msg.chartConfig.data} layout={msg.chartConfig.layout} />
                    </div>
                  )}

                  {msg.tableConfig && (
                    <div className="mt-4 overflow-hidden rounded-xl border border-slate-200">
                      {msg.tableConfig.title && (
                        <div className="border-b border-slate-200 bg-slate-50 px-4 py-2 text-sm font-semibold text-slate-700">
                          {msg.tableConfig.title}
                        </div>
                      )}
                      <div className="overflow-x-auto">
                        <table className="min-w-full divide-y divide-slate-200 text-sm">
                          <thead className="bg-slate-50">
                            <tr>
                              {msg.tableConfig.columns.map((column) => (
                                <th key={column} className="px-4 py-3 text-left font-semibold uppercase tracking-wide text-slate-500">
                                  {column}
                                </th>
                              ))}
                            </tr>
                          </thead>
                          <tbody className="divide-y divide-slate-100 bg-white">
                            {msg.tableConfig.rows.map((row, rowIndex) => (
                              <tr key={rowIndex}>
                                {msg.tableConfig!.columns.map((column) => (
                                  <td key={column} className="px-4 py-3 text-slate-700">
                                    {String(row[column] ?? '')}
                                  </td>
                                ))}
                              </tr>
                            ))}
                          </tbody>
                        </table>
                      </div>
                    </div>
                  )}

                  {/* Key Insights - Discovery Mode UI */}
                  {msg.keyInsights && msg.keyInsights.length > 0 && (
                    <div className="mt-4 bg-indigo-50 border border-indigo-200 rounded-xl overflow-hidden shadow-sm">
                      <div className="bg-indigo-100 px-4 py-2 border-b border-indigo-200 flex items-center">
                        <Sparkles className="w-4 h-4 mr-2 text-indigo-600" />
                        <h4 className="text-sm font-bold text-indigo-800">
                          Hidden Insights & Discovery
                        </h4>
                      </div>
                      <div className="p-4">
                        <ul className="space-y-3">
                          {msg.keyInsights.map((insight, idx) => (
                            <li key={idx} className="flex items-start">
                                <div className="mt-1.5 w-1.5 h-1.5 rounded-full bg-indigo-500 mr-3 flex-shrink-0" />
                                <span className="text-sm text-indigo-900 leading-relaxed">{insight}</span>
                            </li>
                          ))}
                        </ul>
                      </div>
                    </div>
                  )}

                  <div className="mt-2 flex items-center justify-end space-x-2">
                    <span className="text-xs text-slate-400">
                      {new Date(msg.timestamp).toLocaleTimeString([], {hour: '2-digit', minute:'2-digit'})}
                    </span>
                    {msg.role === 'model' && (
                        <button 
                            onClick={() => exportMessage(msg, index)}
                            className="text-xs flex items-center text-medical-600 hover:text-medical-800 font-medium transition-colors"
                            title="Download Report"
                        >
                            <Download className="w-3 h-3 mr-1" />
                            Report
                        </button>
                    )}
                  </div>
                </div>
              </div>
            </div>
          ))}
          {isLoading && (
            <div className="flex justify-start">
               <div className="flex items-center space-x-3">
                  <div className="w-8 h-8 rounded-full bg-medical-600 text-white flex items-center justify-center">
                    <Bot className="w-5 h-5" />
                  </div>
                  <div className="bg-white border border-slate-200 p-4 rounded-2xl rounded-tl-none shadow-sm">
                    <div className="flex space-x-1">
                      <div className="w-2 h-2 bg-slate-400 rounded-full animate-bounce" style={{animationDelay: '0ms'}}></div>
                      <div className="w-2 h-2 bg-slate-400 rounded-full animate-bounce" style={{animationDelay: '150ms'}}></div>
                      <div className="w-2 h-2 bg-slate-400 rounded-full animate-bounce" style={{animationDelay: '300ms'}}></div>
                    </div>
                  </div>
               </div>
            </div>
          )}
          <div ref={messagesEndRef} />
        </div>

        {/* Input Area & Quick Actions */}
        <div className="p-4 border-t border-slate-200 bg-white">
          {/* Quick Action Chips */}
          <div className="mb-2 flex items-center justify-between gap-3">
            <div className="text-[11px] font-semibold uppercase tracking-wide text-slate-500">
              {selectedContextFiles.length > 0 ? 'Suggested For Selected Context' : 'Suggested Starting Points'}
            </div>
            <div className="text-[11px] text-slate-400">
              {selectedContextFiles.length > 0
                ? `${selectedContextFiles.length} source${selectedContextFiles.length === 1 ? '' : 's'} selected`
                : 'Select sources to make these suggestions more specific'}
            </div>
          </div>
          <div className="flex flex-wrap gap-2 mb-3">
              {quickActions.map((action, i) => {
                  const ActionIcon = QUICK_ACTION_ICONS[action.icon];
                  return (
                  <button
                    key={i}
                    onClick={() => handleSend(action.prompt)}
                    disabled={isLoading}
                    className="flex items-center px-3 py-1.5 bg-slate-50 border border-slate-200 rounded-full text-xs font-medium text-slate-600 hover:bg-medical-50 hover:border-medical-200 hover:text-medical-700 transition-all disabled:opacity-50"
                  >
                      <ActionIcon className="w-3 h-3 mr-1.5" />
                      {action.label}
                  </button>
              )})}
          </div>

          <div className="max-w-4xl mx-auto relative">
            <textarea
              value={input}
              onChange={(e) => setInput(e.target.value)}
              onKeyDown={handleKeyDown}
              placeholder={inputPlaceholder}
              className="w-full pl-4 pr-12 py-3 bg-slate-50 border border-slate-200 rounded-xl focus:outline-none focus:ring-2 focus:ring-medical-500 focus:bg-white resize-none shadow-sm text-sm transition-all"
              rows={1}
              style={{ minHeight: '50px' }}
            />
            <button
              onClick={() => handleSend()}
              disabled={!input.trim() || isLoading}
              className="absolute right-2 top-2 p-2 bg-medical-600 text-white rounded-lg hover:bg-medical-700 disabled:opacity-50 disabled:cursor-not-allowed transition-colors shadow-sm"
            >
              <Send className="w-4 h-4" />
            </button>
          </div>
          <div className="text-center mt-2">
            <span className="text-[10px] text-slate-400">
              AI generated content can be inaccurate. Verify all clinical outputs.
            </span>
          </div>
        </div>
      </div>
    </div>
  );
};
