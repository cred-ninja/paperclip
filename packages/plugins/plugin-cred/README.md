# Paperclip Cred Bridge

Paperclip already knows which agent is running, what company and issue context it is operating in, and how approval workflows move through a company template. What it does not do by itself is issue service credentials that remain constrained even if an agent ignores its instructions.

This plugin adds that layer with Cred.

It supports two deployment modes:

- `remote_server`: Paperclip talks to a builder-owned Cred server over HTTP.
- `embedded`: Paperclip uses Cred's local primitives directly inside the plugin and stores provider tokens in a local encrypted vault.

This package is the Paperclip-side integration. Cred core stays separate.

## What Cred Adds To Paperclip

With this plugin installed, a Paperclip agent can:

- request a delegated credential without seeing the long-lived upstream token
- pass a signed receipt to another agent for constrained subdelegation
- use `delegationId` handles through `cred_use` instead of exposing raw tokens to the model
- enforce approval-chain requirements by requiring specific receipt claims on subdelegation

The plugin emits generic Paperclip claim candidates such as:

- `paperclip:role:engineer`
- `paperclip:title:staff-engineer`
- `paperclip:issue-review:approved`
- `paperclip:github-pr:merged`

Company-specific policy stays in configuration or on the Cred server side. The plugin does not hardcode GStack.

## Tools

Paperclip namespaces plugin tools by plugin ID. This plugin registers:

- `cred.paperclip:cred_connect`
- `cred.paperclip:cred_connections`
- `cred.paperclip:cred_delegate`
- `cred.paperclip:cred_subdelegate`
- `cred.paperclip:cred_use`

Typical handoff flow:

1. A reviewer agent calls `cred_delegate` and gets a local `delegationId` plus an optional signed `receipt`.
2. That reviewer passes the `receipt` to another agent.
3. The downstream agent calls `cred_subdelegate` with the parent receipt and its own `child_agent_id`.
4. The downstream agent uses `cred_use` with the returned `delegationId` to call the upstream API.

That is the primitive needed for workflows like “Release Engineer cannot merge unless the receipt chain carries the required approval claim.”

## Installation

```bash
pnpm install
pnpm --filter @cred-ninja/paperclip-plugin-cred build
pnpm paperclipai plugin install ./packages/plugins/plugin-cred
```

If you are iterating locally and reinstalling from the same path, Node's module cache can preserve the previous worker bundle. Installing from a fresh copied path avoids that during development.

## Dependencies

Inside this Paperclip monorepo, the plugin uses:

- `@paperclipai/plugin-sdk` via `workspace:*`
- `@credninja/sdk`
- `@credninja/oauth`
- `@credninja/vault`

If you extract this plugin into its own repository later, replace the workspace SDK dependency with a published `@paperclipai/plugin-sdk` version.

## Mode 1: Remote Server

Use `remote_server` when you want Cred to remain a separate broker service.

In this mode the plugin:

- signs current Paperclip agent context into a short-lived JWT
- sends that JWT to a builder-owned Cred server
- receives short-lived delegated tokens from the server

Minimal plugin config:

```json
{
  "mode": "remote_server",
  "credBaseUrl": "http://127.0.0.1:3399",
  "credAppClientId": "your_app_client_id"
}
```

Optional config:

- `credRequestHeader`
- `credJwtAudience`
- `credAgentDidPrefix`
- `credAgentTokenSecretRef`
- `paperclipAgentJwtSecretRef`

The Cred server should verify the Paperclip JWT and translate trusted Paperclip metadata into Guard metadata or `receiptClaims`.

Example verifier shape:

```ts
import crypto from "node:crypto";

function verifyHs256(jwt: string, secret: string) {
  const [header, payload, signature] = jwt.split(".");
  const expected = crypto.createHmac("sha256", secret).update(`${header}.${payload}`).digest("base64url");
  if (expected !== signature) throw new Error("invalid signature");
  return JSON.parse(Buffer.from(payload, "base64url").toString("utf8"));
}

const secret = process.env.PAPERCLIP_AGENT_JWT_SECRET!;

const agentRequestVerifier = async (req: { header(name: string): string | undefined }) => {
  const token = req.header("x-paperclip-agent-jwt");
  if (!token) return null;

  const payload = verifyHs256(token, secret);
  const paperclip = payload.paperclip ?? {};
  const claimCandidates = Array.isArray(paperclip.claimCandidates) ? paperclip.claimCandidates : [];

  return {
    agentDid: String(payload.sub),
    metadata: {
      paperclip,
      receiptClaims: claimCandidates,
    },
  };
};
```

Use this mode when:

- you want Cred isolated as a separate service
- you want Guard decisions at server issuance time
- you want the same Cred server usable by non-Paperclip runtimes too

## Mode 2: Embedded

Use `embedded` when you want the whole setup to stay local-first and Paperclip-native.

In this mode the plugin:

- uses `@credninja/sdk` in local mode
- stores provider tokens in a local encrypted vault
- issues local receipts and subdelegations inside the plugin
- enforces ordered agent permission rules from plugin config

Embedded mode still needs a tiny localhost callback helper because Paperclip plugins only receive `POST` webhooks, while OAuth providers redirect browsers with `GET` callbacks.

### Embedded Config

Example embedded config:

```json
{
  "mode": "embedded",
  "credAppClientId": "your_app_client_id",
  "embeddedVaultPath": "/absolute/path/to/cred-vault.json",
  "embeddedVaultStorage": "file",
  "embeddedHelperBaseUrl": "http://127.0.0.1:3401",
  "embeddedVaultPassphraseSecretRef": "your-paperclip-secret-id",
  "embeddedCallbackSecretRef": "your-paperclip-secret-id",
  "embeddedPermissionRules": [
    {
      "titles": ["Staff Engineer"],
      "services": ["github"],
      "allowedScopes": ["repo"],
      "allowRootDelegation": true,
      "delegatable": true,
      "maxDelegationDepth": 2
    },
    {
      "titles": ["Release Engineer"],
      "services": ["github"],
      "allowedScopes": ["repo"],
      "allowRootDelegation": false,
      "delegatable": false,
      "maxDelegationDepth": 1,
      "requiredReceiptClaims": ["paperclip:title:staff-engineer", "paperclip:issue-review:approved"]
    }
  ],
  "githubClientId": "github_oauth_client_id",
  "githubClientSecretRef": "your-paperclip-secret-id"
}
```

### Embedded OAuth Helper

Run the helper:

```bash
PAPERCLIP_API_BASE_URL=http://127.0.0.1:3101 \
PAPERCLIP_PLUGIN_ID=cred.paperclip \
PAPERCLIP_PLUGIN_WEBHOOK_SECRET=your_callback_secret \
node embedded-callback-server.mjs
```

Then use `cred_connect` and open the returned `consentUrl`. The helper receives the browser callback and forwards it to the plugin webhook, and the plugin stores the resulting tokens in the embedded vault.

For GitHub, the OAuth callback URL should be:

```text
http://127.0.0.1:3401/oauth/github/callback
```

Use this mode when:

- you want a Paperclip-native local deployment
- you do not want a separate Cred server process in the loop
- you are comfortable letting the Paperclip plugin own local vault and refresh behavior

## How To Use It

Remote-server mode:

1. Run the builder-owned Cred server.
2. Configure the plugin with `mode=remote_server`, `credBaseUrl`, and `credAppClientId`.
3. Use `cred_delegate`, `cred_subdelegate`, and `cred_use` from agents.

Embedded mode:

1. Configure the vault, callback secret, helper base URL, provider credentials, and permission rules.
2. Run `embedded-callback-server.mjs`.
3. Use `cred_connect` once per user/service to seed the local vault.
4. Use `cred_delegate`, `cred_subdelegate`, and `cred_use` from agents.

## GStack Example

You do not need to hardcode GStack into the plugin. Express the workflow with config and instructions:

- Staff Engineer rule: allow root GitHub delegation and make it delegatable.
- Release Engineer rule: deny root delegation and require receipt claims such as `paperclip:title:staff-engineer` plus `paperclip:issue-review:approved`.
- Release Engineer instructions: always use `cred_subdelegate` before merge-capable GitHub work.

That keeps the integration generic across Paperclip companies while still supporting GStack's approval chain.

## Current Limits

- `cred_connect` is primarily for embedded mode. In remote-server mode it returns the server connect URL rather than constructing a provider-specific flow itself.
- `cred_connections` is currently implemented only for embedded mode.
- GitHub OAuth scopes are still coarse. If you want literal issue-write vs merge-write separation, use a GitHub App or another finer-grained backend.
- Embedded mode enforces policy through plugin configuration rather than Guard, so if you want centralized Guard enforcement, use remote-server mode.
