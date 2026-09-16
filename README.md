# dsh-llm-huawei-codeagent

Huawei CodeAgent/CodeMate provider plugin for DeepSeek Harness.

## Compatibility

This package targets the DSH 0.1.5 line and the 0.1.6-alpha.1 runtime. The DSH runtime packages are supplied by the host profile rather than installed as package dependencies, so the plugin uses the host's Cordis/DSH runtime without duplicate copies. Do not install it into an unrelated DSH major/minor line.

## Install from GitHub

```bash
dsh plugin --profile web add github:chengengjian/dsh-llm-huawei-codeagent#v0.2.0
```

Restart DSH Web after installing. The package's `dsh` manifest and `cordis.patch.yml` automatically add the provider to the profile bundle; no manual `cordis.yml` edit is required.

## Configure credentials

In DSH Models settings, enter the Huawei domain account and password in their
separate fields. The account is stored as provider configuration. The password
is stored by DSH's credential store under `HUAWEI_CODEAGENT_PASSWORD` by
default; do not commit it to this repository or put it in a Dockerfile.

Version 0.2.0 intentionally removes the legacy combined `HUAWEI_API_KEY`
(`工号:密码`) format. Re-enter both fields after upgrading from 0.1.x.

Optional settings are `passwordEnv`, `service` (`codeagent` or `codemate`),
`zone` (`green` or `yellow`), `baseURL`, `modelCatalogURL`,
`filterModelsByPermission`, `models`, `streamIdleTimeoutMs`, and `retryPolicy`.

For CodeAgent, the adapter logs in and queries the CLI catalog at
`codeagentcli.rnd.huawei.com/codeAgentPro/chat/modles` (the upstream path is
spelled `modles`). It first reads the account's department and region through
`getUserDetail`, then caches catalog capacities and modalities for six hours.
`filterModelsByPermission` defaults to `false`; set it to `true` to request
only models available to the current account.

User-specified model fields override catalog metadata. If the catalog host is
unreachable, discovery falls back to the built-in model IDs and request-time
resolution retains the conservative 128K context / 8K output fallback. The
built-in list no longer presents those fallback values as provider-reported
metadata.

Dynamic discovery currently targets the CodeAgent directory. `service:
codemate` continues to use configured/static model metadata until the separate
PromptCenter policy response is implemented.

The default upstream endpoints are Huawei internal services. The DSH runtime
must route both the snapengine host and `codeagentcli.rnd.huawei.com` through
its configured HTTP proxy. This plugin uses a provider-scoped Undici dispatcher
that accepts the Huawei internal certificate chain only for HTTPS endpoints
under `huawei.com`; it does not change process-wide TLS verification or
`/etc/hosts`.

Disabling certificate verification allows a network intermediary to impersonate a Huawei endpoint and observe login credentials or tokens. Importing the official BPIT CA chain into the DSH trust store remains the preferred production configuration; the scoped dispatcher is a compatibility measure for environments where that chain is unavailable.

## What is included

- Huawei CodeAgent and CodeMate streaming chat adapter
- Login token caching and refresh
- Model discovery and retry/idle-timeout configuration
- Credential-store integration through DSH's Models settings

## Rebuilding the published `lib/` output

The source in `src/` is maintained from the corresponding package in the deepseek-harness monorepo. Build the monorepo first, then copy the package's generated `lib/index.js`, `lib/invariant.js`, and declaration files from `packages/llm/llm-huawei-codeagent/lib/` into this repository before creating a release tag.

The published package intentionally contains prebuilt output so DSH users do not need a full deepseek-harness checkout or toolchain during plugin installation.
