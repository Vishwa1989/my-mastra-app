import { createTool } from '@mastra/core/tools';
import { z } from 'zod';
import { Pool } from 'pg';
import OpenAI from 'openai';

const connectionString = process.env.SUPABASE_CONNECTION_STRING!;
const openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });

// Reuse pool across invocations
const pool = new Pool({
  connectionString,
  ssl: { rejectUnauthorized: false },
  max: 3,
});

export const gbrainSearchTool = createTool({
  id: 'gbrain-search',
  description: `Search the Gentleborn team knowledge base (gbrain).
Use this whenever asked about:
- Past decisions and why they were made
- Meeting outcomes, next steps, open questions
- Architecture choices and rationale (e.g. why Stedi, why Supabase, why a given pattern)
- Project context — payer model, provider types, HIPAA constraints
- What the team agreed on, what was tried and failed
- Design docs, learnings, TODOs

Always call this before answering questions about project history, architecture, or decisions.`,
  inputSchema: z.object({
    query: z.string().describe('Natural language question or topic to search for'),
    limit: z.number().optional().default(5),
  }),
  execute: async ({ query, limit }: { query: string; limit?: number }) => {
    // 1. Embed the query using the same model as the stored chunks
    const embeddingRes = await openai.embeddings.create({
      model: 'text-embedding-3-large',
      input: query,
      dimensions: 1536,
    });
    const queryVector = embeddingRes.data[0].embedding;

    // 2. Cosine similarity search against content_chunks via pgvector
    const vectorLiteral = `[${queryVector.join(',')}]`;
    const { rows } = await pool.query<{ chunk_text: string; slug: string; distance: number }>(
      `SELECT
         cc.chunk_text,
         p.slug,
         cc.embedding <=> $1::vector AS distance
       FROM content_chunks cc
       JOIN pages p ON p.id = cc.page_id
       WHERE cc.embedding IS NOT NULL
       ORDER BY cc.embedding <=> $1::vector
       LIMIT $2`,
      [vectorLiteral, limit ?? 5],
    );

    if (!rows.length) {
      return { results: 'No relevant knowledge found in gbrain.' };
    }

    const formatted = rows
      .map((r: { chunk_text: string; slug: string; distance: number }, i: number) =>
        `[${i + 1}] source: ${r.slug}\n${r.chunk_text}`
      )
      .join('\n\n---\n\n');

    return { results: formatted };
  },
});
