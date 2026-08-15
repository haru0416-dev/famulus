import assert from "node:assert/strict"
import * as Effect from "effect/Effect"
import { test } from "vitest"
import { Db } from "../src/services/Db.ts"
import { type ExperimentResult, Research, type RunVerdict } from "../src/services/Research.ts"
import { withHarness } from "./helpers.ts"

const assertDbFailed = (error: unknown, message: RegExp): void => {
  assert.equal((error as { _tag?: unknown })._tag, "DbFailed")
  assert.match(String((error as { message?: unknown }).message), message)
}

const openHypothesis = (question = "変更は条件を満たすか") =>
  Effect.gen(function* () {
    const research = yield* Research
    const dossier = yield* research.open(question)
    const hypothesis = yield* research.addClaim(dossier.id, "変更後は検査を通る", "hypothesis")
    return { research, dossier, hypothesis }
  })

type ResearchApi = Effect.Success<ReturnType<typeof openHypothesis>>["research"]

const recordRun = (
  research: ResearchApi,
  hypothesisClaimId: string,
  commandResult: ExperimentResult,
  checkResult?: ExperimentResult,
  command = "apply-change",
) =>
  research.recordExperiment({
    hypothesisClaimId,
    protocol: { acceptance: "check exits 0" },
    environment: { runtime: "test" },
    workspace: "research-test",
    command,
    commandResult,
    checkCommand: "verify-change",
    ...(checkResult ? { checkResult } : {}),
  })

test("結論は引用可能な根拠と限界を持って終端する", () =>
  withHarness(async (h) => {
    const out = await h.run(
      Effect.gen(function* () {
        const research = yield* Research
        const dossier = yield* research.open("現行仕様は何か")
        const source = yield* research.addSnapshot(dossier.id, {
          sourceRef: "https://example.com/spec",
          content: "Current version is 7.0.62.",
          status: 200,
        })
        const conclusion = yield* research.addClaim(dossier.id, "Current version is 7.0.62.", "conclusion")
        yield* research.linkArtifact(conclusion.id, source.id, "support", "Current version is 7.0.62.")
        yield* research.resolveClaim(conclusion.id, "supported")
        yield* research.conclude(dossier.id, conclusion.id, "取得時点の公開ページだけを確認した。")
        return {
          bundle: yield* research.bundle(dossier.id),
          rendered: yield* research.render(dossier.id),
        }
      }),
    )

    assert.equal(out.bundle.dossier?.state, "concluded")
    assert.equal(out.bundle.evidence.length, 1)
    assert.match(out.rendered, /Current version is 7\.0\.62\./)
    assert.match(out.rendered, /sha256=[0-9a-f]{64}/)
  }))

test("終端したdossier・claim・evidenceは変更できない", () =>
  withHarness(async (h) => {
    const closed = await h.run(
      Effect.gen(function* () {
        const research = yield* Research
        const dossier = yield* research.open("終端後の固定")
        const source = yield* research.addSnapshot(dossier.id, {
          sourceRef: "https://example.com/fixed",
          content: "fixed",
          status: 200,
        })
        const conclusion = yield* research.addClaim(dossier.id, "fixed", "conclusion")
        const evidenceId = yield* research.linkArtifact(conclusion.id, source.id, "support", "fixed")
        yield* research.resolveClaim(conclusion.id, "supported")
        yield* research.conclude(dossier.id, conclusion.id, "fixed")
        return { dossier, source, conclusion, evidenceId }
      }),
    )

    const deleteClaim = await h.fail(
      Effect.flatMap(Db, (db) => db.run("DELETE FROM research_claims WHERE id=?", closed.conclusion.id)),
    )
    assertDbFailed(deleteClaim, /research claims are immutable/)

    const updateEvidence = await h.fail(
      Effect.flatMap(Db, (db) =>
        db.run("UPDATE research_claim_evidence SET polarity='context' WHERE id=?", closed.evidenceId),
      ),
    )
    assertDbFailed(updateEvidence, /research evidence is immutable/)

    const updateDossier = await h.fail(
      Effect.flatMap(Db, (db) =>
        db.run("UPDATE research_dossiers SET question='reopened' WHERE id=?", closed.dossier.id),
      ),
    )
    assertDbFailed(updateDossier, /terminal research dossier is immutable/)

    const replaceEvidence = await h.fail(
      Effect.flatMap(Db, (db) =>
        db.run(
          `INSERT OR REPLACE INTO research_claim_evidence(id,claim_id,artifact_id,polarity,quote,added_at)
           VALUES (?,?,?,'context',NULL,?)`,
          closed.evidenceId,
          closed.conclusion.id,
          closed.source.id,
          closed.dossier.created_at,
        ),
      ),
    )
    assertDbFailed(replaceEvidence, /research evidence requires an open dossier/)

    const replaceDossier = await h.fail(
      Effect.flatMap(Db, (db) =>
        db.run(
          `INSERT OR REPLACE INTO research_dossiers(id,question,state,created_at)
           VALUES (?,'reopened','open',?)`,
          closed.dossier.id,
          closed.dossier.created_at,
        ),
      ),
    )
    assertDbFailed(replaceDossier, /research dossier cannot be deleted/)

    const lateClaim = await h.fail(
      Effect.flatMap(Research, (research) => research.addClaim(closed.dossier.id, "late", "observation")),
    )
    assertDbFailed(lateClaim, /Open research dossier not found/)

    const bundle = await h.run(Effect.flatMap(Research, (research) => research.bundle(closed.dossier.id)))
    assert.equal(bundle.dossier?.state, "concluded")
    assert.equal(bundle.evidence.length, 1)
  }))

test("artifactとevidenceは同じdossier内だけで関連付けられる", () =>
  withHarness(async (h) => {
    const fixture = await h.run(
      Effect.gen(function* () {
        const research = yield* Research
        const dossier = yield* research.open("対象")
        const claim = yield* research.addClaim(dossier.id, "対象の主張", "observation")
        const other = yield* research.open("別の調査")
        const otherSource = yield* research.addSnapshot(other.id, {
          sourceRef: "https://example.com/other",
          content: "other",
          status: 200,
        })
        return { dossier, claim, otherSource }
      }),
    )

    const crossSupersedes = await h.fail(
      Effect.flatMap(Research, (research) =>
        research.addSnapshot(fixture.dossier.id, {
          sourceRef: "https://example.com/new",
          content: "new",
          status: 200,
          supersedesId: fixture.otherSource.id,
        }),
      ),
    )
    assertDbFailed(crossSupersedes, /superseded research artifact must belong to the same dossier/)

    const crossEvidence = await h.fail(
      Effect.flatMap(Db, (db) =>
        db.run(
          `INSERT INTO research_claim_evidence(id,claim_id,artifact_id,polarity,quote,added_at)
           VALUES ('cross',?,?,'support','other',?)`,
          fixture.claim.id,
          fixture.otherSource.id,
          fixture.dossier.created_at,
        ),
      ),
    )
    assertDbFailed(crossEvidence, /research artifact evidence must belong to the claim dossier/)
  }))

test("DBへ直接書いても未検証claimや終端dossierは作れない", () =>
  withHarness(async (h) => {
    const dossier = await h.run(Effect.flatMap(Research, (research) => research.open("bypass")))

    const unsupportedClaim = await h.fail(
      Effect.flatMap(Db, (db) =>
        db.run(
          `INSERT INTO research_claims(id,dossier_id,statement,kind,state,created_at,resolved_at)
           VALUES ('unsupported',?,'根拠なし','conclusion','supported',?,?)`,
          dossier.id,
          dossier.created_at,
          dossier.created_at,
        ),
      ),
    )
    assertDbFailed(unsupportedClaim, /research claims must be inserted open/)

    const directConclusion = await h.fail(
      Effect.flatMap(Db, (db) =>
        db.run(
          `INSERT INTO research_dossiers
            (id,question,state,conclusion_claim_id,limitations,created_at,concluded_at)
           VALUES ('direct-conclusion','bypass','concluded','missing','none',?,?)`,
          dossier.created_at,
          dossier.created_at,
        ),
      ),
    )
    assertDbFailed(directConclusion, /research dossiers must be inserted open/)
  }))

test("Web一括記録は根拠の無いclaimと取得失敗snapshotをrollbackする", () =>
  withHarness(async (h) => {
    const quoteMismatch = await h.fail(
      Effect.flatMap(Research, (research) =>
        research.recordWebDossier({
          question: "引用が無い場合",
          limitations: "引用不一致",
          snapshots: [{ url: "https://example.com", content: "actual", status: 200 }],
          claims: [
            {
              statement: "missing",
              kind: "conclusion",
              evidence: [{ url: "https://example.com", quote: "missing", polarity: "support" }],
            },
          ],
        }),
      ),
    )
    assertDbFailed(quoteMismatch, /Research quote is not present in fetched snapshot/)

    const noEvidence = await h.fail(
      Effect.flatMap(Research, (research) =>
        research.recordWebDossier({
          question: "根拠なし数値",
          limitations: "source missing",
          snapshots: [],
          claims: [
            {
              statement: "Current version is 7.0.62",
              kind: "observation",
              evidence: [],
            },
          ],
        }),
      ),
    )
    assertDbFailed(noEvidence, /Research claims require evidence/)

    for (const snapshot of [
      { url: "https://example.com/empty", content: "", status: 0 },
      { url: "https://example.com/nan", content: "body", status: Number.NaN },
    ]) {
      const invalidSnapshot = await h.fail(
        Effect.flatMap(Research, (research) =>
          research.recordWebDossier({
            question: "取得失敗",
            limitations: "invalid snapshot",
            snapshots: [snapshot],
            claims: [],
          }),
        ),
      )
      assertDbFailed(invalidSnapshot, /Research snapshot was not fetched successfully/)
    }

    const dossiers = await h.run(Effect.flatMap(Research, (research) => research.list()))
    assert.deepEqual(dossiers, [], "失敗した一括記録のdossierを残さない")
  }))

test("bundleは保存後に改ざんされたartifactを拒否する", () =>
  withHarness(async (h) => {
    const dossier = await h.run(Effect.flatMap(Research, (research) => research.open("hash")))
    await h.run(
      Effect.flatMap(Db, (db) =>
        db.run(
          `INSERT INTO research_artifacts
            (id,dossier_id,kind,media_type,content,sha256,source_ref,captured_at,provenance,created_at)
           VALUES ('bad-hash',?,'source_snapshot','text/plain','tampered',?,'https://example.com/bad',?,'{}',?)`,
          dossier.id,
          "0".repeat(64),
          dossier.created_at,
          dossier.created_at,
        ),
      ),
    )

    const error = await h.fail(Effect.flatMap(Research, (research) => research.bundle(dossier.id)))
    assert.match(String((error as { message?: unknown }).message), /Research artifact hash mismatch/)
  }))

test("Web一括記録はsnapshotとevidenceを保存してdossierを終端する", () =>
  withHarness(async (h) => {
    const out = await h.run(
      Effect.gen(function* () {
        const research = yield* Research
        const dossier = yield* research.recordWebDossier({
          question: "現行版は何か",
          limitations: "公開ページ1件だけを確認した",
          snapshots: [
            {
              url: "https://example.com/version",
              content: "Current version is 7.0.62.",
              status: 200,
            },
          ],
          claims: [
            {
              statement: "Current version is 7.0.62.",
              kind: "conclusion",
              evidence: [
                {
                  url: "https://example.com/version",
                  quote: "Current version is 7.0.62.",
                  polarity: "support",
                },
              ],
            },
          ],
        })
        return yield* research.bundle(dossier.id)
      }),
    )

    assert.equal(out.dossier?.state, "concluded")
    assert.equal(out.claims[0]?.state, "supported")
    assert.equal(out.artifacts[0]?.media_type, "text/plain")
    assert.equal(out.artifacts[0]?.supersedes_id, null)
    assert.equal(out.evidence[0]?.quote, "Current version is 7.0.62.")
    assert.equal(out.evidence[0]?.location, null)
  }))

test("listは保存済みdossierを新しい順かつlimit内で返す", () =>
  withHarness(async (h) => {
    const result = await h.run(
      Effect.gen(function* () {
        const research = yield* Research
        yield* research.open("old", "2026-08-15T00:00:00.000Z")
        yield* research.open("new", "2026-08-16T00:00:00.000Z")
        return { all: yield* research.list(), limited: yield* research.list(1) }
      }),
    )

    assert.deepEqual(
      result.all.map((dossier) => dossier.question),
      ["new", "old"],
    )
    assert.equal(result.limited.length, 1)
    assert.equal(result.limited[0]?.question, "new")
  }))

interface VerdictCase {
  readonly name: string
  readonly commandResult: ExperimentResult
  readonly checkResult?: ExperimentResult
  readonly expected: RunVerdict
}

const verdictCases: readonly VerdictCase[] = [
  {
    name: "check失敗ならfailed",
    commandResult: { status: "completed", exitCode: 0, output: "changed" },
    checkResult: { status: "completed", exitCode: 1, output: "failed" },
    expected: "failed",
  },
  {
    name: "command失敗でもcheck成功ならverified",
    commandResult: { status: "completed", exitCode: 1, output: "expected failure" },
    checkResult: { status: "completed", exitCode: 0, output: "verified" },
    expected: "verified",
  },
  {
    name: "command unavailableならinconclusive",
    commandResult: { status: "unavailable", exitCode: 127, output: "docker unavailable" },
    expected: "inconclusive",
  },
  {
    name: "command timeoutならinconclusive",
    commandResult: { status: "timed_out", exitCode: 137, output: "timeout" },
    expected: "inconclusive",
  },
]

test.each(verdictCases)("実験verdict: $name", ({ commandResult, checkResult, expected }) =>
  withHarness(async (h) => {
    const verdict = await h.run(
      Effect.gen(function* () {
        const { research, hypothesis } = yield* openHypothesis()
        const run = yield* recordRun(research, hypothesis.id, commandResult, checkResult)
        return run.verdict
      }),
    )
    assert.equal(verdict, expected)
  }),
)

test.each([
  { name: "command", command: " ", checkCommand: "verify-change" },
  { name: "check command", command: "apply-change", checkCommand: " " },
])("空の$nameは実験として記録しない", ({ command, checkCommand }) =>
  withHarness(async (h) => {
    const fixture = await h.run(openHypothesis())
    const error = await h.fail(
      fixture.research.recordExperiment({
        hypothesisClaimId: fixture.hypothesis.id,
        protocol: { acceptance: "empty is invalid" },
        environment: { runtime: "test" },
        workspace: "research-test",
        command,
        commandResult: { status: "completed", exitCode: 0, output: "changed" },
        checkCommand,
        checkResult: { status: "completed", exitCode: 0, output: "" },
      }),
    )
    assertDbFailed(error, /Research experiment command and check command must not be empty/)
  }),
)

test("verified experimentだけがclaimをsupportできる", () =>
  withHarness(async (h) => {
    const fixture = await h.run(
      Effect.gen(function* () {
        const { research, dossier, hypothesis } = yield* openHypothesis()
        const failed = yield* recordRun(
          research,
          hypothesis.id,
          { status: "completed", exitCode: 0, output: "changed" },
          { status: "completed", exitCode: 1, output: "failed" },
        )
        const verified = yield* recordRun(
          research,
          hypothesis.id,
          { status: "completed", exitCode: 1, output: "expected failure" },
          { status: "completed", exitCode: 0, output: "verified" },
        )
        const conclusion = yield* research.addClaim(dossier.id, "検査条件を満たした", "conclusion")
        return { dossier, failed, verified, conclusion }
      }),
    )

    const failedRun = await h.fail(
      Effect.flatMap(Research, (research) =>
        research.linkExperiment(fixture.conclusion.id, fixture.failed.id, "support"),
      ),
    )
    assertDbFailed(failedRun, /only verified experiment runs can support or refute claims/)

    const directArtifact = await h.fail(
      Effect.flatMap(Research, (research) =>
        research.linkArtifact(fixture.conclusion.id, fixture.failed.commandArtifactId, "support", "changed"),
      ),
    )
    assertDbFailed(directArtifact, /Only source snapshots can directly support or refute research claims/)

    await h.run(
      Effect.gen(function* () {
        const research = yield* Research
        yield* research.linkExperiment(fixture.conclusion.id, fixture.verified.id, "support")
        yield* research.resolveClaim(fixture.conclusion.id, "supported")
        yield* research.conclude(fixture.dossier.id, fixture.conclusion.id, "test environment only")
      }),
    )
    const bundle = await h.run(Effect.flatMap(Research, (research) => research.bundle(fixture.dossier.id)))
    assert.equal(bundle.dossier?.state, "concluded")
  }))

test("experiment artifactは未使用かつhypothesisと同じdossierに属する", () =>
  withHarness(async (h) => {
    const fixture = await h.run(
      Effect.gen(function* () {
        const { research, dossier, hypothesis } = yield* openHypothesis()
        const run = yield* recordRun(
          research,
          hypothesis.id,
          { status: "completed", exitCode: 0, output: "changed" },
          { status: "completed", exitCode: 1, output: "failed" },
        )
        const other = yield* research.open("別dossier")
        const otherClaim = yield* research.addClaim(other.id, "別の結論", "conclusion")
        const db = yield* Db
        yield* db.run(
          `INSERT INTO research_artifacts
            (id,dossier_id,kind,media_type,content,uri,sha256,source_ref,captured_at,provenance,supersedes_id,created_at)
           SELECT 'fresh-command',dossier_id,kind,media_type,content,uri,sha256,source_ref,captured_at,provenance,NULL,created_at
             FROM research_artifacts WHERE id=?`,
          run.commandArtifactId,
        )
        yield* db.run(
          `INSERT INTO research_artifacts
            (id,dossier_id,kind,media_type,content,uri,sha256,source_ref,captured_at,provenance,supersedes_id,created_at)
           SELECT 'foreign-command',?,kind,media_type,content,uri,sha256,source_ref,captured_at,provenance,NULL,created_at
             FROM research_artifacts WHERE id=?`,
          other.id,
          run.commandArtifactId,
        )
        yield* db.run(
          `INSERT INTO research_artifacts
            (id,dossier_id,kind,media_type,content,uri,sha256,source_ref,captured_at,provenance,supersedes_id,created_at)
           SELECT 'foreign-check',?,kind,media_type,content,uri,sha256,source_ref,captured_at,provenance,NULL,created_at
             FROM research_artifacts WHERE id=?`,
          other.id,
          run.checkArtifactId,
        )
        return { dossier, hypothesis, run, otherClaim }
      }),
    )

    const fakeVerified = await h.fail(
      Effect.flatMap(Db, (db) =>
        db.run(
          `INSERT INTO research_experiment_runs
            (id,hypothesis_claim_id,protocol,environment,workspace,command,command_artifact_id,command_status,
             command_exit_code,check_command,verdict,started_at,finished_at)
           VALUES ('fake',?,'{}','{}','test','run',?,'completed',0,'check','verified',?,?)`,
          fixture.hypothesis.id,
          "fresh-command",
          fixture.dossier.created_at,
          fixture.dossier.created_at,
        ),
      ),
    )
    assertDbFailed(fakeVerified, /CHECK constraint failed/)

    const reusedArtifacts = await h.fail(
      Effect.flatMap(Db, (db) =>
        db.run(
          `INSERT INTO research_experiment_runs
            (id,hypothesis_claim_id,protocol,environment,workspace,command,command_artifact_id,command_status,
             command_exit_code,check_command,check_artifact_id,check_status,check_exit_code,verdict,started_at,finished_at)
           VALUES ('reused',?,'{}','{}','test','run',?,'completed',0,'check',?,'completed',0,'verified',?,?)`,
          fixture.hypothesis.id,
          fixture.run.commandArtifactId,
          fixture.run.checkArtifactId,
          fixture.dossier.created_at,
          fixture.dossier.created_at,
        ),
      ),
    )
    assertDbFailed(reusedArtifacts, /research experiment artifacts must be distinct unowned sandbox outputs/)

    const foreignArtifacts = await h.fail(
      Effect.flatMap(Db, (db) =>
        db.run(
          `INSERT INTO research_experiment_runs
            (id,hypothesis_claim_id,protocol,environment,workspace,command,command_artifact_id,command_status,
             command_exit_code,check_command,check_artifact_id,check_status,check_exit_code,verdict,started_at,finished_at)
           VALUES ('foreign-artifacts',?,'{}','{}','test','run',?,'completed',0,'check',?,'completed',0,'verified',?,?)`,
          fixture.hypothesis.id,
          "foreign-command",
          "foreign-check",
          fixture.dossier.created_at,
          fixture.dossier.created_at,
        ),
      ),
    )
    assertDbFailed(foreignArtifacts, /research experiment artifacts must belong to the hypothesis dossier/)

    const crossExperiment = await h.fail(
      Effect.flatMap(Db, (db) =>
        db.run(
          `INSERT INTO research_claim_evidence(id,claim_id,experiment_run_id,polarity,added_at)
           VALUES ('cross-run',?,?,'support',?)`,
          fixture.otherClaim.id,
          fixture.run.id,
          fixture.dossier.created_at,
        ),
      ),
    )
    assertDbFailed(crossExperiment, /research experiment evidence must belong to the claim dossier/)
  }))

test("experiment renderはcommandとcheckの観測結果を残す", () =>
  withHarness(async (h) => {
    const rendered = await h.run(
      Effect.gen(function* () {
        const { research, dossier, hypothesis } = yield* openHypothesis()
        const unavailable = yield* recordRun(
          research,
          hypothesis.id,
          { status: "unavailable", exitCode: 127, output: "docker unavailable" },
          undefined,
          "docker run unavailable",
        )
        yield* research.linkExperiment(hypothesis.id, unavailable.id, "context")
        const timedOut = yield* recordRun(
          research,
          hypothesis.id,
          { status: "timed_out", exitCode: 137, output: "timeout" },
          undefined,
          "long-running-command",
        )
        yield* research.linkExperiment(hypothesis.id, timedOut.id, "context")
        const verified = yield* recordRun(
          research,
          hypothesis.id,
          { status: "completed", exitCode: 1, output: "expected failure" },
          { status: "completed", exitCode: 0, output: "verified" },
        )
        const conclusion = yield* research.addClaim(dossier.id, "検査条件を満たした", "conclusion")
        yield* research.linkExperiment(conclusion.id, verified.id, "support")
        yield* research.resolveClaim(conclusion.id, "supported")
        yield* research.conclude(dossier.id, conclusion.id, "test environment only")
        return yield* research.render(dossier.id)
      }),
    )

    assert.match(rendered, /command completed exit=1: apply-change sha256=[0-9a-f]{64}/)
    assert.match(rendered, /check completed exit=0: verify-change sha256=[0-9a-f]{64}/)
    assert.match(rendered, /command unavailable exit=127: docker run unavailable/)
    assert.match(rendered, /command timed_out exit=137: long-running-command/)
  }))
