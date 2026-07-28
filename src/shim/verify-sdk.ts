/**
 * Verification script: runs the REAL @anthropic-ai/claude-agent-sdk query()
 * against the local Copilot-backed shim (no ANTHROPIC_API_KEY involved).
 *
 *   npx tsx src/shim/verify-sdk.ts
 */
process.env.ANTHROPIC_BASE_URL = process.env.ANTHROPIC_BASE_URL ?? 'http://127.0.0.1:8787';
process.env.ANTHROPIC_AUTH_TOKEN = 'dummy';
delete process.env.ANTHROPIC_API_KEY;

const { query } = await import('@anthropic-ai/claude-agent-sdk');

console.log('BASE_URL =', process.env.ANTHROPIC_BASE_URL);

const q = query({
  prompt: 'Reply with exactly the word: SDKOK',
  options: {
    model: 'claude-sonnet-4-5-20250929',
    maxTurns: 1,
    permissionMode: 'bypassPermissions',
    allowedTools: [],
  },
});

try {
  for await (const message of q) {
    console.log('--- message ---');
    console.log(JSON.stringify(message, null, 2).slice(0, 2000));
  }
  console.log('=== SDK STREAM COMPLETED ===');
} catch (e) {
  console.error('=== SDK ERROR ===');
  console.error(e);
  process.exitCode = 1;
}
