# Testing policy and execution

English is authoritative.

[Chinese translation](../ch/testing.md)

## Overview and evidence index

New or changed tests must exercise an interface, integration or complete system boundary; no new unit tests are allowed under this repository's policy.

[E1 Combined launcher](../../tools/linux.sh), [E2 Frontend scripts](../../frontend/package.json), [E3 Python configuration](../../pyproject.toml) and [E4 Current verification](verification.md) distinguish runnable commands from this batch's actual checks.

## Test boundaries

| Layer | Entry and assertions | Allowed substitutes |
| --- | --- | --- |
| Interface | Public HTTP/RPC/CLI/message contract; assert responses or externally observable state. | Dependencies outside the tested module boundary. |
| Integration | Multiple real modules assembled; assert their cross-module contract. | Systems outside the assembled application boundary. |
| System | Complete deployed or simulated application; assert the user-visible journey. | No replacement of internal application modules. |

Direct calls to private helpers or isolated business functions, replacement of internal objects/functions, and assertions only about internal call counts/state are unit tests and must not be introduced.

Rewrite or delete unit tests touched by a change; leave unrelated historical tests unchanged rather than expanding the task into a repository-wide cleanup.

## Commands and prerequisites

After the [README setup](../../README.md#linux-setup-and-development), run the existing combined entry point with Google Chrome available.

```bash
./tools/course_verify.sh
```

It runs Python pytest, frontend typecheck/build, browser speech integration, landscape browser integration, landscape system integration, the VAD development-assets integration, the CPU frontend build and the CPU sample real-browser system journey in sequence.

This command is not a claim that every optional script in the repository is included; specialized RTC/GPU checks require their own dependencies and configured runtime.

The browser suites use `playwright-core` with an installed browser; optional embedding checks need downloaded weights and local configuration, and the opt-in GPU cancellation check needs `TOUR_LIVE_ORIGIN`.

Historical helpers and tests remain subject to a boundary audit; no claim is made that all existing files already meet the current policy.

## Historical evidence and score limit

The public [independent migration QA record](https://github.com/Joey-Z-G-W/AI-Enterprise-Exhibition/issues/8#issuecomment-6707409190) reports 366 Python passes, five optional skips, a frontend build and stage browser checks at baseline `4e81d9d`.

Those are historical results from the earlier migration, not a new execution for this documentation change.

The official course rubric asks for both unit and integration tests for its maximum Testing score; this repository prohibits new unit tests, so plan conservatively for 1 point pending an honest audit of untouched historical tests.

## CPU and deployment acceptance

[HTTP integration](../../tests/test_demo_http.py) uses real SQLite and the public application API; [browser system coverage](../../tests/frontend/demo-system.cjs) runs the actual React/FastAPI sample.

[CLI contracts](../../tests/test_deploy_cli.py) exercise subprocess commands without importing deployment internals.

The [release system test](../../tests/deployment/test_release_system.py) is explicitly opt-in because it changes the authorized local dev/prod stacks and requires two distinct successful main CI releases; it never substitutes the application/database or deletes data volumes.

```bash
COURSE_RELEASE_RUN_A=FIRST_SUCCESSFUL_MAIN_RUN_ID \
COURSE_RELEASE_RUN_B=SECOND_SUCCESSFUL_MAIN_RUN_ID \
.venv/bin/python -m pytest tests/deployment/test_release_system.py -q
```

Stop the polling controller during that controlled sequence to prevent automatic dev promotion racing with the test, then start it again afterward.

The sequence deploys and promotes release A, writes a real question/rating, deploys and promotes release B, restarts B, rolls prod back to A, and injects an unhealthy B container before another rollback attempt.

Assertions cover exact release identity, retained history, failed-candidate rejection and an unchanged healthy route; all actions create GitHub Deployment statuses.

Without both run IDs the test reports an explicit skip; ordinary CI cannot claim that this host-specific acceptance has run.

The hosted workflow executes all existing Python regressions, the five browser suites, a CPU image build and a browser journey against the container; only successful push/main runs upload deployable artifacts.

A failing verification step prevents image publication and the controller ignores failed CI runs; PR validation never runs on the local Docker host.

## Local controller lifecycle

`tools/course_runner.sh install` copies only the reviewed standalone controller; `start` checks GitHub login and Docker, then starts a background process, while `stop` verifies its PID command before termination.

Keep its state/artifact directory outside temporary worktrees; configure a user service if it must resume after reboot, and explicitly review/reinstall controller updates.

The host must remain online and retain Docker access and GitHub authentication; stopping the controller leaves existing application containers running and pauses future deployment processing.
