import Anthropic from '@anthropic-ai/sdk';
import { z } from 'zod';
import { CandidateClaimKind } from '../domain/candidate.js';
import { logger } from '../logger.js';
import type { ClaimInput } from '../ranking/profile-store.js';
import type { ReadDocumentResult } from './read-document.js';

/**
 * The one function that turns a read CV (`read-document.ts`) into draft
 * claims (§17.1), by asking Claude to extract them into a fixed schema.
 *
 * §21.1 and §23.2 both list CV content alongside credentials as data that
 * must never be logged — nothing here logs the CV text, the prompt, or the
 * raw API response, only a redacted `{claimCount, durationMs}` event. Any
 * SDK failure is collapsed into `CvExtractionFailedError` with no upstream
 * text, since an upstream error could itself echo the input back.
 */

export class CvExtractionFailedError extends Error {
  readonly code = 'CV_EXTRACTION_FAILED';
  constructor() {
    super('Could not extract profile information from this CV.');
    this.name = 'CvExtractionFailedError';
  }
}

const MODEL = 'claude-opus-5';
const TOOL_NAME = 'record_candidate_claims';

const ClaimKindList = CandidateClaimKind.options;

const extractionTool: Anthropic.Tool = {
  name: TOOL_NAME,
  description:
    'Record every claim about the candidate found in the attached CV, each tied to the exact text it came from.',
  input_schema: {
    type: 'object',
    properties: {
      claims: {
        type: 'array',
        items: {
          type: 'object',
          properties: {
            kind: { type: 'string', enum: ClaimKindList },
            value: {
              type: 'string',
              description: 'The claim itself, e.g. a skill name, a role title, a location.',
            },
            evidence: {
              type: 'string',
              description: 'The exact quoted span from the CV this claim was drawn from.',
            },
            years: {
              type: 'number',
              description: 'Years of experience, only for a role claim that states a duration.',
            },
            confidence: {
              type: 'number',
              description: 'How directly the CV supports this claim, from 0 to 1.',
            },
          },
          required: ['kind', 'value', 'evidence'],
          additionalProperties: false,
        },
      },
    },
    required: ['claims'],
    additionalProperties: false,
  },
  strict: true,
};

const ExtractedClaimSchema = z.object({
  kind: CandidateClaimKind,
  value: z.string().min(1),
  evidence: z.string().min(1),
  years: z.number().nonnegative().optional(),
  confidence: z.number().min(0).max(1).optional(),
});

const ExtractionResultSchema = z.object({
  claims: z.array(ExtractedClaimSchema),
});

const PROMPT = `Read the attached CV and record every claim it supports about the candidate, using the ${TOOL_NAME} tool.

Cover, where the CV supports them: roles and experience periods, skills, education, certifications, languages, location and work-mode preferences, salary and schedule constraints, and preferred or excluded professions/industries.

Every claim must carry an "evidence" field that is an exact, verbatim quote from the CV — never a paraphrase or a summary. If a claim cannot be tied to specific text in the document, do not record it. Do not infer or invent anything the CV does not actually support.`;

function buildContent(document: ReadDocumentResult): Anthropic.MessageParam['content'] {
  const documentBlock: Anthropic.ContentBlockParam =
    document.kind === 'pdf'
      ? {
          type: 'document',
          source: { type: 'base64', media_type: 'application/pdf', data: document.base64 },
        }
      : { type: 'text', text: document.text };
  return [documentBlock, { type: 'text', text: PROMPT }];
}

export async function extractClaims(document: ReadDocumentResult): Promise<ClaimInput[]> {
  const client = new Anthropic();
  const start = Date.now();

  let response: Anthropic.Message;
  try {
    response = await client.messages.create({
      model: MODEL,
      max_tokens: 16000,
      tool_choice: { type: 'tool', name: TOOL_NAME },
      tools: [extractionTool],
      messages: [{ role: 'user', content: buildContent(document) }],
    });
  } catch {
    throw new CvExtractionFailedError();
  }

  const toolUse = response.content.find(
    (block): block is Anthropic.ToolUseBlock => block.type === 'tool_use',
  );
  if (toolUse === undefined) throw new CvExtractionFailedError();

  const parsed = ExtractionResultSchema.safeParse(toolUse.input);
  if (!parsed.success) throw new CvExtractionFailedError();

  logger.info(
    { claimCount: parsed.data.claims.length, durationMs: Date.now() - start },
    'cv-parsing: extracted claims',
  );

  return parsed.data.claims.map(
    (claim): ClaimInput => ({
      kind: claim.kind,
      value: claim.value,
      evidence: claim.evidence,
      origin: 'parsed',
      ...(claim.years !== undefined ? { years: claim.years } : {}),
      ...(claim.confidence !== undefined ? { confidence: claim.confidence } : {}),
    }),
  );
}
