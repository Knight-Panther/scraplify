// pdfjs-dist ships no typings for its worker entry. Only its presence
// matters here: `extract-text.ts` hands the module to PDF.js's own
// fake-worker hook, which reads `WorkerMessageHandler` off it.
declare module 'pdfjs-dist/build/pdf.worker.mjs' {
  export const WorkerMessageHandler: unknown;
}
