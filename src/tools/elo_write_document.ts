import { z } from 'zod';
import type { AuthInfo } from '@modelcontextprotocol/sdk/server/auth/types.js';
import { EloClient } from '../elo/client.js';
import { refPathString } from '../elo/sord.js';
import { requireEloUser } from '../write/guard.js';
import {
  assertFieldsAllowed,
  assertFileAllowed,
  assertMaskAllowed,
  assertTargetAllowed,
} from '../write/policy.js';
import { hashPayload, prepareWrite, consumeWrite } from '../write/preflight.js';
import { onceOnly } from '../write/idempotency.js';
import { withAudit } from '../write/audit.js';
import {
  addDocumentVersion,
  assertIsFolder,
  assertUnchanged,
  fingerprint,
  readSnapshot,
  uploadDocument,
  type UploadTransport,
} from '../write/operations.js';
import { WritePolicyError } from '../write/errors.js';
import type { WriteToolOptions } from './elo_write_folder.js';

/**
 * Base64 is the only way a file reaches an MCP tool: arguments are JSON, so
 * there is no multipart and no binary frame to use instead.
 */
const contentBase64 = z
  .string()
  .min(1)
  .describe('File content, base64-encoded. The decoded size counts against the configured limit.');

export const UploadDocumentInputSchema = {
  parentId: z.string().describe('objId of the folder to file the document in'),
  name: z.string().min(1).max(255).describe('Name of the document in ELO'),
  maskName: z.string().describe('ELO mask for the new document'),
  fileName: z.string().min(1).describe('Original file name, e.g. "Bericht.pdf"'),
  contentType: z.string().describe('MIME type, e.g. "application/pdf". Must be allowlisted.'),
  contentBase64,
  indexFields: z.record(z.string()).optional().describe('Index fields to set. Allowlisted only.'),
  versionComment: z.string().max(500).optional().describe('Comment stored on this version'),
};

export const AddVersionInputSchema = {
  objId: z.string().describe('objId of the existing document to add a version to'),
  fileName: z.string().min(1).describe('Original file name'),
  contentType: z.string().describe('MIME type. Must be allowlisted.'),
  contentBase64,
  versionComment: z.string().max(500).optional().describe('Comment stored on this version'),
};

const UploadDocumentArgs = z.object(UploadDocumentInputSchema);
const AddVersionArgs = z.object(AddVersionInputSchema);
export type UploadDocumentArgs = z.infer<typeof UploadDocumentArgs>;
export type AddVersionArgs = z.infer<typeof AddVersionArgs>;

export interface DocumentToolOptions extends WriteToolOptions {
  transport: UploadTransport;
}

/**
 * Decode and sanity-check the payload.
 *
 * `Buffer.from(x, 'base64')` never throws — it silently drops anything that is
 * not base64, so a corrupted argument would otherwise arrive as a short,
 * plausible-looking file. Re-encoding and comparing lengths catches that.
 */
function decodeContent(contentBase64: string): Buffer {
  const bytes = Buffer.from(contentBase64, 'base64');
  if (bytes.length === 0) {
    throw new WritePolicyError('The file content is empty or not valid base64.');
  }
  if (bytes.toString('base64').replace(/=+$/, '') !== contentBase64.replace(/=+$/, '')) {
    throw new WritePolicyError(
      'The file content is not valid base64 — part of it would have been discarded silently.',
    );
  }
  return bytes;
}

/** Extension without the dot; ELO stores it separately from the MIME type. */
function extensionOf(fileName: string): string {
  const dot = fileName.lastIndexOf('.');
  return dot > 0 ? fileName.slice(dot + 1).toLowerCase() : '';
}

export async function prepareUploadDocument(
  client: EloClient,
  authInfo: AuthInfo | undefined,
  args: UploadDocumentArgs,
  opts: DocumentToolOptions,
) {
  const session = requireEloUser(authInfo);
  const bytes = decodeContent(args.contentBase64);
  const parentSnapshot = await readSnapshot(client, args.parentId);
  const parent = parentSnapshot.sord;
  assertIsFolder(parent);
  assertTargetAllowed(parent, opts.policy);
  assertMaskAllowed(args.maskName, opts.policy);
  assertFileAllowed(args.contentType, bytes.length, opts.policy);
  if (args.indexFields) assertFieldsAllowed(args.indexFields, opts.policy);

  const { token, expiresAt } = prepareWrite({
    operation: 'upload_document',
    userName: session.userName,
    clientId: authInfo!.clientId,
    payloadHash: hashPayload(args),
    targetId: args.parentId,
    baseline: fingerprint(parentSnapshot),
  });

  return {
    willUpload: {
      name: args.name,
      fileName: args.fileName,
      contentType: args.contentType,
      byteLength: bytes.length,
      maskName: args.maskName,
      indexFields: args.indexFields ?? {},
      into: { objId: parent.id, name: parent.name, path: refPathString(parent) },
    },
    as: session.userName,
    confirmToken: token,
    confirmTokenExpiresAt: new Date(expiresAt).toISOString(),
    note: 'Nothing has been written. Call the commit tool with this confirmToken to file the document.',
  };
}

export async function commitUploadDocument(
  client: EloClient,
  authInfo: AuthInfo | undefined,
  args: UploadDocumentArgs & { confirmToken: string; idempotencyKey: string },
  opts: DocumentToolOptions,
) {
  const session = requireEloUser(authInfo);
  const { confirmToken, idempotencyKey, ...payload } = args;
  const prepared = consumeWrite(confirmToken, {
    userName: session.userName,
    clientId: authInfo!.clientId,
    operation: 'upload_document',
    payloadHash: hashPayload(payload),
  });

  return withAudit(
    {
      operation: 'upload_document',
      userName: session.userName,
      clientId: authInfo!.clientId,
      targetId: payload.parentId,
      fileName: payload.fileName,
      contentType: payload.contentType,
      fieldNames: Object.keys(payload.indexFields ?? {}),
    },
    async () => {
      const { result, replayed } = await onceOnly(session.userName, idempotencyKey, async () => {
        await assertUnchanged(client, payload.parentId, prepared.baseline!);
        return uploadDocument(
          client,
          {
            parentId: payload.parentId,
            name: payload.name,
            maskName: payload.maskName,
            indexFields: payload.indexFields,
            bytes: decodeContent(payload.contentBase64),
            fileName: payload.fileName,
            contentType: payload.contentType,
            ext: extensionOf(payload.fileName),
            versionComment: payload.versionComment,
          },
          opts.transport,
        );
      });
      return { value: { ...result, replayed }, resultObjId: result.objId, replayed };
    },
  );
}

export async function prepareAddVersion(
  client: EloClient,
  authInfo: AuthInfo | undefined,
  args: AddVersionArgs,
  opts: DocumentToolOptions,
) {
  const session = requireEloUser(authInfo);
  const bytes = decodeContent(args.contentBase64);
  const snapshot = await readSnapshot(client, args.objId);
  const target = snapshot.sord;
  assertTargetAllowed(target, opts.policy);
  assertFileAllowed(args.contentType, bytes.length, opts.policy);

  const { token, expiresAt } = prepareWrite({
    operation: 'add_document_version',
    userName: session.userName,
    clientId: authInfo!.clientId,
    payloadHash: hashPayload(args),
    targetId: args.objId,
    baseline: fingerprint(snapshot),
  });

  return {
    document: { objId: target.id, name: target.name, path: refPathString(target) },
    willAddVersion: {
      fileName: args.fileName,
      contentType: args.contentType,
      byteLength: bytes.length,
      versionComment: args.versionComment,
    },
    as: session.userName,
    confirmToken: token,
    confirmTokenExpiresAt: new Date(expiresAt).toISOString(),
    note: 'Nothing has been written. The existing versions stay; this would add one on top.',
  };
}

export async function commitAddVersion(
  client: EloClient,
  authInfo: AuthInfo | undefined,
  args: AddVersionArgs & { confirmToken: string; idempotencyKey: string },
  opts: DocumentToolOptions,
) {
  const session = requireEloUser(authInfo);
  const { confirmToken, idempotencyKey, ...payload } = args;
  const prepared = consumeWrite(confirmToken, {
    userName: session.userName,
    clientId: authInfo!.clientId,
    operation: 'add_document_version',
    payloadHash: hashPayload(payload),
  });

  return withAudit(
    {
      operation: 'add_document_version',
      userName: session.userName,
      clientId: authInfo!.clientId,
      targetId: payload.objId,
      fileName: payload.fileName,
      contentType: payload.contentType,
    },
    async () => {
      const { result, replayed } = await onceOnly(session.userName, idempotencyKey, async () => {
        const current = await assertUnchanged(client, payload.objId, prepared.baseline!);
        return addDocumentVersion(
          client,
          current,
          {
            bytes: decodeContent(payload.contentBase64),
            fileName: payload.fileName,
            contentType: payload.contentType,
            ext: extensionOf(payload.fileName),
            versionComment: payload.versionComment,
          },
          opts.transport,
        );
      });
      return { value: { ...result, replayed }, resultObjId: result.objId, replayed };
    },
  );
}
