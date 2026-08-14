import { defineConfig } from "vitest/config"

export default defineConfig({
  test: {
    coverage: {
      include: ["src/**/*.ts"],
      provider: "istanbul",
      reporter: ["text"],
      thresholds: {
        branches: 55.72,
        functions: 63.91,
        lines: 62.36,
        statements: 61.77,
      },
    },
    environment: "node",
    include: ["test/**/*.test.ts"],
    pool: "forks",
    setupFiles: ["./test/setup.ts"],
  },
})
