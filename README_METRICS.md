# Automation Metrics (Appendix)

Primary entry is now in [`README.md`](./README.md) under **Automation Metrics**.

This file remains as a compact appendix for contract file locations.

## Contract Files
- `config/metrics/automation-run.schema.json`
- `config/metrics/ingestion-mapping.github-workflow.json`
- `config/metrics/ingestion-mapping.retool.json`

## Guardrails
- Never emit secrets, auth headers, or sensitive raw payloads.
- Keep error fields redacted.
- Use environment variables / secret managers for credentials.
