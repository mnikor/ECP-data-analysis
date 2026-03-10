import React, { useState } from 'react';
import { Folder, Plus, Clock, TestTube, Microscope, LogOut, ChevronRight, Trash2 } from 'lucide-react';
import { Project, StudyType, User } from '../types';
import { BrandLogo } from './BrandLogo';

interface Props {
  projects: Project[];
  currentUser: User;
  onSelectProject: (id: string) => void;
  onRequestDeleteProject: (id: string) => void;
  onCreateProject: (name: string, description: string, studyType: StudyType) => void;
  onLogout: () => void;
}

export const ProjectSelector: React.FC<Props> = ({
  projects,
  currentUser,
  onSelectProject,
  onRequestDeleteProject,
  onCreateProject,
  onLogout,
}) => {
  const [isCreating, setIsCreating] = useState(false);
  const [name, setName] = useState('');
  const [description, setDescription] = useState('');
  const [studyType, setStudyType] = useState<StudyType>(StudyType.RCT);

  const userProjects = projects.filter(p => p.ownerId === currentUser.id);

  const handleCreate = () => {
    if (!name) return;
    onCreateProject(name, description, studyType);
    setIsCreating(false);
    setName('');
    setDescription('');
  };

  return (
    <div className="min-h-screen bg-brand-shell flex flex-col items-center py-12 px-4 sm:px-6 lg:px-8">
      <div className="w-full max-w-4xl">
        <div className="flex justify-between items-center mb-8">
          <div>
            <BrandLogo variant="horizontal" subtitle />
            <p className="mt-4 text-sm text-slate-500">Choose a study workspace or start a new evidence program.</p>
          </div>
          <div className="flex items-center space-x-4">
            <span className="text-sm font-medium text-slate-600">Welcome, {currentUser.name}</span>
            <button onClick={onLogout} className="flex items-center text-sm text-slate-500 hover:text-slate-700 transition-colors">
              <LogOut className="w-4 h-4 mr-1" /> Sign Out
            </button>
          </div>
        </div>

        {isCreating ? (
          <div className="bg-white rounded-2xl shadow-xl border border-slate-200 p-8 animate-fadeIn">
            <h2 className="text-xl font-bold text-slate-800 mb-6">Create New Project</h2>
            <div className="space-y-5">
              <div>
                <label className="block text-sm font-semibold text-slate-700 mb-1">Project Name</label>
                <input autoFocus value={name} onChange={e => setName(e.target.value)} className="w-full p-3 border border-slate-300 rounded-xl focus:ring-2 focus:ring-medical-500 outline-none" placeholder="e.g., Oncology Phase III (Study 104)" />
              </div>
              <div>
                <label className="block text-sm font-semibold text-slate-700 mb-1">Description</label>
                <textarea value={description} onChange={e => setDescription(e.target.value)} className="w-full p-3 border border-slate-300 rounded-xl focus:ring-2 focus:ring-medical-500 outline-none resize-none" rows={3} placeholder="Brief description of the study or analysis goals..." />
              </div>
              <div>
                <label className="block text-sm font-semibold text-slate-700 mb-2">Study Type</label>
                <p className="text-xs text-slate-500 mb-3">
                  This sets the workflow model for the workspace and is intended to stay fixed after creation.
                </p>
                <div className="grid grid-cols-2 gap-4">
                  <button onClick={() => setStudyType(StudyType.RCT)} className={`p-4 rounded-xl border-2 text-left transition-all ${studyType === StudyType.RCT ? 'border-medical-500 bg-medical-50' : 'border-slate-200 hover:border-slate-300 bg-white'}`}>
                    <TestTube className={`w-6 h-6 mb-2 ${studyType === StudyType.RCT ? 'text-medical-600' : 'text-slate-400'}`} />
                    <h3 className={`font-bold ${studyType === StudyType.RCT ? 'text-medical-900' : 'text-slate-700'}`}>Clinical Trial</h3>
                    <p className="text-xs text-slate-500 mt-1">Strict control, CDISC SDTM mapping, and formal statistical analysis.</p>
                  </button>
                  <button onClick={() => setStudyType(StudyType.RWE)} className={`p-4 rounded-xl border-2 text-left transition-all ${studyType === StudyType.RWE ? 'border-amber-300 bg-amber-50' : 'border-slate-200 hover:border-slate-300 bg-white'}`}>
                    <Microscope className={`w-6 h-6 mb-2 ${studyType === StudyType.RWE ? 'text-amber-700' : 'text-slate-400'}`} />
                    <h3 className={`font-bold ${studyType === StudyType.RWE ? 'text-amber-900' : 'text-slate-700'}`}>Real-World Evidence (RWE)</h3>
                    <p className="text-xs text-slate-500 mt-1">EHR data, cohort building, and observational analysis (retrospective & prospective).</p>
                  </button>
                </div>
              </div>
              <div className="flex justify-end space-x-3 pt-4 border-t border-slate-100">
                <button onClick={() => setIsCreating(false)} className="px-5 py-2.5 text-slate-600 font-medium hover:bg-slate-100 rounded-xl transition-colors">Cancel</button>
                <button onClick={handleCreate} disabled={!name} className="px-6 py-2.5 bg-medical-600 text-white font-bold rounded-xl hover:bg-medical-700 disabled:opacity-50 transition-all shadow-md">Create Project</button>
              </div>
            </div>
          </div>
        ) : (
          <div className="space-y-6 animate-fadeIn">
            <div className="flex justify-between items-center">
              <h2 className="text-xl font-bold text-slate-800">Your Projects</h2>
              <button onClick={() => setIsCreating(true)} className="flex items-center px-4 py-2 bg-medical-600 text-white rounded-lg font-medium hover:bg-medical-700 transition-colors shadow-sm">
                <Plus className="w-4 h-4 mr-2" /> New Project
              </button>
            </div>
            
            {userProjects.length === 0 ? (
              <div className="bg-white rounded-2xl border border-slate-200 p-12 text-center shadow-sm">
                <Folder className="w-16 h-16 text-slate-300 mx-auto mb-4" />
                <h3 className="text-lg font-bold text-slate-700 mb-2">No projects found</h3>
                <p className="text-slate-500 mb-6">Create your first project to start analyzing clinical data.</p>
                <button onClick={() => setIsCreating(true)} className="inline-flex items-center px-5 py-2.5 bg-medical-600 text-white rounded-xl font-medium hover:bg-medical-700 transition-colors shadow-md">
                  <Plus className="w-5 h-5 mr-2" /> Create Project
                </button>
              </div>
            ) : (
              <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
                {userProjects.map(project => (
                  <div key={project.id} onClick={() => onSelectProject(project.id)} className="bg-white rounded-xl border border-slate-200 p-6 hover:border-medical-300 hover:shadow-md transition-all cursor-pointer group">
                    <div className="flex justify-between items-start mb-4">
                      <div className={`p-2 rounded-lg ${project.studyType === StudyType.RCT ? 'bg-medical-50 text-medical-600' : 'bg-amber-50 text-amber-700'}`}>
                        {project.studyType === StudyType.RCT ? <TestTube className="w-6 h-6" /> : <Microscope className="w-6 h-6" />}
                      </div>
                      <div className="flex items-center gap-2">
                        <button
                          type="button"
                          onClick={(e) => {
                            e.stopPropagation();
                            onRequestDeleteProject(project.id);
                          }}
                          className="rounded-lg border border-red-100 bg-red-50 p-2 text-red-500 transition-colors hover:border-red-200 hover:bg-red-100 hover:text-red-600"
                          title={`Delete ${project.name}`}
                          aria-label={`Delete ${project.name}`}
                        >
                          <Trash2 className="w-4 h-4" />
                        </button>
                        <ChevronRight className="w-5 h-5 text-slate-300 group-hover:text-medical-500 transition-colors" />
                      </div>
                    </div>
                    <h3 className="text-lg font-bold text-slate-800 mb-1 group-hover:text-medical-700 transition-colors">{project.name}</h3>
                    <p className="text-sm text-slate-500 mb-4 line-clamp-2">{project.description || 'No description provided.'}</p>
                    <div className="flex items-center justify-between text-xs text-slate-400 pt-4 border-t border-slate-100">
                      <span className="flex items-center"><Clock className="w-3 h-3 mr-1" /> Updated {new Date(project.updatedAt).toLocaleDateString()}</span>
                      <div className="flex items-center gap-2">
                        <span className="font-medium px-2 py-1 bg-slate-100 rounded-md">{project.files.length} Files</span>
                        <span className="font-medium px-2 py-1 bg-slate-100 rounded-md">{project.statSessions.length} Analyses</span>
                      </div>
                    </div>
                  </div>
                ))}
              </div>
            )}
          </div>
        )}
      </div>
    </div>
  );
}
