// ZCode 3.14 desktop host contract (CLI 0.16): app-server does not load
// desktop accounts itself. Supply provider/updateAccountConfig and answer
// interaction/requestProviderRuntimeHeaders, just as the desktop host does.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createHash, createDecipheriv } from 'node:crypto';

const hash = (s) => createHash('sha256').update(s).digest('hex');
const json = (file, fallback) => {
  try { return JSON.parse(fs.readFileSync(file, 'utf8')); }
  catch (e) { if (e.code === 'ENOENT' && fallback !== undefined) return fallback; throw new Error(`Cannot read ZCode config: ${file}`); }
};

export function zcodeRuntime(entry, provider, app, bridgeHome, inherited = process.env) {
  const base = path.resolve(inherited.ZCODE_DATA_BASE_DIR || inherited.ZCODE_DESKTOP_HOME_DIR || os.homedir());
  const root = path.join(base, '.zcode/v2');
  const settingsFile = path.join(inherited.ZCODE_DESKTOP_HOME_DIR || base, '.zcode/v2/setting.json');
  const settings = json(settingsFile, {});
  let version = inherited.ZCODE_APP_VERSION;
  if (!version) {
    try { version = fs.readFileSync(path.join(app, 'Contents/Info.plist'), 'utf8').match(/<key>CFBundleShortVersionString<\/key>\s*<string>([^<]+)<\/string>/)?.[1]; } catch {}
  }
  const channel = inherited.ZCODE_ENV || 'production';
  const endpoint = new URL(inherited.ZCODE_BASE_URL || inherited.ZCODE_ENDPOINT_ORIGIN || settings.zcodeEndpointOrigin || (channel === 'test' ? inherited.ZCODE_TEST_BASE_URL || 'https://zcode.chatglm.site' : inherited.ZCODE_PRODUCTION_BASE_URL || 'https://zcode.z.ai')).origin;
  const platform = `${process.platform === 'win32' ? 'windows' : process.platform}-${({ arm64: 'aarch64', x64: 'x86_64' })[process.arch] || process.arch}`;
  const active = version && path.join(root, 'runtime/provider', platform, version, `endpoint-${hash(endpoint).slice(0, 32)}`, 'zcode-builtin.json');
  const builtin = inherited.ZCODE_BUILTIN_PROVIDER_CONFIG_FILE || (active && fs.existsSync(active) ? active : provider);
  const release = json(builtin);
  // Use a bridge-owned copy so native source locks/normalization never touch
  // the desktop's release. Deliberately omit BUNDLED_CONFIG_FILE: it enables
  // standalone CDN refresh, whose compiled appVersion is 0.0.0-dev.
  const file = path.join(bridgeHome, 'zcode-shim/provider', `release-${hash(JSON.stringify(release))}.json`);
  if (!fs.existsSync(file)) fs.writeFileSync(file, JSON.stringify(release), { mode: 0o600 });
  const env = { ...inherited, ZCODE_APP_VERSION: version || '0.0.0-dev', ZCODE_ENV: channel,
    ZCODE_RUNTIME_ENV: inherited.ZCODE_RUNTIME_ENV || 'production', ZCODE_ENDPOINT_ORIGIN: endpoint,
    ZCODE_DATA_BASE_DIR: base, ZCODE_BUILTIN_PROVIDER_CONFIG_FILE: file,
    ZCODE_PERSONAL_PROVIDER_CONFIG_FILE: inherited.ZCODE_PERSONAL_PROVIDER_CONFIG_FILE || path.join(root, 'provider_config.json'),
    ZCODE_STORAGE_DIR: inherited.ZCODE_STORAGE_DIR || path.join(bridgeHome, 'zcode-state'),
  };
  delete env.ZCODE_BUILTIN_PROVIDER_BUNDLED_CONFIG_FILE;
  return { entry, env, release, builtin: file, root, settingsFile };
}

// The desktop and CLI both use enc:v1 AES-GCM, with the same user/machine
// fallback secret. No Electron safeStorage/keychain, credential writes, OAuth
// refresh, or login migration is involved. Only decrypt fields we actually use.
function credentials(runtime) {
  const record = json(path.join(runtime.root, 'credentials.json'), {});
  const secret = runtime.env.ZCODE_CREDENTIAL_SECRET?.trim() || `zcode-credential-fallback:${os.platform()}:${os.homedir()}:${os.userInfo().username}`;
  return (key) => {
    const value = record[key];
    if (value === undefined) return null;
    if (typeof value !== 'string') throw new Error('Invalid ZCode credential record');
    if (!value.startsWith('enc:v1:')) return value.trim() || null;
    try {
      const pieces = value.slice(7).split('.');
      if (pieces.length !== 3) throw new Error();
      const [iv, tag, data] = pieces.map((s) => Buffer.from(s, 'base64url'));
      const decipher = createDecipheriv('aes-256-gcm', createHash('sha256').update(secret).digest(), iv);
      decipher.setAuthTag(tag);
      return Buffer.concat([decipher.update(data), decipher.final()]).toString('utf8').trim() || null;
    } catch { throw new Error('ZCODE_CREDENTIAL_DECRYPT_FAILED: desktop credentials are unreadable by the bridge'); }
  };
}

export function zcodeAccounts(runtime) {
  const load = credentials(runtime), settings = json(runtime.settingsFile, {});
  const providers = {}, states = {};
  const rules = runtime.release.config?.providerConfigRules?.providerRules || [];
  const keys = new Map();
  for (const rule of rules) {
    const access = rule.config?.access;
    if (access?.type !== 'zhipu-account') continue;
    const { accountType: family, mode } = access;
    // Project an existing individual plan only. Start/team/off-peak require
    // additional live provisioning; never guess their entitlement or mint keys.
    let key = null;
    if (mode === 'individual-coding-plan') {
      const raw = load(`oauth:${family}:user_info`);
      let identity;
      try { const profile = raw && JSON.parse(raw); identity = profile?.id ?? profile?.user_id; } catch { throw new Error('Invalid ZCode account profile'); }
      if (identity != null && load(`oauth:${family}:access_token`)) key = load(`account-provider:coding-plan:${rule.providerId}:account:${encodeURIComponent(String(identity))}:api-key`);
    }
    const entitled = !!key;
    const current = settings.providerFamilyDomain === family && settings.providerFamilyConnectionSelections?.[family]?.kind === mode;
    providers[rule.providerId] = { access: { type: 'zhipu-account', entitled } };
    states[rule.providerId] = { availability: entitled ? 'available' : 'unavailable', entitled, current };
    if (key) keys.set(rule.providerId, key);
  }
  const basedOnZCodeBuiltinRevision = `zcode-builtin:${runtime.release.revision}:${hash(path.resolve(runtime.builtin))}`;
  return {
    snapshot: { revision: `bridge-account:${hash(JSON.stringify([providers, states]))}`, basedOnZCodeBuiltinRevision, providers, states },
    requestAuth(request) {
      const key = keys.get(request.providerId), access = rules.find((r) => r.providerId === request.providerId)?.config?.access;
      if (!key || !states[request.providerId]?.current || request.modelSelection?.providerId !== request.providerId || request.accountAccess?.accountType !== access.accountType || request.accountAccess?.mode !== access.mode) throw new Error('ZCode account provider is not the active connected individual plan');
      return { headersApplied: true, requestAuth: { apiKey: key } };
    },
  };
}

export function selectZcodeModel(requested, model = {}, states = {}) {
  const available = model.available || [];
  if (!requested) return null;
  const normalize = (s) => String(s || '').trim().toLowerCase();
  const name = normalize(requested);
  const hits = available.filter((m) => [m.ref?.modelId, m.label, m.displayName, `${m.ref?.providerId}/${m.ref?.modelId}`].some((s) => normalize(s) === name));
  if (!hits.length) throw new Error(`ZCode model unavailable: ${requested}. Installed models: ${available.map((m) => `${m.ref?.providerId}/${m.ref?.modelId}`).join(', ')}`);
  if (hits.length === 1) return hits[0];
  // The account state's current flag expresses the desktop's active family /
  // plan, even when the session default still refers to a personal provider.
  const active = hits.filter((m) => states[m.ref.providerId]?.current);
  if (active.length === 1) return active[0];
  const pool = active.length ? active : hits;
  for (const ref of [model.current, model.lastUsed, model.default]) {
    const match = pool.find((m) => m.ref.providerId === ref?.providerId && m.ref.modelId === ref?.modelId)
      || pool.find((m) => m.ref.providerId === ref?.providerId);
    if (match) return match;
  }
  throw new Error(`Ambiguous ZCode model ${requested}; use providerId/modelId`);
}
