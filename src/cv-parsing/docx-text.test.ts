import { readFile } from 'node:fs/promises';
import { describe, expect, it } from 'vitest';
import { docxHtmlToText, docxText } from './docx-text.js';

describe('docxText', () => {
  it('keeps manual line breaks and table cells apart', async () => {
    // One paragraph "SME ბიზნეს მრჩეველი<br>Bank of Georgia<br>2021 – present",
    // then a two-cell table. mammoth.extractRawText ran all three lines together.
    const buffer = await readFile(new URL('./fixtures/line-breaks-cv.docx', import.meta.url));
    const text = await docxText({ buffer });
    expect(text).toContain('SME ბიზნეს მრჩეველი\nBank of Georgia\n2021 – present');
    expect(text).toMatch(/Credit analyst\s+TBC Bank/);
    expect(text).toContain('Skills & tools');
    expect(text).not.toContain('მრჩეველიBank');
  });
});

describe('docxHtmlToText', () => {
  it('drops tags and images and decodes the entities mammoth emits', () => {
    expect(
      docxHtmlToText('<p>A &amp; B &lt;C&gt; &quot;D&quot; &#39;E&#39;<img src="" /></p>'),
    ).toBe(`A & B <C> "D" 'E'\n\n`);
  });
});
