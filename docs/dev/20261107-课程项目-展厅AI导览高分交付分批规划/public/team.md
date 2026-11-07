# Agent team

## Overview and evidence index

The current workflow separates requirements, implementation and independent acceptance.

[E1 Process](process.md) describes the sequence; [E2 Tracker activity](tracker.md#current-role-activity) records what actually happened in this batch.

| Role | Responsibility | Handoff |
| --- | --- | --- |
| PM / coordinating agent | Clarify scope, maintain public issues, set acceptance criteria, protect the active user workspace and publish authorized reviewed work. | Issue with baseline, scope and acceptance criteria. |
| Engineer agent | Read the issue and source, implement approved files, run appropriate checks and report limitations. | Changed files, exact check results and task-local JSON report. |
| Independent QA agent | Inspect the Engineer's final diff and verify acceptance criteria without self-approval or silent product edits. | Pass/fail by criterion, evidence and required repairs. |
| Operations / on-call (planned) | Define deployment and rollback procedures, user-impact alert handling and bounded repairs; this role has not run an on-call workflow in this batch. | Future deployment/rollback evidence and alert → diagnosis → authorized repair → business recovery acceptance. |
| Human owner | Set product priorities, authorize actions beyond current scope and provide final experiential feedback. | Decisions and feedback through PM. |

## Working agreements

PM handles user communication; agents report to PM and reuse the same task directory.

An agent may write only files explicitly approved by PM; read-only investigation does not authorize changes elsewhere.

Engineer and QA must be distinct execution roles, even if public issue comments are posted by the same coordinating account.

Task-local JSON handoffs and raw logs remain private by default; the public tracker receives a concise factual summary with links to curated evidence.

Manual production publication and rollback decisions remain with the authorized release owner; a future responder must use scoped repair permissions and return to a human when those limits are reached.
