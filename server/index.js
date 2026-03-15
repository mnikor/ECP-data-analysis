import fs from 'node:fs/promises';
import fsSync from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { loadEnv, createServer as createViteServer } from 'vite';
import { GoogleGenAI } from '@google/genai';
import { createProjectStore } from './projectStore.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const root = path.resolve(__dirname, '..');
const distDir = path.resolve(root, 'dist');
const isProduction = process.env.NODE_ENV === 'production';
const port = Number(process.env.PORT || 3000);
const projectStore = createProjectStore(root);

const env = loadEnv(isProduction ? 'production' : 'development', root, '');
for (const [key, value] of Object.entries(env)) {
  if (!(key in process.env)) process.env[key] = value;
}

const withRetry = async (operation, maxRetries = 3, delayMs = 2000) => {
  for (let attempt = 0; attempt < maxRetries; attempt += 1) {
    try {
      return await operation();
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      const status = error?.status;
      const isTransient =
        message.includes("Model isn't available right now") ||
        message.includes('503') ||
        message.includes('429') ||
        status === 503 ||
        status === 429;

      if (!isTransient || attempt === maxRetries - 1) {
        throw error;
      }

      await new Promise((resolve) => setTimeout(resolve, delayMs));
    }
  }

  throw new Error('Max retries reached');
};

const getAiClient = () => {
  const apiKey = process.env.GEMINI_API_KEY;
  if (!apiKey) return null;
  return new GoogleGenAI({ apiKey });
};

const readJsonBody = async (req) => {
  const chunks = [];
  for await (const chunk of req) {
    chunks.push(chunk);
  }
  const body = Buffer.concat(chunks).toString('utf8');
  return body ? JSON.parse(body) : {};
};

const sendJson = (res, statusCode, payload) => {
  res.writeHead(statusCode, {
    'Content-Type': 'application/json',
    'Cache-Control': 'no-store',
  });
  res.end(JSON.stringify(payload));
};

const resolvePythonBinary = () => {
  if (process.env.ECP_PYTHON_BIN) return process.env.ECP_PYTHON_BIN;

  const venvPython = path.join(root, '.venv', 'bin', 'python3');
  if (fsSync.existsSync(venvPython)) return venvPython;

  return 'python3';
};

const runPythonParser = (filePath) =>
  new Promise((resolve, reject) => {
    const scriptPath = path.join(__dirname, 'parse_sas.py');
    const child = spawn(resolvePythonBinary(), [scriptPath, filePath], {
      cwd: root,
      env: process.env,
      stdio: ['ignore', 'pipe', 'pipe'],
    });

    let stdout = '';
    let stderr = '';

    child.stdout.on('data', (chunk) => {
      stdout += chunk.toString('utf8');
    });

    child.stderr.on('data', (chunk) => {
      stderr += chunk.toString('utf8');
    });

    child.on('error', (error) => {
      reject(error);
    });

    child.on('close', (code) => {
      let parsed = null;
      try {
        parsed = stdout ? JSON.parse(stdout) : null;
      } catch {
        parsed = null;
      }

      if (code === 0 && parsed && !parsed.error) {
        resolve(parsed);
        return;
      }

      const errorMessage =
        parsed?.error ||
        stderr.trim() ||
        stdout.trim() ||
        'Failed to parse SAS dataset.';
      reject(new Error(errorMessage));
    });
  });

const handleSasParse = async (req, res) => {
  if (req.method !== 'POST') {
    sendJson(res, 405, { error: 'Method not allowed' });
    return;
  }

  let tempPath = null;

  try {
    const body = await readJsonBody(req);
    const fileName = typeof body.fileName === 'string' ? body.fileName : '';
    const base64Data = typeof body.base64Data === 'string' ? body.base64Data : '';
    const extension = path.extname(fileName).toLowerCase();

    if (!fileName || !base64Data) {
      sendJson(res, 400, { error: 'fileName and base64Data are required.' });
      return;
    }

    if (!['.xpt', '.sas7bdat'].includes(extension)) {
      sendJson(res, 400, { error: 'Only .xpt and .sas7bdat files are supported.' });
      return;
    }

    const buffer = Buffer.from(base64Data, 'base64');
    tempPath = path.join(os.tmpdir(), `evidence-copilot-${crypto.randomUUID()}${extension}`);
    await fs.writeFile(tempPath, buffer);

    const parsed = await runPythonParser(tempPath);
    sendJson(res, 200, parsed);
  } catch (error) {
    const message = error instanceof Error ? error.message : 'Failed to parse SAS dataset.';
    console.error('SAS parse error', error);
    sendJson(res, 500, { error: message });
  } finally {
    if (tempPath) {
      await fs.rm(tempPath, { force: true }).catch(() => {});
    }
  }
};

const handleAiGenerate = async (req, res) => {
  if (req.method !== 'POST') {
    sendJson(res, 405, { error: 'Method not allowed' });
    return;
  }

  const ai = getAiClient();
  if (!ai) {
    sendJson(res, 503, { error: 'AI service is not configured on the server.' });
    return;
  }

  try {
    const body = await readJsonBody(req);
    const prompt = typeof body.prompt === 'string' ? body.prompt : '';

    if (!prompt.trim()) {
      sendJson(res, 400, { error: 'Prompt is required.' });
      return;
    }

    const response = await withRetry(() =>
      ai.models.generateContent({
        model: body.model || 'gemini-3.1-pro-preview',
        contents: { parts: [{ text: prompt }] },
        config: {
          ...(body.systemInstruction ? { systemInstruction: body.systemInstruction } : {}),
          ...(typeof body.temperature === 'number' ? { temperature: body.temperature } : {}),
          ...(body.responseMimeType ? { responseMimeType: body.responseMimeType } : {}),
          ...(body.responseSchema ? { responseSchema: body.responseSchema } : {}),
        },
      })
    );

    sendJson(res, 200, { text: response.text || '' });
  } catch (error) {
    const message = error instanceof Error ? error.message : 'Unknown AI server error';
    console.error('AI proxy error', error);
    sendJson(res, 500, { error: message });
  }
};

const handleProjects = async (req, res) => {
  if (req.method === 'GET') {
    try {
      const projects = await projectStore.readProjects();
      sendJson(res, 200, {
        projects,
        storageBackend: projectStore.backend,
        metadataBackend: projectStore.metadataBackend,
        artifactBackend: projectStore.artifactBackend,
      });
    } catch (error) {
      const message = error instanceof Error ? error.message : 'Failed to load projects.';
      console.error('Project store read error', error);
      sendJson(res, 500, { error: message });
    }
    return;
  }

  if (req.method === 'PUT') {
    try {
      const body = await readJsonBody(req);
      const projects = Array.isArray(body?.projects) ? body.projects : null;
      if (!projects) {
        sendJson(res, 400, { error: 'Projects array is required.' });
        return;
      }

      await projectStore.writeProjects(projects);
      sendJson(res, 200, {
        ok: true,
        projectCount: projects.length,
        storageBackend: projectStore.backend,
        metadataBackend: projectStore.metadataBackend,
        artifactBackend: projectStore.artifactBackend,
      });
    } catch (error) {
      const message = error instanceof Error ? error.message : 'Failed to save projects.';
      console.error('Project store write error', error);
      sendJson(res, 500, { error: message });
    }
    return;
  }

  if (req.method === 'DELETE') {
    try {
      await projectStore.clearProjects();
      sendJson(res, 200, {
        ok: true,
        storageBackend: projectStore.backend,
        metadataBackend: projectStore.metadataBackend,
        artifactBackend: projectStore.artifactBackend,
      });
    } catch (error) {
      const message = error instanceof Error ? error.message : 'Failed to clear projects.';
      console.error('Project store clear error', error);
      sendJson(res, 500, { error: message });
    }
    return;
  }

  sendJson(res, 405, { error: 'Method not allowed' });
};

const serveStaticAsset = async (pathname, res) => {
  const normalizedPath = pathname === '/' ? '/index.html' : pathname;
  const requestedPath = path.join(distDir, normalizedPath.replace(/^\/+/, ''));
  const safePath = requestedPath.startsWith(distDir) ? requestedPath : distDir;

  try {
    const filePath = normalizedPath === '/' ? path.join(distDir, 'index.html') : safePath;
    const file = await fs.readFile(filePath);
    const extension = path.extname(filePath).toLowerCase();
    const contentType =
      extension === '.html' ? 'text/html; charset=utf-8' :
      extension === '.js' ? 'application/javascript; charset=utf-8' :
      extension === '.css' ? 'text/css; charset=utf-8' :
      extension === '.svg' ? 'image/svg+xml' :
      extension === '.png' ? 'image/png' :
      extension === '.json' ? 'application/json; charset=utf-8' :
      'application/octet-stream';

    res.writeHead(200, { 'Content-Type': contentType });
    res.end(file);
    return true;
  } catch {
    if (pathname === '/' || !path.extname(pathname)) {
      const indexFile = await fs.readFile(path.join(distDir, 'index.html'));
      res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
      res.end(indexFile);
      return true;
    }
    return false;
  }
};

const start = async () => {
  const vite = !isProduction
    ? await createViteServer({
        root,
        server: { middlewareMode: true, hmr: false },
        appType: 'spa',
      })
    : null;

  const server = http.createServer(async (req, res) => {
    const url = new URL(req.url || '/', `http://${req.headers.host || 'localhost'}`);

    if (url.pathname === '/api/health') {
      sendJson(res, 200, {
        ok: true,
        aiConfigured: Boolean(process.env.GEMINI_API_KEY),
        projectStoreBackend: projectStore.backend,
        metadataStoreBackend: projectStore.metadataBackend,
        artifactStoreBackend: projectStore.artifactBackend,
      });
      return;
    }

    if (url.pathname === '/api/projects') {
      await handleProjects(req, res);
      return;
    }

    if (url.pathname === '/api/ai/generate') {
      await handleAiGenerate(req, res);
      return;
    }

    if (url.pathname === '/api/ingestion/parse-sas') {
      await handleSasParse(req, res);
      return;
    }

    if (vite) {
      vite.middlewares(req, res, () => {
        res.statusCode = 404;
        res.end('Not found');
      });
      return;
    }

    const served = await serveStaticAsset(url.pathname, res);
    if (!served) {
      res.statusCode = 404;
      res.end('Not found');
    }
  });

  server.listen(port, '0.0.0.0', () => {
    console.log(`Evidence CoPilot server running on http://localhost:${port}`);
  });
};

start().catch((error) => {
  console.error('Failed to start server', error);
  process.exit(1);
});
