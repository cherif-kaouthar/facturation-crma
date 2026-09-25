import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    environment: 'node',
    include: ['**/*.test.{js,ts,tsx}'],
    exclude: ['node_modules', 'dist', 'release'],
  },
});
