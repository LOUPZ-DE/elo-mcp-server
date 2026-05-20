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
  xDateIso?: string;
  objKeys?: EloObjKey[];
  refPaths?: EloRefPathInfo[];
}

export interface EloFileStream {
  url?: string;
}

export interface EloFileData {
  stream?: EloFileStream;
}

export interface EloDocVersion {
  version?: string;
  comment?: string;
  contentType?: string;
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
  moreResults?: boolean;
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
