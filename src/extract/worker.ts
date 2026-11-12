/**
 * Worker-thread entry point for text extraction — see `isolated.ts` for why it
 * exists. Receives one document through `workerData`, posts exactly one
 * message back, and is terminated by the parent.
 */
import { parentPort, workerData } from 'node:worker_threads';
import { extractText } from './index.js';

interface Job {
  data: Uint8Array;
  contentType?: string;
  ext?: string;
  fileName?: string;
}

const job = workerData as Job;

try {
  const result = await extractText({
    ...job,
    // Structured clone delivers a plain Uint8Array; the extractors use Buffer
    // methods. Same memory, no copy.
    data: Buffer.from(job.data.buffer, job.data.byteOffset, job.data.byteLength),
  });
  parentPort!.postMessage({ ok: true, result });
} catch (err) {
  // Error classes do not survive the thread boundary; their `code` does, and
  // the parent rebuilds the class from it.
  parentPort!.postMessage({
    ok: false,
    code: (err as { code?: unknown }).code,
    message: err instanceof Error ? err.message : String(err),
  });
}
