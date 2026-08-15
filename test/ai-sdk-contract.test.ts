import assert from "node:assert/strict"
import { readFileSync } from "node:fs"
import { Experimental_Agent, stepCountIs, ToolLoopAgent } from "ai"
import { test } from "vitest"

const packageJson = JSON.parse(
  readFileSync(new URL("../node_modules/ai/package.json", import.meta.url), "utf8"),
) as { version: string }

test("AI SDK execution kernel is pinned to the tested stable agent API", () => {
  assert.equal(packageJson.version, "7.0.62")
  assert.equal(ToolLoopAgent, Experimental_Agent)
  assert.equal(typeof ToolLoopAgent, "function")
  assert.equal(typeof stepCountIs(1), "function")
})
