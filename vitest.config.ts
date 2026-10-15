import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    include: ['test/*.test.ts'],
    env: {
      NODE_ENV: 'test',
      LOG_LEVEL: "silent",
      SUPABASE_URL: 'http://localhost:54321',
      SUPABASE_SERVICE_ROLE_KEY: 'test-service-key',
      DEVICE_JWT_SECRET: 'test-secret-test-secret-test-secret-12345',
    },
  },
});
