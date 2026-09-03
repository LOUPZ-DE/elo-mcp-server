import { createHash } from 'node:crypto';
import { EloClient } from '../elo/client.js';
import { EDIT_INFO_Z_ALL, LOCK_Z_NO, SORD_Z_ALL, isFolder } from '../elo/constants.js';
import { allIndexFields, refPathString } from '../elo/sord.js';
import type {
  CheckinSordResponse,
  CheckoutResponse,
  CreateSordResponse,
  EloObjKey,
  EloSord,
} from '../elo/types.js';
import { WriteConflictError, WritePolicyError } from './errors.js';

// The two operations of step 2, each split so the preview and the write share
// exactly one code path for reading the target.
//
// Only two Z bitmasks appear here, and both are already proven against this
// instance: LOCK_Z_NO ({bset:'0'}) and SORD_Z_ALL ({bset:'-1'}). The constant
// classes are in the live OpenAPI document by name but carry no values, so
// anything else would be a guess. Passing LOCK_Z_NO as `unlockZ` says "do not
// unlock", which is the correct request when nothing was locked in the first
// place — this design takes no locks and detects conflicts by comparing the
// object against what the preview showed.

/** Reads a target and refuses anything that is not a usable folder/object. */
export async function readTarget(client: EloClient, objId: string): Promise<EloSord> {
  const response = await client.request<CheckoutResponse>(
    '/rest/IXServicePortIF/checkoutSord',
    { objId, editInfoZ: EDIT_INFO_Z_ALL, lockZ: LOCK_Z_NO },
  );
  const sord = response.result?.sord;
  if (!sord) {
    throw new WritePolicyError(`No object with objId ${objId} is readable for this account.`);
  }
  return sord;
}

export function assertIsFolder(sord: EloSord): void {
  if (!isFolder(sord.type)) {
    throw new WritePolicyError(
      `"${sord.name}" is a document, not a folder — nothing can be filed inside it.`,
    );
  }
}

/**
 * A short stand-in for "the object as the preview showed it".
 *
 * Change date plus name plus index values: enough that an edit by somebody else
 * between preview and commit changes it. IX updates XDateIso on any checkin, so
 * in practice the date alone would do; the rest is there because a fingerprint
 * that silently depends on one optional field is a fingerprint that stops
 * working when that field is absent.
 */
export function fingerprint(sord: EloSord): string {
  const parts = {
    id: String(sord.id),
    changed: sord.XDateIso ?? sord.xDateIso ?? '',
    name: sord.name,
    fields: allIndexFields(sord),
  };
  return createHash('sha256').update(JSON.stringify(parts)).digest('hex').slice(0, 32);
}

/**
 * Re-read the object and refuse if it moved on since the preview.
 *
 * This is the whole concurrency story: no locks, so nothing can be left locked,
 * and a conflict aborts rather than overwriting somebody's edit.
 */
export async function assertUnchanged(
  client: EloClient,
  objId: string,
  baseline: string,
): Promise<EloSord> {
  const current = await readTarget(client, objId);
  if (fingerprint(current) !== baseline) {
    throw new WriteConflictError(
      `"${current.name}" changed in ELO after the preview was made. Nothing was written. ` +
        'Prepare the change again to see the current state.',
    );
  }
  return current;
}

/** Merges field updates into a sord's objKeys, leaving untouched keys alone. */
export function applyIndexFields(sord: EloSord, fields: Record<string, string>): EloObjKey[] {
  const keys: EloObjKey[] = (sord.objKeys ?? []).map((k) => ({ ...k }));
  for (const [name, value] of Object.entries(fields)) {
    const existing = keys.find((k) => k.name === name);
    if (existing) existing.data = [value];
    else keys.push({ name, data: [value] });
  }
  return keys;
}

export interface CreateFolderInput {
  parentId: string;
  name: string;
  maskName: string;
  indexFields?: Record<string, string>;
}

/**
 * createSord → fill → checkinSord.
 *
 * `createSord` builds a template in memory and persists nothing; the object
 * exists only once `checkinSord` returns its objId. Both go through
 * `requestOnce`, so a session that lapses mid-sequence surfaces instead of
 * being replayed into a second folder.
 */
export async function createFolder(
  client: EloClient,
  input: CreateFolderInput,
): Promise<{ objId: string; name: string }> {
  const created = await client.requestOnce<CreateSordResponse>(
    '/rest/IXServicePortIF/createSord',
    { parentId: input.parentId, maskId: input.maskName, editInfoZ: EDIT_INFO_Z_ALL },
  );
  const template = created.result?.sord;
  if (!template) {
    throw new WritePolicyError(
      `ELO returned no template for mask "${input.maskName}" — check that the mask exists and this account may use it.`,
    );
  }

  const sord: EloSord = {
    ...template,
    name: input.name,
    objKeys: input.indexFields ? applyIndexFields(template, input.indexFields) : template.objKeys,
  };

  const checked = await client.requestOnce<CheckinSordResponse>(
    '/rest/IXServicePortIF/checkinSord',
    { sord, sordZ: SORD_Z_ALL, unlockZ: LOCK_Z_NO },
  );
  const objId = checked.result;
  if (objId === undefined || objId === null) {
    throw new WritePolicyError('ELO accepted the folder but returned no objId.');
  }
  return { objId: String(objId), name: input.name };
}

/**
 * checkoutSord → merge fields → checkinSord.
 *
 * The caller has already verified the fingerprint; `current` is the sord that
 * check returned, so this does not re-read and cannot act on a different
 * version than the one that was compared.
 */
export async function updateMetadata(
  client: EloClient,
  current: EloSord,
  fields: Record<string, string>,
): Promise<{ objId: string; name: string; path?: string }> {
  const sord: EloSord = { ...current, objKeys: applyIndexFields(current, fields) };
  const checked = await client.requestOnce<CheckinSordResponse>(
    '/rest/IXServicePortIF/checkinSord',
    { sord, sordZ: SORD_Z_ALL, unlockZ: LOCK_Z_NO },
  );
  if (checked.result === undefined || checked.result === null) {
    throw new WritePolicyError('ELO accepted the change but returned no objId.');
  }
  return { objId: String(current.id), name: current.name, path: refPathString(current) };
}
