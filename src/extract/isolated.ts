import { Worker } from 'node:worker_threads';
import { EncryptedDocumentError, ExtractionFailedError } from './types.js';
import type { ExtractInput, ExtractResult } from './types.js';

/**
 * Text extraction in a worker thread, one worker per document.
 *
 * Why: Node serves every request from one thread, and the parsers hold it.
 * Measured with a generated 750-page table PDF — the shape of the BKI
 * catalogue — a second client's request waited 1.3 s of a 1.6 s parse, and
 * 6.5 s of a 7.7 s one at 3 000 pages. On the server the real catalogue parses
 * in 17 s, and for those 17 s every other user's search, listing and
 * tools/list stood still. ELO_CONTENT_CONCURRENCY cannot help with that; it
 * only decides how many parses queue. In a worker the same 750 pages leave the
 * main thread stalled for 30 ms at most.
 *
 * It also makes a time limit possible that actually stops a parse:
 * `terminate()` interrupts running JavaScript, which an in-process parse
 * offers no way to do.
 *
 * Deliberately **no heap limit** (`resourceLimits`). Measured on the 3 000-page
 * PDF, which needs roughly 150–190 MB: limits of 32–96 MB ended the worker
 * cleanly, but 128 MB aborted the *whole process*. Node gives a worker that
 * reaches its limit about 16 MB of leeway to wind down, and a limit that is
 * crossed during one large allocation — joining or normalising a text of
 * millions of characters — blows straight through it. A ceiling that sometimes
 * takes the server with it is worse than none. Without one, a worker gets the
 * same heap limit as the main thread, so memory behaves exactly as it did
 * before. A dependable memory ceiling needs a child process instead.
 *
 * One worker per document rather than a pool: a terminated worker returns its
 * whole heap, where a pooled one would keep what a 60 MB PDF made it grow to.
 * Starting one costs about 30 ms after a build (measured), next to an IX
 * checkout that takes over half a second on its own.
 */

/** Long enough for the 747-page catalogue (17 s on the server), with room. */
export const DEFAULT_EXTRACT_TIMEOUT_MS = 60_000;

/** The parse was stopped because it ran past its time limit. */
export class ExtractionTimeoutError extends ExtractionFailedError {}

// Under tsx the sources run as .ts, after a build as .js; the worker has to be
// started from whichever file exists.
const WORKER_URL = new URL(
  import.meta.url.endsWith('.ts') ? './worker.ts' : './worker.js',
  import.meta.url,
);

/**
 * Same contract as `extractText`, run in its own thread.
 *
 * Takes ownership of `input.data` when the Buffer owns its memory: the bytes
 * are moved to the worker, not copied, and the caller's Buffer is empty
 * afterwards. Read anything you need from it — its length, say — beforehand.
 */
export function extractTextIsolated(
  input: ExtractInput,
  timeoutMs: number = DEFAULT_EXTRACT_TIMEOUT_MS,
): Promise<ExtractResult> {
  const { data, ...rest } = input;
  // A downloaded document owns its ArrayBuffer and is moved as is. Small
  // Buffers are slices of a pool shared with unrelated Buffers; moving that
  // would detach all of them, so those get an exact copy, which is moved.
  const owned = data.byteOffset === 0 && data.byteLength === data.buffer.byteLength;
  const bytes = owned ? new Uint8Array(data.buffer) : new Uint8Array(data);

  const worker = new Worker(WORKER_URL, {
    workerData: { ...rest, data: bytes },
    transferList: [bytes.buffer as ArrayBuffer],
  });

  return new Promise<ExtractResult>((resolve, reject) => {
    let settled = false;
    const settle = (outcome: () => void): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      outcome();
      // Whatever happened, the worker and its heap go now.
      void worker.terminate();
    };

    const timer = setTimeout(
      () =>
        settle(() =>
          reject(
            new ExtractionTimeoutError(
              `Reading the text took longer than ${Math.round(timeoutMs / 1000)} s and was stopped. ` +
                'The document is too large or too complex to read here; open the eloLink to view it.',
            ),
          ),
        ),
      timeoutMs,
    );

    worker.once('message', (msg: WorkerReply) =>
      settle(() => (msg.ok ? resolve(msg.result) : reject(rebuildError(msg)))),
    );
    worker.once('error', (err: Error) =>
      settle(() =>
        reject(new ExtractionFailedError(`Text extraction failed: ${err.message.slice(0, 200)}`)),
      ),
    );
    worker.once('exit', (code) =>
      settle(() =>
        reject(new ExtractionFailedError(`Text extraction stopped unexpectedly (exit code ${code}).`)),
      ),
    );
  });
}

type WorkerReply =
  | { ok: true; result: ExtractResult }
  | { ok: false; code?: unknown; message: string };

function rebuildError(msg: Extract<WorkerReply, { ok: false }>): Error {
  if (msg.code === 'DOCUMENT_ENCRYPTED') return new EncryptedDocumentError(msg.message);
  if (msg.code === 'EXTRACTION_FAILED') return new ExtractionFailedError(msg.message);
  return new Error(msg.message);
}
