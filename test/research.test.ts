import assert from "node:assert/strict"
import * as Effect from "effect/Effect"
import { test } from "vitest"
import { Research } from "../src/services/Research.ts"
import { withHarness } from "./helpers.ts"

test("結論は引用可能な根拠と限界を持ち、終端後は固定される", () =>
  withHarness(async (h) => {
    const result = await h.run(
      Effect.gen(function* () {
        const research = yield* Research
        const dossier = yield* research.open("現行仕様は何か")
        const source = yield* research.addSnapshot(dossier.id, {
          sourceRef: "https://example.com/spec",
          content: "Current version is 7.0.62.",
        })
        const conclusion = yield* research.addClaim(dossier.id, "Current version is 7.0.62.", "conclusion")
        yield* research.linkArtifact(conclusion.id, source.id, "support", "Current version is 7.0.62.")
        yield* research.resolveClaim(conclusion.id, "supported")
        yield* research.conclude(dossier.id, conclusion.id, "取得時点の公開ページだけを確認した。")
        const bundle = yield* research.bundle(dossier.id)
        const late = yield* Effect.result(research.addClaim(dossier.id, "late", "observation"))
        return { bundle, late }
      }),
    )
    assert.equal(result.bundle.dossier?.state, "concluded")
    assert.equal(result.bundle.evidence.length, 1)
    assert.equal(result.late._tag, "Failure")
  }))

test("command成功ではなくcheck成功だけが実験をverifiedにする", () =>
  withHarness(async (h) => {
    const verdict = await h.run(
      Effect.gen(function* () {
        const research = yield* Research
        const dossier = yield* research.open("変更は条件を満たすか")
        const hypothesis = yield* research.addClaim(dossier.id, "変更後は検査を通る", "hypothesis")
        const run = yield* research.recordExperiment({
          hypothesisClaimId: hypothesis.id,
          protocol: { acceptance: "check exits 0" },
          environment: { runtime: "test" },
          workspace: "research-test",
          command: "apply-change",
          commandResult: { status: "completed", exitCode: 0, output: "changed" },
          checkCommand: "verify-change",
          checkResult: { status: "completed", exitCode: 1, output: "failed" },
        })
        return run.verdict
      }),
    )
    assert.equal(verdict, "failed")
  }))
