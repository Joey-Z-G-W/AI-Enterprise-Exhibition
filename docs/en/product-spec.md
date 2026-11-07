# Exhibition guide product specification

English is authoritative.

[Chinese translation](../ch/product-spec.md)

## Overview and evidence index

Visitors need clear, supportable exhibit explanations; staff need a guide that admits missing knowledge and does not mix one visitor's session with another's.

The current product provides a local GPU avatar experience; the next course batches will add persistent business behavior and reproducible delivery.

[E1 Architecture](architecture.md), [E2 Tracker](tracker.md), [E3 Testing](testing.md) and [E4 Scoring evidence](rubric.md) distinguish source evidence from future acceptance work.

## Implemented scope

The public baseline `4e81d9d` includes a React interface, FastAPI question and session endpoints, OpenTalking retrieval/voice/avatar integration, an optional reviewed media catalog, playback receipts, cancellation and an adaptive stage.

The full experience requires local models, GPU runtime, a configured knowledge base and external service credentials; these are not included as public sample data.

The business service stores visitor context in memory and clears it on shutdown; OpenTalking's own runtime database is not proof of an implemented visitor-facing business persistence flow.

## Observable acceptance criteria

These criteria describe the intended contract of the implemented scope and must be verified against a configured runtime; this documentation batch does not claim a fresh acceptance run.

| ID | Scenario and observable result | Current source evidence |
| --- | --- | --- |
| S1 | A valid supported question returns HTTP 200 with matching visitor/turn identity, answer text and validated source excerpts; ambiguous evidence prompts clarification. | [Question contract](../../src/exhibition_guide/answer.py) |
| S2 | Missing evidence produces an explicit unknown response; conflicting evidence returns `status=answer` and explicitly states that the material conflicts and the correct answer cannot be confirmed. | [Answer decisions](../../src/exhibition_guide/answer.py) |
| S3 | On a configured GPU session, a spoken paragraph retains the same RTC session while verified images follow sentence boundaries; missing/failed images use the shared stage background. | [Presentation coordination](../../frontend/src/lib/presentationCoordinator.ts), [stage](../../frontend/src/App.tsx) |
| S4 | Stop, interruption or a new visitor prevents old callbacks from restoring speech/images; a subsequent visitor does not inherit previous tour state. | [Session context](../../src/exhibition_guide/context.py), [browser integration](../../tests/frontend/stage-browser-integration.cjs) |
| E1 | Disabled answer configuration returns HTTP 503 and `service_not_configured`; invalid request bodies return HTTP 422. | [HTTP application](../../src/exhibition_guide/main.py) |
| E2 | Retrieval/model timeouts return HTTP 504 with a stable error code; other upstream failures return a safe error response, without raw exception details. | [HTTP application](../../src/exhibition_guide/main.py), [answer errors](../../src/exhibition_guide/answer.py) |
| E3 | Stale/conflicting/cancelled turns return HTTP 409; visitor capacity returns HTTP 429. | [HTTP application](../../src/exhibition_guide/main.py) |
| P1 | Public UI configuration exposes only avatar ID and voice, never service credentials; response and error checks must detect leaked keys or private endpoints. | [UI config contract](../../tests/test_ui_config.py) |
| P2 | Any published corpus, screenshot, log or telemetry sample contains no enterprise-only data, visitor personal data or credentials. | Publication review in [process](process.md); continuous telemetry controls remain planned. |

Questions and retrieved material can be sent to the configured external LLM, and narration text to the configured TTS provider; this is not an offline-only product.

Production use needs reviewed provider/data policies; this batch does not claim production privacy certification.

## Public sample-data requirements

A future public walkthrough must ship fictional, author-owned or explicitly licensed material, with a source URL or authorship record, license/permission, retrieval date, stable ID and checksum for each document and image.

Each sample must label historical, proposed and built exhibits accurately, retain source-to-fact mappings, and avoid customer names, email addresses, internal quotations and restricted archives.

Include supported, ambiguous, unknown and conflicting questions, expected observable responses, and at least one image-failure case; publish import/configuration instructions that work from a fresh checkout.

Current synthetic test fixtures demonstrate selected contracts; they do not replace a published end-to-end sample corpus.

## Planned scope

| Batch | Acceptance direction | Status |
| --- | --- | --- |
| 2 | A visitor-facing write/read flow persists business data across restart; provide public samples and groom a CPU core mode independent of avatar hardware. | Pending, [#9](https://github.com/Joey-Z-G-W/AI-Enterprise-Exhibition/issues/9) |
| 3 | One container command starts the documented mode and database; one command runs the supported checks. | Pending |
| 4 | Show deployment, PR checks, dev deployment and rollback, with optional manual production deployment. | Pending |
| 5 | Correlate request logs, metrics and traces in a UI; demonstrate user-impact alert and recovery without private content. | Pending |
| 6 | An alert wakes an agent for diagnosis, a bounded repair and verified recovery. | Pending stretch |

Email consent, expert approval and real email delivery remain in [#1](https://github.com/Joey-Z-G-W/AI-Enterprise-Exhibition/issues/1); additional enterprise content remains in [#6](https://github.com/Joey-Z-G-W/AI-Enterprise-Exhibition/issues/6).
