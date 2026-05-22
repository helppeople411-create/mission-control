/**
 * Skill Engine — PDF text extraction.
 *
 * The repo ships no PDF dependency, so extraction is pluggable. The default
 * extractor handles text that was already extracted client-side, and will
 * opportunistically use an optional `pdf-parse` module if one is installed.
 *
 * To guarantee server-side extraction, install a parser and register an
 * extractor with `setPdfExtractor()`.
 */

export interface PdfExtractor {
  readonly name: string;
  /**
   * @param data   Raw PDF bytes (may be empty if preExtracted is supplied).
   * @param preExtracted  Text already extracted upstream, if any.
   */
  extract(
    data: Buffer,
    preExtracted?: string
  ): Promise<string> | string;
}

let activeExtractor: PdfExtractor | null = null;

export function setPdfExtractor(extractor: PdfExtractor): void {
  activeExtractor = extractor;
}

export function getPdfExtractor(): PdfExtractor {
  return activeExtractor ?? defaultPdfExtractor;
}

export class PdfExtractionError extends Error {}

export const defaultPdfExtractor: PdfExtractor = {
  name: 'default',

  async extract(data: Buffer, preExtracted?: string): Promise<string> {
    // Prefer text the caller already extracted.
    if (preExtracted && preExtracted.trim().length > 0) {
      return preExtracted;
    }
    // Opportunistically use pdf-parse if it happens to be installed.
    if (data && data.length > 0) {
      try {
        // Optional dependency — not in package.json by default. The module
        // specifier is kept non-literal so the build does not require it.
        const optionalParser = 'pdf-parse';
        const mod: any = await import(optionalParser);
        const parse = mod.default ?? mod;
        const result = await parse(data);
        if (result?.text) return result.text as string;
      } catch {
        // pdf-parse not available — fall through to the clear error below.
      }
    }
    throw new PdfExtractionError(
      'No PDF text could be extracted. Supply pre-extracted text in ' +
        '`raw_text`, or install a PDF parser and register one with ' +
        'setPdfExtractor().'
    );
  },
};
