import { createHash } from 'node:crypto';
import { EloClient } from '../elo/client.js';
import {
  DOC_VERSION_Z_ALL,
  EDIT_INFO_Z_ALL,
  LOCK_Z_NO,
  SORD_Z_ALL,
  isFolder,
} from '../elo/constants.js';
import { allIndexFields, refPathString } from '../elo/sord.js';
import type {
  CheckinDocResponse,
  CheckinSordResponse,
  CheckoutResponse,
  CreateSordResponse,
  EloDocVersion,
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

/**
 * What a target looked like when it was read — sord plus, for a document, its
 * current version.
 *
 * The version is here because the fingerprint needs it. A live run showed
 * `XDateIso` does NOT move when a new document version is checked in, so a
 * fingerprint over the sord alone cannot notice that somebody added one — which
 * is precisely the concurrent change `elo_add_document_version` has to catch.
 */
export interface TargetSnapshot {
  sord: EloSord;
  version?: EloDocVersion;
}

/**
 * Reads a target and refuses anything this account cannot see.
 *
 * `checkoutDoc`, not `checkoutSord`: in this IX version the latter leaves the
 * `sord` field empty regardless of editInfoZ (see the note in
 * elo_get_metadata.ts), and it is the only call that returns the document
 * versions the fingerprint needs.
 */
export async function readSnapshot(client: EloClient, objId: string): Promise<TargetSnapshot> {
  const response = await client.request<CheckoutResponse>(
    '/rest/IXServicePortIF/checkoutDoc',
    { objId, editInfoZ: EDIT_INFO_Z_ALL, docVersionZ: DOC_VERSION_Z_ALL, lockZ: LOCK_Z_NO },
  );
  const sord = response.result?.sord;
  if (!sord) {
    throw new WritePolicyError(`No object with objId ${objId} is readable for this account.`);
  }
  return { sord, version: response.result?.document?.docs?.[0] };
}

/** Convenience for the many places that only need the sord. */
export async function readTarget(client: EloClient, objId: string): Promise<EloSord> {
  return (await readSnapshot(client, objId)).sord;
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
export function fingerprint(snapshot: TargetSnapshot | EloSord): string {
  const sord = 'sord' in snapshot ? snapshot.sord : snapshot;
  const version = 'sord' in snapshot ? snapshot.version : undefined;
  const parts = {
    id: String(sord.id),
    changed: sord.XDateIso ?? sord.xDateIso ?? '',
    name: sord.name,
    fields: allIndexFields(sord),
    // Measured, not assumed: checking in a new document version leaves
    // XDateIso untouched, so without the version identity here a concurrent
    // version would slip past the conflict check unnoticed.
    version: version ? [version.id, version.version, version.md5].join('|') : '',
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
  const current = await readSnapshot(client, objId);
  if (fingerprint(current) !== baseline) {
    throw new WriteConflictError(
      `"${current.sord.name}" changed in ELO after the preview was made. Nothing was written. ` +
        'Prepare the change again to see the current state.',
    );
  }
  return current.sord;
}

/**
 * Has this sord been stored yet?
 *
 * A template from `createSord` carries **`id: -1`** — measured against the live
 * instance, and returned as a JSON *number* despite `EloSord.id` being typed as
 * a string. `0` and an empty value are treated the same way for safety.
 *
 * This matters in exactly one place and cost a live run to find:
 * `checkinSord` happily accepts `-1` and reads it as "store me", while
 * `checkinDocBegin` takes `document.objId` literally and refuses with
 * `[ELOIX:5023] Das Objekt mit der ID document[0].objId=-1 ist nicht vorhanden`.
 * For a new document the field has to be omitted entirely.
 */
export function isUnsavedSord(sord: EloSord): boolean {
  const id = String(sord.id ?? '');
  return id === '' || id === '0' || id === '-1';
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

export interface UploadInput {
  /** Bytes already decoded from whatever the caller sent. */
  bytes: Buffer;
  fileName: string;
  contentType: string;
  /** Extension without the dot; ELO stores it separately from the MIME type. */
  ext: string;
  versionComment?: string;
}

export interface UploadTransport {
  maxBytes: number;
  timeoutMs: number;
}

/**
 * The three-step document checkin: begin → send bytes → end.
 *
 * `checkinDocBegin` reserves a version and answers with the URL the bytes go
 * to. What comes back from that upload is an opaque id which
 * `checkinDocEnd` needs in `docs[0].uploadResult` — without it ELO has a
 * version record pointing at nothing.
 *
 * The upload URL is a short-lived capability and never logged. It also points
 * at the internal host in this deployment (BUGFIXES #10), which is why
 * `EloClient.upload` re-anchors it rather than using it as given.
 */
async function checkinDocument(
  client: EloClient,
  sord: EloSord,
  input: UploadInput,
  transport: UploadTransport,
): Promise<{ objId: string; version?: string }> {
  const begun = await client.requestOnce<CheckinDocResponse>(
    '/rest/IXServicePortIF/checkinDocBegin',
    {
      document: {
        // Omitted for a new document: see isUnsavedSord(). Sending the
        // template's -1 makes IX look for an object with that id and refuse.
        ...(isUnsavedSord(sord) ? {} : { objId: sord.id }),
        docs: [
          {
            ext: input.ext,
            contentType: input.contentType,
            ...(input.versionComment ? { comment: input.versionComment } : {}),
          },
        ],
      },
    },
  );

  const version = begun.result?.docs?.[0];
  if (!version?.url) {
    throw new WritePolicyError(
      'ELO did not return an upload URL for this document, so the file cannot be stored.',
    );
  }

  const uploadResult = await client.upload(version.url, input.bytes, {
    maxBytes: transport.maxBytes,
    timeoutMs: transport.timeoutMs,
    contentType: input.contentType,
  });

  const ended = await client.requestOnce<CheckinDocResponse>(
    '/rest/IXServicePortIF/checkinDocEnd',
    {
      sord,
      document: {
        ...begun.result,
        docs: [{ ...version, uploadResult }],
      },
      sordZ: SORD_Z_ALL,
      unlockZ: LOCK_Z_NO,
    },
  );

  const objId = ended.result?.objId ?? (isUnsavedSord(sord) ? undefined : sord.id);
  if (!objId) {
    throw new WritePolicyError('ELO accepted the document but returned no objId.');
  }
  return { objId: String(objId), version: ended.result?.docs?.[0]?.version };
}

export interface UploadDocumentInput extends UploadInput {
  parentId: string;
  name: string;
  maskName: string;
  indexFields?: Record<string, string>;
}

/** createSord → fill → checkinDoc{Begin,End}. A brand-new document. */
export async function uploadDocument(
  client: EloClient,
  input: UploadDocumentInput,
  transport: UploadTransport,
): Promise<{ objId: string; name: string; version?: string }> {
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

  const { objId, version } = await checkinDocument(client, sord, input, transport);
  return { objId, name: input.name, version };
}

/**
 * A further version of an existing document.
 *
 * Additive: ELO keeps the previous versions, which is why the commit tool for
 * this is annotated `destructiveHint: false`. The caller has already verified
 * the fingerprint, so `current` is the sord that check returned.
 */
export async function addDocumentVersion(
  client: EloClient,
  current: EloSord,
  input: UploadInput,
  transport: UploadTransport,
): Promise<{ objId: string; name: string; version?: string; path?: string }> {
  if (isFolder(current.type)) {
    throw new WritePolicyError(
      `"${current.name}" is a folder — a folder has no document versions.`,
    );
  }
  const { objId, version } = await checkinDocument(client, current, input, transport);
  return { objId, name: current.name, version, path: refPathString(current) };
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
