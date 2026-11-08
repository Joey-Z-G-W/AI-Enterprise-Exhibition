# Course evidence and gaps

English is authoritative.

[Chinese translation](../ch/rubric.md)

## Overview and evidence index

The [official project rubric](https://github.com/DataTalksClub/ai-dev-tools-zoomcamp/blob/main/project/README.md), checked on 2026-11-07, has 12 criteria totaling 24 points and a 10-point passing threshold.

English documentation and three peer reviews are mandatory; deadlines and submission/review workflow belong to the [course platform](https://courses.datatalks.club/ai-dev-tools-2026/).

[E1 README](../../README.md), [E2 Specification](product-spec.md), [E3 Tracker](tracker.md) and [E4 Verification](verification.md) are the review entry points.

## Evidence map

Evidence here supports review; it does not award points or replace a working demonstration.

| Criterion | Maximum | Accessible evidence now | Missing evidence / next step |
| --- | ---: | --- | --- |
| Problem Description | 2 | [README users, problem and expected behavior](../../README.md#functionality-and-expected-behavior). | Reviewer evaluation pending. |
| Product Specification | 2 | [Spec](product-spec.md), public [#12](https://github.com/Joey-Z-G-W/AI-Enterprise-Exhibition/issues/12) acceptance criteria and [actual role activity](tracker.md#current-role-activity). | Earlier documentation/localization receipts remain in #10/#11; reviewer evaluation pending. |
| Agent Team Specification | 2 | [Team roles](team.md), [process](process.md) and [independent implementation QA](https://github.com/Joey-Z-G-W/AI-Enterprise-Exhibition/issues/12#issuecomment-6708934862). | Final operational acceptance is recorded in #12. |
| Context Management | 2 | [Root AGENTS](../../AGENTS.md) links modular repository docs. | Verify every link on the pushed branch. |
| Application | 2 | [CPU React UI](../../frontend/src/DemoApp.tsx), [FastAPI/SQLite](../../src/exhibition_guide/demo.py) and [executed persistence/isolation checks](verification.md#current-delivery-checks). | The original GPU mode remains available; the CPU sample explicitly uses local retrieval, not a live LLM. |
| Testing | 2 | [Unified command](testing.md) and [current CI evidence](verification.md#current-delivery-checks) for Python, browser and Compose. | Budget 1 conservatively. Live acceptance is run separately. |
| Containerization | 2 | [Dockerfile](../../Dockerfile), [Compose](../../compose.yaml) and [executed clean build/recreation](verification.md#current-delivery-checks). | Real named-volume persistence was independently verified; no developer environment or GPU is required. |
| Deployment | 2 | [Local deployment commands](../../README.md#local-deployment-and-rollback) and [real local Docker demo and acceptance](verification.md#local-sample-demonstration). | Loopback-only demonstration, not a public hosted URL; managed release identities are in #12. |
| CI/CD | 3 | [Successful main CI](https://github.com/Joey-Z-G-W/AI-Enterprise-Exhibition/actions/runs/42385984934), [actual automatic dev/manual prod deployments](verification.md#current-delivery-checks) and failed-validation rejection. | Final deployed revision and two-release rollback acceptance are maintained in the [#12 release receipt](https://github.com/Joey-Z-G-W/AI-Enterprise-Exhibition/issues/12). |
| Observability | 2 | No correlated telemetry/UI evidence claimed. | Logs, metrics, traces with shared request identity and privacy checks pending. |
| Alerting on User Impact | 1 | No current alert evidence claimed. | Trigger a user-impact alert and show recovery. |
| On-Call Agent | 2 | No responder evidence claimed. | Stretch: alert-triggered diagnosis, bounded repair and verification. |
| **Total available** | **24** | **No current awarded total asserted.** | **Scores require reviewer judgment and executed evidence.** |

## Delivery targets

[Roadmap #9](https://github.com/Joey-Z-G-W/AI-Enterprise-Exhibition/issues/9) first targets 20–21/24 after the remaining application, delivery and operations work, then approximately 23/24 with the on-call responder.

These are planning targets, not the current score or a guarantee; the conservative Testing budget is 1 because the repository forbids new unit tests while the rubric's maximum asks for unit and integration tests.

The initial target depends on the demonstrated CI/CD level; #12 implements persistence and delivery, while stages 5-6 observability, alerting and on-call response remain pending.

No local historical report, runtime database file or proposed architecture is counted as a newly demonstrated course deliverable.
