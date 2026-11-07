# Exhibition AI Guide

English is authoritative.

[Chinese translation](docs/ch/README.md)

An exhibition visitor can ask questions about reviewed exhibits and hear a digital guide explain relevant material while images follow the spoken sentences.

The application helps visitors find reliable information without waiting for a human guide, and helps exhibition staff avoid unsupported answers.

The original GPU interface is Chinese; the CPU sample interface and authoritative reviewer documentation are English.

## Overview and evidence index

| Entry | What it explains |
| --- | --- |
| [E1 Product specification](docs/en/product-spec.md) | Users, observable acceptance criteria, implemented scope and roadmap |
| [E2 Architecture](docs/en/architecture.md) | React, FastAPI, OpenTalking, configuration and data boundaries |
| [E3 Agent instructions](AGENTS.md) | Repository-local process, roles and testing rules |
| [E4 Public tracker](docs/en/tracker.md) | Current work, actual role activity and historical baseline |
| [E5 Course evidence](docs/en/rubric.md) | All 12 scoring criteria, gaps and targets |
| [E6 Verification](docs/en/verification.md) | Executed tests, local Docker demo and release evidence |

## Functionality and expected behavior

The implemented GPU experience combines voice capture, retrieval-backed answers, paragraph speech, a WebRTC avatar, sentence-aligned images, case memory, interruption and an adaptive presentation stage.

Answers should cite supported material, ask for clarification when needed, and acknowledge missing evidence instead of inventing exhibit facts.

A new visitor or an interruption must prevent stale speech and images from returning.

These capabilities are present in the public source; a fresh checkout still needs runtime configuration, models and reviewed content for a complete experience.

## Current limits and demo status

The historical GPU baseline, `main` at `4e81d9d`, contains generic functionality synchronized from `ruika` at `a523fa1` through [issue #8](https://github.com/Joey-Z-G-W/AI-Enterprise-Exhibition/issues/8).

It deliberately excludes the enterprise corpus, private configuration and locally modified vendor tree.

The CPU sample mode adds original fictional exhibits, deterministic evidence retrieval, visitor history and feedback in SQLite, and Docker delivery in [#12](https://github.com/Joey-Z-G-W/AI-Enterprise-Exhibition/issues/12).

It does not call a live LLM or render an avatar; the existing GPU mode remains available below.

The selected deployment is local Docker, with loopback-only dev/prod URLs rather than a public hosted service; see [executed verification and release receipts](docs/en/verification.md).

## CPU sample quick start

Install Docker Engine and Docker Compose, then run from a clean checkout; no Python environment, GPU, API key or private configuration is required.

```bash
docker compose up --build --wait
```

Open [the sample guide](http://127.0.0.1:8090), choose a fictional exhibit, ask one of its example questions, submit feedback, and reload to inspect retained history.

Use the clear-history action to remove your records, or the new-visitor action to start an isolated session.

The app serves the built React interface and FastAPI on one origin; its named `course-demo_guide-data` volume retains SQLite data across restart/recreate.

```bash
docker compose restart
docker compose up --build --force-recreate --wait
```

Do not add `--volumes` to `docker compose down` when retaining visitor data.

If managed dev is already using port 8090, start the standalone sample with `GUIDE_PORT=8092 docker compose up --build --wait` and open port 8092.

Sample authorship, licenses, stable IDs and checksums ship in [sample_data](src/exhibition_guide/sample_data/); no enterprise corpus is required.

## Local deployment and rollback

[Course CI](.github/workflows/ci.yml) runs tests and image builds on GitHub-hosted runners for pull requests and main; only a successful push to this repository's main publishes a deployable image artifact.

A fixed local controller downloads that exact run's artifact with up to 16 bounded parallel byte ranges, verifies the GitHub archive checksum and commit/image identity, starts a candidate, and changes the stable gateway route only after readiness succeeds.

Dev uses port 8090 and volume `course-dev-data`; prod uses port 8091 and volume `course-prod-data`, with distinct visitor cookies.

Stop the standalone Compose sample before starting managed dev on the same port.

```bash
./tools/course_runner.sh install
./tools/course_runner.sh start
./tools/course_runner.sh status
python3 tools/course_deploy.py promote
python3 tools/course_deploy.py rollback --environment prod
./tools/course_runner.sh stop
```

The controller needs Docker access, GitHub CLI authentication with Actions read and Deployments write access, and an online host; no self-hosted Actions runner is registered, and automated PR jobs run only on GitHub-hosted runners.

A manually reviewed PR QA image can be loaded for local acceptance; the automatic deployment controller still accepts only successful main releases.

`install` copies the reviewed controller and its standard-library artifact helper outside the checkout; review and reinstall changes explicitly, and restart after host reboot or configure a user service.

Override `COURSE_CONTROLLER_DIR` and `COURSE_STATE_DIR` for persistent locations; pass the same state path via `--state-dir` before CLI subcommands.

Each deployment records its CI run, exact commit and image ID in local state and [GitHub Deployments](https://github.com/Joey-Z-G-W/AI-Enterprise-Exhibition/deployments); the environment URL is reachable only on the selected host.

Rollback uses the previous health-verified image and retains the database volume; candidates must remain compatible with the existing SQLite schema, and destructive schema migrations need a separate backup/migration design.

Image artifacts expire after 14 days; rollback keeps the verified local image, while a new promotion needs the retained CI artifact.

Detailed acceptance, including two real releases and failed-candidate recovery, is in [testing](docs/en/testing.md).

## Linux setup and development

Run all commands from the repository root on Linux with Git, Bash, Python 3 with pip, curl, tar, xz and sha256sum available, plus access to the configured package and model registries.

The installer provisions Python 3.11, installs locked dependencies, and downloads Node.js 22 if Node is absent; an existing Node must be version 22 or newer.

Install the frontend/backend dependencies and create ignored `config/local.toml` from the example.

```bash
./tools/linux.sh setup
./tools/linux.sh doctor
```

Start the frontend and business backend only, then open [the local interface](http://127.0.0.1:5290).

```bash
./tools/linux.sh dev
```

The default business backend listens on `127.0.0.1:8010`; Vite proxies `/guide` to it and `/opentalking` to port `8210`.

With the default disabled configuration, health and UI configuration are available, but questions return HTTP 503 with `service_not_configured`, and the full avatar experience is unavailable.

Check process health from a second terminal; this does not verify question answering or GPU readiness.

```bash
curl --fail http://127.0.0.1:5290/guide/health
```

## Full GPU experience

Install C/C++ build tools for native runtime dependencies and use a compatible local NVIDIA/CUDA environment; the supplied runtime profile targets an RTX 4060 with 8 GB VRAM, and other hardware has not been validated by this documentation batch.

After the base setup, initialize the pinned OpenTalking submodule and its separate runtime, then download the avatar, speech and embedding models.

```bash
./tools/linux.sh opentalking setup
./tools/linux.sh opentalking download
```

Configure ignored `config/local.toml`: enable and fill the LLM endpoint/model/key, enable the local embedding endpoint/model/dimensions/key, and supply an existing imported knowledge-base ID under `knowledge.kb_id`.

Review ignored `config/opentalking.env` for your hardware; its template is [the public GPU profile](config/opentalking.example.env).

Prepare a knowledge base in OpenTalking using publishable reviewed material, and set up a reviewed media manifest if image narration is required; the public sample preparation walkthrough is still pending.

The local embedding service requires a nonempty token and downloaded weights; the default full runtime also depends on external LLM and Edge TTS services.

Stop any earlier `dev` process with Ctrl+C, then start the frontend, business backend, embedding service and OpenTalking together.

```bash
./tools/linux.sh start
```

The launcher waits for health responses on ports `5290`, `8210` and `8220`; successful startup alone does not prove that the knowledge base, model credentials or media are usable.

## Build and test

Build the frontend after setup.

```bash
./tools/linux.sh build
```

Run the existing combined verification entry point with Google Chrome installed; see [E7 Testing details](docs/en/testing.md) for dependencies, scope and historical limitations.

```bash
./tools/course_verify.sh
```

The command runs Python, existing speech/landscape/browser system regressions and the CPU sample browser journey; executed results and release receipts are recorded in [verification](docs/en/verification.md).
