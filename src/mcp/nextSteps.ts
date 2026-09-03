import type { SordView } from '../elo/sord.js';
import type { SearchResult } from '../tools/elo_search.js';
import type { FindProjectFolderResult } from '../tools/elo_find_project_folder.js';
import type { ListFolderResult } from '../tools/elo_list_folder.js';
import type { DocumentContent } from '../tools/elo_get_document_content.js';
import type { DocumentMetadata } from '../tools/elo_get_metadata.js';
import type { WhoAmIResult } from '../tools/elo_whoami.js';

// Layer 3 of the self-description: what to do next, given what just came back.
//
// Pure functions over a tool's own result, so the conditional logic — which is
// the whole point — is unit-testable without a server. Each returns [] when
// nothing useful applies; `respond` then omits the field entirely rather than
// padding every answer with advice.
//
// The house rule for everything below: name the tool and fill in the arguments.
// A step the model has to reconstruct is a step it will get wrong.

const first = <T>(xs: T[] | undefined): T | undefined => xs?.[0];
const firstOfType = (results: SordView[] | undefined, type: 'document' | 'folder') =>
  results?.find((r) => r.type === type);

export function nextStepsForProjectFolder(result: FindProjectFolderResult): string[] {
  // One exact hit is the only case where picking a project is safe. With
  // several, the instructions say to ask rather than choose — so the follow-up
  // has to be "ask", not another tool call.
  if (result.matchMode === 'exact' && result.exactCount === 1) {
    const folder = first(result.results);
    if (!folder) return [];
    return [
      `elo_list_folder with {"folderId":"${folder.objId}"} to see what is filed in this project`,
      `elo_search with {"query":"<term>","parentId":"${folder.objId}"} to search inside it instead of archive-wide`,
    ];
  }
  if (result.results.length > 1) {
    return [
      `${result.results.length} folders matched — ask the user which project is meant instead of picking one`,
    ];
  }
  if (result.results.length === 0) {
    return [`elo_search with {"query":"${result.query}"} to look archive-wide instead`];
  }
  // A single fuzzy hit: usable, but say so rather than treating it as certain.
  const folder = first(result.results);
  return folder
    ? [
        `elo_list_folder with {"folderId":"${folder.objId}"} — note this was a fuzzy match, so confirm the path before citing it`,
      ]
    : [];
}

export function nextStepsForListFolder(result: ListFolderResult): string[] {
  const steps: string[] = [];
  if (result.truncated) {
    steps.push(
      `elo_list_folder with {"folderId":"${result.folderId}","offset":${result.offset + result.returned}} to continue — this listing is incomplete`,
    );
  }
  const doc = firstOfType(result.results, 'document');
  if (doc) {
    steps.push(`elo_get_document_content with {"objId":"${doc.objId}"} to read "${doc.name}"`);
  }
  const folder = firstOfType(result.results, 'folder');
  // Only suggest descending when there is nothing to read here — otherwise the
  // reading step is the more useful one and two hints dilute each other.
  if (folder && !doc) {
    steps.push(`elo_list_folder with {"folderId":"${folder.objId}"} to look inside "${folder.name}"`);
  }
  return steps;
}

export function nextStepsForSearch(result: SearchResult): string[] {
  const steps: string[] = [];
  if (result.truncated) {
    steps.push(
      `elo_search with {"query":"${result.query}","offset":${result.offset + result.returned}} to continue — this result is incomplete`,
    );
  }
  // The scoping advice only makes sense while the search is still archive-wide.
  if (!result.scope && result.results.length > 0) {
    steps.push(
      'elo_find_project_folder first, then repeat this search with its objId as parentId, if the question was about one project',
    );
  }
  const doc = firstOfType(result.results, 'document');
  if (doc) {
    steps.push(`elo_get_document_content with {"objId":"${doc.objId}"} to read "${doc.name}"`);
  }
  return steps;
}

export function nextStepsForDocumentContent(result: DocumentContent): string[] {
  if (result.truncated && result.nextOffset !== undefined) {
    return [
      `elo_get_document_content with {"objId":"${result.objId}","offset":${result.nextOffset}} to read on — this is not the whole document`,
    ];
  }
  // A scanned page has no text to page through; a link is the only useful thing
  // left to hand the user.
  if (result.textLayer === 'none') {
    return [
      `elo_get_document_link with {"objId":"${result.objId}"} — there is no text layer, so give the user the link instead of guessing at the content`,
    ];
  }
  return [];
}

export function nextStepsForMetadata(result: DocumentMetadata): string[] {
  return result.type === 'document'
    ? [`elo_get_document_content with {"objId":"${result.objId}"} to read what is inside it`]
    : [`elo_list_folder with {"folderId":"${result.objId}"} to see what is filed in it`];
}

export function nextStepsForWhoAmI(result: WhoAmIResult): string[] {
  // Only worth saying when signing in would actually change something.
  if (result.identity === 'service-account' && result.authMode === 'both') {
    return [
      'this connection uses the shared API key and the technical account — reconnect with "Sign in with OAuth" to work under your own ELO permissions',
    ];
  }
  return [];
}
