/**
 * Server-side PDF text extractor, backed by `pdf-parse`.
 *
 * Wired in `src/instrumentation.ts` so it activates automatically. With
 * this registered, `/api/learn/pdf` extracts text from uploaded PDFs even
 * when the client did not supply `raw_text`.
 */

import { PdfExtractionError, type PdfExtractor } from './pdf';

interface PdfParseResult {
  text?: string;
}

export const pdfParseExtractor: PdfExtractor = {
  name: 'pdf-parse',

  async extract(data: Buffer, preExtracted?: string): Promise<string> {
    if (preExtracted && preExtracted.trim().length > 0) return preExtracted;
    if (!data || data.length === 0) {
      throw new PdfExtractionError(
        'No PDF data and no pre-extracted text supplied.'
      );
    }
    // Dynamic import keeps `pdf-parse` out of the client bundle.
    const mod = (await import('pdf-parse')) as
      | { default?: (buf: Buffer) => Promise<PdfParseResult> }
      | ((buf: Buffer) => Promise<PdfParseResult>);
    const parse =
      typeof mod === 'function'
        ? mod
        : (mod.default as (buf: Buffer) => Promise<PdfParseResult>);
    const result = await parse(data);
    const text = result?.text?.trim();
    if (!text) {
      throw new PdfExtractionError(
        'PDF parsed but no extractable text was found (likely a scanned/image PDF).'
      );
    }
    return text;
  },
};
