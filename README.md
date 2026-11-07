# Exhibition AI Guide

English is authoritative.

[Chinese translation](docs/ch/README.md)

An exhibition visitor can ask questions about reviewed exhibits and hear a digital guide explain relevant material while images follow the spoken sentences.

The application helps visitors find reliable information without waiting for a human guide, and helps exhibition staff avoid unsupported answers.

The current interface is Chinese; reviewer documentation is English.

## Overview and evidence index

| Entry | What it explains |
| --- | --- |
| [E1 Product specification](docs/en/product-spec.md) | Users, observable acceptance criteria, implemented scope and roadmap |
| [E2 Architecture](docs/en/architecture.md) | React, FastAPI, OpenTalking, configuration and data boundaries |
| [E3 Agent instructions](AGENTS.md) | Repository-local process, roles and testing rules |
| [E4 Public tracker](docs/en/tracker.md) | Current work, actual role activity and historical baseline |
| [E5 Course evidence](docs/en/rubric.md) | All 12 scoring criteria, gaps and targets |
| [E6 Verification](docs/en/verification.md) | Checks performed for this documentation batch |

## Functionality and expected behavior

The implemented GPU experience combines voice capture, retrieval-backed answers, paragraph speech, a WebRTC avatar, sentence-aligned images, case memory, interruption and an adaptive presentation stage.

Answers should cite supported material, ask for clarification when needed, and acknowledge missing evidence instead of inventing exhibit facts.

A new visitor or an interruption must prevent stale speech and images from returning.

These capabilities are present in the public source; a fresh checkout still needs runtime configuration, models and reviewed content for a complete experience.

## Current limits and demo status

Public baseline `main` at `4e81d9d` contains generic functionality synchronized from `ruika` at `a523fa1` through [issue #8](https://github.com/Joey-Z-G-W/AI-Enterprise-Exhibition/issues/8).

It deliberately excludes the enterprise corpus, private configuration and locally modified vendor tree.

There is no published, usable public demo or deployment for reviewers yet; a public sample corpus and a reproducible walkthrough are pending.

Conversation and tour state are held in memory; a visitor-facing business database and a separately runnable CPU core are planned in [roadmap #9](https://github.com/Joey-Z-G-W/AI-Enterprise-Exhibition/issues/9).

The existing CPU embedding component and health-only development mode do not constitute that proposed CPU application.

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
./tools/linux.sh test
```

This documentation batch checks links, syntax and command definitions only; it does not claim a fresh product test run.
