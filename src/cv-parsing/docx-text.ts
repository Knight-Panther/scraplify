import mammoth from 'mammoth';

/**
 * Plain text from a .docx, shared by the operator flow (`read-document.ts`)
 * and the browser CV worker (`web/lib/cv-ranked/extract-text.ts`).
 *
 * Not `mammoth.extractRawText`: that keeps only text, tabs and paragraph
 * ends, so a manual line break (`<w:br/>`) vanishes and the words either side
 * of it run together. CVs lean on line breaks — "Title<br>Employer<br>Dates"
 * inside one paragraph or table cell is the common layout — and a real
 * Georgian CV lost every job title that way ("SME ბიზნეს მრჩეველიBank of
 * Georgia"). Going through mammoth's HTML keeps each break, table cell and
 * block as whitespace instead.
 *
 * Images are replaced with an empty `src` so no image is ever base64-encoded
 * (the text is all that is wanted, and a large photo would only cost time).
 */

const ENTITIES: Record<string, string> = { lt: '<', gt: '>', quot: '"', '#39': "'", amp: '&' };

export function docxHtmlToText(html: string): string {
  return html
    .replace(/<br\s*\/?>/g, '\n')
    .replace(/<\/td>/g, '\t')
    .replace(/<\/(p|h[1-6]|li|tr|table|ul|ol|dl|dt|dd)>/g, '\n\n')
    .replace(/<[^>]*>/g, '')
    .replace(/&(lt|gt|quot|#39|amp);/g, (_, name: string) => ENTITIES[name] ?? '');
}

export async function docxText(
  input: { buffer: Buffer } | { arrayBuffer: ArrayBuffer },
): Promise<string> {
  const { value } = await mammoth.convertToHtml(input, {
    styleMap: ["br[type='page'] => br", "br[type='column'] => br"],
    convertImage: mammoth.images.imgElement(async () => ({ src: '' })),
  });
  return docxHtmlToText(value);
}
