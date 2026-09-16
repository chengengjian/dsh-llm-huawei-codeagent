# dsh-llm-huawei-codeagent

Huawei CodeAgent/CodeMate provider plugin for DeepSeek Harness.

## Compatibility

This package targets the DSH 0.1.5 line and the 0.1.6-alpha.1 runtime. The DSH runtime packages are supplied by the host profile rather than installed as package dependencies, so the plugin uses the host's Cordis/DSH runtime without duplicate copies. Do not install it into an unrelated DSH major/minor line.

## Install from GitHub

```bash
dsh plugin --profile web add github:chengengjian/dsh-llm-huawei-codeagent#v0.1.1
```

Restart DSH Web after installing. The package's `dsh` manifest and `cordis.patch.yml` automatically add the provider to the profile bundle; no manual `cordis.yml` edit is required.

## Configure credentials

In the DSH Models settings, configure the Huawei CodeAgent provider's API key as the Huawei domain credential in this format:

```text
工号:密码
```

The default credential reference is `HUAWEI_API_KEY`. Credentials are stored by DSH's credential store; do not commit them to this repository or put them in a Dockerfile.

Optional settings are `service` (`codeagent` or `codemate`), `zone` (`green` or `yellow`), `baseURL`, `models`, `streamIdleTimeoutMs`, and `retryPolicy`.

The default upstream endpoints are Huawei internal services. The DSH runtime must have the required network route, DNS/hosts mapping, proxy, and CA trust configured by the deployment environment.

## What is included

- Huawei CodeAgent and CodeMate streaming chat adapter
- Login token caching and refresh
- Model discovery and retry/idle-timeout configuration
- Credential-store integration through DSH's Models settings

## Rebuilding the published `lib/` output

The source in `src/` is maintained from the corresponding package in the deepseek-harness monorepo. Build the monorepo first, then copy the package's generated `lib/index.js`, `lib/invariant.js`, and declaration files from `packages/llm/llm-huawei-codeagent/lib/` into this repository before creating a release tag.

The published package intentionally contains prebuilt output so DSH users do not need a full deepseek-harness checkout or toolchain during plugin installation.
