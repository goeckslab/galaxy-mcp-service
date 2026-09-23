# Service compatibility and validation

For developers changing the MCP service and operators validating a deployment. This document covers service contracts, not installation instructions or a claim that every AI client works.

## Compatibility contract

- Tools work over Streamable HTTP without a graphical renderer. Text and structured results carry equivalent evidence; server workflow instructions remain advisory.
- Interactive cards use the standard MCP Apps bridge. Each host still needs its own authentication and security-policy checks. HTML previews are static and do not require nested report frames.
- OAuth requests resolve only the grant's authorized Galaxy sites. Multi-site calls select a site explicitly; report loading, paging and status refresh retain that source.
- Submission and observation are separate: a status query never resubmits an analysis. A failed query preserves the last known UI snapshot rather than claiming completion.

Implementation details and report-reading limits are in the [service README](../README.md); credentials, consent and token contracts are in the [broker guide](broker.md).

## Run the automated checks

From the service root:

```sh
pnpm check
pnpm test:broker
python3 -B -m unittest discover -s tests/deploy -p 'test_*.py'
```

The service suites cover schemas, annotations, redaction, paging, report extraction, tool-state handling, source binding and UI lifecycle behavior. Broker integration uses PostgreSQL and fixture Galaxy accounts; see its [test prerequisites](broker.md#reproduce-the-integration-checks). Deployment-helper tests simulate failure and rollback paths; they are not a production recovery drill.

## Live acceptance

Client-specific results and the acceptance procedure have one owner: `docs/client-validation.md` in the Galaxy plugin source repository. Refer to that dated matrix before describing a provider as supported. The [public Galaxy plugin repository](https://github.com/goeckslab/galaxy-plugin) supplies user installation instructions, not the private test evidence.

For service releases, additionally follow the [AWS post-deployment checks](aws-deployment.md): HTTPS, anonymous-access rejection, registered OAuth callbacks, independent-user/site isolation, revocation and restart recovery. A healthy container or passing local suite does not establish those outcomes.

Detailed historical client runs previously kept here are retained in the local, ignored `artifacts/docs-before-20260913/client-compatibility.md` archive. Keep future raw transcripts, account identifiers and screenshots outside public documentation; add concise non-sensitive outcomes to the owning validation record instead of duplicating its chronology here.
