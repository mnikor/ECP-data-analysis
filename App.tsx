import React, { useState, useEffect, useMemo } from 'react';
import { LayoutDashboard, FileInput, Map, GitMerge, MessageSquareText, History, BarChart2, LogOut, Scale, Database, ShieldCheck, HeartPulse, Filter, Folder, Bot, AlertTriangle, Trash2 } from 'lucide-react';
import { Ingestion } from './components/Ingestion';
import { Mapping } from './components/Mapping';
import { Pipeline } from './components/Pipeline';
import { Analysis } from './components/Analysis';
import { Statistics } from './components/Statistics';
import { Provenance } from './components/Provenance';
import { Dashboard } from './components/Dashboard';
import { Login } from './components/Login';
import { BiasAudit } from './components/BiasAudit';
import { CohortBuilder } from './components/CohortBuilder';
import { ProjectSelector } from './components/ProjectSelector';
import { Autopilot } from './components/Autopilot';
import { BrandLogo } from './components/BrandLogo';
import { ClinicalFile, ProvenanceRecord, MappingSpec, ChatMessage, AnalysisSession, User, ProvenanceType, StudyType, Project } from './types';
import { MOCK_FILES, INITIAL_PROVENANCE, MOCK_MAPPING } from './constants';
import { clearProjectsInIndexedDb, loadProjectsFromIndexedDb, saveProjectsToIndexedDb } from './utils/projectStorage';
import { getAccessProfile, POC_DEFAULT_ROLE } from './utils/accessControl';

enum View {
  DASHBOARD = 'DASHBOARD',
  INGESTION = 'INGESTION',
  MAPPING = 'MAPPING',
  TRANSFORMATION = 'TRANSFORMATION',
  COHORT_BUILDER = 'COHORT_BUILDER', // New View for RWE
  AUTOPILOT = 'AUTOPILOT',
  STATISTICS = 'STATISTICS',
  ANALYSIS = 'ANALYSIS',
  BIAS_AUDIT = 'BIAS_AUDIT',
  PROVENANCE = 'PROVENANCE'
}

const PROJECTS_STORAGE_KEY = 'clinical_ai_projects';

const safelyLoadProjectsFromLocalStorage = (): Project[] | null => {
  const saved = localStorage.getItem(PROJECTS_STORAGE_KEY);
  if (!saved) return null;
  try {
    const parsed = JSON.parse(saved);
    if (Array.isArray(parsed)) return parsed as Project[];
    return null;
  } catch (e) {
    console.warn('Failed to parse saved projects from localStorage. Resetting storage.', e);
    localStorage.removeItem(PROJECTS_STORAGE_KEY);
    return null;
  }
};

const hasLegacyTrimmedContent = (projects: Project[]): boolean =>
  projects.some((project) =>
    project.files.some((file) => typeof file.content === 'string' && file.content.length === 50000)
  );

const createDefaultProjects = (): Project[] => [
  {
    id: 'default-mock-project',
    name: 'Demo Clinical Trial',
    description: 'Pre-loaded with mock data for demonstration.',
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
    ownerId: 'admin',
    studyType: StudyType.RCT,
    files: MOCK_FILES,
    provenance: INITIAL_PROVENANCE,
    mappingSpecs: [MOCK_MAPPING],
    chatMessages: [{
      id: 'welcome',
      role: 'model',
      content: 'Hello. I am ready to analyze your clinical data. Please select a mode and documents to begin.',
      timestamp: new Date().toISOString()
    }],
    statSessions: []
  }
];

// Simple SHA-256 simulation for browser
const generateHash = async (message: string) => {
    const msgBuffer = new TextEncoder().encode(message);
    const hashBuffer = await crypto.subtle.digest('SHA-256', msgBuffer);
    const hashArray = Array.from(new Uint8Array(hashBuffer));
    const hashHex = hashArray.map(b => b.toString(16).padStart(2, '0')).join('');
    return hashHex;
};

const getStudyTypeLabel = (type: StudyType) => type === StudyType.RCT ? 'Clinical Trial' : 'Real-World Evidence';

interface NavItemProps {
  view: View;
  icon: any;
  label: string;
  helper?: string;
  currentView: View;
  onNavigate: (view: View) => void;
}

const NavItem: React.FC<NavItemProps> = ({ view, icon: Icon, label, helper, currentView, onNavigate }) => {
  return (
    <button
      onClick={() => onNavigate(view)}
      className={`w-full flex items-start space-x-3 px-4 py-3 rounded-2xl transition-all duration-200 mb-1.5 border ${
        currentView === view 
          ? 'bg-white border-medical-200 text-medical-900 shadow-sm shadow-slate-200/70 ring-1 ring-medical-100' 
          : 'border-transparent text-slate-700 hover:text-slate-900 hover:bg-white'
      }`}
    >
      <span className={`mt-0.5 flex h-9 w-9 items-center justify-center rounded-xl ${
        currentView === view ? 'bg-medical-100 text-medical-800' : 'bg-slate-100 text-slate-600'
      }`}>
        <Icon className="w-4 h-4" />
      </span>
      <span className="min-w-0 text-left">
        <span className="block font-semibold text-[15px] leading-5">{label}</span>
        {helper && <span className="mt-0.5 block text-[12px] leading-4 text-slate-500">{helper}</span>}
      </span>
    </button>
  );
};

const App: React.FC = () => {
  const [currentUser, setCurrentUser] = useState<User | null>(null);
  const [currentView, setCurrentView] = useState<View>(View.DASHBOARD);
  const [storageReady, setStorageReady] = useState(false);
  
  const [projects, setProjects] = useState<Project[]>(createDefaultProjects);
  
  const [activeProjectId, setActiveProjectId] = useState<string | null>(null);
  const [activeStatSessionId, setActiveStatSessionId] = useState<string>('NEW');
  const [projectPendingDeletion, setProjectPendingDeletion] = useState<Project | null>(null);
  const [deleteProjectConfirmation, setDeleteProjectConfirmation] = useState('');
  const accessProfile = useMemo(() => getAccessProfile(currentUser), [currentUser]);

  useEffect(() => {
    let cancelled = false;

    const loadProjects = async () => {
      try {
        const indexedDbProjects = await loadProjectsFromIndexedDb();
        if (!cancelled && indexedDbProjects && indexedDbProjects.length > 0) {
          if (hasLegacyTrimmedContent(indexedDbProjects)) {
            console.warn('Detected legacy trimmed IndexedDB payload. Clearing corrupted saved data.');
            await clearProjectsInIndexedDb();
          } else {
          setProjects(indexedDbProjects);
          setStorageReady(true);
          return;
          }
        }
      } catch (e) {
        console.warn('IndexedDB load failed. Falling back to localStorage migration.', e);
      }

      const localProjects = safelyLoadProjectsFromLocalStorage();
      if (!cancelled && localProjects && localProjects.length > 0) {
        if (hasLegacyTrimmedContent(localProjects)) {
          console.warn('Detected legacy trimmed localStorage payload. Clearing it instead of migrating corrupted file contents.');
          localStorage.removeItem(PROJECTS_STORAGE_KEY);
          setStorageReady(true);
          return;
        }
        setProjects(localProjects);
        try {
          await saveProjectsToIndexedDb(localProjects);
        } catch (e) {
          console.warn('Failed to migrate localStorage projects to IndexedDB.', e);
        }
      }

      if (!cancelled) setStorageReady(true);
    };

    loadProjects();
    return () => {
      cancelled = true;
    };
  }, []);

  useEffect(() => {
    if (!storageReady) return;

    saveProjectsToIndexedDb(projects).catch((e) => {
      console.error('Failed to persist projects to IndexedDB. Data remains in memory for this session.', e);
    });
  }, [projects, storageReady]);

  const activeProject = projects.find(p => p.id === activeProjectId);

  const updateActiveProject = (updater: (prev: Project) => Project) => {
    setProjects(prev => prev.map(p => p.id === activeProjectId ? { ...updater(p), updatedAt: new Date().toISOString() } : p));
  };

  const files = activeProject?.files || [];
  const provenance = activeProject?.provenance || [];
  const mappingSpecs = activeProject?.mappingSpecs || [];
  const chatMessages = activeProject?.chatMessages || [];
  const statSessions = activeProject?.statSessions || [];
  const studyType = activeProject?.studyType || StudyType.RCT;

  const setChatMessages = (updater: any) => {
    updateActiveProject(p => ({
      ...p,
      chatMessages: typeof updater === 'function' ? updater(p.chatMessages) : updater
    }));
  };

  const setStatSessions = (updater: any) => {
    updateActiveProject(p => ({
      ...p,
      statSessions: typeof updater === 'function' ? updater(p.statSessions) : updater
    }));
  };

  const handleLogin = (name: string) => {
    setCurrentUser({
      id: name.toLowerCase().replace(' ', '_'),
      name,
      role: POC_DEFAULT_ROLE,
      accessLabel: accessProfile.label,
      authProvider: 'POC'
    });
  };

  const handleLogout = () => {
    setCurrentUser(null);
    setActiveProjectId(null);
    setCurrentView(View.DASHBOARD);
  };

  const handleCreateProject = (name: string, description: string, type: StudyType) => {
    const newProject: Project = {
      id: crypto.randomUUID(),
      name,
      description,
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
      ownerId: currentUser!.id,
      studyType: type,
      files: [],
      provenance: [],
      mappingSpecs: [],
      chatMessages: [{
        id: 'welcome',
        role: 'model',
        content: `Welcome to ${name}. I am ready to analyze your clinical data. Please upload documents to begin.`,
        timestamp: new Date().toISOString()
      }],
      statSessions: []
    };
    setProjects(prev => [...prev, newProject]);
    setActiveProjectId(newProject.id);
    setCurrentView(View.DASHBOARD);
  };

  const handleRequestDeleteProject = (projectId: string) => {
    const project = projects.find((candidate) => candidate.id === projectId);
    if (!project) return;
    setProjectPendingDeletion(project);
    setDeleteProjectConfirmation('');
  };

  const dismissDeleteProject = () => {
    setProjectPendingDeletion(null);
    setDeleteProjectConfirmation('');
  };

  const handleConfirmDeleteProject = () => {
    if (!projectPendingDeletion || deleteProjectConfirmation !== projectPendingDeletion.name) return;

    const deletingActiveProject = projectPendingDeletion.id === activeProjectId;
    setProjects((prev) => prev.filter((project) => project.id !== projectPendingDeletion.id));

    if (deletingActiveProject) {
      setActiveProjectId(null);
      setActiveStatSessionId('NEW');
      setCurrentView(View.DASHBOARD);
    }

    dismissDeleteProject();
  };

  const handleAddFile = (file: ClinicalFile) => {
    updateActiveProject(p => ({ ...p, files: [...p.files, file] }));
    handleRecordProvenance({
        id: crypto.randomUUID(),
        timestamp: new Date().toISOString(),
        userId: currentUser?.name || 'Unknown',
        userRole: currentUser?.role,
        actionType: ProvenanceType.INGESTION,
        details: `Ingested file: ${file.name} (${file.size})`,
        inputs: [],
        outputs: [file.id]
    });
  };

  const handleRemoveFile = (id: string) => {
    updateActiveProject(p => ({ ...p, files: p.files.filter(f => f.id !== id) }));
  };

  const handleRecordProvenance = async (record: ProvenanceRecord) => {
    const dataToHash = `${record.id}|${record.timestamp}|${record.userId}|${record.details}|${record.inputs.join(',')}`;
    const hash = await generateHash(dataToHash);
    
    const finalRecord = { ...record, hash, userRole: currentUser?.role || 'SYSTEM' };
    updateActiveProject(p => ({ ...p, provenance: [...p.provenance, finalRecord] }));
  };

  const handleSaveSpec = (spec: MappingSpec) => {
      updateActiveProject(p => ({ ...p, mappingSpecs: [...p.mappingSpecs, spec] }));
      handleRecordProvenance({
          id: crypto.randomUUID(),
          timestamp: new Date().toISOString(),
          userId: currentUser?.name || 'Unknown',
          userRole: currentUser?.role,
          actionType: ProvenanceType.MAPPING_SPEC,
          details: `Created mapping spec: ${spec.sourceDomain} -> ${spec.targetDomain}`,
          inputs: [],
          outputs: [spec.id]
      });
  };

  const renderContent = () => {
    switch (currentView) {
      case View.DASHBOARD:
        return <Dashboard files={files} provenance={provenance} onNavigate={setCurrentView} currentUser={currentUser} studyType={studyType} />;
      case View.INGESTION:
        return <Ingestion files={files} onAddFile={handleAddFile} onRemoveFile={handleRemoveFile} />;
      case View.MAPPING:
        return <Mapping files={files} onSaveSpec={handleSaveSpec} />;
      case View.TRANSFORMATION:
        return <Pipeline 
          files={files} 
          mappingSpecs={mappingSpecs} 
          onAddFile={handleAddFile} 
          onRecordProvenance={handleRecordProvenance}
          currentUser={currentUser} 
        />;
      case View.COHORT_BUILDER:
        return <CohortBuilder 
          files={files} 
          onAddFile={handleAddFile}
          onRecordProvenance={handleRecordProvenance}
          currentUser={currentUser}
        />;
      case View.AUTOPILOT:
        return <Autopilot
          files={files}
          onAddFile={handleAddFile}
          onSaveSpec={handleSaveSpec}
          onRecordProvenance={handleRecordProvenance}
          sessions={statSessions}
          setSessions={setStatSessions}
          setActiveSessionId={setActiveStatSessionId}
          onOpenStatistics={(sessionId) => {
            setActiveStatSessionId(sessionId);
            setCurrentView(View.STATISTICS);
          }}
          currentUser={currentUser}
          studyType={studyType}
        />;
      case View.STATISTICS:
        return <Statistics 
          files={files} 
          onRecordProvenance={handleRecordProvenance}
          sessions={statSessions}
          setSessions={setStatSessions}
          activeSessionId={activeStatSessionId}
          setActiveSessionId={setActiveStatSessionId}
          currentUser={currentUser}
          studyType={studyType}
        />;
      case View.ANALYSIS:
        return <Analysis 
          files={files} 
          onRecordProvenance={handleRecordProvenance} 
          messages={chatMessages}
          setMessages={setChatMessages}
        />;
      case View.BIAS_AUDIT:
        return <BiasAudit 
          files={files} 
          onRecordProvenance={handleRecordProvenance}
          currentUser={currentUser.name}
        />;
      case View.PROVENANCE:
        return <Provenance records={provenance} />;
      default:
        return <Dashboard files={files} provenance={provenance} onNavigate={setCurrentView} currentUser={currentUser} studyType={studyType} />;
    }
  };

  const studyTypeLabel = getStudyTypeLabel(studyType);

  const deleteProjectModal = projectPendingDeletion ? (
    <div className="fixed inset-0 z-[100] flex items-center justify-center bg-slate-950/55 px-4">
      <div className="w-full max-w-lg rounded-3xl border border-red-100 bg-white p-7 shadow-2xl shadow-slate-900/20">
        <div className="flex items-start gap-4">
          <div className="flex h-12 w-12 items-center justify-center rounded-2xl bg-red-50 text-red-600">
            <AlertTriangle className="w-6 h-6" />
          </div>
          <div className="flex-1">
            <p className="text-xs font-bold uppercase tracking-[0.22em] text-red-500">Delete Project</p>
            <h2 className="mt-1 text-2xl font-bold text-slate-900">{projectPendingDeletion.name}</h2>
            <p className="mt-2 text-sm leading-6 text-slate-600">
              This permanently removes the workspace, uploaded files, saved analyses, chat history, and provenance records stored under this project.
            </p>
          </div>
        </div>

        <div className="mt-6 grid gap-3 sm:grid-cols-2">
          <div className="rounded-2xl border border-slate-200 bg-slate-50 p-4">
            <div className="text-[11px] font-bold uppercase tracking-[0.2em] text-slate-500">Workspace Type</div>
            <div className="mt-2 text-sm font-semibold text-slate-900">{getStudyTypeLabel(projectPendingDeletion.studyType)}</div>
          </div>
          <div className="rounded-2xl border border-slate-200 bg-slate-50 p-4">
            <div className="text-[11px] font-bold uppercase tracking-[0.2em] text-slate-500">Saved Assets</div>
            <div className="mt-2 text-sm font-semibold text-slate-900">
              {projectPendingDeletion.files.length} files, {projectPendingDeletion.statSessions.length} analyses
            </div>
          </div>
        </div>

        <div className="mt-6 rounded-2xl border border-slate-200 bg-slate-50 p-4">
          <label className="block text-sm font-semibold text-slate-700">
            Type <span className="font-bold text-slate-900">{projectPendingDeletion.name}</span> to confirm deletion
          </label>
          <input
            autoFocus
            value={deleteProjectConfirmation}
            onChange={(event) => setDeleteProjectConfirmation(event.target.value)}
            className="mt-3 w-full rounded-xl border border-slate-300 bg-white px-4 py-3 text-sm text-slate-900 outline-none transition-all focus:border-red-300 focus:ring-2 focus:ring-red-200"
            placeholder={projectPendingDeletion.name}
          />
        </div>

        <div className="mt-6 flex flex-col-reverse gap-3 sm:flex-row sm:justify-end">
          <button
            type="button"
            onClick={dismissDeleteProject}
            className="rounded-xl border border-slate-200 bg-white px-5 py-3 text-sm font-semibold text-slate-700 transition-colors hover:bg-slate-50"
          >
            Cancel
          </button>
          <button
            type="button"
            onClick={handleConfirmDeleteProject}
            disabled={deleteProjectConfirmation !== projectPendingDeletion.name}
            className="inline-flex items-center justify-center gap-2 rounded-xl bg-red-600 px-5 py-3 text-sm font-semibold text-white transition-colors hover:bg-red-700 disabled:cursor-not-allowed disabled:bg-red-200"
          >
            <Trash2 className="w-4 h-4" />
            Delete Project Permanently
          </button>
        </div>
      </div>
    </div>
  ) : null;

  // Role-Based Navigation Config
  const navGroups = useMemo(() => {
      const groups = [];

      // 1. General (Everyone)
      groups.push({
          title: 'General',
          items: [
              { view: View.DASHBOARD, icon: LayoutDashboard, label: 'Dashboard' }
          ]
      });

      // 2. Data Engineering (Adaptive based on Study Type)
      if (accessProfile.canAccessDataOps) {
          const engineeringItems = [
              { view: View.INGESTION, icon: FileInput, label: 'Ingestion & QC' },
          ];

          if (studyType === StudyType.RCT) {
              // Clinical Trial Workflow: Rigid Mapping & Pipelines
              engineeringItems.push(
                  { view: View.MAPPING, icon: Map, label: 'Mapping Specs (SDTM)' },
                  { view: View.TRANSFORMATION, icon: GitMerge, label: 'ETL Pipeline' }
              );
          } else {
              // RWE Workflow: Cohort Building & Filtering
              engineeringItems.push(
                  { view: View.COHORT_BUILDER, icon: Filter, label: 'Cohort Builder' }
              );
          }

          groups.push({
              title: studyType === StudyType.RCT ? 'Clinical Trial Operations' : 'RWE Operations',
              items: engineeringItems
          });
      }

      // 3. Clinical Intelligence (Monitors, Statisticians, Admins)
      if (accessProfile.canAccessClinicalIntelligence) {
          groups.push({
              title: 'Clinical Intelligence',
              items: [
                  { view: View.ANALYSIS, icon: MessageSquareText, label: 'AI Insights Chat', helper: 'Help me understand what to do and what happened' },
                  { view: View.AUTOPILOT, icon: Bot, label: 'AI Autopilot', helper: 'Do work for me' },
                  { view: View.STATISTICS, icon: BarChart2, label: 'Statistical Analysis', helper: 'Let me control the work' },
                  { view: View.BIAS_AUDIT, icon: Scale, label: 'Bias Audit' },
              ]
          });
      }

      // 4. Governance (Admins, Monitors, Auditors)
      if (accessProfile.canAccessGovernance) {
          groups.push({
              title: 'Governance',
              items: [
                  { view: View.PROVENANCE, icon: History, label: 'Provenance Log' }
              ]
          });
      }

      return groups;
  }, [accessProfile, studyType]);

  if (!storageReady) {
    return (
      <div className="min-h-screen bg-brand-shell flex items-center justify-center text-slate-600">
        Loading saved projects...
      </div>
    );
  }

  if (!currentUser) {
    return <Login onLogin={handleLogin} />;
  }

  if (!activeProjectId || !activeProject) {
    return (
      <>
        <ProjectSelector 
          projects={projects} 
          currentUser={currentUser} 
          onSelectProject={(id) => { setActiveProjectId(id); setCurrentView(View.DASHBOARD); }} 
          onRequestDeleteProject={handleRequestDeleteProject}
          onCreateProject={handleCreateProject} 
          onLogout={handleLogout} 
        />
        {deleteProjectModal}
      </>
    );
  }

  return (
    <div className="flex h-screen overflow-hidden bg-brand-shell text-slate-900">
      {/* Sidebar */}
      <div className="z-20 flex h-full w-80 flex-shrink-0 flex-col overflow-hidden border-r border-slate-300 bg-[#f6f7f9] shadow-[8px_0_24px_rgba(15,23,42,0.06)]">
        <div className="shrink-0 border-b border-slate-200 px-6 py-4">
          <BrandLogo variant="sidebar" />

          <div className="mt-3 flex items-center justify-between gap-3">
            <div className="min-w-0">
              <div className="text-[10px] font-bold uppercase tracking-[0.22em] text-slate-500">Current Workspace</div>
              <div className="mt-1 truncate text-sm font-semibold text-slate-900" title={activeProject.name}>
                {activeProject.name}
              </div>
            </div>
            <span
              className={`inline-flex shrink-0 items-center rounded-full border px-3 py-1 text-[11px] font-bold uppercase tracking-[0.16em] ${
                studyType === StudyType.RCT
                  ? 'border-medical-200 bg-medical-50 text-medical-800'
                  : 'border-amber-200 bg-amber-50 text-amber-800'
              }`}
            >
              {studyTypeLabel}
            </span>
          </div>
        </div>

        <nav className="min-h-0 flex-1 overflow-y-auto px-4 py-4 space-y-5">
          {navGroups.map((group, idx) => (
              <div key={idx} className="animate-fadeIn" style={{ animationDelay: `${idx * 100}ms` }}>
                  <h3 className="mb-2 flex items-center px-4 text-[10px] font-bold uppercase tracking-[0.22em] text-slate-500">
                      {group.title.includes('Data Engineering') && <Database className="w-3 h-3 mr-1" />}
                      {group.title.includes('Operations') && <Database className="w-3 h-3 mr-1" />}
                      {group.title === 'Clinical Intelligence' && <HeartPulse className="w-3 h-3 mr-1" />}
                      {group.title === 'Governance' && <ShieldCheck className="w-3 h-3 mr-1" />}
                      {group.title}
                  </h3>
                  <div className="rounded-2xl border border-slate-200/80 bg-white/70 p-2 shadow-[0_1px_0_rgba(255,255,255,0.9)]">
                      {group.items.map(item => (
                          <NavItem 
                            key={item.view} 
                            view={item.view} 
                            icon={item.icon} 
                            label={item.label} 
                            helper={item.helper}
                            currentView={currentView}
                            onNavigate={setCurrentView}
                          />
                      ))}
                  </div>
              </div>
          ))}
        </nav>

        <div className="shrink-0 border-t border-slate-200 bg-[#f6f7f9] p-4">
           <button 
             onClick={() => setActiveProjectId(null)}
             className="w-full flex items-center justify-center space-x-2 px-4 py-2.5 bg-white text-slate-700 rounded-xl hover:bg-slate-50 transition-colors text-xs font-bold uppercase tracking-wide border border-slate-200 mb-4"
           >
             <Folder className="w-4 h-4" />
             <span>Switch Project</span>
           </button>
           <button
             onClick={() => handleRequestDeleteProject(activeProject.id)}
             className="mb-4 w-full flex items-center justify-center space-x-2 px-4 py-2.5 bg-red-50 text-red-600 rounded-xl hover:bg-red-100 transition-colors text-xs font-bold uppercase tracking-wide border border-red-100"
           >
             <Trash2 className="w-4 h-4" />
             <span>Delete Project</span>
           </button>
           <div className="flex items-center space-x-3 px-2 mb-4">
              <div className="w-8 h-8 rounded-full flex items-center justify-center text-xs font-bold text-white shadow-sm bg-brand-red">
                  {currentUser.name.charAt(0)}
              </div>
              <div className="flex-1 overflow-hidden">
                <p className="text-sm font-medium text-slate-900 truncate" title={currentUser.name}>{currentUser.name}</p>
                <p className="text-[10px] text-slate-500 uppercase tracking-wider font-bold">{accessProfile.label}</p>
              </div>
           </div>
           <button 
             onClick={handleLogout}
             className="w-full flex items-center justify-center space-x-2 px-4 py-2.5 bg-slate-900 text-white rounded-xl hover:bg-slate-800 transition-colors text-xs font-bold uppercase tracking-wide border border-slate-900"
           >
             <LogOut className="w-3 h-3" />
             <span>Sign Out</span>
           </button>
        </div>
      </div>

      {/* Main Content */}
      <main className="relative min-w-0 flex-1 overflow-hidden">
        {renderContent()}
      </main>
      {deleteProjectModal}
    </div>
  );
};

export default App;
