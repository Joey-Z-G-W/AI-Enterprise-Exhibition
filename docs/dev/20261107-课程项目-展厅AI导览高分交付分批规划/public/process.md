# Coding process

## Overview and evidence index

One groomed public issue moves through PM, Engineer and independent QA, then publication verification.

[E1 Roles](team.md), [E2 Test boundaries](testing.md) and [E3 Actual activity](tracker.md#current-role-activity) define the handoffs.

## Workflow

1. PM reads the requested outcome, creates or updates the public issue, and defines observable acceptance criteria, allowed files, baseline and exclusions.
2. Engineer reads that issue and the repository context, reports contradictions, and implements only the approved scope.
3. For product changes, Engineer first reproduces expected behavior through an interface, integration or system test, then implements and runs appropriate checks.
4. Engineer reports changed files, exact checks, limitations and unresolved criteria to PM with a task-local JSON handoff.
5. A separate QA agent independently inspects the final diff and checks every criterion, including regressions, privacy and publication scope.
6. Failed criteria return to Engineer; QA rechecks repairs before PM publishes the reviewed change under the user's authorization.
7. PM verifies the pushed branch and public links, records evidence in the issue, and leaves issue closure to the agreed owner workflow.

Documentation-only tasks use link, anchor, command and publication checks without pretending to execute the product suite.

## Evidence rules

Keep one directory per task, using `evidence/` for raw outputs, `scripts/` for temporary tools and `tmp/` for JSON handoffs.

Publish only curated generic English documents explicitly included in the task scope; private evidence remains ignored.

Record facts after they happen, distinguish historical reports from current checks, and never fabricate earlier agent use of the tracker.

Later roadmap batches require their own grooming and acceptance criteria before implementation.
