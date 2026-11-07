# Repository agent instructions

Build one exhibition guide application with React, FastAPI and OpenTalking; distinguish implemented behavior from proposed work.

Start with the [product specification](docs/dev/20261107-课程项目-展厅AI导览高分交付分批规划/public/20261107-课程项目-展厅AI导览高分交付分批规划-spec.md) and [architecture/context](docs/dev/20261107-课程项目-展厅AI导览高分交付分批规划/public/architecture.md).

## Required context

- Follow the [coding process](docs/dev/20261107-课程项目-展厅AI导览高分交付分批规划/public/process.md) for one groomed issue at a time.
- Use the [team responsibilities](docs/dev/20261107-课程项目-展厅AI导览高分交付分批规划/public/team.md): PM → Engineer → independent QA.
- Follow the [testing boundaries](docs/dev/20261107-课程项目-展厅AI导览高分交付分批规划/public/testing.md); add only interface, integration or system tests.
- Consult the [public tracker](docs/dev/20261107-课程项目-展厅AI导览高分交付分批规划/public/tracker.md) and [evidence map](docs/dev/20261107-课程项目-展厅AI导览高分交付分批规划/public/rubric.md) before claiming completion.

## Work boundaries

Read the issue's acceptance criteria and allowed file scope before editing; raise contradictions with the PM rather than silently changing scope.

For product changes, first reproduce the expected difference through an interface, integration or system test, then implement and validate.

Do not add unit tests; rewrite or remove touched unit tests, and leave unrelated legacy tests alone.

An independent QA agent must verify each acceptance criterion and publication scope; the Engineer cannot approve their own work.

Keep one task directory per requirement under `docs/dev/YYYYMMDD-module-detailed-requirement/`, or per incident under `docs/problem/YYYYMMDD-version-module-detailed-symptom/`.

Reuse an existing task directory and keep evidence, temporary scripts and intermediate JSON reports in its `evidence/`, `scripts/` and `tmp/` subdirectories.

Keep only explicitly approved generic documents in a task's `public/` directory; do not broadly unignore docs.

Never commit credentials, customer corpora, private configuration, downloaded models, vendor working-tree changes or unrelated user edits.

Use a separate worktree when another branch runs the local experience; do not stop its services or overwrite its README.

Record actual role activity and exact checks in the issue, label historical results, and keep unresolved acceptance criteria pending.

The current task is [#10](https://github.com/Joey-Z-G-W/AI-Enterprise-Exhibition/issues/10), based on `main` at `4e81d9d`; later runtime and operations work belongs to [#9](https://github.com/Joey-Z-G-W/AI-Enterprise-Exhibition/issues/9).
