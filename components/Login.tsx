import React, { useState } from 'react';
import { ShieldCheck, User } from 'lucide-react';
import { BrandLogo } from './BrandLogo';

interface LoginProps {
  onLogin: (name: string) => void;
}

export const Login: React.FC<LoginProps> = ({ onLogin }) => {
  const [name, setName] = useState('Dr. Smith');
  const [isLoading, setIsLoading] = useState(false);

  const handleLogin = (e: React.FormEvent) => {
    e.preventDefault();
    setIsLoading(true);
    // Simulate network delay
    setTimeout(() => {
      onLogin(name);
      setIsLoading(false);
    }, 800);
  };

  return (
    <div className="min-h-screen bg-brand-shell flex flex-col justify-center items-center p-4">
      <div className="mb-8 animate-fadeIn">
        <BrandLogo variant="stacked" subtitle className="scale-75 origin-center sm:scale-90" />
      </div>

      <div className="bg-white rounded-[28px] p-8 w-full max-w-md shadow-[0_20px_60px_rgba(15,23,42,0.08)] border border-slate-200 animate-fadeIn">
        <h2 className="text-xl font-bold text-slate-800 mb-6 flex items-center">
          <ShieldCheck className="w-5 h-5 mr-2 text-medical-600" />
          Secure Workspace
        </h2>
        <p className="text-sm text-slate-500 mb-6">
          Sign in to review evidence workflows, launch Autopilot, and run controlled statistical analyses.
        </p>

        <form onSubmit={handleLogin} className="space-y-4">
          <div>
            <label className="block text-sm font-semibold text-slate-700 mb-2">Username</label>
            <div className="relative">
              <User className="absolute left-3 top-3 w-5 h-5 text-slate-400" />
              <input 
                type="text"
                value={name}
                onChange={(e) => setName(e.target.value)}
                className="w-full pl-10 pr-4 py-3 border border-slate-300 rounded-xl bg-slate-50 focus:ring-2 focus:ring-medical-500 focus:bg-white outline-none transition-all"
                required
                placeholder="Enter your name"
              />
            </div>
          </div>

          <div className="rounded-2xl border border-medical-100 bg-medical-50/60 p-4">
            <p className="text-sm font-semibold text-medical-900">POC access model</p>
            <p className="mt-1 text-xs leading-5 text-slate-600">
              All modules are available during pilot testing. Corporate sign-in and authorization will be integrated later without changing the core workflows.
            </p>
          </div>

          <div className="pt-4">
            <button 
              type="submit"
              disabled={isLoading}
              className="w-full bg-medical-600 text-white py-3 rounded-xl font-bold hover:bg-medical-700 transition-all shadow-lg shadow-medical-600/20 flex justify-center items-center"
            >
              {isLoading ? (
                <div className="w-6 h-6 border-2 border-white border-t-transparent rounded-full animate-spin"></div>
              ) : (
                'Enter Application'
              )}
            </button>
          </div>
        </form>

        <div className="mt-6 pt-6 border-t border-slate-100 text-center">
           <p className="text-xs text-slate-400">
             Authorized Use Only. Activities are logged for audit, traceability, and review purposes.
           </p>
        </div>
      </div>
    </div>
  );
};
