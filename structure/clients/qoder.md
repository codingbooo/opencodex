# Qoder Client Integration

Qoder follows the shared [client-integration ownership contract](integrations.md); this page records only what is specific to it.

## Qoder settings ownership

Qoder IDE / qodercli uses JSON at `~/.qoder/settings.json`. The Qoder exporter in
`src/clients/config-export.ts` writes `providers.opencodex` and one
`modelConfigs.customModels` entry per model. Array ownership selects both `provider` and
`model`, preserving same-named models belonging to other providers. Apply, refresh and disable
use the existing recorded-fragment writer; restore uses its snapshots. Model IDs that cannot
be represented by the shared selector grammar refuse managed contribution construction.
The default model is the first normalized model; an empty catalog omits the default.
Input limits use authoritative context metadata or Qoder's requested 128000 fallback.
Exports reject non-loopback placeholder use; the writer's existing admission gate protects
apply while permitting cleanup after a bind change. CLI help, Dashboard export rows, integration
tabs and preview-path validation register the same Qoder client; the managed path templates live in
`src/integrations/mutation-plan.ts` and the builder in `src/clients/config-export/qoder.ts`.
