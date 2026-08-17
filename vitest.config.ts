import { defineConfig } from "vitest/config"

export default defineConfig({
  test: {
    coverage: {
      include: ["src/**/*.ts"],
      // ruri の実ロードは初回にネットワークからモデルを取るので、ゲートでは踏めない。
      // ゲートは stub(test/setup.ts)で機構を検査し、実モデルの検索品質は eval:recall が測る。
      exclude: ["src/model/embedding-ruri.ts"],
      provider: "istanbul",
      reporter: ["text"],
      thresholds: {
        branches: 69.29,
        functions: 78.63,
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
