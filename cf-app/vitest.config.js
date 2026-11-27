import { defineConfig } from 'vitest/config';
import { cloudflareTest } from '@cloudflare/vitest-plugin';
import { fileURLToPath } from 'node:url';

const here = p => fileURLToPath(new URL(p, import.meta.url));

export default defineConfig({
  plugins: [cloudflareTest({ wrangler: { configPath: './test/wrangler.test.jsonc' } })],
  // What wrangler.jsonc "alias" does for a deploy: ../mcp/src and this Worker share one MCP SDK and zod.
  resolve: {
    alias: [
      { find: /^@modelcontextprotocol\/sdk\/(.*)$/, replacement: here('./node_modules/@modelcontextprotocol/sdk/dist/esm/$1') },
      { find: /^zod$/, replacement: here('./node_modules/zod/index.js') },
    ],
  },
  test: { include: ['test/**/*.worker.test.js'] },
});
