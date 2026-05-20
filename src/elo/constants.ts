// ELO IX Sord type boundaries (see SordC in the ELO IX JavaDoc).
// Sord.type < LBT_DOCUMENT  → folder/structure
// Sord.type >= LBT_DOCUMENT → document
export const LBT_DOCUMENT = 254;

export function isFolder(sordType: number): boolean {
  return sordType < LBT_DOCUMENT;
}

// LockZ.NO equivalent — passed as `lockZ` when we only want to read.
export const LOCK_Z_NO = { bset: '0' } as const;

// SordC/EditInfoC/DocVersionC member-set selectors. ELO IX expects these as
// objects with a `bset` field whose value is a stringified bitmask of the
// corresponding Java SordC/EditInfoC/DocVersionC constants. Named constants
// like "mb_all" are NOT accepted — Jackson fails to parse them, which causes
// a clean HTTP 400 with an empty response body.
// "-1" sets all bits → return every member. Slightly wasteful but resilient.
//
// EditInfoZ additionally requires a NESTED sordZ to actually populate the
// sord.objKeys array. Without it, the sord comes back without index fields,
// even with mb_all set on the EditInfo bitmask.
export const SORD_Z_ALL = { bset: '-1' } as const;
export const EDIT_INFO_Z_ALL = {
  bset: '-1',
  sordZ: { bset: '-1' },
} as const;
export const DOC_VERSION_Z_ALL = { bset: '-1' } as const;
