---
name: evidence-first-engineering
description: Use when implementing, debugging, optimizing, refactoring, investigating, benchmarking, writing evidence-bearing technical reports, or changing agent instructions where scope, correctness, performance, causality, or completion must be justified by observable evidence.
user-invocable: true
argument-hint: "[task, symptom, claim, or artifact]"
---

# Evidence-First Engineering

Make the smallest intervention that closes a predeclared observable gap.

Activity is not progress. A small diff is not automatically a small solution. A passing
component check is not proof that the user's symptom is gone. Broadly understand the
system, then narrowly change it.

## Lifecycle

```text
FRAME -> SURVEY -> EXPAND? -> EXPLAIN -> PROVE RED -> SELECT -> ACT
   ^                                                   |          |
   |                                                   v          v
   +---------------- failed evidence <- VERIFY <- REVIEW? <- GREEN
                                                   |
                                                   v
                                                 CLOSE
```

Use one lifecycle for code, investigations, measurements, reports, and instruction
changes. Adapt the evidence artifact, not the standard of proof.

### Bounded mechanical path

Use `FRAME -> SELECT -> ACT -> VERIFY -> CLOSE` when all of these are observable before
editing:

- The requested transformation is exact and changes no runtime behavior, user-visible
  meaning, measurement claim, or instruction semantics.
- The affected artifact and validator are known.
- The change is local, reversible, authorized, and has no security, persistence, public
  interface, or external side effect.

Examples include a typo, formatting correction, or metadata repair. Write a one-sentence
contract, inspect the affected artifact, make the direct change, and run the structural
validator. Do not invent a cause, failing behavior test, or expansion exercise for a
mechanical transformation. If any predicate above becomes false, return to the full
lifecycle.

## 1. Frame The Observable Gap

Before proposing a solution, write the smallest useful outcome contract:

```text
Observed symptom or question:
User or decision path:
Done when:
Evidence that will decide:
Behavior that must remain true:
Constraints and non-goals:
Measured:
Not measured:
```

For a change request, describe what the user did and observed. For an investigation,
name the decision or claim the evidence must support. For a report, name the claims the
available observations permit.

Define the judge before seeing the result. If later evidence disproves the frame, revise
the contract explicitly and record why. Do not silently move the finish line to match the
result.

**Outcome gate:** solution changes wait until the contract exists and the real path has
been surveyed. Diagnostic probes may run before then.

## 2. Survey Broadly

Follow the actual path end to end before minimizing the intervention:

- Read the relevant implementation, callers, consumers, tests, configuration, state,
  and recent changes.
- Locate a working sibling path and enumerate every material difference.
- Identify shared boundaries where one correction can replace repeated local guards.
- List what the current instrument records and what can change without appearing in it:
  output content, count, order, side effects, permissions, persistence, concurrency,
  lifecycle, deployment state, or another entry point.
- Preserve the vocabulary used at the start. Imported analogies may generate hypotheses;
  they do not get to redefine the observed problem.

Understanding is allowed to be broad. Ownership of new code, state, dependencies, and
concepts should be narrow.

## 3. Expand Only When The Frame Is Uncertain

Before the first probe, name the strongest plausible alternative frame and one relevant
dimension the planned evidence will not observe. This is the minimum expansion pass even
when the answer appears obvious.

Expand before narrowing when causes compete, the requested fix conflicts with evidence,
the first answer depends on an untested assumption, or repeated probes stop producing
information.

Use moves that create distinct predictions:

- Turn a fixed condition into a variable: environment, language, actor, time, scale,
  state, or measurement method.
- Reverse the polarity, subject, or causal direction.
- Search for the same failure structure under a different name, including distant fields.
- Look for the human or organizational version of the phenomenon.
- Ask what the leading explanation fails to predict.
- Point the instrument at itself: could the detector, scorer, benchmark, or terminology
  create the result?
- Enumerate unobserved paths before saying there are none.

Use independent contexts only when they test independent assumptions. Do not fan out by
ritual. If another investigator would receive the same evidence and make the same
prediction, it is duplication.

Record an empty move as `tried; no new candidate`. Stop expanding when the next move has
no distinct prediction or the outcome contract already discriminates the remaining
choices.

Before closing, make one final attempt to falsify the leading explanation. If no distinct
countercheck exists, state that result rather than silently treating it as confirmation.

## 4. Explain Before Correcting

For each credible cause, state:

```text
Hypothesis:
Predicted observation if true:
Cheapest discriminating probe:
Result:
Updated status: supported | weakened | rejected | untested
```

Test one variable at a time. A changed error is information; the same error after the
same class of fix means the approach rests on a wrong assumption. Return to the frame or
architecture instead of layering another patch.

Containment is allowed when root cause cannot yet be established, but label it as
containment, bound its side effects, instrument recurrence, and do not report it as a
root-cause fix.

**Cause gate:** no corrective fix without a stated hypothesis, predicted observation,
and discriminating probe.

## 5. Produce Red Evidence

Before changing the artifact, prove that the evidence can detect the gap.

- Feature or bug fix: observe a failing automated test or executable reproduction.
- Optimization: record the user's baseline path, output, state, metric, conditions, and
  acceptance threshold.
- Refactor: establish characterization checks that pass before and after the change.
- Investigation: predeclare the rubric or observation that separates the hypotheses.
- Technical report: draft the limitations first; remove claims those limits defeat.
- Skill or instruction: run a no-guidance scenario, record the actual failure and its
  rationalization, then rerun the same scenario with the minimal guidance.

When faithful reproduction is unsafe or impossible, use the closest safe probe and name
the missing boundary. A proxy does not become end-to-end evidence by being convenient.

**Red gate:** intended behavior changes require an observed failure first. A throwaway
probe may precede RED, but if retained it becomes production work and returns to this
gate. Mechanically generated output may rely on a tested source definition and a
validator; generation itself is not an exemption from evidence.

## 6. Select The Minimum-Sufficient Intervention

Evaluate this ladder from the top and stop at the first rung that satisfies the outcome
contract:

1. No change: the premise is false, the requirement is already met, or explanation is
   the requested outcome.
2. Delete, disable, configure, constrain, or use existing data.
3. Reuse an existing helper, pattern, path, or schema.
4. Use the standard library or a native language, OS, browser, database, or platform
   capability supported by the actual target versions.
5. Use an already-installed dependency.
6. Correct the root cause at the narrowest shared boundary.
7. Add the least new local code and evidence artifact that fully satisfies the contract.
8. Add a new abstraction, dependency, persistent state, or subsystem only when lower
   rungs are demonstrably insufficient.

Minimize owned mechanism, not characters. Count new concepts, states, configuration,
failure modes, synchronization points, dependencies, and places that must change
together. A longer root-cause correction can be smaller than duplicated guards.

Never minimize away trust-boundary validation, security controls, data-loss prevention,
accessibility, required observability, explicit requirements, or the evidence needed to
know the result works.

**Sufficiency gate:** every higher rung requires evidence that applicable lower rungs do
not satisfy the contract.

## 7. Act Narrowly

Make only changes supported by the evidence. Preserve unrelated working paths. Do not
bundle cleanup, future scaffolding, speculative configurability, one-implementation
interfaces, or unrequested generalization.

The causal path, not the originally named file, defines scope. Change additional files
when the symptom cannot otherwise disappear; do not touch unrelated files merely because
the task is open.

Proceed without ceremony when the contract is clear, the action is reversible, authority
already exists, and there is no external side effect. Obtain user approval before choosing
new user-visible semantics, a UI or public API contract, or one of several materially
different valid designs. Also stop when meaning is materially ambiguous, the action is
destructive or irreversible, a security or authority boundary changes, external
publication or spending is involved, or every route would be guesswork.

If deliberate simplification cuts a real corner, record it near the durable decision:

```text
Simplification: <chosen shortcut>
Ceiling: <observable limit>
Upgrade when: <measurable trigger>
```

Do not mark ordinary concise code as a simplification debt.

## 8. Make Green Evidence Fresh

Run the smallest focused check first, then the canonical gate, then the original user or
decision path. Read the complete output and exit status. Past runs and agent reports are
not current evidence.

For optimizations:

- Keep correctness outside the optimization score as a pass/fail gate.
- Compare the same path and controlled state before and after.
- Compare outputs independently of timing or resource metrics.
- Keep agent-caused failures in the denominator; report excluded runs and reasons.
- Report the recorded keys, sample count, conditions, threshold margin, and unobserved
  dimensions.

For behavior-affecting instruction changes, test activation and compliance separately. A
valid file proves only that the host can parse it. Discovery does not prove invocation;
invocation does not prove obedience. Use fresh contexts, a no-guidance control, pressure
that reproduces the observed rationalization, and negative cases where the instruction
should not apply. Predeclare the judge, acceptable failure rate, decision threshold, and
sample size before seeing results. If the work is only exploratory, use at least five
trials per wording variant, inspect every result, and label the result exploratory; one
success supports only that one scenario. Remove a rule and rerun when deciding whether it
has behavioral effect. Pure typo or metadata fixes need structural validation, not a
behavioral experiment. Put mechanical invariants in code, schemas, linters, or gates
rather than relying on prose.

**Measurement gate:** a better score is rejected when correctness, required output, or
the user path fails.

## 9. Review Independently When It Can Change The Verdict

Use an isolated reviewer for nontrivial changes: behavior, data, persistence, concurrency,
security, public interfaces, performance claims, multi-component changes, or instructions
intended to control future agents.

Give the reviewer the outcome contract, baseline evidence, diff or artifact, and fresh
verification results. Ask for attempts to falsify spec compliance and correctness. Do not
prime the reviewer with the implementer's confidence.

Treat findings as hypotheses. Verify them against the artifact before changing it. Re-run
the relevant evidence after accepted fixes.

## 10. Close On The Original Path

A change is complete only when the original symptom is gone through the path where the
user experienced it, required behavior remains true, and an observation independent of
the changed component confirms the result.

An investigation is complete only when the predeclared evidence answers the decision or
reduces it to an explicit unresolved uncertainty. A report is complete only when every
factual claim points to an observation and every inference is labeled. Distinguish
observation from intervention: an association does not establish cause unless the causal
variable was manipulated or an equivalent identification argument was predeclared. Name
judges, classifiers, and rubrics created after seeing the data.

If the user path cannot be run, report `partial` or `blocked`. A deadline narrows the
claim; it does not lower the evidence standard.

**Closure gate:** unit tests, component benchmarks, code review, smaller diffs, and
plausible explanations are supporting evidence. None substitutes for the contracted end
condition.

## Report Without Inflating The Result

Use this shape when the work involves evidence and no stricter output contract applies:

```text
Status: complete | partial | blocked
Observed: <facts from fresh checks>
Inference: <supported explanation, if any>
Changed: <small factual description>
Evidence: <commands, user-path result, outputs, n, and conditions>
Rejected or empty probes: <material attempts>
Unmeasured / limits: <explicit boundary>
Simplification: <choice, ceiling, upgrade trigger, if any>
```

Separate observation from interpretation. State measured facts directly. State
unmeasured territory as unmeasured rather than weakening the sentence with vague
confidence language. Give ratios with numerators and denominators. Preserve retractions,
failed approaches, and conditions that limit the conclusion.

## Pressure Signals

Return to the relevant gate when reasoning contains any of these moves:

- "The diff is tiny, so it is safer."
- "The unit tests pass, so the bug is fixed."
- "The benchmark improved, so the optimization worked."
- "The requested file must be the cause."
- "There is no time to reproduce or verify."
- "The agent or reviewer said it passed."
- "We already know the rule, so the skill needs no baseline."
- "The file parses, so the skill will activate and be followed."
- "This abstraction may be useful later."

## Limits Of This Skill

This document cannot grant authority, tools, network access, or automatic activation.
Its existence does not establish behavioral effect. Activation and compliance require
separate observation in each host and model. Rules whose violation must be impossible
belong in executable mechanisms, not only in this file.
