import fs from 'node:fs/promises';
import path from 'node:path';

const DEFAULT_BACKEND = process.env.PROJECT_STORE_BACKEND || 'local-disk';

const isNotFoundError = (error) =>
  Boolean(error && typeof error === 'object' && 'code' in error && error.code === 'ENOENT');

const ensureDir = async (dirPath) => {
  await fs.mkdir(dirPath, { recursive: true });
};

const readJsonFile = async (filePath, fallback = null) => {
  try {
    const raw = await fs.readFile(filePath, 'utf8');
    return JSON.parse(raw);
  } catch (error) {
    if (isNotFoundError(error)) return fallback;
    throw error;
  }
};

const writeJsonAtomic = async (filePath, payload) => {
  const tempFile = `${filePath}.tmp`;
  await fs.writeFile(tempFile, JSON.stringify(payload, null, 2), 'utf8');
  await fs.rename(tempFile, filePath);
};

const removeIfExists = async (targetPath) => {
  try {
    await fs.rm(targetPath, { recursive: true, force: true });
  } catch (error) {
    if (!isNotFoundError(error)) {
      throw error;
    }
  }
};

const stripFileContent = (file) => {
  const { content, ...rest } = file;
  return rest;
};

const listFilesRecursive = async (dirPath) => {
  try {
    const entries = await fs.readdir(dirPath, { withFileTypes: true });
    const files = await Promise.all(
      entries.map(async (entry) => {
        const fullPath = path.join(dirPath, entry.name);
        if (entry.isDirectory()) {
          return listFilesRecursive(fullPath);
        }
        return [fullPath];
      })
    );
    return files.flat();
  } catch (error) {
    if (isNotFoundError(error)) return [];
    throw error;
  }
};

const buildArtifactPath = (artifactsDir, projectId, fileId) =>
  path.join(artifactsDir, projectId, `${fileId}.json`);

export const createProjectStore = (rootDir, options = {}) => {
  const backend = options.backend || DEFAULT_BACKEND;
  const dataDir = path.join(rootDir, '.app-data');
  const legacyProjectsFile = path.join(dataDir, 'projects.json');
  const metadataFile = path.join(dataDir, 'projects.metadata.json');
  const artifactsDir = path.join(dataDir, 'file-artifacts');

  const assertSupported = () => {
    if (backend !== 'local-disk') {
      throw new Error(`Unsupported project store backend: ${backend}`);
    }
  };

  const ensureStoreLayout = async () => {
    await ensureDir(dataDir);
    await ensureDir(artifactsDir);
  };

  const hydrateProjects = async (projects) => {
    const hydratedProjects = await Promise.all(
      (projects || []).map(async (project) => {
        const files = await Promise.all(
          (project.files || []).map(async (file) => {
            const artifact = await readJsonFile(buildArtifactPath(artifactsDir, project.id, file.id), null);
            return artifact && typeof artifact.content === 'string'
              ? { ...file, content: artifact.content }
              : { ...file };
          })
        );
        return { ...project, files };
      })
    );

    return hydratedProjects;
  };

  const persistSplitStore = async (projects) => {
    await ensureStoreLayout();

    const metadataProjects = projects.map((project) => ({
      ...project,
      files: (project.files || []).map(stripFileContent),
    }));

    await writeJsonAtomic(metadataFile, metadataProjects);

    const desiredArtifacts = new Set();

    for (const project of projects) {
      const projectArtifactDir = path.join(artifactsDir, project.id);
      await ensureDir(projectArtifactDir);

      for (const file of project.files || []) {
        const artifactPath = buildArtifactPath(artifactsDir, project.id, file.id);
        if (typeof file.content === 'string') {
          desiredArtifacts.add(artifactPath);
          await writeJsonAtomic(artifactPath, {
            fileId: file.id,
            projectId: project.id,
            content: file.content,
          });
        }
      }
    }

    const existingArtifacts = await listFilesRecursive(artifactsDir);
    await Promise.all(
      existingArtifacts
        .filter((artifactPath) => !desiredArtifacts.has(artifactPath))
        .map((artifactPath) => removeIfExists(artifactPath))
    );

    const projectDirs = await fs.readdir(artifactsDir, { withFileTypes: true }).catch((error) => {
      if (isNotFoundError(error)) return [];
      throw error;
    });
    const activeProjectIds = new Set(projects.map((project) => project.id));
    await Promise.all(
      projectDirs
        .filter((entry) => entry.isDirectory() && !activeProjectIds.has(entry.name))
        .map((entry) => removeIfExists(path.join(artifactsDir, entry.name)))
    );

    await removeIfExists(legacyProjectsFile);
  };

  const migrateLegacyProjectsIfNeeded = async () => {
    const legacyProjects = await readJsonFile(legacyProjectsFile, null);
    if (!Array.isArray(legacyProjects)) {
      return null;
    }

    await persistSplitStore(legacyProjects);
    return legacyProjects;
  };

  const readProjects = async () => {
    assertSupported();

    const metadataProjects = await readJsonFile(metadataFile, null);
    if (Array.isArray(metadataProjects)) {
      return hydrateProjects(metadataProjects);
    }

    const migratedProjects = await migrateLegacyProjectsIfNeeded();
    if (Array.isArray(migratedProjects)) {
      return migratedProjects;
    }

    return [];
  };

  const writeProjects = async (projects) => {
    assertSupported();
    await persistSplitStore(projects);
  };

  const clearProjects = async () => {
    assertSupported();
    await Promise.all([removeIfExists(metadataFile), removeIfExists(legacyProjectsFile), removeIfExists(artifactsDir)]);
  };

  return {
    backend,
    metadataBackend: backend,
    artifactBackend: backend,
    readProjects,
    writeProjects,
    clearProjects,
  };
};
