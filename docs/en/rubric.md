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
| Product Specification | 2 | [Spec](product-spec.md), public [#10](https://github.com/Joey-Z-G-W/AI-Enterprise-Exhibition/issues/10) AC and [historical PM/Engineer/QA record](tracker.md#historical-documentation-activity). | Consult #10 for the historical publication receipt and #11 for the localization review; reviewer evaluation pending. |
| Agent Team Specification | 2 | [Team roles](team.md) and [process](process.md). | Historical QA is recorded on #10/#11; current application/delivery QA belongs to #12. |
| Context Management | 2 | [Root AGENTS](../../AGENTS.md) links modular repository docs. | Verify every link on the pushed branch. |
| Application | 2 | [React](../../frontend/src/App.tsx), [FastAPI](../../src/exhibition_guide/main.py) and historical [#8](https://github.com/Joey-Z-G-W/AI-Enterprise-Exhibition/issues/8). | CPU SQLite sample flow and [HTTP/browser tests](testing.md#cpu-and-deployment-acceptance) are implemented in #12; final executed evidence is in [verification](verification.md). |
| Testing | 2 | [Test command and historical results](testing.md). | Fresh reproducible result and legacy boundary audit pending; budget 1 conservatively. |
| Containerization | 2 | [Dockerfile](../../Dockerfile) and [Compose](../../compose.yaml) start the CPU UI/API/SQLite. | Actual image, restart and browser acceptance in #12. |
| Deployment | 2 | [Local deployment commands](../../README.md#local-deployment-and-rollback), dev 8090/prod 8091. | Local Docker demonstration, not a public hosted URL; executed evidence in #12. |
| CI/CD | 3 | [Hosted CI](../../.github/workflows/ci.yml), trusted-main controller, manual prod and rollback. | Actual CI/deployment links and failure evidence required in #12. |
| Observability | 2 | No correlated telemetry/UI evidence claimed. | Logs, metrics, traces with shared request identity and privacy checks pending. |
| Alerting on User Impact | 1 | No current alert evidence claimed. | Trigger a user-impact alert and show recovery. |
| On-Call Agent | 2 | No responder evidence claimed. | Stretch: alert-triggered diagnosis, bounded repair and verification. |
| **Total available** | **24** | **No current awarded total asserted.** | **Scores require reviewer judgment and executed evidence.** |

## Delivery targets

[Roadmap #9](https://github.com/Joey-Z-G-W/AI-Enterprise-Exhibition/issues/9) first targets 20–21/24 after the remaining application, delivery and operations work, then approximately 23/24 with the on-call responder.

These are planning targets, not the current score or a guarantee; the conservative Testing budget is 1 because the repository forbids new unit tests while the rubric's maximum asks for unit and integration tests.

The initial target depends on the demonstrated CI/CD level; #12 implements persistence and delivery, while stages 5-6 observability, alerting and on-call response remain pending.

No local historical report, runtime database file or proposed architecture is counted as a newly demonstrated course deliverable.
