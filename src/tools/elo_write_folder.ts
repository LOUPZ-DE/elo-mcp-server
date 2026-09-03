import { z } from 'zod';
import type { AuthInfo } from '@modelcontextprotocol/sdk/server/auth/types.js';
import { EloClient } from '../elo/client.js';
import { refPathString } from '../elo/sord.js';
import { requireEloUser } from '../write/guard.js';
import {
  assertMaskAllowed,
  assertTargetAllowed,
  assertFieldsAllowed,
  type WritePolicy,
} from '../write/policy.js';
import { hashPayload, prepareWrite, consumeWrite } from '../write/preflight.js';
import { onceOnly } from '../write/idempotency.js';
import { withAudit } from '../write/audit.js';
import { assertIsFolder, assertUnchanged, createFolder, fingerprint, readTarget } from '../write/operations.js';

export const CreateFolderInputSchema = {
  parentId: z
    .string()
    .describe('objId of the folder the new folder goes into. Must be inside a configured write area.'),
  name: z.string().min(1).max(255).describe('Name of the new folder'),
  maskName: z.string().describe('ELO mask for the new folder, e.g. "Ordner"'),
  indexFields: z
    .record(z.string())
    .optional()
    .describe('Index fields to set on the new folder. Only allowlisted fields are accepted.'),
};

export const CommitInputSchema = {
  confirmToken: z.string().describe('The confirmToken from the matching preview call'),
  idempotencyKey: z
    .string()
    .min(8)
    .describe(
      'Your own unique id for this change. Repeating a key returns the first result instead of writing twice — send the same key when retrying after a timeout.',
    ),
};

const CreateFolderArgs = z.object(CreateFolderInputSchema);
export type CreateFolderArgs = z.infer<typeof CreateFolderArgs>;

export interface WriteToolOptions {
  policy: WritePolicy;
  webclientBaseUrl: string;
}

/**
 * Preview a folder creation and reserve a confirmation.
 *
 * Everything that can be checked before writing is checked here, so the preview
 * either shows what would happen or explains why it cannot — a commit that
 * fails on policy would mean the user confirmed something that was never going
 * to work.
 */
export async function prepareCreateFolder(
  client: EloClient,
  authInfo: AuthInfo | undefined,
  args: CreateFolderArgs,
  opts: WriteToolOptions,
) {
  const session = requireEloUser(authInfo);
  const parent = await readTarget(client, args.parentId);
  assertIsFolder(parent);
  assertTargetAllowed(parent, opts.policy);
  assertMaskAllowed(args.maskName, opts.policy);
  if (args.indexFields) assertFieldsAllowed(args.indexFields, opts.policy);

  const payloadHash = hashPayload(args);
  const { token, expiresAt } = prepareWrite({
    operation: 'create_folder',
    userName: session.userName,
    clientId: authInfo!.clientId,
    payloadHash,
    targetId: args.parentId,
    baseline: fingerprint(parent),
  });

  return {
    willCreate: {
      name: args.name,
      maskName: args.maskName,
      indexFields: args.indexFields ?? {},
      inside: { objId: parent.id, name: parent.name, path: refPathString(parent) },
    },
    as: session.userName,
    confirmToken: token,
    confirmTokenExpiresAt: new Date(expiresAt).toISOString(),
    note: 'Nothing has been written. Call the commit tool with this confirmToken to create the folder.',
  };
}

export async function commitCreateFolder(
  client: EloClient,
  authInfo: AuthInfo | undefined,
  args: CreateFolderArgs & { confirmToken: string; idempotencyKey: string },
) {
  const session = requireEloUser(authInfo);
  const { confirmToken, idempotencyKey, ...payload } = args;
  const prepared = consumeWrite(confirmToken, {
    userName: session.userName,
    clientId: authInfo!.clientId,
    operation: 'create_folder',
    payloadHash: hashPayload(payload),
  });

  return withAudit(
    {
      operation: 'create_folder',
      userName: session.userName,
      clientId: authInfo!.clientId,
      targetId: payload.parentId,
      fieldNames: Object.keys(payload.indexFields ?? {}),
    },
    async () => {
      const { result, replayed } = await onceOnly(session.userName, idempotencyKey, async () => {
        // Re-checked immediately before writing: the preview may be minutes old.
        await assertUnchanged(client, payload.parentId, prepared.baseline!);
        return createFolder(client, payload);
      });
      return { value: { ...result, replayed }, resultObjId: result.objId, replayed };
    },
  );
}
