import { defineConfig, devices } from '@playwright/test';

export default defineConfig({
  testDir: './tests/e2e',
  testMatch: '**/*.test.mjs',
  fullyParallel: false,
  workers: 1,
  reporter: 'list',
  use: { baseURL: 'http://127.0.0.1:8123', trace: 'off' },
  projects: [
    {
      name: 'chromium-phone',
      use: { ...devices['Desktop Chrome'], viewport: { width: 390, height: 844 } },
    },
  ],
  webServer: {
    command: 'node tests/helpers/server.mjs 8123',
    url: 'http://127.0.0.1:8123/index.html',
    reuseExistingServer: true,
    timeout: 20000,
  },
});
