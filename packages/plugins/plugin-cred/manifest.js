const manifest = {
  id: 'cred.paperclip',
  apiVersion: 1,
  version: '0.2.1',
  displayName: 'Cred Bridge',
  description: 'Delegation bridge from Paperclip agent runs to either a self-hosted Cred server or embedded local Cred primitives.',
  author: 'Cred Ninja',
  categories: ['connector', 'automation'],
  capabilities: [
    'agent.tools.register',
    'agents.read',
    'issues.read',
    'http.outbound',
    'secrets.read-ref',
    'activity.log.write',
    'metrics.write',
    'plugin.state.read',
    'plugin.state.write',
    'webhooks.receive',
  ],
  entrypoints: {
    worker: './worker.js',
  },
  webhooks: [
    {
      endpointKey: 'oauth-callback',
      displayName: 'OAuth Callback',
      description: 'Receives OAuth callback payloads from the local embedded callback helper.',
    },
  ],
  instanceConfigSchema: {
    type: 'object',
    additionalProperties: false,
    properties: {
      mode: {
        type: 'string',
        enum: ['remote_server', 'embedded'],
        description: 'How the plugin talks to Cred. remote_server uses an external Cred server. embedded uses local Cred primitives plus a localhost callback helper.',
        default: 'remote_server',
      },
      credBaseUrl: {
        type: 'string',
        description: 'Base URL of the builder-owned Cred server.',
      },
      credAppClientId: {
        type: 'string',
        description: 'Cred app client ID used for delegation requests.',
      },
      credJwtAudience: {
        type: 'string',
        description: 'Optional JWT audience expected by the Cred verifier.',
        default: 'cred',
      },
      credRequestHeader: {
        type: 'string',
        description: 'Header name used to send the signed Paperclip agent JWT to Cred.',
        default: 'x-paperclip-agent-jwt',
      },
      credAgentDidPrefix: {
        type: 'string',
        description: 'Prefix used to derive agent DIDs from Paperclip agent IDs.',
        default: 'paperclip:agent:',
      },
      credAgentTokenSecretRef: {
        type: 'string',
        description: 'Optional secret ref for legacy Cred bearer auth.',
      },
      paperclipAgentJwtSecretRef: {
        type: 'string',
        description: 'Optional secret ref for the HMAC secret used to sign Paperclip agent JWTs. Defaults to PAPERCLIP_AGENT_JWT_SECRET from the host env.',
      },
      embeddedVaultPath: {
        type: 'string',
        description: 'Path to the local embedded Cred vault file when mode=embedded.',
      },
      embeddedVaultStorage: {
        type: 'string',
        enum: ['file', 'sqlite'],
        description: 'Storage backend for the embedded Cred vault.',
        default: 'file',
      },
      embeddedVaultPassphraseSecretRef: {
        type: 'string',
        description: 'Secret ref for the embedded vault passphrase. Defaults to PAPERCLIP_CRED_VAULT_PASSPHRASE from the host env.',
      },
      embeddedHelperBaseUrl: {
        type: 'string',
        description: 'Base URL of the localhost OAuth callback helper used in embedded mode.',
        default: 'http://127.0.0.1:3401',
      },
      embeddedCallbackSecretRef: {
        type: 'string',
        description: 'Secret ref for the shared secret used between the localhost callback helper and this plugin. Defaults to PAPERCLIP_CRED_CALLBACK_SECRET from the host env.',
      },
      embeddedPermissionRules: {
        type: 'array',
        description: 'Ordered per-agent embedded permission rules. First match wins.',
        items: {
          type: 'object',
          additionalProperties: false,
          properties: {
            services: {
              type: 'array',
              items: { type: 'string' },
            },
            allowedScopes: {
              type: 'array',
              items: { type: 'string' },
            },
            agentIds: {
              type: 'array',
              items: { type: 'string' },
            },
            agentUrlKeys: {
              type: 'array',
              items: { type: 'string' },
            },
            roles: {
              type: 'array',
              items: { type: 'string' },
            },
            titles: {
              type: 'array',
              items: { type: 'string' },
            },
            allowRootDelegation: {
              type: 'boolean',
            },
            delegatable: {
              type: 'boolean',
            },
            maxDelegationDepth: {
              type: 'integer',
              minimum: 1,
            },
            requiredReceiptClaims: {
              type: 'array',
              items: { type: 'string' },
            },
            rateLimitMaxRequests: {
              type: 'integer',
              minimum: 1,
            },
            rateLimitWindowMs: {
              type: 'integer',
              minimum: 1,
            },
          },
          required: ['services', 'allowedScopes'],
        },
      },
      githubClientId: {
        type: 'string',
        description: 'OAuth client ID for GitHub when mode=embedded.',
      },
      githubClientSecretRef: {
        type: 'string',
        description: 'Secret ref for the GitHub OAuth client secret when mode=embedded.',
      },
      googleClientId: {
        type: 'string',
        description: 'OAuth client ID for Google when mode=embedded.',
      },
      googleClientSecretRef: {
        type: 'string',
        description: 'Secret ref for the Google OAuth client secret when mode=embedded.',
      },
      slackClientId: {
        type: 'string',
        description: 'OAuth client ID for Slack when mode=embedded.',
      },
      slackClientSecretRef: {
        type: 'string',
        description: 'Secret ref for the Slack OAuth client secret when mode=embedded.',
      },
      notionClientId: {
        type: 'string',
        description: 'OAuth client ID for Notion when mode=embedded.',
      },
      notionClientSecretRef: {
        type: 'string',
        description: 'Secret ref for the Notion OAuth client secret when mode=embedded.',
      },
      salesforceClientId: {
        type: 'string',
        description: 'OAuth client ID for Salesforce when mode=embedded.',
      },
      salesforceClientSecretRef: {
        type: 'string',
        description: 'Secret ref for the Salesforce OAuth client secret when mode=embedded.',
      },
      linearClientId: {
        type: 'string',
        description: 'OAuth client ID for Linear when mode=embedded.',
      },
      linearClientSecretRef: {
        type: 'string',
        description: 'Secret ref for the Linear OAuth client secret when mode=embedded.',
      },
      hubspotClientId: {
        type: 'string',
        description: 'OAuth client ID for HubSpot when mode=embedded.',
      },
      hubspotClientSecretRef: {
        type: 'string',
        description: 'Secret ref for the HubSpot OAuth client secret when mode=embedded.',
      },
    },
    required: ['credAppClientId'],
  },
  tools: [
    {
      name: 'cred_connect',
      displayName: 'Cred Connect',
      description: 'Start a browser-based authorization flow for a service.',
      parametersSchema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          user_id: {
            type: 'string',
            description: 'Cred user ID to connect.',
          },
          service: {
            type: 'string',
            description: 'Service name such as github, google, slack, notion, or salesforce.',
          },
          scopes: {
            type: 'array',
            items: { type: 'string' },
            description: 'Requested scopes.',
          },
        },
        required: ['user_id', 'service'],
      },
    },
    {
      name: 'cred_connections',
      displayName: 'Cred Connections',
      description: 'List locally stored user connections in embedded mode.',
      parametersSchema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          user_id: {
            type: 'string',
            description: 'Cred user ID to inspect.',
          },
        },
        required: ['user_id'],
      },
    },
    {
      name: 'cred_delegate',
      displayName: 'Cred Delegate',
      description: 'Request a delegated credential from Cred for the current Paperclip agent.',
      parametersSchema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          user_id: {
            type: 'string',
            description: 'Cred user ID to delegate for.',
          },
          service: {
            type: 'string',
            description: 'Service name such as github, google, slack, notion, or salesforce.',
          },
          scopes: {
            type: 'array',
            items: { type: 'string' },
            description: 'Requested scopes.',
          },
          issue_id: {
            type: 'string',
            description: 'Optional issue context to include in the signed Paperclip JWT.',
          },
        },
        required: ['user_id', 'service'],
      },
    },
    {
      name: 'cred_subdelegate',
      displayName: 'Cred Subdelegate',
      description: 'Create a child delegation from a signed parent receipt for another agent or runtime.',
      parametersSchema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          parent_receipt: {
            type: 'string',
            description: 'Signed parent receipt produced by Cred.',
          },
          user_id: {
            type: 'string',
            description: 'Cred user ID to delegate for.',
          },
          service: {
            type: 'string',
            description: 'Service name such as github, google, slack, notion, or salesforce.',
          },
          scopes: {
            type: 'array',
            items: { type: 'string' },
            description: 'Optional subset of the parent scopes.',
          },
          issue_id: {
            type: 'string',
            description: 'Optional issue context to include in the signed Paperclip JWT.',
          },
          child_agent_id: {
            type: 'string',
            description: 'Paperclip agent ID for the child delegatee.',
          },
          agent_did: {
            type: 'string',
            description: 'Explicit child agent DID for non-Paperclip recipients.',
          },
        },
        required: ['parent_receipt', 'user_id', 'service'],
      },
    },
    {
      name: 'cred_use',
      displayName: 'Cred Use',
      description: 'Use a cached delegation handle to call an upstream API without exposing the raw token.',
      parametersSchema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          delegation_id: {
            type: 'string',
            description: 'Delegation handle returned by cred_delegate or cred_subdelegate.',
          },
          url: {
            type: 'string',
            description: 'Full upstream API URL.',
          },
          method: {
            type: 'string',
            enum: ['GET', 'POST', 'PUT', 'PATCH', 'DELETE'],
            description: 'HTTP method.',
          },
          body: {
            type: 'object',
            description: 'Optional request body for non-GET calls.',
          },
          extra_headers: {
            type: 'object',
            additionalProperties: { type: 'string' },
            description: 'Optional additional headers for the upstream call.',
          },
        },
        required: ['delegation_id', 'url', 'method'],
      },
    },
  ],
};

export default manifest;
