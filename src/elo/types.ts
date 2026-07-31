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
  id?: string;
  version?: string;
  comment?: string;
  contentType?: string;
  /** Uppercase file extension, e.g. "PDF", "DOCX", "ECF". */
  ext?: string;
  size?: number;
  md5?: string;
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
