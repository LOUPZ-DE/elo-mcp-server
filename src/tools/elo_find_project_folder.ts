import { z } from 'zod';
import { EloClient } from '../elo/client.js';
import { isFolder, SORD_Z_ALL } from '../elo/constants.js';
import type { FindResponse } from '../elo/types.js';

export const FindProjectFolderInputSchema = {
  projectNumber: z.string().optional().describe('Project number (e.g. "2025-001")'),
  projectName: z.string().optional().describe('Project name (e.g. "Customer XYZ")'),
};

const FindProjectFolderArgs = z
  .object(FindProjectFolderInputSchema)
  .refine((d) => Boolean(d.projectNumber || d.projectName), {
    message: 'Either projectNumber or projectName is required.',
  });
export type FindProjectFolderArgs = z.infer<typeof FindProjectFolderArgs>;

export interface ProjectFolder {
  objId: string;
  name: string;
  path: string;
  eloLink: string;
  projectNumber?: string;
}

export interface FindProjectFolderOptions {
  webclientBaseUrl: string;
  /** Name of the ELO index field that holds the project number. */
  projectNumberField: string;
}

export async function eloFindProjectFolder(
  client: EloClient,
  args: FindProjectFolderArgs,
  options: FindProjectFolderOptions,
): Promise<ProjectFolder[]> {
  const query = args.projectNumber ?? args.projectName ?? '';
  if (!query) {
    throw new Error('Either projectNumber or projectName is required.');
  }

  const body = {
    findInfo: {
      findByESearch: {
        searchOptions: {},
        searchParams: {
          query,
          searchIn: 'TITLE,INDEX_FIELDS',
        },
      },
    },
    max: 50,
    sordZ: SORD_Z_ALL,
  };

  const response = await client.request<FindResponse>(
    '/rest/IXServicePortIF/findFirstSords',
    body,
  );

  const webBase = options.webclientBaseUrl.replace(/\/$/, '');
  const folders = (response.result?.sords ?? []).filter((s) => isFolder(s.type));

  return folders.map((s) => {
    const firstRefPath = s.refPaths?.[0]?.path ?? [];
    const path = firstRefPath.map((p) => p.name).join('/');
    const projectNumber = s.objKeys?.find(
      (k) => k.name === options.projectNumberField,
    )?.data?.[0];

    return {
      objId: s.id,
      name: s.name,
      path,
      eloLink: `${webBase}/${s.id}?title=${encodeURIComponent(s.name)}`,
      projectNumber,
    };
  });
}
