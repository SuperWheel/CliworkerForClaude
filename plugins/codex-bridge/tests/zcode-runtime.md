# ZCode desktop account bridge investigation

Verified locally against ZCode desktop 3.14.4 and its bundled CLI 0.16.9.
Source inspection used copies of the ASAR's `out/main` and `out/host` JS under
`/private/tmp/zcode-desktop-inspect`; no application bundle was modified.

## Root cause

- The bundled and cached built-in releases are present, readable, and contain
  the account provider/model rules (revision 30). A provider symlink alone does
  not grant access to those providers.
- CLI `prepareCliProviderRuntimeEnv` uses the compiled shared `ZCODE_VERSION`,
  which falls back to `0.0.0-dev`, for its cache directory and CDN query.
  `ZCODE_APP_VERSION` supplies request headers but does not fix that cache/query.
- `ZCode Built-in missing` comes from `ZCodeBuiltinSynchronizer`: the client
  config response omits `builtin_provider_config_json`, so the refresh returns
  `missing`. It is not a missing-file or credential-decryption diagnostic.
- Protocol bootstrap calls `startProcessProviderRegistryRuntime(env)` without
  `standalone`. Its mutable account source starts fail-closed. Desktop host
  pushes `provider/updateAccountConfig`, then answers
  `interaction/requestProviderRuntimeHeaders` before account model requests.
  Environment variables alone therefore leave account models unavailable.
- Headless prompt mode uses a different standalone account projection: it
  requires `account-provider:<providerId>:identity` plus a cached coding-plan
  key. Desktop instead identifies the signed-in account via
  `oauth:<family>:user_info` and desktop connection settings. Signing into the
  desktop does not create that standalone identity pointer.

## Desktop startup contract and bridge implementation

Desktop `resolveElectronRuntimeZCodeAgentCommand` runs its bundled Node entry
using Electron with `ELECTRON_RUN_AS_NODE=1`, `app-server --stdio`, and
`--surface desktop`. `buildHostProcessEnv` supplies the desktop app version,
environment, and non-default data base directory. The host's `resolveSpawnEnv`
adds the resolved endpoint and explicit built-in/personal provider config paths
through `createNodeProviderRuntimePathEnv`.

The bridge uses ordinary Node (the same CJS entry works without Electron), reads
the installed app's version from Info.plist, resolves the desktop data directory
and endpoint, and chooses the matching version/platform/endpoint release.
It passes explicit provider paths and omits the standalone bundled-refresh env
variable. A bridge-owned copy of the release prevents native normalization and
lock writes in the desktop release directory. Native session storage is also
bridge-owned by default. Desktop settings, credentials and provider config are
read; the bridge does not edit them.

The bridge now uses app-server for default and explicit model turns. Its small
host adapter projects already provisioned individual coding-plan keys into the
native account-config protocol, using the desktop account identity and active
family/plan. This follows the native standalone rule that a provisioned key
enables an individual plan; it does not manufacture credentials. At each native
auth request it re-reads the account and settings and only supplies a key for
the active, matching provider. Auth material is sent solely over child stdin,
never in account snapshots, digests or bridge log events.

## Credential evidence and limits

Both host `createCredentialCipher` and CLI `createZCodeCredentialCipher` use
`enc:v1:` AES-256-GCM with `ZCODE_CREDENTIAL_SECRET`, or the same user/machine
fallback. Neither path uses Electron safeStorage. A read-only probe successfully
decrypted all 8 existing credential records, reporting only counts/categories.
No credential values were printed or persisted by the probe.

Supported here: existing individual-plan keys for signed-in Z.AI/BigModel
accounts; case-insensitive model IDs, labels and qualified IDs; ambiguity
resolved using active account state, then native session current/last-used
selection. Personal providers remain available through the native registry.

Not implemented: OAuth refresh/login/logout, automatic key provisioning,
Start/Team/off-peak entitlement discovery, or changing the desktop's active
account. Those require additional host services; they remain fail-closed.
Expired/missing keys need to be repaired through the desktop. The internal
account protocol and credential format are version-sensitive.

## Acceptance

`tests/engine-format.mjs` includes isolated encrypted-credential, environment,
read-only-source, auth-scope and model-resolution regressions.
`tests/engine-lifecycle.mjs` exercises the protocol for default models as well
as explicit models. `tests/engines.mjs` derives the expected plugin version from
the manifest and, when `ZCODE_GLM_MODEL` is set, requires a real MCP GLM agent to
write `fact.py`, run it using python3, and emit the normal command/file-change
digest. The test independently executes the generated program and checks all
eight factorial results. This case explicitly uses `danger-full-access`
(native `yolo`) for the authorized execution in its temporary directory;
native `edit` mode asks interactively for `python3`, which a headless bridge
declines. General workspace-write tasks still use `edit`.
