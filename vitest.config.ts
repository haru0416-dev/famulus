import { defineConfig } from "vitest/config"

export default defineConfig({
  test: {
    coverage: {
      include: ["src/**/*.ts"],
      provider: "istanbul",
      reporter: ["text"],
      thresholds: {
        branches: 69.36,
        functions: 78.79,
        lines: 78.14,
        statements: 76.67,
      },
    },
    environment: "node",
    include: ["test/**/*.test.ts"],
    pool: "forks",
    setupFiles: ["./test/setup.ts"],
  },
})
