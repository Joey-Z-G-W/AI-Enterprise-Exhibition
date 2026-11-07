# Repository agent instructions

English is authoritative.

[Chinese translation](docs/ch/agent-guide.md)

Build one exhibition guide application with React, FastAPI and OpenTalking; distinguish implemented behavior from proposed work.

Start with the [product specification](docs/en/product-spec.md) and [architecture/context](docs/en/architecture.md).

## Required context

- Follow the [coding process](docs/en/process.md) for one groomed issue at a time.
- Use the [team responsibilities](docs/en/team.md): PM → Engineer → independent QA.
- Follow the [testing boundaries](docs/en/testing.md); add only interface, integration or system tests.
- Consult the [public tracker](docs/en/tracker.md) and [evidence map](docs/en/rubric.md) before claiming completion.

## Work boundaries

Read the issue's acceptance criteria and allowed file scope before editing; raise contradictions with the PM rather than silently changing scope.

For product changes, first reproduce the expected difference through an interface, integration or system test, then implement and validate.

Do not add unit tests; rewrite or remove touched unit tests, and leave unrelated legacy tests alone.

An independent QA agent must verify each acceptance criterion and publication scope; the Engineer cannot approve their own work.

Keep one task directory per requirement under `docs/dev/YYYYMMDD-module-detailed-requirement/`, or per incident under `docs/problem/YYYYMMDD-version-module-detailed-symptom/`.

Reuse an existing task directory and keep evidence, temporary scripts and intermediate JSON reports in its `evidence/`, `scripts/` and `tmp/` subdirectories.

Keep authoritative project documentation in English: root `README.md` and `AGENTS.md`, plus the eight modules under `docs/en/`.

Keep one complete secondary Chinese translation set only under `docs/ch/`, using `agent-guide.md` for the agent-instruction translation; English remains authoritative.

English Markdown must contain no Chinese characters or CJK punctuation, including paths, link targets and code blocks; use ASCII filenames and paths rather than encoded non-ASCII paths.

Link each English page to its Chinese translation with an English label, and each translation back to its English source; update both sets together and preserve facts, commands, limitations and pending statuses.

Publish only exactly allowlisted documents; keep private task evidence ignored and do not retain public copies under task directories.

Never commit credentials, customer corpora, private configuration, downloaded models, vendor working-tree changes or unrelated user edits.

Use a separate worktree when another branch runs the local experience; do not stop its services or overwrite its README.

Record actual role activity and exact checks in the issue, label historical results, and keep unresolved acceptance criteria pending.

The current language migration is [#11](https://github.com/Joey-Z-G-W/AI-Enterprise-Exhibition/issues/11), based on `main` at `f30f180`; the earlier documentation task is [#10](https://github.com/Joey-Z-G-W/AI-Enterprise-Exhibition/issues/10), and later runtime and operations work belongs to [#9](https://github.com/Joey-Z-G-W/AI-Enterprise-Exhibition/issues/9).
