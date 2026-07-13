import { defineConfig, devices } from '@playwright/test';

export default defineConfig({
  testDir: 'e2e/',
  fullyParallel: true,
  reporter: 'list',
  projects: [
    {
      name: 'chromium',
      use: { ...devices['Desktop Chrome'] },
    },
  ],
});
