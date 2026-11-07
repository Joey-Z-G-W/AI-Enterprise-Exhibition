# Testing policy and execution

## Overview and evidence index

New or changed tests must exercise an interface, integration or complete system boundary; no new unit tests are allowed under this repository's policy.

[E1 Combined launcher](../../../../tools/linux.sh), [E2 Frontend scripts](../../../../frontend/package.json), [E3 Python configuration](../../../../pyproject.toml) and [E4 Current verification](verification.md) distinguish runnable commands from this batch's actual checks.

## Test boundaries

| Layer | Entry and assertions | Allowed substitutes |
| --- | --- | --- |
| Interface | Public HTTP/RPC/CLI/message contract; assert responses or externally observable state. | Dependencies outside the tested module boundary. |
| Integration | Multiple real modules assembled; assert their cross-module contract. | Systems outside the assembled application boundary. |
| System | Complete deployed or simulated application; assert the user-visible journey. | No replacement of internal application modules. |

Direct calls to private helpers or isolated business functions, replacement of internal objects/functions, and assertions only about internal call counts/state are unit tests and must not be introduced.

Rewrite or delete unit tests touched by a change; leave unrelated historical tests unchanged rather than expanding the task into a repository-wide cleanup.

## Commands and prerequisites

After the [README setup](../../../../README.md#linux-setup-and-development), run the existing combined entry point with Google Chrome available.

```bash
./tools/linux.sh test
```

It runs Python pytest, frontend typecheck/build, browser speech integration, landscape browser integration and landscape system integration in sequence.

This command is not a claim that every optional script in the repository is included; specialized RTC/GPU checks require their own dependencies and configured runtime.

The browser suites use `playwright-core` with an installed browser; optional embedding checks need downloaded weights and local configuration, and the opt-in GPU cancellation check needs `TOUR_LIVE_ORIGIN`.

Historical helpers and tests remain subject to a boundary audit; no claim is made that all existing files already meet the current policy.

## Historical evidence and score limit

The public [independent migration QA record](https://github.com/Joey-Z-G-W/AI-Enterprise-Exhibition/issues/8#issuecomment-6707409190) reports 366 Python passes, five optional skips, a frontend build and stage browser checks at baseline `4e81d9d`.

Those are historical results from the earlier migration, not a new execution for this documentation change.

The official course rubric asks for both unit and integration tests for its maximum Testing score; this repository prohibits new unit tests, so plan conservatively for 1 point pending an honest audit of untouched historical tests.
