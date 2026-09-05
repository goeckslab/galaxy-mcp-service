# Client validation

This document records real client and Galaxy validation separately from automated tests.

## Product surface

Version 0.4 exposes 29 public actions across connection, histories, datasets, collections, installed tools, jobs, stored workflows, workflow invocations, and curated IWC workflows, plus one private app-only HTML report loader. `run_tool` returns on acceptance; `get_tool_request_status` resumes observation without resubmission, and `get_run_status` presents an existing tool request or workflow invocation in a read-only status card. The earlier four compatibility probes were removed from the public tool catalog.

Local-path upload/download, direct history deletion, and unrestricted user-tool management are not exposed to remote clients.

## Validation matrix

| Date | Client | Connection | Result |
| --- | --- | --- | --- |
| 2026-08-30 | MCP SDK integration tests | In-process mock Galaxy | Passed read, write, input-validation, annotation, secret-redaction, and protocol checks |
| 2026-08-30 | Local MCP SDK client | `http://127.0.0.1:8080/mcp` to usegalaxy.org | Discovered 26 actions; server, user, histories, tool search, and stored-workflow reads passed |
| 2026-08-30 | Local MCP SDK client | `http://127.0.0.1:8080/mcp` to usegalaxy.org | Created an isolated test history, uploaded the public 1 KB `3.fastqsanger` fixture, ran FastQC 0.74+galaxy1, and verified one input plus two outputs reached `ok`; producing job ended `ok` with exit code 0 |
| 2026-08-30 | ChatGPT direct Chat | OpenAI Secure MCP Tunnel | Refreshed and discovered 26 real actions; a live `get_history_details` call returned the expected name, state, count, and id |
| 2026-08-30 | ChatGPT direct Chat | OpenAI Secure MCP Tunnel to usegalaxy.org | Exercised all 26 actions. Read paths passed; an isolated URL upload and FastQC run produced an `ok` job and two `ok` outputs; an IWC workflow imported successfully; a fresh QA invocation was created, cancelled, and read back as `cancelled`. Screenshot evidence was delivered to Slack. |
| 2026-08-30 | ChatGPT Work | OpenAI Secure MCP Tunnel | The same live call reached Galaxy and completed with HTTP 200, but Work omitted the returned fields from its final answer; tracked as a client result-handoff issue |
| 2026-08-31 | ChatGPT direct Chat | OpenAI Secure MCP Tunnel to usegalaxy.org | Created a fresh history, uploaded the public FASTQ fixture, displayed an actual read preview, ran FastQC, listed the input plus HTML and RawData outputs, displayed the RawData peek, and verified the producing job was `ok` with exit code 0. |
| 2026-08-31 | ChatGPT direct Chat | OpenAI Secure MCP Tunnel to usegalaxy.org | Rendered the live FastQC history as the v5 MCP Apps card with three typed, ready items: the FASTQ input, HTML report, and text result. |
| 2026-08-31 | ChatGPT direct Chat | OpenAI Secure MCP Tunnel to usegalaxy.org | Discovered 27 actions, read the complete 14,197-character FastQC RawData result through `get_dataset_text`, and produced a grounded assessment with 7 pass, 0 warn, and 4 fail modules plus the correct five-read sample-size limitation. |
| 2026-08-31 | ChatGPT direct Chat | OpenAI Secure MCP Tunnel to usegalaxy.org | Rendered the v6 history card, clicked the completed FastQC RawData row, and verified that the card called `get_dataset_text` and displayed the real FastQC version, Basic Statistics, all module flags, and a raw-text disclosure. Screenshot evidence was delivered to Slack. |
| 2026-08-31 | ChatGPT direct Chat | OpenAI Secure MCP Tunnel to usegalaxy.org | Rendered the v7 history card, clicked the completed FastQC Webpage row, and verified the full 888,758-character HTML report displayed Summary, Basic Statistics, and embedded plots inside the sandboxed viewer. The private loader stayed app-only; scripts, forms, links, and external network access were disabled. Screenshot evidence was delivered to Slack. |
| 2026-09-02 | ChatGPT direct Chat | OpenAI Secure MCP Tunnel to usegalaxy.org | Reopened a v7 history-content conversation after deploying v8 and verified that the legacy resource URI rehydrated successfully. The card showed human-readable names, types, and states without internal IDs; the v8 local browser matrix also passed at 360, 520, and 768 CSS pixels with keyboard-accessible horizontal scrolling for raw text and wide HTML reports. |

## Version 0.3 local review — 2026-09-05

The local automated suite passes 39 tests, including resumable submission, missing-handle errors, pagination, OAuth-provider compatibility, request cancellation, redirect rejection, health Host checks, and UI bridge behavior. The production widget was also exercised in a local browser with clearly labelled synthetic fixtures at 880 and 390 pixels: navigation, pagination, text/HTML scrolling, safe section links, theme changes, and height updates passed. These are not new live Galaxy or ChatGPT results. CI is configured but has not run on a remote repository.

A Node.js 22 container smoke check passed health, service version, all 29 tools, and the v9 resource with the current build mounted read-only in an existing image. A fresh Docker image build stalled at base-image metadata resolution and was cancelled; fresh image packaging remains unverified.

## Version 0.4 run-status validation — 2026-09-05

Lint, TypeScript checks, frozen dependency installation, and all 84 automated tests passed. These include read-only MCP integration and UI refresh/navigation checks; the added tests do not execute real analyses.

The status reader was checked against an existing, already-cancelled QA workflow on the configured Galaxy instance. It returned the observed cancelled state, workflow name, and containing-history handle using two GET requests; it did not create, submit, or cancel any Galaxy resource. An older completed FastQC job did not expose a tool-request handle and was not presented as a successful status-card test.

Local browser validation used the production v10 HTML. Recorded Galaxy screenshots retain their actual cancelled state and are labelled as snapshot replay, not live polling. Separately labelled synthetic scenarios cover running-to-completed refresh, failed-query snapshot retention, retry, and history/report/back navigation at wide and 390-pixel widths. The narrow card had no horizontal overflow. Browser message-channel warnings were observed without breaking these interactions; this is not a claim of a warning-free browser session or a completed ChatGPT-host validation.

## Real FastQC path

The end-to-end check used a history named `ChatGPT MCP FastQC E2E 2026-08-30` and the public Galaxy Project test fixture at `https://raw.githubusercontent.com/galaxyproject/galaxy-test-data/master/3.fastqsanger`.

The validation path was:

1. `create_history`
2. `upload_file_from_url`
3. `get_dataset_details` and `get_job_details`
4. `search_tools_by_name` and `get_tool_input_template`
5. `run_tool`
6. `get_history_contents` and `get_job_details`

The first FastQC submission was rejected before execution because the generated template supplied `kmers: 0` while the live Galaxy schema requires a value of at least 2. Retrying with `kmers: 7` produced one HTML report and one text report successfully. The template constraint mismatch was fixed on 2026-09-05 in a tested ops dependency patch; that fix has not yet been revalidated through a new live ChatGPT analysis. A failed validation response was not counted as a completed run.

During the all-action ChatGPT run, one multi-action prompt caused ChatGPT to call `create_history` twice and stop before its remaining actions. This was retained as failure evidence. Re-running `create_history` as a single action called it once and passed; later write actions were also tested one at a time. Until the client behavior is resolved, validation prompts should contain one non-idempotent action at a time.

## Release boundary

The environment-variable API key represents one trusted Galaxy account. Per-user OAuth and authorization policy are required before multi-user, production, clinical, or sensitive-data deployment.
