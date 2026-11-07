# Public tracker and delivery record

English is authoritative.

[Chinese translation](../ch/tracker.md)

## Overview and evidence index

Task #12 delivers roadmap batches 2-4: persistent CPU samples, reproducible Docker delivery and trusted-main local CI/CD.

Task #11 previously made English authoritative and confined complete translations to `docs/ch/`.

[E1 Current task #12](https://github.com/Joey-Z-G-W/AI-Enterprise-Exhibition/issues/12), [E2 Roadmap #9](https://github.com/Joey-Z-G-W/AI-Enterprise-Exhibition/issues/9) and [E3 Verification](verification.md) provide the active scope and evidence.

## Existing tasks

| Issue | Role in delivery | Current interpretation |
| --- | --- | --- |
| [#1 Email follow-up](https://github.com/Joey-Z-G-W/AI-Enterprise-Exhibition/issues/1) | Consent, expert review and real email delivery. | Future work; not implemented by this batch. |
| [#6 Content expansion](https://github.com/Joey-Z-G-W/AI-Enterprise-Exhibition/issues/6) | Review further archived enterprise cases/images. | Separate content work; no enterprise archive published here. |
| [#7 Adaptive stage](https://github.com/Joey-Z-G-W/AI-Enterprise-Exhibition/issues/7) | Avatar/material layout and smooth no-image states. | Historical implemented feature; issue remains open for user feedback. |
| [#8 Synchronize to main](https://github.com/Joey-Z-G-W/AI-Enterprise-Exhibition/issues/8) | Transfer accepted generic functionality from `ruika`. | Historical sync and independent QA at `4e81d9d`. |
| [#9 Course roadmap](https://github.com/Joey-Z-G-W/AI-Enterprise-Exhibition/issues/9) | Persistence, reproducibility, deployment and operations. | Batches 2-4 are in #12; stages 5-6 remain pending; targets are not awarded scores. |
| [#10 English docs and workflow](https://github.com/Joey-Z-G-W/AI-Enterprise-Exhibition/issues/10) | Historical documentation batch with AC1–AC7. | Published at `f30f180`; prior Engineer/QA evidence is retained below. |
| [#11 English primary and Chinese translations](https://github.com/Joey-Z-G-W/AI-Enterprise-Exhibition/issues/11) | Current language/path migration with AC1–AC6. | Complete translations, raw-English checks and independent publication review. |
| [#12 CPU samples and Docker CI/CD](https://github.com/Joey-Z-G-W/AI-Enterprise-Exhibition/issues/12) | Current runtime/delivery task with AC1-AC12. | Implementation and actual verification are tracked separately. |

## Baseline record

The original product baseline is [4e81d9d](https://github.com/Joey-Z-G-W/AI-Enterprise-Exhibition/commit/4e81d9d09b99002e254d9965b5f1ca37c415f9ad); the source feature branch is `ruika` at `a523fa1`.

The [#8 publication record](https://github.com/Joey-Z-G-W/AI-Enterprise-Exhibition/issues/8#issuecomment-6707410043) confirms the generic main synchronization, including the earlier Linux support.

That migration retained generic configuration and excluded enterprise content and private configuration; the historical documentation branch did not alter product source, vendor gitlinks or the original running workspace.

## Historical documentation activity

This historical record describes task #10 on 2026-11-07, published at `f30f180`; it does not represent a fresh product test run or the current #11 localization QA.

| Role | Actual activity | Evidence/status |
| --- | --- | --- |
| PM | Created roadmap #9 and groomed #10 with AC1–AC7, an isolated main-based worktree and an explicit documentation-only scope. | [PM handoff](https://github.com/Joey-Z-G-W/AI-Enterprise-Exhibition/issues/10#issuecomment-6707504126), [#9](https://github.com/Joey-Z-G-W/AI-Enterprise-Exhibition/issues/9). |
| Engineer | A GPT-6 Astra Engineer read #10 and the rubric, inspected main contracts, authored the English documents, and repaired the QA finding about conflicting evidence. | [Engineer handoff](https://github.com/Joey-Z-G-W/AI-Enterprise-Exhibition/issues/10#issuecomment-6707553029) and [verification](verification.md). |
| Independent QA | A separate GPT-6.1 Sol QA agent checked the documents against source, identified inaccurate handoff wording, and independently verified its correction; local checks passed. | [Initial finding](https://github.com/Joey-Z-G-W/AI-Enterprise-Exhibition/issues/10#issuecomment-6707568906), [local QA result](https://github.com/Joey-Z-G-W/AI-Enterprise-Exhibition/issues/10#issuecomment-6707585830); final publication acceptance is recorded in #10. |
| PM publication | Commit/push and verify public branch documents after QA. | Consult [#10](https://github.com/Joey-Z-G-W/AI-Enterprise-Exhibition/issues/10) for the final reviewed commit, publication receipt and remote retrieval results. |

The local QA report is deliberately separate from the [final publication acceptance](https://github.com/Joey-Z-G-W/AI-Enterprise-Exhibition/issues/10#issuecomment-6707633096), which records the reviewed commit and remote acceptance result for historical #10.

## Historical localization activity

Task [#11](https://github.com/Joey-Z-G-W/AI-Enterprise-Exhibition/issues/11) starts from `main` at `f30f180` and reuses the existing task directory for ignored evidence.

| Role | Actual activity | Evidence/status |
| --- | --- | --- |
| PM | Groomed the English-primary policy, complete Chinese translation set and exact allowed file scope in #11. | [PM handoff](https://github.com/Joey-Z-G-W/AI-Enterprise-Exhibition/issues/11#issuecomment-6707689086) and #11 acceptance criteria. |
| Engineer | Read #11, migrated the eight English modules to ASCII paths, translated all ten pages and updated reciprocal navigation and publication rules. | Current diff and [localization verification](verification.md#current-localization-checks). |
| Independent QA | Independent acceptance is required for language purity, translation completeness, navigation and scope. | Consult #11 for the actual QA result. |
| PM publication | Publish reviewed documents and verify remote main and public file contents. | Consult #11 for the final reviewed commit, publication receipt and remote retrieval results. |

This language migration does not claim new application, GPU or browser test execution.

## Current role activity

[#12](https://github.com/Joey-Z-G-W/AI-Enterprise-Exhibition/issues/12) starts from main `f9943c9` in a separate worktree; the original GPU workspace, vendor modifications and unrelated containers are excluded.

| Role | Actual activity | Evidence/status |
| --- | --- | --- |
| PM | Groomed AC1-AC12, separate application/delivery scopes and local Docker deployment. | [PM handoff](https://github.com/Joey-Z-G-W/AI-Enterprise-Exhibition/issues/12#issuecomment-6708111741). |
| Application Engineer | Implemented CPU sample retrieval, persistent isolated sessions/questions/feedback and HTTP/browser tests. | Source diff; exact checks in [verification](verification.md). |
| Delivery Engineer | Implemented Compose/image packaging, combined verification, hosted CI and a fixed trusted-main deployment controller. | CLI tests and source diff; actual container/CI/CD results recorded separately. |
| Independent QA | Must inspect AC1-AC12, publication scope, runtime isolation and operational evidence. | Pending independent acceptance; consult #12 for final result. |
| PM publication | Must publish reviewed code, verify main CI and real local deployment, promotion and rollback. | Pending final release receipt in #12. |

Stages 5-6 remain open in #9; no new observability, alerting or on-call responder completion is claimed.
