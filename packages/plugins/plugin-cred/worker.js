import crypto from 'node:crypto';
import { definePlugin, runWorker } from '@paperclipai/plugin-sdk';

const MAX_RESPONSE_BYTES = 32_768;
const CALLBACK_SECRET_HEADER = 'x-paperclip-cred-callback-secret';
const EMBEDDED_STATE_NAMESPACE = 'cred-embedded';
const EMBEDDED_MODE = 'embedded';
const REMOTE_SERVER_MODE = 'remote_server';
const EMBEDDED_PROVIDER_KEYS = [
  'github',
  'google',
  'slack',
  'notion',
  'salesforce',
  'linear',
  'hubspot',
];

const SERVICE_ALLOWLIST = {
  google: [
    'https://www.googleapis.com/',
    'https://gmail.googleapis.com/',
    'https://calendar.googleapis.com/',
    'https://drive.googleapis.com/',
    'https://sheets.googleapis.com/',
    'https://docs.googleapis.com/',
    'https://admin.googleapis.com/',
    'https://people.googleapis.com/',
  ],
  github: [
    'https://api.github.com/',
  ],
  slack: [
    'https://slack.com/api/',
  ],
  notion: [
    'https://api.notion.com/',
  ],
  salesforce: [],
  linear: [
    'https://api.linear.app/',
  ],
  hubspot: [
    'https://api.hubapi.com/',
  ],
};

class TokenCache {
  #entries = new Map();
  #cleanupTimer;

  constructor() {
    this.#cleanupTimer = setInterval(() => this.sweep(), 60_000);
    this.#cleanupTimer.unref?.();
  }

  store(entry) {
    const delegationId = `del_${crypto.randomBytes(10).toString('hex')}`;
    this.#entries.set(delegationId, { ...entry });
    const ttl = entry.expiresAt - Date.now();
    if (ttl > 0) {
      const timeout = setTimeout(() => this.#entries.delete(delegationId), ttl);
      timeout.unref?.();
    }
    return delegationId;
  }

  get(delegationId) {
    const entry = this.#entries.get(delegationId);
    if (!entry) {
      return undefined;
    }
    if (Date.now() >= entry.expiresAt) {
      this.#entries.delete(delegationId);
      return undefined;
    }
    return { ...entry };
  }

  isAllowedUrl(service, rawUrl) {
    let parsed;
    try {
      parsed = new URL(rawUrl);
    } catch {
      return false;
    }
    if (parsed.protocol !== 'https:') {
      return false;
    }
    if (parsed.username || parsed.password) {
      return false;
    }
    if (parsed.port !== '' && parsed.port !== '443') {
      return false;
    }

    const hostname = parsed.hostname.toLowerCase();
    if (service === 'salesforce') {
      const looksLikeIpSubdomain = /^(\d{1,3}\.){3}\d{1,3}\./.test(hostname);
      if (looksLikeIpSubdomain) {
        return false;
      }
      return hostname.endsWith('.salesforce.com') || hostname.endsWith('.force.com');
    }

    const bases = SERVICE_ALLOWLIST[service];
    if (!bases) {
      return false;
    }
    const normalizedUrl = `https://${hostname}${parsed.pathname}`;
    return bases.some((base) => normalizedUrl.startsWith(base));
  }

  sweep() {
    const now = Date.now();
    for (const [delegationId, entry] of this.#entries.entries()) {
      if (now >= entry.expiresAt) {
        this.#entries.delete(delegationId);
      }
    }
  }
}

const tokenCache = new TokenCache();

function asRecord(value) {
  return value && typeof value === 'object' && !Array.isArray(value) ? value : {};
}

function asString(value, field) {
  if (typeof value !== 'string' || value.trim().length === 0) {
    throw new Error(`${field} must be a non-empty string`);
  }
  return value.trim();
}

function optionalString(value, field) {
  if (value === undefined || value === null || value === '') {
    return undefined;
  }
  return asString(value, field);
}

function asScopes(value) {
  if (value === undefined) {
    return undefined;
  }
  if (!Array.isArray(value)) {
    throw new Error('scopes must be an array of strings');
  }
  const scopes = value
    .filter((item) => typeof item === 'string')
    .map((item) => item.trim())
    .filter(Boolean);
  return scopes.length > 0 ? [...new Set(scopes)].sort() : undefined;
}

function asStringArray(value, field) {
  if (value === undefined) {
    return undefined;
  }
  if (!Array.isArray(value)) {
    throw new Error(`${field} must be an array of strings`);
  }
  const items = value
    .filter((item) => typeof item === 'string')
    .map((item) => item.trim())
    .filter(Boolean);
  return items.length > 0 ? [...new Set(items)] : undefined;
}

function asPositiveInteger(value, field) {
  if (value === undefined || value === null || value === '') {
    return undefined;
  }
  const number = Number(value);
  if (!Number.isInteger(number) || number <= 0) {
    throw new Error(`${field} must be a positive integer`);
  }
  return number;
}

function asBoolean(value, defaultValue = false) {
  if (value === undefined || value === null || value === '') {
    return defaultValue;
  }
  if (typeof value === 'boolean') {
    return value;
  }
  throw new Error('Expected boolean');
}

function slugify(value) {
  return value.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '');
}

function normalizeBaseUrl(value, field) {
  const url = new URL(asString(value, field));
  url.pathname = url.pathname.replace(/\/+$/, '');
  return url.toString().replace(/\/+$/, '');
}

function normalizeMode(value) {
  if (value === undefined || value === null || value === '') {
    return REMOTE_SERVER_MODE;
  }
  const mode = asString(value, 'mode').toLowerCase();
  if (mode !== REMOTE_SERVER_MODE && mode !== EMBEDDED_MODE) {
    throw new Error(`mode must be ${REMOTE_SERVER_MODE} or ${EMBEDDED_MODE}`);
  }
  return mode;
}

function base64urlEncode(input) {
  return Buffer.from(input).toString('base64url');
}

function encodeJsonBase64url(input) {
  return base64urlEncode(JSON.stringify(input));
}

function decodeBase64urlJson(segment, field) {
  try {
    return JSON.parse(Buffer.from(segment, 'base64url').toString('utf8'));
  } catch {
    throw new Error(`Invalid ${field}`);
  }
}

function signHs256Jwt(secret, payload, audience) {
  const now = Math.floor(Date.now() / 1000);
  const fullPayload = {
    iss: 'paperclip-plugin-cred',
    aud: audience,
    iat: now,
    exp: now + 300,
    ...payload,
  };
  const header = {
    alg: 'HS256',
    typ: 'JWT',
  };
  const encodedHeader = encodeJsonBase64url(header);
  const encodedPayload = encodeJsonBase64url(fullPayload);
  const unsigned = `${encodedHeader}.${encodedPayload}`;
  const signature = crypto
    .createHmac('sha256', secret)
    .update(unsigned)
    .digest('base64url');
  return `${unsigned}.${signature}`;
}

function sha256Hex(value) {
  return crypto.createHash('sha256').update(value).digest('hex');
}

function receiptClaimsFromReceipt(receipt) {
  const parts = receipt.split('.');
  if (parts.length !== 3) {
    throw new Error('Invalid parent receipt format');
  }
  const payload = asRecord(decodeBase64urlJson(parts[1], 'parent receipt payload'));
  const claims = Array.isArray(payload.receiptClaims)
    ? payload.receiptClaims.filter((claim) => typeof claim === 'string' && claim.trim().length > 0)
    : [];
  return [...new Set(claims)];
}

function asPermissionRules(value) {
  if (value === undefined) {
    return [];
  }
  if (!Array.isArray(value)) {
    throw new Error('embeddedPermissionRules must be an array');
  }

  return value.map((rawRule, index) => {
    const rule = asRecord(rawRule);
    const services = asStringArray(rule.services, `embeddedPermissionRules[${index}].services`);
    if (!services || services.length === 0) {
      throw new Error(`embeddedPermissionRules[${index}].services must contain at least one service`);
    }

    const allowedScopes = asStringArray(rule.allowedScopes, `embeddedPermissionRules[${index}].allowedScopes`);
    if (!allowedScopes || allowedScopes.length === 0) {
      throw new Error(`embeddedPermissionRules[${index}].allowedScopes must contain at least one scope`);
    }

    const agentIds = asStringArray(rule.agentIds, `embeddedPermissionRules[${index}].agentIds`);
    const agentUrlKeys = asStringArray(rule.agentUrlKeys, `embeddedPermissionRules[${index}].agentUrlKeys`);
    const roles = asStringArray(rule.roles, `embeddedPermissionRules[${index}].roles`);
    const titles = asStringArray(rule.titles, `embeddedPermissionRules[${index}].titles`);
    if (!agentIds && !agentUrlKeys && !roles && !titles) {
      throw new Error(
        `embeddedPermissionRules[${index}] must match at least one of agentIds, agentUrlKeys, roles, or titles`,
      );
    }

    const maxRequests = asPositiveInteger(rule.rateLimitMaxRequests, `embeddedPermissionRules[${index}].rateLimitMaxRequests`);
    const windowMs = asPositiveInteger(rule.rateLimitWindowMs, `embeddedPermissionRules[${index}].rateLimitWindowMs`);

    return {
      services,
      allowedScopes,
      agentIds,
      agentUrlKeys,
      roles: roles?.map((item) => item.toLowerCase()),
      titles: titles?.map((item) => item.toLowerCase()),
      allowRootDelegation: asBoolean(rule.allowRootDelegation, true),
      delegatable: asBoolean(rule.delegatable, false),
      maxDelegationDepth: asPositiveInteger(rule.maxDelegationDepth, `embeddedPermissionRules[${index}].maxDelegationDepth`) ?? 1,
      requiredReceiptClaims: asStringArray(rule.requiredReceiptClaims, `embeddedPermissionRules[${index}].requiredReceiptClaims`) ?? [],
      rateLimit: maxRequests && windowMs
        ? { maxRequests, windowMs }
        : undefined,
    };
  });
}

async function resolveRemoteRuntimeConfig(ctx, raw) {
  const credBaseUrl = normalizeBaseUrl(raw.credBaseUrl, 'credBaseUrl');
  const credAppClientId = asString(raw.credAppClientId, 'credAppClientId');
  const credRequestHeader = optionalString(raw.credRequestHeader, 'credRequestHeader') ?? 'x-paperclip-agent-jwt';
  const credJwtAudience = optionalString(raw.credJwtAudience, 'credJwtAudience') ?? 'cred';
  const credAgentDidPrefix = optionalString(raw.credAgentDidPrefix, 'credAgentDidPrefix') ?? 'paperclip:agent:';

  let credAgentToken;
  if (typeof raw.credAgentTokenSecretRef === 'string' && raw.credAgentTokenSecretRef.trim().length > 0) {
    credAgentToken = await ctx.secrets.resolve(raw.credAgentTokenSecretRef.trim());
  }

  let paperclipJwtSecret;
  if (typeof raw.paperclipAgentJwtSecretRef === 'string' && raw.paperclipAgentJwtSecretRef.trim().length > 0) {
    paperclipJwtSecret = await ctx.secrets.resolve(raw.paperclipAgentJwtSecretRef.trim());
  } else {
    paperclipJwtSecret = process.env.PAPERCLIP_AGENT_JWT_SECRET;
  }

  if (typeof paperclipJwtSecret !== 'string' || paperclipJwtSecret.trim().length === 0) {
    throw new Error('Paperclip agent JWT secret is not configured. Set PAPERCLIP_AGENT_JWT_SECRET or paperclipAgentJwtSecretRef.');
  }

  return {
    mode: REMOTE_SERVER_MODE,
    credBaseUrl,
    credAppClientId,
    credRequestHeader,
    credJwtAudience,
    credAgentDidPrefix,
    credAgentToken: credAgentToken?.trim() || undefined,
    paperclipJwtSecret: paperclipJwtSecret.trim(),
  };
}

async function resolveEmbeddedRuntimeConfig(ctx, raw) {
  const credAppClientId = asString(raw.credAppClientId, 'credAppClientId');
  const credAgentDidPrefix = optionalString(raw.credAgentDidPrefix, 'credAgentDidPrefix') ?? 'paperclip:agent:';
  const embeddedVaultPath = asString(raw.embeddedVaultPath, 'embeddedVaultPath');
  const embeddedVaultStorage = optionalString(raw.embeddedVaultStorage, 'embeddedVaultStorage') ?? 'file';
  if (!['file', 'sqlite'].includes(embeddedVaultStorage)) {
    throw new Error('embeddedVaultStorage must be file or sqlite');
  }

  let embeddedVaultPassphrase;
  if (typeof raw.embeddedVaultPassphraseSecretRef === 'string' && raw.embeddedVaultPassphraseSecretRef.trim().length > 0) {
    embeddedVaultPassphrase = await ctx.secrets.resolve(raw.embeddedVaultPassphraseSecretRef.trim());
  } else {
    embeddedVaultPassphrase = process.env.PAPERCLIP_CRED_VAULT_PASSPHRASE;
  }
  if (typeof embeddedVaultPassphrase !== 'string' || embeddedVaultPassphrase.trim().length === 0) {
    throw new Error(
      'Embedded vault passphrase is not configured. Set PAPERCLIP_CRED_VAULT_PASSPHRASE or embeddedVaultPassphraseSecretRef.',
    );
  }

  let embeddedCallbackSecret;
  if (typeof raw.embeddedCallbackSecretRef === 'string' && raw.embeddedCallbackSecretRef.trim().length > 0) {
    embeddedCallbackSecret = await ctx.secrets.resolve(raw.embeddedCallbackSecretRef.trim());
  } else {
    embeddedCallbackSecret = process.env.PAPERCLIP_CRED_CALLBACK_SECRET;
  }
  if (typeof embeddedCallbackSecret !== 'string' || embeddedCallbackSecret.trim().length === 0) {
    throw new Error(
      'Embedded callback secret is not configured. Set PAPERCLIP_CRED_CALLBACK_SECRET or embeddedCallbackSecretRef.',
    );
  }

  const embeddedHelperBaseUrl = normalizeBaseUrl(
    optionalString(raw.embeddedHelperBaseUrl, 'embeddedHelperBaseUrl') ?? 'http://127.0.0.1:3401',
    'embeddedHelperBaseUrl',
  );
  if (!embeddedHelperBaseUrl.startsWith('http://127.0.0.1') && !embeddedHelperBaseUrl.startsWith('http://localhost')) {
    throw new Error('embeddedHelperBaseUrl must use localhost or 127.0.0.1');
  }

  const providers = {};
  for (const service of EMBEDDED_PROVIDER_KEYS) {
    const clientId = optionalString(raw[`${service}ClientId`], `${service}ClientId`);
    const secretRef = optionalString(raw[`${service}ClientSecretRef`], `${service}ClientSecretRef`);
    if (!clientId && !secretRef) {
      continue;
    }
    if (!clientId || !secretRef) {
      throw new Error(`${service}ClientId and ${service}ClientSecretRef must both be set for embedded mode`);
    }
    providers[service] = {
      clientId,
      clientSecret: await ctx.secrets.resolve(secretRef),
    };
  }

  return {
    mode: EMBEDDED_MODE,
    credAppClientId,
    credAgentDidPrefix,
    embeddedVaultPath,
    embeddedVaultStorage,
    embeddedVaultPassphrase: embeddedVaultPassphrase.trim(),
    embeddedCallbackSecret: embeddedCallbackSecret.trim(),
    embeddedHelperBaseUrl,
    embeddedPermissionRules: asPermissionRules(raw.embeddedPermissionRules),
    providers,
  };
}

async function resolveRuntimeConfig(ctx) {
  const raw = asRecord(await ctx.config.get());
  const mode = normalizeMode(raw.mode);
  if (mode === EMBEDDED_MODE) {
    return resolveEmbeddedRuntimeConfig(ctx, raw);
  }
  return resolveRemoteRuntimeConfig(ctx, raw);
}

async function resolveIssueContext(ctx, issueId, companyId) {
  if (!issueId) {
    return undefined;
  }
  const issue = await ctx.issues.get(issueId, companyId);
  if (!issue) {
    throw new Error(`Issue ${issueId} was not found in company ${companyId}`);
  }
  const workProducts = Array.isArray(issue.workProducts) ? issue.workProducts : [];
  const approvedCount = workProducts.filter((product) => product.reviewState === 'approved').length;
  const boardReviewCount = workProducts.filter((product) => product.reviewState === 'needs_board_review').length;
  const mergedGithubPullRequests = workProducts.filter(
    (product) => product.provider === 'github' && product.type === 'pull_request' && product.status === 'merged',
  ).length;

  const claimCandidates = [
    `paperclip:issue:${issue.id}`,
    `paperclip:issue-status:${slugify(issue.status)}`,
  ];
  if (approvedCount > 0) {
    claimCandidates.push('paperclip:issue-review:approved');
  }
  if (boardReviewCount > 0) {
    claimCandidates.push('paperclip:issue-review:needs-board-review');
  }
  if (mergedGithubPullRequests > 0) {
    claimCandidates.push('paperclip:github-pr:merged');
  }

  return {
    id: issue.id,
    identifier: issue.identifier ?? null,
    title: issue.title,
    status: issue.status,
    assigneeAgentId: issue.assigneeAgentId ?? null,
    projectId: issue.projectId ?? null,
    reviewSummary: {
      approvedCount,
      boardReviewCount,
      mergedGithubPullRequests,
    },
    claimCandidates,
  };
}

async function buildPaperclipContext(ctx, runtimeConfig, runCtx, issueId) {
  const agent = await ctx.agents.get(runCtx.agentId, runCtx.companyId);
  if (!agent) {
    throw new Error(`Agent ${runCtx.agentId} was not found in company ${runCtx.companyId}`);
  }

  const agentDid = `${runtimeConfig.credAgentDidPrefix}${agent.id}`;
  const claimCandidates = [
    `paperclip:company:${runCtx.companyId}`,
    `paperclip:project:${runCtx.projectId}`,
    `paperclip:role:${slugify(agent.role)}`,
  ];

  if (agent.title) {
    claimCandidates.push(`paperclip:title:${slugify(agent.title)}`);
  }

  const issue = await resolveIssueContext(ctx, issueId, runCtx.companyId);
  if (issue) {
    claimCandidates.push(...issue.claimCandidates);
  }

  return {
    agent,
    agentDid,
    claimCandidates: [...new Set(claimCandidates)],
    issue,
    payload: {
      sub: agentDid,
      paperclip: {
        agent: {
          id: agent.id,
          name: agent.name,
          urlKey: agent.urlKey,
          role: agent.role,
          title: agent.title ?? null,
        },
        run: {
          agentId: runCtx.agentId,
          runId: runCtx.runId,
          companyId: runCtx.companyId,
          projectId: runCtx.projectId,
          issueId: issue?.id ?? null,
        },
        claimCandidates: [...new Set(claimCandidates)],
        issue: issue ?? null,
      },
    },
  };
}

async function buildPaperclipJwt(ctx, runtimeConfig, runCtx, issueId) {
  const context = await buildPaperclipContext(ctx, runtimeConfig, runCtx, issueId);
  return {
    ...context,
    jwt: signHs256Jwt(runtimeConfig.paperclipJwtSecret, context.payload, runtimeConfig.credJwtAudience),
  };
}

async function readJson(response) {
  const raw = await response.text();
  if (!raw) {
    return {};
  }
  try {
    return JSON.parse(raw);
  } catch {
    return { message: raw };
  }
}

async function postToCred(ctx, runtimeConfig, path, body, signedJwt) {
  const headers = {
    Accept: 'application/json',
    'Content-Type': 'application/json',
    [runtimeConfig.credRequestHeader]: signedJwt,
  };
  if (runtimeConfig.credAgentToken) {
    headers.Authorization = `Bearer ${runtimeConfig.credAgentToken}`;
  }

  const response = await ctx.http.fetch(`${runtimeConfig.credBaseUrl}${path}`, {
    method: 'POST',
    headers,
    body: JSON.stringify(body),
  });
  const payload = await readJson(response);
  if (!response.ok) {
    const message = typeof payload.error === 'string'
      ? payload.error
      : typeof payload.message === 'string'
        ? payload.message
        : `Cred request failed (${response.status})`;
    const error = new Error(message);
    error.status = response.status;
    error.payload = payload;
    throw error;
  }
  return payload;
}

function formatCredError(error) {
  const status = typeof error?.status === 'number' ? error.status : undefined;
  const payload = asRecord(error?.payload);
  if (status === 403 && payload.error === 'consent_required' && typeof payload.consent_url === 'string') {
    return {
      isError: false,
      content: `User needs to authorize. Send them to: ${payload.consent_url}`,
      metric: 'consent_required',
    };
  }

  const suffix = status ? ` (${status})` : '';
  return {
    isError: true,
    content: `Error${suffix}: ${error instanceof Error ? error.message : String(error)}`,
    metric: 'error',
  };
}

async function logBridgeActivity(ctx, companyId, message, metadata) {
  try {
    await ctx.activity.log({
      companyId,
      message,
      metadata,
    });
  } catch {
    // Activity logging is best-effort. Tool execution should still succeed.
  }
}

async function getEmbeddedModules() {
  const [{ Cred }, oauthModule, vaultModule] = await Promise.all([
    import('@credninja/sdk'),
    import('@credninja/oauth'),
    import('@credninja/vault'),
  ]);
  return {
    Cred,
    OAuthClient: oauthModule.OAuthClient,
    createAdapter: oauthModule.createAdapter,
    CredVault: vaultModule.CredVault,
  };
}

async function getEmbeddedCred(runtimeConfig) {
  const { Cred } = await getEmbeddedModules();
  return new Cred({
    mode: 'local',
    vault: {
      passphrase: runtimeConfig.embeddedVaultPassphrase,
      path: runtimeConfig.embeddedVaultPath,
      storage: runtimeConfig.embeddedVaultStorage,
    },
    providers: Object.fromEntries(
      Object.entries(runtimeConfig.providers).map(([service, provider]) => [service, {
        clientId: provider.clientId,
        clientSecret: provider.clientSecret,
      }]),
    ),
  });
}

async function getEmbeddedVault(runtimeConfig) {
  const { CredVault } = await getEmbeddedModules();
  const vault = new CredVault({
    passphrase: runtimeConfig.embeddedVaultPassphrase,
    path: runtimeConfig.embeddedVaultPath,
    storage: runtimeConfig.embeddedVaultStorage,
  });
  await vault.init();
  return vault;
}

function makeStateKey(state) {
  return `oauth-state:${state}`;
}

function makeAgentFingerprint(agentDid) {
  return sha256Hex(agentDid);
}

function matchesEmbeddedPermissionRule(rule, agent, service) {
  if (!rule.services.includes(service)) {
    return false;
  }

  const role = typeof agent.role === 'string' ? agent.role.toLowerCase() : '';
  const title = typeof agent.title === 'string' ? agent.title.toLowerCase() : '';

  if (rule.agentIds && !rule.agentIds.includes(agent.id)) {
    return false;
  }
  if (rule.agentUrlKeys && !rule.agentUrlKeys.includes(agent.urlKey)) {
    return false;
  }
  if (rule.roles && !rule.roles.includes(role)) {
    return false;
  }
  if (rule.titles && !rule.titles.includes(title)) {
    return false;
  }

  return true;
}

function resolveEmbeddedPermissionRule(runtimeConfig, agent, service) {
  return runtimeConfig.embeddedPermissionRules.find((rule) => matchesEmbeddedPermissionRule(rule, agent, service));
}

async function ensureEmbeddedPermission(runtimeConfig, paperclipContext, service) {
  const rule = resolveEmbeddedPermissionRule(runtimeConfig, paperclipContext.agent, service);
  if (!rule) {
    throw new Error(`No embedded permission rule matched agent ${paperclipContext.agent.id} for ${service}`);
  }

  const vault = await getEmbeddedVault(runtimeConfig);
  const now = new Date().toISOString();
  await vault.registerAgent({
    id: paperclipContext.agent.id,
    did: paperclipContext.agentDid,
    fingerprint: makeAgentFingerprint(paperclipContext.agentDid),
    name: paperclipContext.agent.name,
    scopeCeiling: rule.allowedScopes,
    status: 'active',
    createdBy: 'paperclip-plugin-cred',
    createdAt: now,
    updatedAt: now,
    lastSeenAt: now,
  });
  await vault.createPermission({
    agentId: paperclipContext.agent.id,
    connectionId: service,
    allowedScopes: rule.allowedScopes,
    rateLimit: rule.rateLimit,
    requiresApproval: rule.requiredReceiptClaims.length > 0,
    delegatable: rule.delegatable,
    maxDelegationDepth: rule.maxDelegationDepth,
    createdBy: 'paperclip-plugin-cred',
  });
  return rule;
}

async function buildEmbeddedOAuthClient(runtimeConfig, service) {
  const provider = runtimeConfig.providers[service];
  if (!provider) {
    throw new Error(`Embedded provider ${service} is not configured`);
  }

  const { OAuthClient, createAdapter } = await getEmbeddedModules();
  const redirectUri = `${runtimeConfig.embeddedHelperBaseUrl}/oauth/${service}/callback`;
  return {
    client: new OAuthClient({
      adapter: createAdapter(service),
      clientId: provider.clientId,
      clientSecret: provider.clientSecret,
      redirectUri,
    }),
    redirectUri,
  };
}

async function handleRemoteDelegate(ctx, rawParams, runCtx, runtimeConfig) {
  const params = asRecord(rawParams);
  const userId = asString(params.user_id, 'user_id');
  const service = asString(params.service, 'service');
  const scopes = asScopes(params.scopes);
  const issueId = optionalString(params.issue_id, 'issue_id');

  try {
    const signed = await buildPaperclipJwt(ctx, runtimeConfig, runCtx, issueId);
    const payload = await postToCred(ctx, runtimeConfig, '/api/v1/delegate', {
      user_id: userId,
      service,
      appClientId: runtimeConfig.credAppClientId,
      agent_did: signed.agentDid,
      ...(scopes ? { scopes } : {}),
    }, signed.jwt);

    const expiresIn = typeof payload.expires_in === 'number' ? payload.expires_in : 900;
    const delegationId = tokenCache.store({
      accessToken: asString(payload.access_token, 'access_token'),
      service,
      userId,
      expiresAt: Date.now() + expiresIn * 1000,
    });

    await ctx.metrics.write('delegate.success', 1, { service, mode: runtimeConfig.mode });
    await logBridgeActivity(ctx, runCtx.companyId, `Cred delegation issued for ${service}`, {
      mode: runtimeConfig.mode,
      agentId: runCtx.agentId,
      runId: runCtx.runId,
      issueId: issueId ?? null,
      service,
      userId,
      delegationId,
    });

    return {
      content: JSON.stringify({
        mode: runtimeConfig.mode,
        delegationId,
        service,
        expiresIn,
        receipt: typeof payload.receipt === 'string' ? payload.receipt : undefined,
        agentDid: signed.agentDid,
        claimCandidates: signed.claimCandidates,
        note: 'Pass delegationId to cred_use to make authenticated API calls.',
      }),
    };
  } catch (error) {
    const formatted = formatCredError(error);
    await ctx.metrics.write(`delegate.${formatted.metric}`, 1, { service, mode: runtimeConfig.mode });
    return {
      content: formatted.content,
      isError: formatted.isError,
    };
  }
}

async function handleEmbeddedDelegate(ctx, rawParams, runCtx, runtimeConfig) {
  const params = asRecord(rawParams);
  const userId = asString(params.user_id, 'user_id');
  const service = asString(params.service, 'service');
  const scopes = asScopes(params.scopes);
  const issueId = optionalString(params.issue_id, 'issue_id');

  try {
    const paperclipContext = await buildPaperclipContext(ctx, runtimeConfig, runCtx, issueId);
    const permissionRule = await ensureEmbeddedPermission(runtimeConfig, paperclipContext, service);
    if (!permissionRule.allowRootDelegation) {
      throw new Error(`Agent ${paperclipContext.agent.id} is not allowed to request a root delegation for ${service}`);
    }

    const cred = await getEmbeddedCred(runtimeConfig);
    const payload = await cred.delegate({
      userId,
      service,
      appClientId: runtimeConfig.credAppClientId,
      agentDid: paperclipContext.agentDid,
      scopes,
      receiptClaims: paperclipContext.claimCandidates,
    });

    const delegationId = tokenCache.store({
      accessToken: payload.accessToken,
      service,
      userId,
      expiresAt: payload.expiresAt.getTime(),
    });

    await ctx.metrics.write('delegate.success', 1, { service, mode: runtimeConfig.mode });
    await logBridgeActivity(ctx, runCtx.companyId, `Embedded Cred delegation issued for ${service}`, {
      mode: runtimeConfig.mode,
      agentId: runCtx.agentId,
      runId: runCtx.runId,
      issueId: issueId ?? null,
      service,
      userId,
      delegationId,
    });

    return {
      content: JSON.stringify({
        mode: runtimeConfig.mode,
        delegationId,
        service,
        expiresIn: payload.expiresIn,
        receipt: payload.receipt,
        agentDid: paperclipContext.agentDid,
        claimCandidates: paperclipContext.claimCandidates,
        note: 'Pass delegationId to cred_use to make authenticated API calls.',
      }),
    };
  } catch (error) {
    await ctx.metrics.write('delegate.error', 1, { service, mode: runtimeConfig.mode });
    return {
      content: `Error: ${error instanceof Error ? error.message : String(error)}`,
      isError: true,
    };
  }
}

async function handleDelegate(ctx, rawParams, runCtx) {
  const runtimeConfig = await resolveRuntimeConfig(ctx);
  if (runtimeConfig.mode === EMBEDDED_MODE) {
    return handleEmbeddedDelegate(ctx, rawParams, runCtx, runtimeConfig);
  }
  return handleRemoteDelegate(ctx, rawParams, runCtx, runtimeConfig);
}

async function resolveChildAgentDid(ctx, runtimeConfig, companyId, childAgentId, explicitAgentDid) {
  if (explicitAgentDid) {
    return explicitAgentDid;
  }
  if (!childAgentId) {
    throw new Error('Either child_agent_id or agent_did is required');
  }
  const childAgent = await ctx.agents.get(childAgentId, companyId);
  if (!childAgent) {
    throw new Error(`Child agent ${childAgentId} was not found in company ${companyId}`);
  }
  return `${runtimeConfig.credAgentDidPrefix}${childAgent.id}`;
}

async function resolveChildPaperclipContext(ctx, runtimeConfig, companyId, childAgentId, service) {
  const childAgent = await ctx.agents.get(childAgentId, companyId);
  if (!childAgent) {
    throw new Error(`Child agent ${childAgentId} was not found in company ${companyId}`);
  }
  const childContext = {
    agent: childAgent,
    agentDid: `${runtimeConfig.credAgentDidPrefix}${childAgent.id}`,
  };
  const permissionRule = await ensureEmbeddedPermission(runtimeConfig, childContext, service);
  return { childContext, permissionRule };
}

async function handleRemoteSubdelegate(ctx, rawParams, runCtx, runtimeConfig) {
  const params = asRecord(rawParams);
  const parentReceipt = asString(params.parent_receipt, 'parent_receipt');
  const userId = asString(params.user_id, 'user_id');
  const service = asString(params.service, 'service');
  const scopes = asScopes(params.scopes);
  const issueId = optionalString(params.issue_id, 'issue_id');
  const childAgentId = optionalString(params.child_agent_id, 'child_agent_id');
  const explicitAgentDid = optionalString(params.agent_did, 'agent_did');

  try {
    const signed = await buildPaperclipJwt(ctx, runtimeConfig, runCtx, issueId);
    const childAgentDid = await resolveChildAgentDid(
      ctx,
      runtimeConfig,
      runCtx.companyId,
      childAgentId,
      explicitAgentDid,
    );

    const payload = await postToCred(ctx, runtimeConfig, '/api/v1/subdelegate', {
      parent_receipt: parentReceipt,
      user_id: userId,
      service,
      appClientId: runtimeConfig.credAppClientId,
      agent_did: childAgentDid,
      ...(scopes ? { scopes } : {}),
    }, signed.jwt);

    const expiresIn = typeof payload.expires_in === 'number' ? payload.expires_in : 900;
    const delegationId = tokenCache.store({
      accessToken: asString(payload.access_token, 'access_token'),
      service,
      userId,
      expiresAt: Date.now() + expiresIn * 1000,
    });

    await ctx.metrics.write('subdelegate.success', 1, { service, mode: runtimeConfig.mode });
    await logBridgeActivity(ctx, runCtx.companyId, `Cred subdelegation issued for ${service}`, {
      mode: runtimeConfig.mode,
      agentId: runCtx.agentId,
      runId: runCtx.runId,
      issueId: issueId ?? null,
      service,
      userId,
      delegationId,
      childAgentDid,
    });

    return {
      content: JSON.stringify({
        mode: runtimeConfig.mode,
        delegationId,
        service,
        expiresIn,
        receipt: asString(payload.receipt, 'receipt'),
        chainDepth: typeof payload.chain_depth === 'number' ? payload.chain_depth : undefined,
        parentDelegationId: typeof payload.parent_delegation_id === 'string' ? payload.parent_delegation_id : undefined,
        childAgentDid,
        parentAgentDid: signed.agentDid,
        claimCandidates: signed.claimCandidates,
        note: 'Pass delegationId to cred_use to make authenticated API calls.',
      }),
    };
  } catch (error) {
    const formatted = formatCredError(error);
    await ctx.metrics.write(`subdelegate.${formatted.metric}`, 1, { service, mode: runtimeConfig.mode });
    return {
      content: formatted.content,
      isError: formatted.isError,
    };
  }
}

async function handleEmbeddedSubdelegate(ctx, rawParams, runCtx, runtimeConfig) {
  const params = asRecord(rawParams);
  const parentReceipt = asString(params.parent_receipt, 'parent_receipt');
  const userId = asString(params.user_id, 'user_id');
  const service = asString(params.service, 'service');
  const scopes = asScopes(params.scopes);
  const issueId = optionalString(params.issue_id, 'issue_id');
  const childAgentId = optionalString(params.child_agent_id, 'child_agent_id');
  const explicitAgentDid = optionalString(params.agent_did, 'agent_did');

  try {
    const parentClaims = receiptClaimsFromReceipt(parentReceipt);
    let childAgentDid = explicitAgentDid;
    let permissionRule;

    if (childAgentId) {
      const child = await resolveChildPaperclipContext(ctx, runtimeConfig, runCtx.companyId, childAgentId, service);
      childAgentDid = child.childContext.agentDid;
      permissionRule = child.permissionRule;
    } else if (!explicitAgentDid) {
      throw new Error('Either child_agent_id or agent_did is required');
    } else {
      throw new Error('embedded mode requires child_agent_id so the plugin can resolve Paperclip permissions');
    }

    const missingClaims = permissionRule.requiredReceiptClaims.filter((claim) => !parentClaims.includes(claim));
    if (missingClaims.length > 0) {
      throw new Error(`Parent receipt is missing required claims: ${missingClaims.join(', ')}`);
    }

    const paperclipContext = await buildPaperclipContext(ctx, runtimeConfig, runCtx, issueId);
    const cred = await getEmbeddedCred(runtimeConfig);
    const payload = await cred.subDelegate({
      parentReceipt,
      userId,
      service,
      appClientId: runtimeConfig.credAppClientId,
      agentDid: childAgentDid,
      ...(scopes ? { scopes } : {}),
    });

    const delegationId = tokenCache.store({
      accessToken: payload.accessToken,
      service,
      userId,
      expiresAt: payload.expiresAt.getTime(),
    });

    await ctx.metrics.write('subdelegate.success', 1, { service, mode: runtimeConfig.mode });
    await logBridgeActivity(ctx, runCtx.companyId, `Embedded Cred subdelegation issued for ${service}`, {
      mode: runtimeConfig.mode,
      agentId: runCtx.agentId,
      runId: runCtx.runId,
      issueId: issueId ?? null,
      service,
      userId,
      delegationId,
      childAgentDid,
    });

    return {
      content: JSON.stringify({
        mode: runtimeConfig.mode,
        delegationId,
        service,
        expiresIn: payload.expiresIn,
        receipt: payload.receipt,
        chainDepth: payload.chainDepth,
        parentDelegationId: payload.parentDelegationId,
        childAgentDid,
        parentAgentDid: paperclipContext.agentDid,
        claimCandidates: paperclipContext.claimCandidates,
        note: 'Pass delegationId to cred_use to make authenticated API calls.',
      }),
    };
  } catch (error) {
    await ctx.metrics.write('subdelegate.error', 1, { service, mode: runtimeConfig.mode });
    return {
      content: `Error: ${error instanceof Error ? error.message : String(error)}`,
      isError: true,
    };
  }
}

async function handleSubdelegate(ctx, rawParams, runCtx) {
  const runtimeConfig = await resolveRuntimeConfig(ctx);
  if (runtimeConfig.mode === EMBEDDED_MODE) {
    return handleEmbeddedSubdelegate(ctx, rawParams, runCtx, runtimeConfig);
  }
  return handleRemoteSubdelegate(ctx, rawParams, runCtx, runtimeConfig);
}

async function handleUse(ctx, rawParams, runCtx) {
  const params = asRecord(rawParams);
  const delegationId = asString(params.delegation_id, 'delegation_id');
  const method = asString(params.method, 'method').toUpperCase();
  const url = asString(params.url, 'url');
  const extraHeaders = asRecord(params.extra_headers);
  const body = params.body;

  if (!['GET', 'POST', 'PUT', 'PATCH', 'DELETE'].includes(method)) {
    return {
      content: 'Error: method must be GET, POST, PUT, PATCH, or DELETE.',
      isError: true,
    };
  }
  if (method === 'GET' && body !== undefined) {
    return {
      content: 'Error: GET requests cannot have a body.',
      isError: true,
    };
  }

  const entry = tokenCache.get(delegationId);
  if (!entry) {
    return {
      content: 'Error: delegation handle not found or expired. Call cred_delegate or cred_subdelegate again.',
      isError: true,
    };
  }
  if (!tokenCache.isAllowedUrl(entry.service, url)) {
    return {
      content: `Error: URL is not a valid ${entry.service} API endpoint.`,
      isError: true,
    };
  }

  const sanitizedHeaders = Object.fromEntries(
    Object.entries(extraHeaders).filter(([key, value]) => {
      if (typeof value !== 'string') {
        return false;
      }
      const normalized = key.toLowerCase();
      return normalized !== 'authorization' &&
        normalized !== 'signature' &&
        normalized !== 'signature-input' &&
        normalized !== 'signature-agent';
    }),
  );

  const headers = {
    Accept: 'application/json',
    Authorization: `Bearer ${entry.accessToken}`,
    'User-Agent': 'paperclip-plugin-cred/0.2.1',
    ...(body !== undefined ? { 'Content-Type': 'application/json' } : {}),
    ...sanitizedHeaders,
  };

  try {
    const response = await ctx.http.fetch(url, {
      method,
      headers,
      body: body !== undefined ? JSON.stringify(body) : undefined,
    });
    const contentType = response.headers.get('content-type') ?? '';
    const raw = await response.text();
    const truncated = raw.length > MAX_RESPONSE_BYTES;
    const snippet = truncated ? raw.slice(0, MAX_RESPONSE_BYTES) : raw;
    let parsedBody;
    try {
      parsedBody = JSON.parse(snippet);
    } catch {
      parsedBody = snippet;
    }

    await ctx.metrics.write('use.request', 1, { service: entry.service, method });
    await logBridgeActivity(ctx, runCtx.companyId, `Cred upstream request for ${entry.service}`, {
      agentId: runCtx.agentId,
      runId: runCtx.runId,
      service: entry.service,
      method,
      status: response.status,
    });

    return {
      content: JSON.stringify({
        status: response.status,
        ok: response.ok,
        contentType: contentType.split(';')[0].trim(),
        body: parsedBody,
        ...(truncated ? { truncated: true, truncatedAt: MAX_RESPONSE_BYTES } : {}),
      }, null, 2),
      isError: !response.ok,
    };
  } catch (error) {
    await ctx.metrics.write('use.error', 1, { service: entry.service, method });
    return {
      content: `Error: upstream request failed${error instanceof Error ? ` - ${error.message}` : ''}`,
      isError: true,
    };
  }
}

async function handleConnect(ctx, rawParams, runCtx) {
  const runtimeConfig = await resolveRuntimeConfig(ctx);
  const params = asRecord(rawParams);
  const userId = asString(params.user_id, 'user_id');
  const service = asString(params.service, 'service');
  const scopes = asScopes(params.scopes) ?? [];

  if (runtimeConfig.mode === REMOTE_SERVER_MODE) {
    return {
      content: JSON.stringify({
        mode: runtimeConfig.mode,
        service,
        connectUrl: `${runtimeConfig.credBaseUrl}/connect/${service}`,
        note: 'Open connectUrl in a browser to authorize against the builder-owned Cred server.',
      }),
    };
  }

  try {
    const { client, redirectUri } = await buildEmbeddedOAuthClient(runtimeConfig, service);
    const { url, state, codeVerifier } = await client.getAuthorizationUrl({ scopes });

    await ctx.state.set(
      {
        scopeKind: 'instance',
        namespace: EMBEDDED_STATE_NAMESPACE,
        stateKey: makeStateKey(state),
      },
      {
        userId,
        service,
        scopes,
        redirectUri,
        codeVerifier: codeVerifier ?? null,
        createdAt: new Date().toISOString(),
        companyId: runCtx.companyId,
      },
    );

    await logBridgeActivity(ctx, runCtx.companyId, `Embedded OAuth flow started for ${service}`, {
      mode: runtimeConfig.mode,
      agentId: runCtx.agentId,
      runId: runCtx.runId,
      userId,
      service,
      redirectUri,
    });

    return {
      content: JSON.stringify({
        mode: runtimeConfig.mode,
        service,
        userId,
        consentUrl: url,
        redirectUri,
        state,
        note: 'Open consentUrl in a browser. The localhost helper will complete the callback and store the tokens in the embedded vault.',
      }),
    };
  } catch (error) {
    return {
      content: `Error: ${error instanceof Error ? error.message : String(error)}`,
      isError: true,
    };
  }
}

async function handleConnections(ctx, rawParams) {
  const runtimeConfig = await resolveRuntimeConfig(ctx);
  const params = asRecord(rawParams);
  const userId = asString(params.user_id, 'user_id');

  if (runtimeConfig.mode !== EMBEDDED_MODE) {
    return {
      content: `Error: cred_connections is currently only implemented for ${EMBEDDED_MODE} mode.`,
      isError: true,
    };
  }

  try {
    const cred = await getEmbeddedCred(runtimeConfig);
    const connections = await cred.getUserConnections(userId);
    return {
      content: JSON.stringify({
        mode: runtimeConfig.mode,
        userId,
        connections,
      }, null, 2),
    };
  } catch (error) {
    return {
      content: `Error: ${error instanceof Error ? error.message : String(error)}`,
      isError: true,
    };
  }
}

async function handleEmbeddedOAuthWebhook(ctx, input) {
  const runtimeConfig = await resolveRuntimeConfig(ctx);
  if (runtimeConfig.mode !== EMBEDDED_MODE) {
    throw new Error('oauth-callback webhook is only supported in embedded mode');
  }

  const providedSecret = input.headers[CALLBACK_SECRET_HEADER];
  const normalizedSecret = Array.isArray(providedSecret) ? providedSecret[0] : providedSecret;
  if (normalizedSecret !== runtimeConfig.embeddedCallbackSecret) {
    throw new Error('Invalid embedded callback secret');
  }

  const body = asRecord(input.parsedBody);
  const service = asString(body.service, 'service');
  const state = asString(body.state, 'state');
  const error = optionalString(body.error, 'error');
  const errorDescription = optionalString(body.error_description, 'error_description');

  const stateKey = {
    scopeKind: 'instance',
    namespace: EMBEDDED_STATE_NAMESPACE,
    stateKey: makeStateKey(state),
  };
  const pending = asRecord(await ctx.state.get(stateKey));
  if (!pending || Object.keys(pending).length === 0) {
    throw new Error('OAuth state not found or already consumed');
  }
  if (pending.service !== service) {
    throw new Error('OAuth callback service does not match stored state');
  }

  if (error) {
    await ctx.state.delete(stateKey);
    throw new Error(errorDescription ? `${error}: ${errorDescription}` : error);
  }

  const code = asString(body.code, 'code');
  const { client } = await buildEmbeddedOAuthClient(runtimeConfig, service);
  const tokens = await client.exchangeCode({
    code,
    ...(typeof pending.codeVerifier === 'string' && pending.codeVerifier.length > 0
      ? { codeVerifier: pending.codeVerifier }
      : {}),
  });

  const vault = await getEmbeddedVault(runtimeConfig);
  await vault.store({
    provider: service,
    userId: asString(pending.userId, 'stored userId'),
    accessToken: asString(tokens.access_token, 'access_token'),
    refreshToken: optionalString(tokens.refresh_token, 'refresh_token'),
    expiresAt: typeof tokens.expires_in === 'number'
      ? new Date(Date.now() + tokens.expires_in * 1000)
      : undefined,
    scopes: typeof tokens.scope === 'string'
      ? tokens.scope.split(/[,\s]+/).map((scope) => scope.trim()).filter(Boolean)
      : pending.scopes,
  });

  await ctx.state.delete(stateKey);
  await logBridgeActivity(ctx, asString(pending.companyId, 'stored companyId'), `Embedded OAuth connection stored for ${service}`, {
    mode: runtimeConfig.mode,
    userId: pending.userId,
    service,
  });
}

const plugin = definePlugin({
  async setup(ctx) {
    ctx.tools.register(
      'cred_connect',
      {
        displayName: 'Cred Connect',
        description: 'Start a browser-based authorization flow for a service. In embedded mode this generates a localhost callback URL; in remote server mode it returns the server connect URL.',
        parametersSchema: {
          type: 'object',
          additionalProperties: false,
          properties: {
            user_id: { type: 'string' },
            service: { type: 'string' },
            scopes: { type: 'array', items: { type: 'string' } },
          },
          required: ['user_id', 'service'],
        },
      },
      async (params, runCtx) => handleConnect(ctx, params, runCtx),
    );

    ctx.tools.register(
      'cred_connections',
      {
        displayName: 'Cred Connections',
        description: 'List locally stored user connections in embedded mode.',
        parametersSchema: {
          type: 'object',
          additionalProperties: false,
          properties: {
            user_id: { type: 'string' },
          },
          required: ['user_id'],
        },
      },
      async (params) => handleConnections(ctx, params),
    );

    ctx.tools.register(
      'cred_delegate',
      {
        displayName: 'Cred Delegate',
        description: 'Request a delegated credential from Cred. Works against either the remote server bridge or embedded local mode.',
        parametersSchema: {
          type: 'object',
          additionalProperties: false,
          properties: {
            user_id: { type: 'string' },
            service: { type: 'string' },
            scopes: { type: 'array', items: { type: 'string' } },
            issue_id: { type: 'string' },
          },
          required: ['user_id', 'service'],
        },
      },
      async (params, runCtx) => handleDelegate(ctx, params, runCtx),
    );

    ctx.tools.register(
      'cred_subdelegate',
      {
        displayName: 'Cred Subdelegate',
        description: 'Create a child delegation from a signed parent receipt.',
        parametersSchema: {
          type: 'object',
          additionalProperties: false,
          properties: {
            parent_receipt: { type: 'string' },
            user_id: { type: 'string' },
            service: { type: 'string' },
            scopes: { type: 'array', items: { type: 'string' } },
            issue_id: { type: 'string' },
            child_agent_id: { type: 'string' },
            agent_did: { type: 'string' },
          },
          required: ['parent_receipt', 'user_id', 'service'],
        },
      },
      async (params, runCtx) => handleSubdelegate(ctx, params, runCtx),
    );

    ctx.tools.register(
      'cred_use',
      {
        displayName: 'Cred Use',
        description: 'Use a cached delegation handle to call an upstream API.',
        parametersSchema: {
          type: 'object',
          additionalProperties: false,
          properties: {
            delegation_id: { type: 'string' },
            url: { type: 'string' },
            method: {
              type: 'string',
              enum: ['GET', 'POST', 'PUT', 'PATCH', 'DELETE'],
            },
            body: { type: 'object' },
            extra_headers: {
              type: 'object',
              additionalProperties: { type: 'string' },
            },
          },
          required: ['delegation_id', 'url', 'method'],
        },
      },
      async (params, runCtx) => handleUse(ctx, params, runCtx),
    );
  },

  async onHealth() {
    return {
      status: 'ok',
      message: 'Cred bridge worker ready',
    };
  },

  async onValidateConfig(config) {
    try {
      const raw = asRecord(config);
      const mode = normalizeMode(raw.mode);
      asString(raw.credAppClientId, 'credAppClientId');

      if (mode === REMOTE_SERVER_MODE) {
        normalizeBaseUrl(raw.credBaseUrl, 'credBaseUrl');
      } else {
        asString(raw.embeddedVaultPath, 'embeddedVaultPath');
        optionalString(raw.embeddedVaultStorage, 'embeddedVaultStorage');
        normalizeBaseUrl(optionalString(raw.embeddedHelperBaseUrl, 'embeddedHelperBaseUrl') ?? 'http://127.0.0.1:3401', 'embeddedHelperBaseUrl');
        asPermissionRules(raw.embeddedPermissionRules);
      }

      return { ok: true };
    } catch (error) {
      return {
        ok: false,
        errors: [error instanceof Error ? error.message : String(error)],
      };
    }
  },

  async onWebhook(input) {
    if (input.endpointKey !== 'oauth-callback') {
      throw new Error(`Unknown webhook endpoint: ${input.endpointKey}`);
    }
    await handleEmbeddedOAuthWebhook(ctxRef, input);
  },
});

let ctxRef;

const wrappedPlugin = definePlugin({
  async setup(ctx) {
    ctxRef = ctx;
    return plugin.definition.setup(ctx);
  },
  async onHealth() {
    return plugin.definition.onHealth?.();
  },
  async onValidateConfig(config) {
    return plugin.definition.onValidateConfig?.(config);
  },
  async onWebhook(input) {
    return plugin.definition.onWebhook?.(input);
  },
});

export default wrappedPlugin;

runWorker(wrappedPlugin, import.meta.url);
