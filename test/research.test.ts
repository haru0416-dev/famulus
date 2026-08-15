import assert from "node:assert/strict"
import * as Effect from "effect/Effect"
import { test } from "vitest"
import { Db } from "../src/services/Db.ts"
import { Research } from "../src/services/Research.ts"
import { withHarness } from "./helpers.ts"

test("結論は引用可能な根拠と限界を持ち、終端後は固定される", () =>
  withHarness(async (h) => {
    const result = await h.run(
      Effect.gen(function* () {
        const research = yield* Research
        const db = yield* Db
        const dossier = yield* research.open("現行仕様は何か")
        const unsupported = yield* Effect.result(
          db.run(
            `INSERT INTO research_claims(id,dossier_id,statement,kind,state,created_at,resolved_at)
             VALUES ('unsupported',?,'根拠なし','conclusion','supported',?,?)`,
            dossier.id,
            dossier.created_at,
            dossier.created_at,
          ),
        )
        const directConclusion = yield* Effect.result(
          db.run(
            `INSERT INTO research_dossiers
              (id,question,state,conclusion_claim_id,limitations,created_at,concluded_at)
             VALUES ('direct-conclusion','bypass','concluded','missing','none',?,?)`,
            dossier.created_at,
            dossier.created_at,
          ),
        )
        const webBelief = yield* Effect.result(
          db.run(
            `INSERT INTO events
              (id,at,kind,source,taint,exposure,provenance,content,search_text,belief_slot,valid_from)
             VALUES ('web-belief',?,'belief','web',1,'public','[]','42','fact','public.fact',?)`,
            dossier.created_at,
            dossier.created_at,
          ),
        )
        const source = yield* research.addSnapshot(dossier.id, {
          sourceRef: "https://example.com/spec",
          content: "Current version is 7.0.62.",
          status: 200,
        })
        const conclusion = yield* research.addClaim(dossier.id, "Current version is 7.0.62.", "conclusion")
        const other = yield* research.open("別の調査")
        const otherSource = yield* research.addSnapshot(other.id, {
          sourceRef: "https://example.com/other",
          content: "other",
          status: 200,
        })
        const crossSupersedes = yield* Effect.result(
          research.addSnapshot(dossier.id, {
            sourceRef: "https://example.com/new",
            content: "new",
            status: 200,
            supersedesId: otherSource.id,
          }),
        )
        const crossDossier = yield* Effect.result(
          db.run(
            `INSERT INTO research_claim_evidence(id,claim_id,artifact_id,polarity,quote,added_at)
             VALUES ('cross',?,?,'support','other',?)`,
            conclusion.id,
            otherSource.id,
            dossier.created_at,
          ),
        )
        yield* research.linkArtifact(conclusion.id, source.id, "support", "Current version is 7.0.62.")
        yield* research.resolveClaim(conclusion.id, "supported")
        yield* research.conclude(dossier.id, conclusion.id, "取得時点の公開ページだけを確認した。")
        const bundle = yield* research.bundle(dossier.id)
        const rendered = yield* research.render(dossier.id)
        const deleteClaim = yield* Effect.result(
          db.run("DELETE FROM research_claims WHERE id=?", conclusion.id),
        )
        const evidenceId = String(bundle.evidence[0]?.id)
        const replaceEvidence = yield* Effect.result(
          db.run(
            `INSERT OR REPLACE INTO research_claim_evidence(id,claim_id,artifact_id,polarity,quote,added_at)
             VALUES (?,?,?,'context',NULL,?)`,
            evidenceId,
            conclusion.id,
            source.id,
            dossier.created_at,
          ),
        )
        const replaceDossier = yield* Effect.result(
          db.run(
            `INSERT OR REPLACE INTO research_dossiers(id,question,state,created_at)
             VALUES (?,'reopened','open',?)`,
            dossier.id,
            dossier.created_at,
          ),
        )
        const late = yield* Effect.result(research.addClaim(dossier.id, "late", "observation"))
        const invalid = yield* Effect.result(
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
        )
        const dossiers = yield* research.list()
        const emptySnapshot = yield* Effect.result(
          research.recordWebDossier({
            question: "取得失敗",
            limitations: "本文なし",
            snapshots: [{ url: "https://x.com/example", content: "", status: 0 }],
            claims: [],
          }),
        )
        const nanStatus = yield* Effect.result(
          research.recordWebDossier({
            question: "不正status",
            limitations: "NaN",
            snapshots: [{ url: "https://example.com/nan", content: "body", status: Number.NaN }],
            claims: [],
          }),
        )
        yield* db.run(
          `INSERT INTO research_artifacts
            (id,dossier_id,kind,media_type,content,sha256,source_ref,captured_at,provenance,created_at)
           VALUES ('bad-hash',?,'source_snapshot','text/plain','tampered',?,'https://example.com/bad',?,'{}',?)`,
          other.id,
          "0".repeat(64),
          dossier.created_at,
          dossier.created_at,
        )
        const hashMismatch = yield* Effect.result(research.bundle(other.id))
        return {
          bundle,
          rendered,
          late,
          invalid,
          dossiers,
          unsupported,
          directConclusion,
          webBelief,
          crossDossier,
          crossSupersedes,
          replaceEvidence,
          replaceDossier,
          emptySnapshot,
          deleteClaim,
          nanStatus,
          hashMismatch,
        }
      }),
    )
    assert.equal(result.bundle.dossier?.state, "concluded")
    assert.equal(result.bundle.evidence.length, 1)
    assert.match(result.rendered, /Current version is 7\.0\.62\./)
    assert.match(result.rendered, /sha256=[0-9a-f]{64}/)
    assert.equal(result.late._tag, "Failure")
    assert.equal(result.invalid._tag, "Failure")
    assert.equal(result.dossiers.length, 2)
    assert.equal(result.unsupported._tag, "Failure")
    assert.equal(result.directConclusion._tag, "Failure")
    assert.equal(result.webBelief._tag, "Failure")
    assert.equal(result.crossDossier._tag, "Failure")
    assert.equal(result.crossSupersedes._tag, "Failure")
    assert.equal(result.replaceEvidence._tag, "Failure")
    assert.equal(result.replaceDossier._tag, "Failure")
    assert.equal(result.emptySnapshot._tag, "Failure")
    assert.equal(result.deleteClaim._tag, "Failure")
    assert.equal(result.nanStatus._tag, "Failure")
    assert.equal(result.hashMismatch._tag, "Failure")
  }))

test("command成功ではなくcheck成功だけが実験をverifiedにする", () =>
  withHarness(async (h) => {
    const verdict = await h.run(
      Effect.gen(function* () {
        const research = yield* Research
        const db = yield* Db
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
        const emptyCheck = yield* Effect.result(
          research.recordExperiment({
            hypothesisClaimId: hypothesis.id,
            protocol: { acceptance: "empty is invalid" },
            environment: { runtime: "test" },
            workspace: "research-test",
            command: "apply-change",
            commandResult: { status: "completed", exitCode: 0, output: "changed" },
            checkCommand: " ",
            checkResult: { status: "completed", exitCode: 0, output: "" },
          }),
        )
        const unavailable = yield* research.recordExperiment({
          hypothesisClaimId: hypothesis.id,
          protocol: { acceptance: "runtime is available" },
          environment: { runtime: "test" },
          workspace: "research-test",
          command: "docker run unavailable",
          commandResult: { status: "unavailable", exitCode: 127, output: "docker unavailable" },
          checkCommand: "verify-change",
        })
        yield* research.linkExperiment(hypothesis.id, unavailable.id, "context")
        const timedOut = yield* research.recordExperiment({
          hypothesisClaimId: hypothesis.id,
          protocol: { acceptance: "finishes before deadline" },
          environment: { runtime: "test" },
          workspace: "research-test",
          command: "long-running-command",
          commandResult: { status: "timed_out", exitCode: 137, output: "timeout" },
          checkCommand: "verify-change",
        })
        yield* research.linkExperiment(hypothesis.id, timedOut.id, "context")
        const verified = yield* research.recordExperiment({
          hypothesisClaimId: hypothesis.id,
          protocol: { acceptance: "check exits 0" },
          environment: { runtime: "test" },
          workspace: "research-test",
          command: "apply-change",
          commandResult: { status: "completed", exitCode: 1, output: "expected failure" },
          checkCommand: "verify-change",
          checkResult: { status: "completed", exitCode: 0, output: "verified" },
        })
        const conclusion = yield* research.addClaim(dossier.id, "検査条件を満たした", "conclusion")
        const failedArtifactSupport = yield* Effect.result(
          research.linkArtifact(conclusion.id, run.commandArtifactId, "support", "changed"),
        )
        yield* research.linkExperiment(conclusion.id, verified.id, "support")
        yield* research.resolveClaim(conclusion.id, "supported")
        yield* research.conclude(dossier.id, conclusion.id, "test environment only")
        const rendered = yield* research.render(dossier.id)
        const fakeVerified = yield* Effect.result(
          db.run(
            `INSERT INTO research_experiment_runs
              (id,hypothesis_claim_id,protocol,environment,workspace,command,command_artifact_id,command_status,
               command_exit_code,check_command,verdict,started_at,finished_at)
             VALUES ('fake',?,'{}','{}','test','run',?,'completed',0,'check','verified',?,?)`,
            hypothesis.id,
            run.commandArtifactId,
            dossier.created_at,
            dossier.created_at,
          ),
        )
        const reusedArtifacts = yield* Effect.result(
          db.run(
            `INSERT INTO research_experiment_runs
              (id,hypothesis_claim_id,protocol,environment,workspace,command,command_artifact_id,command_status,
               command_exit_code,check_command,check_artifact_id,check_status,check_exit_code,verdict,started_at,finished_at)
             VALUES ('reused',?,'{}','{}','test','run',?,'completed',0,'check',?,'completed',0,'verified',?,?)`,
            hypothesis.id,
            run.commandArtifactId,
            run.checkArtifactId,
            dossier.created_at,
            dossier.created_at,
          ),
        )
        const other = yield* research.open("別dossier")
        const otherClaim = yield* research.addClaim(other.id, "別の結論", "conclusion")
        const otherArtifact = yield* research.addSnapshot(other.id, {
          sourceRef: "https://example.com/other-run",
          content: "foreign output",
          status: 200,
        })
        const foreignArtifacts = yield* Effect.result(
          db.run(
            `INSERT INTO research_experiment_runs
              (id,hypothesis_claim_id,protocol,environment,workspace,command,command_artifact_id,command_status,
               command_exit_code,check_command,check_artifact_id,check_status,check_exit_code,verdict,started_at,finished_at)
             VALUES ('foreign-artifacts',?,'{}','{}','test','run',?,'completed',0,'check',?,'completed',0,'verified',?,?)`,
            hypothesis.id,
            otherArtifact.id,
            otherArtifact.id,
            dossier.created_at,
            dossier.created_at,
          ),
        )
        const crossExperiment = yield* Effect.result(
          db.run(
            `INSERT INTO research_claim_evidence(id,claim_id,experiment_run_id,polarity,added_at)
             VALUES ('cross-run',?,?,'support',?)`,
            otherClaim.id,
            run.id,
            dossier.created_at,
          ),
        )
        return {
          verdict: run.verdict,
          emptyCheck,
          unavailableVerdict: unavailable.verdict,
          timedOutVerdict: timedOut.verdict,
          failedArtifactSupport,
          fakeVerified,
          reusedArtifacts,
          crossExperiment,
          foreignArtifacts,
          rendered,
        }
      }),
    )
    assert.equal(verdict.verdict, "failed")
    assert.equal(verdict.emptyCheck._tag, "Failure")
    assert.equal(verdict.unavailableVerdict, "inconclusive")
    assert.equal(verdict.timedOutVerdict, "inconclusive")
    assert.equal(verdict.failedArtifactSupport._tag, "Failure")
    assert.equal(verdict.fakeVerified._tag, "Failure")
    assert.equal(verdict.reusedArtifacts._tag, "Failure")
    assert.equal(verdict.crossExperiment._tag, "Failure")
    assert.equal(verdict.foreignArtifacts._tag, "Failure")
    assert.match(verdict.rendered, /command completed exit=1: apply-change sha256=[0-9a-f]{64}/)
    assert.match(verdict.rendered, /check completed exit=0: verify-change sha256=[0-9a-f]{64}/)
    assert.match(verdict.rendered, /command unavailable exit=127: docker run unavailable/)
    assert.match(verdict.rendered, /command timed_out exit=137: long-running-command/)
  }))
