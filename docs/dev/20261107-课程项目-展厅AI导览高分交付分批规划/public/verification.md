# Documentation-batch verification

## Overview and evidence index

This batch changes generic documentation and its exact ignore exceptions only; product code and runtime services are outside scope.

[E1 Task acceptance criteria](https://github.com/Joey-Z-G-W/AI-Enterprise-Exhibition/issues/10), [E2 Current role record](tracker.md#current-role-activity), [E3 Startup source](../../../../tools/linux.sh) and [E4 Historical testing](testing.md#historical-evidence-and-score-limit) provide the audit trail.

## Engineer checks

The Engineer read the complete #10 issue, the current official rubric, the source of the Linux launchers, frontend scripts, example configuration, API contracts and the #8 historical QA/publication comments.

Local validation covers Markdown target existence and heading anchors, shell syntax/help, expected launcher command branches, configuration defaults, exact public-document allowlisting and whitespace errors.

Engineer validation passed for 10 Markdown documents and 65 local links/anchors, shell syntax/help, expected command branches and exact ignore behavior.

The [Engineer handoff](https://github.com/Joey-Z-G-W/AI-Enterprise-Exhibition/issues/10#issuecomment-6707553029) records 10 documents and 65 local links/anchors passing, alongside the command and ignore checks, without publishing raw private evidence.

No dependency installation, model download, GPU launch, application test suite, build, deployment or browser acceptance run is claimed for this documentation batch.

## Independent QA and publication

The [independent local QA report](https://github.com/Joey-Z-G-W/AI-Enterprise-Exhibition/issues/10#issuecomment-6707585830) records 10 documents, 65 local links/anchors, 20 ignore probes, the exact 11-file scope, shell syntax/help and unchanged product files passing.

QA found that the specification incorrectly described conflicting answers as a handoff; the Engineer corrected it to the implementation's explicit inability-to-confirm response, and QA rechecked the repair.

Consult that thread for the final reviewed commit, remote publication receipt and pushed-branch retrieval results.

The local review covered AC1–AC7 as applicable before publication, source/command accuracy and exclusions, including ignored evidence/tmp directories and the unchanged vendor pointer; final remote acceptance remains a separate recorded gate.

After publication, PM must retrieve README, AGENTS and all eight linked public task documents at the pushed branch, and verify the branch head equals the reviewed commit.

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
