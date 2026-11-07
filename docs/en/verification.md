# Verification and release evidence

English is authoritative.

[Chinese translation](../ch/verification.md)

## Overview and evidence index

[#12](https://github.com/Joey-Z-G-W/AI-Enterprise-Exhibition/issues/12) covers persistent CPU samples and roadmap stages 2-4, starting from main `f9943c9` in an isolated worktree.

[E1 Acceptance criteria](https://github.com/Joey-Z-G-W/AI-Enterprise-Exhibition/issues/12), [E2 Role activity](tracker.md#current-role-activity), [E3 Test commands](testing.md) and [E4 CI workflow](../../.github/workflows/ci.yml) are the audit entry points.

Source implementation is separate from executed evidence; independent QA and final remote release acceptance must be recorded before the issue is considered complete.

## Current delivery checks

The delivery CLI's four interface tests first failed because the command did not exist, then passed after implementation; the optional two-release system test reports a skip until actual main CI run IDs are supplied.

Docker Compose configuration validation passed locally; the first local image build was blocked before compilation by registry requests returning EOF from the host Docker daemon.

That network failure is not a passing container test; a hosted image build and actual local container/browser acceptance remain required.

Shell syntax and Python compilation checks passed for the new delivery scripts.

| Gate | Status and required evidence |
| --- | --- |
| Full Python and real-browser regression | Pending final combined result and independent QA. |
| CPU Compose startup/restart and browser journey | Pending actual image and retained SQLite records. |
| PR/main CI success | Pending public run URL and exact commit. |
| Controlled validation failure | Pending failed run or failed-candidate record proving delivery stays blocked. |
| Automatic dev deployment | Pending successful GitHub Deployment with exact CI run/image/commit. |
| Manual prod promotion and rollback | Pending two real releases, retained records and failed-candidate rejection. |
| Publication | Pending final reviewed main commit, public links and independent acceptance. |

The final PM release receipt in #12 must replace pending operational claims with actual run/deployment links; configuration files alone do not satisfy those gates.

## Current localization checks

English README/AGENTS and eight `docs/en/` pages remain authoritative, with a complete corresponding Chinese set under `docs/ch/`.

The delivery update must preserve reciprocal links, exact command blocks, no Chinese characters or CJK punctuation in raw English Markdown, and ignored task evidence.

Independent QA must check the final diff and both language sets, not only the earlier localization baseline.

## Historical evidence

The [#8 migration QA](https://github.com/Joey-Z-G-W/AI-Enterprise-Exhibition/issues/8#issuecomment-6707409190) reported 366 Python passes and five optional skips at baseline `4e81d9d`; those results remain historical.

Historical [#10 local QA](https://github.com/Joey-Z-G-W/AI-Enterprise-Exhibition/issues/10#issuecomment-6707585830) checked ten documents, 65 links/anchors, 20 ignore probes and unchanged product files; its [final publication acceptance](https://github.com/Joey-Z-G-W/AI-Enterprise-Exhibition/issues/10#issuecomment-6707633096) is separate from this runtime task.

[#11](https://github.com/Joey-Z-G-W/AI-Enterprise-Exhibition/issues/11) established English-primary documentation and complete Chinese translations; it did not execute the new CPU/Docker delivery path.

## Recheck commands

```bash
git diff --check
bash -n tools/course_verify.sh tools/course_runner.sh
python3 -m py_compile tools/course_deploy.py tools/course_proxy.py
./tools/course_verify.sh
```

The complete verification command requires installed Python/Node dependencies and Google Chrome; host-specific release acceptance additionally requires two actual main CI artifacts, GitHub permissions and Docker access as described in [testing](testing.md#cpu-and-deployment-acceptance).
