import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { ReadDocumentResult } from './read-document.js';

const createMock = vi.fn();
const loggerInfoMock = vi.fn();

vi.mock('@anthropic-ai/sdk', () => ({
  default: vi.fn().mockImplementation(function AnthropicMock() {
    return { messages: { create: createMock } };
  }),
}));

vi.mock('../logger.js', () => ({
  logger: { info: loggerInfoMock },
}));

const { extractClaims, CvExtractionFailedError } = await import('./extract-claims.js');

function toolUseResponse(input: unknown) {
  return {
    content: [{ type: 'tool_use', id: 'tu_1', name: 'record_candidate_claims', input }],
  };
}

const PDF_DOC: ReadDocumentResult = { kind: 'pdf', base64: 'JVBERi0xLjQK' };
const TEXT_DOC: ReadDocumentResult = {
  kind: 'text',
  text: 'Jane Doe. Software Engineer. Skilled in TypeScript.',
};

beforeEach(() => {
  createMock.mockReset();
  loggerInfoMock.mockReset();
});

describe('extractClaims', () => {
  it('maps a valid tool_use response into ClaimInput[] with origin "parsed"', async () => {
    createMock.mockResolvedValue(
      toolUseResponse({
        claims: [
          { kind: 'skill', value: 'TypeScript', evidence: 'Skilled in TypeScript.' },
          {
            kind: 'role',
            value: 'Software Engineer',
            evidence: 'Software Engineer.',
            years: 5,
            confidence: 0.9,
          },
        ],
      }),
    );

    const claims = await extractClaims(TEXT_DOC);

    expect(claims).toEqual([
      { kind: 'skill', value: 'TypeScript', evidence: 'Skilled in TypeScript.', origin: 'parsed' },
      {
        kind: 'role',
        value: 'Software Engineer',
        evidence: 'Software Engineer.',
        origin: 'parsed',
        years: 5,
        confidence: 0.9,
      },
    ]);
  });

  it('sends a document content block for a PDF', async () => {
    createMock.mockResolvedValue(toolUseResponse({ claims: [] }));

    await extractClaims(PDF_DOC);

    const call = createMock.mock.calls.at(0)?.[0];
    expect(call.model).toBe('claude-opus-5');
    expect(call.messages[0].content[0]).toEqual({
      type: 'document',
      source: { type: 'base64', media_type: 'application/pdf', data: PDF_DOC.base64 },
    });
  });

  it('sends a text content block for a DOCX-extracted text', async () => {
    createMock.mockResolvedValue(toolUseResponse({ claims: [] }));

    await extractClaims(TEXT_DOC);

    const call = createMock.mock.calls.at(0)?.[0];
    expect(call.messages[0].content[0]).toEqual({ type: 'text', text: TEXT_DOC.text });
  });

  it('throws CvExtractionFailedError when the response has no tool_use block', async () => {
    createMock.mockResolvedValue({ content: [{ type: 'text', text: 'I could not find a tool.' }] });

    await expect(extractClaims(TEXT_DOC)).rejects.toBeInstanceOf(CvExtractionFailedError);
  });

  it('throws CvExtractionFailedError when the tool input fails schema validation', async () => {
    createMock.mockResolvedValue(
      toolUseResponse({ claims: [{ kind: 'not_a_real_kind', value: 'x', evidence: 'y' }] }),
    );

    await expect(extractClaims(TEXT_DOC)).rejects.toBeInstanceOf(CvExtractionFailedError);
  });

  it('collapses an SDK failure into a generic error with no upstream text', async () => {
    createMock.mockRejectedValue(new Error('upstream said: quoted CV text here'));

    let caught: unknown;
    try {
      await extractClaims(TEXT_DOC);
    } catch (error) {
      caught = error;
    }

    expect(caught).toBeInstanceOf(CvExtractionFailedError);
    expect((caught as Error).message).not.toContain('quoted CV text here');
  });

  it('never logs CV content — only claim count and duration', async () => {
    createMock.mockResolvedValue(
      toolUseResponse({
        claims: [{ kind: 'skill', value: 'TypeScript', evidence: 'Skilled in TypeScript.' }],
      }),
    );

    await extractClaims(TEXT_DOC);

    expect(loggerInfoMock).toHaveBeenCalledTimes(1);
    const fields = loggerInfoMock.mock.calls.at(0)?.[0];
    expect(Object.keys(fields).sort()).toEqual(['claimCount', 'durationMs']);
  });
});
