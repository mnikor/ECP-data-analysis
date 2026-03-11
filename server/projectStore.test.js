import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { createProjectStore } from './projectStore.js';

const tempRoots = [];

const makeTempRoot = async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'ecp-project-store-'));
  tempRoots.push(root);
  return root;
};

const sampleProjects = [
  {
    id: 'project-1',
    name: 'Demo Project',
    files: [
      {
        id: 'file-1',
        name: 'raw_dm.csv',
        type: 'RAW',
        content: 'USUBJID,AGE\n01,65',
        metadata: { qcApplicable: true },
      },
      {
        id: 'file-2',
        name: 'protocol.pdf',
        type: 'DOCUMENT',
      },
    ],
    chatMessages: [],
    provenance: [],
    mappingSpecs: [],
    statSessions: [],
  },
];

afterEach(async () => {
  await Promise.all(tempRoots.splice(0).map((root) => fs.rm(root, { recursive: true, force: true })));
});

describe('projectStore', () => {
  it('stores project metadata separately from file payloads and rehydrates on read', async () => {
    const root = await makeTempRoot();
    const store = createProjectStore(root);

    await store.writeProjects(sampleProjects);

    const metadata = JSON.parse(
      await fs.readFile(path.join(root, '.app-data', 'projects.metadata.json'), 'utf8')
    );
    expect(metadata[0].files[0].content).toBeUndefined();

    const artifact = JSON.parse(
      await fs.readFile(path.join(root, '.app-data', 'file-artifacts', 'project-1', 'file-1.json'), 'utf8')
    );
    expect(artifact.content).toBe('USUBJID,AGE\n01,65');

    const projects = await store.readProjects();
    expect(projects[0].files[0].content).toBe('USUBJID,AGE\n01,65');
    expect(projects[0].files[1].content).toBeUndefined();
  });

  it('migrates legacy monolithic project storage into split metadata and artifacts', async () => {
    const root = await makeTempRoot();
    const appDataDir = path.join(root, '.app-data');
    await fs.mkdir(appDataDir, { recursive: true });
    await fs.writeFile(path.join(appDataDir, 'projects.json'), JSON.stringify(sampleProjects, null, 2), 'utf8');

    const store = createProjectStore(root);
    const projects = await store.readProjects();

    expect(projects[0].files[0].content).toBe('USUBJID,AGE\n01,65');

    const metadata = JSON.parse(
      await fs.readFile(path.join(root, '.app-data', 'projects.metadata.json'), 'utf8')
    );
    expect(metadata[0].files[0].content).toBeUndefined();

    const legacyExists = await fs
      .access(path.join(appDataDir, 'projects.json'))
      .then(() => true)
      .catch(() => false);
    expect(legacyExists).toBe(false);
  });
});
