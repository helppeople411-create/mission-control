/**
 * Next.js instrumentation hook — wires the three pluggable LLM seams at
 * server startup. The seam impls themselves no-op when their env config
 * is missing, so registering them is always safe.
 *
 * Registered seams:
 *   - Council reasoner       → src/lib/council/reasoner-llm.ts
 *   - Knowledge digester     → src/lib/skills/digester-llm.ts
 *   - PDF text extractor     → src/lib/skills/pdf-real.ts
 *
 * Edge runtime is skipped — native fetch + `pdf-parse` need Node.
 */

export async function register(): Promise<void> {
  if (process.env.NEXT_RUNTIME !== 'nodejs') return;

  const [
    { setCouncilReasoner },
    { llmReasoner },
    { setKnowledgeDigester },
    { llmDigester },
    { setPdfExtractor },
    { pdfParseExtractor },
    { logger },
  ] = await Promise.all([
    import('./lib/council/reasoner'),
    import('./lib/council/reasoner-llm'),
    import('./lib/skills/digester'),
    import('./lib/skills/digester-llm'),
    import('./lib/skills/pdf'),
    import('./lib/skills/pdf-real'),
    import('./lib/logger'),
  ]);

  setCouncilReasoner(llmReasoner);
  setKnowledgeDigester(llmDigester);
  setPdfExtractor(pdfParseExtractor);

  logger.info(
    {
      reasoner: 'litellm',
      digester: 'litellm',
      pdfExtractor: 'pdf-parse',
      litellmConfigured: !!process.env.LITELLM_API_KEY,
    },
    'LLM seams registered'
  );
}
