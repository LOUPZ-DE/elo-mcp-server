// Minimal typings for the ELO IX REST API surface we touch.
// These are intentionally narrow — only the fields we read.

export interface EloObjKey {
  name: string;
  data?: string[];
}

export interface EloRefPathItem {
  id?: string;
  name: string;
  guid?: string;
}

// ELO IX wraps each reference path in an object with the actual path items
// under `.path` and a pre-joined `pathAsString` (separator: pilcrow ¶).
export interface EloRefPathInfo {
  path: EloRefPathItem[];
  pathAsString?: string;
}

export interface EloSord {
  id: string;
  guid?: string;
  name: string;
  type: number;
  maskName?: string;
  ownerName?: string;
  IDateIso?: string;
  // IX spells the change date `XDateIso` with a capital X (verified in
  // scripts/probe-ix.ts). The lowercase variant is kept because earlier code
  // read it and other IX versions may differ — always read both.
  XDateIso?: string;
  xDateIso?: string;
  objKeys?: EloObjKey[];
  refPaths?: EloRefPathInfo[];
  // Verified present with `sordZ: {bset:'-1'}` (scripts/probe-ix.ts, P1).
  // NOTE: IX serialises `parentId` as a JSON *number*, unlike `id` which comes
  // back as a string. Always normalise with String() before comparing.
  parentId?: string | number;
  parentIds?: Array<string | number>;
  /** Number of direct children. 0 on documents and on empty folders. */
  childCount?: number;
  /**
   * ELO's history counter for this object. On a document with two versions it
   * reads 2 — the only hint the REST API gives that earlier versions exist,
   * since nothing here can enumerate them (issue #15).
   */
  histCount?: number;
  /** docId of the working version, matching `document.docs[0].id`. */
  doc?: number;
  /** "Extra text" / description field of the mask. */
  desc?: string;
  deleted?: boolean;
}

export interface EloFileStream {
  url?: string;
  size?: number;
}

export interface EloFileData {
  // Probed against the Loupz instance: absent there — content must be fetched
  // from `stream.url` (scripts/probe-ix.ts, P10). Declared because IX can
  // inline the bytes as base64 on other configurations.
  data?: string;
  stream?: EloFileStream;
}

export interface EloDocVersion {
  /**
   * The document-version id, and the only usable version identifier here.
   *
   * IX returns it as a JSON *number*, and it is what `checkoutDoc`'s `docId`
   * selects on. Note it is archive-global, not scoped to the object — see the
   * guard in `elo_get_document_content`.
   */
  id?: string | number;
  /**
   * ELO's own version label. Measured empty on this instance for every version
   * of every document, which is why `id` carries the identity instead.
   */
  version?: string;
  comment?: string;
  contentType?: string;
  /** Uppercase file extension, e.g. "PDF", "DOCX", "ECF". */
  ext?: string;
  /** IX sends this as a string ("57"), the JavaDoc says int. Both turn up. */
  size?: number | string;
  md5?: string;
  guid?: string;
  /** When this version was checked in. */
  createDateIso?: string;
  /** When it last changed. */
  updateDateIso?: string;
  accessDateIso?: string;
  ownerName?: string;
  ownerId?: number;
  /** True for the version ELO serves by default. */
  workVersion?: boolean;
  milestone?: boolean;
  deleted?: boolean;
  /**
   * Absolute IX URL — but in practice it points at the *internal* host
   * (`<internal-host>:9090`), which is unreachable from the container.
   * Always run it through `resolveStreamUrl()` before use. See BUGFIXES #10.
   */
  url?: string;
  previewUrl?: string;
  fileData?: EloFileData;
}

export interface EloDocument {
  docs?: EloDocVersion[];
  /**
   * Present on the checkin path — `checkinDocEnd` answers with the objId of the
   * stored object, which is the only place a brand-new document's id appears.
   * Absent on the read path, where `checkoutDoc` already knows what was asked
   * for. Both per the live OpenAPI document (Indexserver 23.0.0.0).
   */
  objId?: string;
  /** Attachments. Declared for completeness; the write MVP does not use them. */
  atts?: EloDocVersion[];
}

export interface EloEditInfo {
  sord?: EloSord;
  document?: EloDocument;
}

export interface EloFindResult {
  sords?: EloSord[];
  /** Verified populated (probe P7) — true when IX has more hits than `max`. */
  moreResults?: boolean;
  /** Number of sords in this response. */
  count?: number;
  /** IX's estimate of the total hit count; -1 when unknown. */
  estimatedCount?: number;
  /** Server-side search handle; must be released with `findClose` (probe P8). */
  searchId?: string;
}

export interface EloLoginClientInfo {
  language: string;
  country: string;
  timeZone: string;
}

export interface EloLoginResult {
  clientInfo?: unknown;
  user?: unknown;
  ticketLifetime?: number;
}

export interface EloResponse<T> {
  result?: T;
  exception?: { name?: string; message?: string };
}

export type FindResponse = EloResponse<EloFindResult>;
export type CheckoutResponse = EloResponse<EloEditInfo>;
export type LoginResponse = EloResponse<EloLoginResult>;

/**
 * `checkoutUser` returns the UserInfo directly under `result` — not wrapped in
 * a `userInfo` field (verified in scripts/probe-ix.ts). Only the fields we read
 * are declared; `flags` is deliberately absent because it holds directly
 * assigned rights only and is not usable on its own (BUGFIXES #20).
 */
export interface EloUserInfo {
  id?: string;
  name?: string;
  guid?: string;
  /** Free-text description on the account; often the person's full name. */
  desc?: string;
}

export type CheckoutUserResponse = EloResponse<EloUserInfo>;

/**
 * `createSord` hands back an EditInfo carrying a *template* sord — nothing is
 * persisted until `checkinSord` is called with it. `checkinSord` answers with
 * the objId of the stored object as a bare number.
 *
 * Both signatures were read from the live instance's OpenAPI document
 * (Indexserver 23.0.0.0, GET /rest/openapi.json), not from the JavaDoc.
 */
export type CreateSordResponse = EloResponse<EloEditInfo>;
export type CheckinSordResponse = EloResponse<number>;

/**
 * `checkinDocBegin` returns a Document whose `docs[0].url` is where the bytes
 * go; the string that upload answers with belongs in `docs[0].uploadResult`
 * before `checkinDocEnd` is called. Both signatures read from the live
 * OpenAPI document (Indexserver 23.0.0.0).
 */
export type CheckinDocResponse = EloResponse<EloDocument>;
