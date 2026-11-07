# Documentation-batch verification

English is authoritative.

[Chinese translation](../ch/verification.md)

## Overview and evidence index

Task #11 changes documentation language, paths and exact ignore exceptions only; product code and runtime services are outside scope.

[E1 Current task acceptance criteria](https://github.com/Joey-Z-G-W/AI-Enterprise-Exhibition/issues/11), [E2 Current role record](tracker.md#current-role-activity), [E3 Startup source](../../tools/linux.sh) and [E4 Historical testing](testing.md#historical-evidence-and-score-limit) provide the audit trail.

## Historical Engineer checks

The Engineer for historical task #10, published at `f30f180`, read the complete #10 issue, the current official rubric, the source of the Linux launchers, frontend scripts, example configuration, API contracts and the #8 historical QA/publication comments.

Local validation covers Markdown target existence and heading anchors, shell syntax/help, expected launcher command branches, configuration defaults, exact public-document allowlisting and whitespace errors.

Engineer validation passed for 10 Markdown documents and 65 local links/anchors, shell syntax/help, expected command branches and exact ignore behavior.

The [Engineer handoff](https://github.com/Joey-Z-G-W/AI-Enterprise-Exhibition/issues/10#issuecomment-6707553029) records 10 documents and 65 local links/anchors passing, alongside the command and ignore checks, without publishing raw private evidence.

No dependency installation, model download, GPU launch, application test suite, build, deployment or browser acceptance run was claimed for that historical documentation batch; the same exclusions apply to current task #11.

## Historical independent QA and publication

The [independent local QA report](https://github.com/Joey-Z-G-W/AI-Enterprise-Exhibition/issues/10#issuecomment-6707585830) records 10 documents, 65 local links/anchors, 20 ignore probes, the exact 11-file scope, shell syntax/help and unchanged product files passing.

QA found that the specification incorrectly described conflicting answers as a handoff; the Engineer corrected it to the implementation's explicit inability-to-confirm response, and QA rechecked the repair.

The [final publication acceptance](https://github.com/Joey-Z-G-W/AI-Enterprise-Exhibition/issues/10#issuecomment-6707633096) records the reviewed commit, remote publication receipt and pushed-branch retrieval results for historical #10.

The local review covered AC1–AC7 as applicable before publication, source/command accuracy and exclusions, including ignored evidence/tmp directories and the unchanged vendor pointer; final remote acceptance remains a separate recorded gate.

The historical publication gate required retrieving README, AGENTS and all eight linked public task documents at the pushed branch and matching its head to the reviewed commit.

## Current localization checks

Engineer validation for #11 checks all ten English raw Markdown files for Chinese characters and CJK punctuation, the ten complete Chinese counterparts, reciprocal links, local targets/anchors, identical command blocks, table/section coverage and exact publication scope.

The eight old public task documents are removed; only the eight `docs/en/` modules and ten `docs/ch/` translations are allowed under public docs, while task evidence remains ignored.

The baseline is `main` at `f30f180`; previous #10 document checks and #8 product tests remain historical evidence, not new executions.

Independent QA must verify language purity, faithful translation, navigation and unchanged product files; consult [#11](https://github.com/Joey-Z-G-W/AI-Enterprise-Exhibition/issues/11) for the actual QA result, final reviewed commit, remote publication receipt and retrieval checks.

After publication, PM must retrieve the two root English documents, eight English modules and ten Chinese translations from remote main and match its head to the reviewed commit.

## Recheck commands

Check whitespace in the current diff.

```bash
git diff --check
```

Check shell parsing without installing or starting anything.

```bash
bash -n tools/linux.sh tools/opentalking.sh
```

Read the supported Linux entry-point commands without starting services.

```bash
./tools/linux.sh --help
```
