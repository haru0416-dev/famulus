import { createHash, randomUUID } from "node:crypto"
import * as Context from "effect/Context"
import * as Effect from "effect/Effect"
import * as Layer from "effect/Layer"
import { nowIso } from "../core/time.ts"
import { Db, type DbTx, type Row } from "./Db.ts"

export type ClaimKind = "observation" | "hypothesis" | "conclusion"
export type ClaimState = "open" | "supported" | "refuted" | "inconclusive"
export type EvidencePolarity = "support" | "refute" | "context"
export type RunStatus = "completed" | "timed_out" | "unavailable"
export type RunVerdict = "verified" | "failed" | "inconclusive"

export interface DossierRow {
  readonly id: string
  readonly question: string
  readonly state: "open" | "concluded" | "inconclusive"
  readonly conclusion_claim_id: string | null
  readonly limitations: string | null
  readonly created_at: string
  readonly concluded_at: string | null
}

export interface ClaimRow {
  readonly id: string
  readonly dossier_id: string
  readonly statement: string
  readonly kind: ClaimKind
  readonly state: ClaimState
  readonly created_at: string
  readonly resolved_at: string | null
}

export interface ArtifactRow {
  readonly id: string
  readonly dossier_id: string
  readonly kind: "source_snapshot" | "sandbox_output"
  readonly media_type: string
  readonly content: string | null
  readonly uri: string | null
  readonly sha256: string
  readonly source_ref: string | null
  readonly captured_at: string
  readonly provenance: string
  readonly supersedes_id: string | null
  readonly created_at: string
}

export interface ExperimentResult {
  readonly status: RunStatus
  readonly exitCode?: number
  readonly output: string
}

const cast = <A>(value: Row): A => value as unknown as A
const sha256 = (content: string): string => createHash("sha256").update(content).digest("hex")

const requireOpen = (tx: DbTx, dossierId: string): void => {
  if (!tx.get("SELECT 1 FROM research_dossiers WHERE id=? AND state='open'", dossierId)) {
    throw new Error(`Open research dossier not found: ${dossierId}`)
  }
}

const makeResearch = () =>
  Effect.gen(function* () {
    const db = yield* Db

    const open = (question: string, at: string = nowIso()) =>
      db.withImmediateTransaction("open research dossier", (tx) => {
        const id = randomUUID()
        tx.run(
          "INSERT INTO research_dossiers(id,question,state,created_at) VALUES (?,?,'open',?)",
          id,
          question.trim(),
          at,
        )
        return cast<DossierRow>(tx.get("SELECT * FROM research_dossiers WHERE id=?", id) as Row)
      })

    const addSnapshot = (
      dossierId: string,
      input: {
        sourceRef: string
        content: string
        status: number
        mediaType?: string
        provenance?: unknown
        supersedesId?: string
      },
      at: string = nowIso(),
    ) =>
      db.withImmediateTransaction("add research source snapshot", (tx) => {
        requireOpen(tx, dossierId)
        if (
          !Number.isInteger(input.status) ||
          input.status < 200 ||
          input.status >= 300 ||
          input.content.length === 0
        ) {
          throw new Error(`Research snapshot was not fetched successfully: ${input.sourceRef}`)
        }
        const id = randomUUID()
        tx.run(
          `INSERT INTO research_artifacts
             (id,dossier_id,kind,media_type,content,sha256,source_ref,captured_at,provenance,supersedes_id,created_at)
           VALUES (?,?,'source_snapshot',?,?,?,?,?,?,?,?)`,
          id,
          dossierId,
          input.mediaType ?? "text/plain",
          input.content,
          sha256(input.content),
          input.sourceRef,
          at,
          JSON.stringify(input.provenance ?? { source: input.sourceRef, status: input.status }),
          input.supersedesId ?? null,
          at,
        )
        return cast<ArtifactRow>(tx.get("SELECT * FROM research_artifacts WHERE id=?", id) as Row)
      })

    const addClaim = (dossierId: string, statement: string, kind: ClaimKind, at: string = nowIso()) =>
      db.withImmediateTransaction("add research claim", (tx) => {
        requireOpen(tx, dossierId)
        const id = randomUUID()
        tx.run(
          "INSERT INTO research_claims(id,dossier_id,statement,kind,state,created_at) VALUES (?,?,?,?,'open',?)",
          id,
          dossierId,
          statement.trim(),
          kind,
          at,
        )
        return cast<ClaimRow>(tx.get("SELECT * FROM research_claims WHERE id=?", id) as Row)
      })

    const linkArtifact = (
      claimId: string,
      artifactId: string,
      polarity: EvidencePolarity,
      quote?: string,
      location?: string,
      at: string = nowIso(),
    ) =>
      db.withImmediateTransaction("link research artifact", (tx) => {
        const claim = tx.get("SELECT dossier_id FROM research_claims WHERE id=?", claimId)
        const artifact = tx.get(
          "SELECT dossier_id,kind,content FROM research_artifacts WHERE id=?",
          artifactId,
        )
        if (!claim || !artifact || claim.dossier_id !== artifact.dossier_id) {
          throw new Error("Research evidence must belong to the same dossier")
        }
        if (polarity !== "context" && artifact.kind !== "source_snapshot") {
          throw new Error("Only source snapshots can directly support or refute research claims")
        }
        if (quote && typeof artifact.content === "string" && !artifact.content.includes(quote)) {
          throw new Error("Research evidence quote is not present in the source snapshot")
        }
        const id = randomUUID()
        tx.run(
          `INSERT INTO research_claim_evidence(id,claim_id,artifact_id,polarity,quote,location,added_at)
           VALUES (?,?,?,?,?,?,?)`,
          id,
          claimId,
          artifactId,
          polarity,
          quote ?? null,
          location ?? null,
          at,
        )
        return id
      })

    const resolveClaim = (claimId: string, state: Exclude<ClaimState, "open">, at: string = nowIso()) =>
      db.run(
        "UPDATE research_claims SET state=?,resolved_at=? WHERE id=? AND state='open'",
        state,
        at,
        claimId,
      )

    const recordExperiment = (
      input: {
        hypothesisClaimId: string
        protocol: unknown
        environment: unknown
        workspace: string
        command: string
        commandResult: ExperimentResult
        checkCommand: string
        checkResult?: ExperimentResult
      },
      at: string = nowIso(),
    ) =>
      db.withImmediateTransaction("record research experiment", (tx) => {
        const claim = tx.get(
          "SELECT dossier_id FROM research_claims WHERE id=? AND kind='hypothesis'",
          input.hypothesisClaimId,
        )
        if (!claim) throw new Error(`Hypothesis claim not found: ${input.hypothesisClaimId}`)
        const dossierId = String(claim.dossier_id)
        requireOpen(tx, dossierId)
        if (!input.command.trim() || !input.checkCommand.trim()) {
          throw new Error("Research experiment command and check command must not be empty")
        }
        const artifact = (content: string): string => {
          const id = randomUUID()
          tx.run(
            `INSERT INTO research_artifacts
               (id,dossier_id,kind,media_type,content,sha256,captured_at,provenance,created_at)
             VALUES (?,?,'sandbox_output','text/plain',?,?,?,json_object('workspace',?),?)`,
            id,
            dossierId,
            content,
            sha256(content),
            at,
            input.workspace,
            at,
          )
          return id
        }
        const commandArtifactId = artifact(input.commandResult.output)
        const checkArtifactId = input.checkResult ? artifact(input.checkResult.output) : null
        const verdict: RunVerdict =
          input.checkResult?.status === "completed"
            ? input.checkResult.exitCode === 0
              ? "verified"
              : "failed"
            : "inconclusive"
        const id = randomUUID()
        tx.run(
          `INSERT INTO research_experiment_runs
             (id,hypothesis_claim_id,protocol,environment,workspace,command,command_artifact_id,command_status,
              command_exit_code,check_command,check_artifact_id,check_status,check_exit_code,verdict,started_at,finished_at)
           VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
          id,
          input.hypothesisClaimId,
          JSON.stringify(input.protocol),
          JSON.stringify(input.environment),
          input.workspace,
          input.command,
          commandArtifactId,
          input.commandResult.status,
          input.commandResult.exitCode ?? null,
          input.checkCommand,
          checkArtifactId,
          input.checkResult?.status ?? null,
          input.checkResult?.exitCode ?? null,
          verdict,
          at,
          at,
        )
        return { id, verdict, commandArtifactId, checkArtifactId }
      })

    const linkExperiment = (
      claimId: string,
      experimentRunId: string,
      polarity: EvidencePolarity,
      at: string = nowIso(),
    ) =>
      db.withImmediateTransaction("link research experiment", (tx) => {
        const claim = tx.get("SELECT dossier_id FROM research_claims WHERE id=?", claimId)
        const run = tx.get(
          `SELECT c.dossier_id FROM research_experiment_runs r
             JOIN research_claims c ON c.id=r.hypothesis_claim_id WHERE r.id=?`,
          experimentRunId,
        )
        if (!claim || !run || claim.dossier_id !== run.dossier_id) {
          throw new Error("Research experiment evidence must belong to the same dossier")
        }
        const id = randomUUID()
        tx.run(
          `INSERT INTO research_claim_evidence(id,claim_id,experiment_run_id,polarity,added_at)
           VALUES (?,?,?,?,?)`,
          id,
          claimId,
          experimentRunId,
          polarity,
          at,
        )
        return id
      })

    const conclude = (
      dossierId: string,
      conclusionClaimId: string,
      limitations: string,
      at: string = nowIso(),
    ) =>
      db.run(
        `UPDATE research_dossiers SET state='concluded',conclusion_claim_id=?,limitations=?,concluded_at=?
          WHERE id=? AND state='open'`,
        conclusionClaimId,
        limitations.trim(),
        at,
        dossierId,
      )

    const inconclusive = (dossierId: string, limitations: string, at: string = nowIso()) =>
      db.run(
        `UPDATE research_dossiers SET state='inconclusive',limitations=?,concluded_at=? WHERE id=? AND state='open'`,
        limitations.trim(),
        at,
        dossierId,
      )

    const bundle = (dossierId: string) =>
      Effect.all({
        dossier: db.get("SELECT * FROM research_dossiers WHERE id=?", dossierId),
        claims: db.all("SELECT * FROM research_claims WHERE dossier_id=? ORDER BY created_at,id", dossierId),
        artifacts: db.all(
          "SELECT * FROM research_artifacts WHERE dossier_id=? ORDER BY created_at,id",
          dossierId,
        ),
        evidence: db.all(
          `SELECT e.*,a.kind artifact_kind,a.source_ref,a.sha256,a.captured_at,
                  r.verdict,r.command,r.command_status,r.command_exit_code,
                  r.check_command,r.check_status,r.check_exit_code,
                  command_artifact.sha256 command_sha256,check_artifact.sha256 check_sha256
             FROM research_claim_evidence e
             JOIN research_claims c ON c.id=e.claim_id
             LEFT JOIN research_artifacts a ON a.id=e.artifact_id
             LEFT JOIN research_experiment_runs r ON r.id=e.experiment_run_id
             LEFT JOIN research_artifacts command_artifact ON command_artifact.id=r.command_artifact_id
             LEFT JOIN research_artifacts check_artifact ON check_artifact.id=r.check_artifact_id
            WHERE c.dossier_id=? ORDER BY e.added_at,e.id`,
          dossierId,
        ),
      }).pipe(
        Effect.flatMap((result) =>
          Effect.try({
            try: () => {
              for (const value of result.artifacts) {
                const artifact = cast<ArtifactRow>(value)
                if (artifact.content !== null && sha256(artifact.content) !== artifact.sha256) {
                  throw new Error(`Research artifact hash mismatch: ${artifact.id}`)
                }
              }
              return result
            },
            catch: (error) => (error instanceof Error ? error : new Error(String(error))),
          }),
        ),
      )

    const list = (limit = 20) =>
      db.all("SELECT * FROM research_dossiers ORDER BY created_at DESC,id DESC LIMIT ?", limit)

    const render = (dossierId: string) =>
      bundle(dossierId).pipe(
        Effect.flatMap(({ dossier, claims, evidence }) =>
          Effect.try({
            try: () => {
              if (!dossier) throw new Error(`Research dossier not found: ${dossierId}`)
              const byClaim = new Map<string, Row[]>()
              for (const edge of evidence) {
                const id = String(edge.claim_id)
                byClaim.set(id, [...(byClaim.get(id) ?? []), edge])
              }
              const lines = [`dossier: ${dossier.id}`, `問い: ${dossier.question}`, `状態: ${dossier.state}`]
              for (const claim of claims) {
                lines.push(`主張(${claim.kind}/${claim.state}): ${claim.statement}`)
                for (const edge of byClaim.get(String(claim.id)) ?? []) {
                  if (edge.artifact_id) {
                    lines.push(
                      `- ${edge.polarity}: ${edge.source_ref}「${edge.quote}」 sha256=${edge.sha256}`,
                    )
                  } else {
                    lines.push(
                      `- ${edge.polarity}: experiment ${edge.verdict}` +
                        ` / command ${edge.command_status}${edge.command_exit_code === null ? "" : ` exit=${edge.command_exit_code}`}: ${edge.command} sha256=${edge.command_sha256}` +
                        ` / check ${edge.check_status ?? "not-run"}${edge.check_exit_code === null ? "" : ` exit=${edge.check_exit_code}`}: ${edge.check_command} ${edge.check_sha256 ? `sha256=${edge.check_sha256}` : "not-run"}`,
                    )
                  }
                }
              }
              lines.push(`限界: ${dossier.limitations}`)
              return lines.join("\n")
            },
            catch: (error) => (error instanceof Error ? error : new Error(String(error))),
          }),
        ),
      )

    const recordWebDossier = (
      input: {
        question: string
        limitations: string
        snapshots: readonly { url: string; content: string; status: number }[]
        claims: readonly {
          statement: string
          kind: ClaimKind
          evidence: readonly { url: string; quote: string; polarity: EvidencePolarity }[]
        }[]
      },
      at: string = nowIso(),
    ) =>
      db.withImmediateTransaction("record web research dossier", (tx) => {
        const dossierId = randomUUID()
        tx.run(
          "INSERT INTO research_dossiers(id,question,state,created_at) VALUES (?,?,'open',?)",
          dossierId,
          input.question.trim(),
          at,
        )
        const artifacts = input.snapshots.map((snapshot) => {
          if (
            !Number.isInteger(snapshot.status) ||
            snapshot.status < 200 ||
            snapshot.status >= 300 ||
            snapshot.content.length === 0
          ) {
            throw new Error(`Research snapshot was not fetched successfully: ${snapshot.url}`)
          }
          const id = randomUUID()
          tx.run(
            `INSERT INTO research_artifacts
               (id,dossier_id,kind,media_type,content,sha256,source_ref,captured_at,provenance,created_at)
             VALUES (?,?,'source_snapshot','text/plain',?,?,?,?,?,?)`,
            id,
            dossierId,
            snapshot.content,
            sha256(snapshot.content),
            snapshot.url,
            at,
            JSON.stringify({ url: snapshot.url, status: snapshot.status }),
            at,
          )
          return { ...snapshot, id }
        })
        let conclusionId: string | undefined
        for (const item of input.claims) {
          if (item.evidence.length === 0) throw new Error("Research claims require evidence")
          const claimId = randomUUID()
          tx.run(
            "INSERT INTO research_claims(id,dossier_id,statement,kind,state,created_at) VALUES (?,?,?,?,'open',?)",
            claimId,
            dossierId,
            item.statement.trim(),
            item.kind,
            at,
          )
          let support = 0
          let refute = 0
          for (const evidence of item.evidence) {
            if (evidence.quote.trim().length === 0) throw new Error("Research evidence quote cannot be empty")
            const artifact = artifacts.find(
              (candidate) => candidate.url === evidence.url && candidate.content.includes(evidence.quote),
            )
            if (!artifact)
              throw new Error(`Research quote is not present in fetched snapshot: ${evidence.url}`)
            tx.run(
              `INSERT INTO research_claim_evidence(id,claim_id,artifact_id,polarity,quote,added_at)
               VALUES (?,?,?,?,?,?)`,
              randomUUID(),
              claimId,
              artifact.id,
              evidence.polarity,
              evidence.quote,
              at,
            )
            if (evidence.polarity === "support") support += 1
            if (evidence.polarity === "refute") refute += 1
          }
          const state: Exclude<ClaimState, "open"> =
            support > 0 && refute === 0
              ? "supported"
              : refute > 0 && support === 0
                ? "refuted"
                : "inconclusive"
          tx.run("UPDATE research_claims SET state=?,resolved_at=? WHERE id=?", state, at, claimId)
          if (item.kind === "conclusion" && state === "supported") {
            if (conclusionId) throw new Error("Research dossier must have at most one supported conclusion")
            conclusionId = claimId
          }
        }
        tx.run(
          conclusionId
            ? `UPDATE research_dossiers SET state='concluded',conclusion_claim_id=?,limitations=?,concluded_at=? WHERE id=?`
            : `UPDATE research_dossiers SET state='inconclusive',conclusion_claim_id=?,limitations=?,concluded_at=? WHERE id=?`,
          conclusionId ?? null,
          input.limitations.trim(),
          at,
          dossierId,
        )
        return { id: dossierId }
      })

    return {
      open,
      addSnapshot,
      addClaim,
      linkArtifact,
      resolveClaim,
      recordExperiment,
      linkExperiment,
      conclude,
      inconclusive,
      bundle,
      list,
      render,
      recordWebDossier,
    } as const
  })

export class Research extends Context.Service<Research, Effect.Success<ReturnType<typeof makeResearch>>>()(
  "Research",
) {
  static readonly layer = Layer.effect(Research, makeResearch())
}
