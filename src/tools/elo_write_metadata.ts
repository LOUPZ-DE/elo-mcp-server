import { z } from 'zod';
import type { AuthInfo } from '@modelcontextprotocol/sdk/server/auth/types.js';
import { EloClient } from '../elo/client.js';
import { allIndexFields, refPathString } from '../elo/sord.js';
import { requireEloUser } from '../write/guard.js';
import { assertFieldsAllowed, assertTargetAllowed } from '../write/policy.js';
import { hashPayload, prepareWrite, consumeWrite } from '../write/preflight.js';
import { onceOnly } from '../write/idempotency.js';
import { withAudit } from '../write/audit.js';
import { assertUnchanged, fingerprint, readSnapshot, updateMetadata } from '../write/operations.js';
import type { WriteToolOptions } from './elo_write_folder.js';

export const UpdateMetadataInputSchema = {
  objId: z.string().describe('objId of the object whose index fields should change'),
  indexFields: z
    .record(z.string())
    .describe('Field name to new value. Only allowlisted fields are accepted; others are refused.'),
};

const UpdateMetadataArgs = z.object(UpdateMetadataInputSchema);
export type UpdateMetadataArgs = z.infer<typeof UpdateMetadataArgs>;

/**
 * Preview an index-field change.
 *
 * The preview names the current value beside the new one for every field. This
 * is the one operation of the four that overwrites rather than adds, so what a
 * confirmation is worth depends entirely on the person seeing what is being
 * replaced.
 */
export async function prepareUpdateMetadata(
  client: EloClient,
  authInfo: AuthInfo | undefined,
  args: UpdateMetadataArgs,
  opts: WriteToolOptions,
) {
  const session = requireEloUser(authInfo);
  const snapshot = await readSnapshot(client, args.objId);
  const target = snapshot.sord;
  assertTargetAllowed(target, opts.policy);
  assertFieldsAllowed(args.indexFields, opts.policy);

  const current = allIndexFields(target);
  const changes = Object.entries(args.indexFields).map(([field, next]) => ({
    field,
    from: current[field] ?? '(empty)',
    to: next,
    unchanged: current[field] === next,
  }));

  const payloadHash = hashPayload(args);
  const { token, expiresAt } = prepareWrite({
    operation: 'update_metadata',
    userName: session.userName,
    clientId: authInfo!.clientId,
    payloadHash,
    targetId: args.objId,
    baseline: fingerprint(snapshot),
  });

  return {
    object: {
      objId: target.id,
      name: target.name,
      path: refPathString(target),
      maskName: target.maskName,
    },
    changes,
    as: session.userName,
    confirmToken: token,
    confirmTokenExpiresAt: new Date(expiresAt).toISOString(),
    note:
      'Nothing has been written. These values would REPLACE the current ones — check the "from" column before confirming.',
  };
}

export async function commitUpdateMetadata(
  client: EloClient,
  authInfo: AuthInfo | undefined,
  args: UpdateMetadataArgs & { confirmToken: string; idempotencyKey: string },
) {
  const session = requireEloUser(authInfo);
  const { confirmToken, idempotencyKey, ...payload } = args;
  const prepared = consumeWrite(confirmToken, {
    userName: session.userName,
    clientId: authInfo!.clientId,
    operation: 'update_metadata',
    payloadHash: hashPayload(payload),
  });

  return withAudit(
    {
      operation: 'update_metadata',
      userName: session.userName,
      clientId: authInfo!.clientId,
      targetId: payload.objId,
      // Names only. The values are the user's data, not ours to copy into a log.
      fieldNames: Object.keys(payload.indexFields),
    },
    async () => {
      const { result, replayed } = await onceOnly(session.userName, idempotencyKey, async () => {
        const current = await assertUnchanged(client, payload.objId, prepared.baseline!);
        return updateMetadata(client, current, payload.indexFields);
      });
      return { value: { ...result, replayed }, resultObjId: result.objId, replayed };
    },
  );
}
