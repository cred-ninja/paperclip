import express from "express";
import request from "supertest";
import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  resolveSessionCompactionPolicy,
  ADAPTER_SESSION_MANAGEMENT,
} from "@paperclipai/adapter-utils";
import { agentRoutes } from "../routes/agents.js";
import { errorHandler } from "../middleware/index.js";

const agentId = "11111111-1111-4111-8111-111111111111";
const companyId = "22222222-2222-4222-8222-222222222222";

const baseAgent = {
  id: agentId,
  companyId,
  name: "Worker",
  urlKey: "worker",
  role: "engineer",
  title: null,
  icon: null,
  status: "running",
  reportsTo: null,
  capabilities: null,
  adapterType: "claude_local",
  adapterConfig: {},
  runtimeConfig: {},
  budgetMonthlyCents: 0,
  spentMonthlyCents: 0,
  pauseReason: null,
  pausedAt: null,
  permissions: {},
  lastHeartbeatAt: null,
  metadata: null,
  createdAt: new Date("2026-03-20T00:00:00Z"),
  updatedAt: new Date("2026-03-20T00:00:00Z"),
};

const healthySession = {
  sessionId: "session-abc",
  sessionAgeHours: 0.5,
  sessionRunCount: 3,
  rawInputTokens: 50_000,
  maxSessionAgeHours: 2,
  maxSessionRuns: 24,
  maxRawInputTokens: 1_000_000,
  healthy: true,
  warningReason: null,
  policySource: "adapter_default",
};

const unhealthySession = {
  ...healthySession,
  sessionAgeHours: 2.5,
  healthy: false,
  warningReason: "session age (2h) exceeds limit (2h)",
};

const mockAgentService = vi.hoisted(() => ({
  getById: vi.fn(),
  resolveByReference: vi.fn(),
}));

const mockHeartbeatService = vi.hoisted(() => ({
  getSessionHealth: vi.fn(),
  listTaskSessions: vi.fn(),
  resetRuntimeSession: vi.fn(),
}));

const mockAccessService = vi.hoisted(() => ({
  canUser: vi.fn(),
  hasPermission: vi.fn(),
}));

vi.mock("../services/index.js", () => ({
  agentService: () => mockAgentService,
  agentInstructionsService: () => ({ materializeManagedBundle: vi.fn() }),
  accessService: () => mockAccessService,
  approvalService: () => ({ create: vi.fn(), getById: vi.fn() }),
  companySkillService: () => ({
    listRuntimeSkillEntries: vi.fn(async () => []),
    resolveRequestedSkillKeys: vi.fn(async (_c: string, r: string[]) => r),
  }),
  budgetService: () => ({ upsertPolicy: vi.fn() }),
  heartbeatService: () => mockHeartbeatService,
  issueApprovalService: () => ({ linkManyForApproval: vi.fn() }),
  issueService: () => ({ list: vi.fn() }),
  logActivity: vi.fn(),
  secretService: () => ({
    normalizeAdapterConfigForPersistence: vi.fn(),
    resolveAdapterConfigForRuntime: vi.fn(),
  }),
  syncInstructionsBundleConfigFromFilePath: vi.fn((_a: unknown, c: unknown) => c),
  workspaceOperationService: () => ({}),
}));

function createDbStub() {
  return {
    select: vi.fn().mockReturnValue({
      from: vi.fn().mockReturnValue({
        where: vi.fn().mockReturnValue({
          then: vi.fn().mockResolvedValue([{
            id: companyId,
            name: "GStack",
            requireBoardApprovalForNewAgents: false,
          }]),
        }),
      }),
    }),
  };
}

function createApp(actor: Record<string, unknown> = {
  type: "board",
  userId: "local-board",
  companyIds: [companyId],
  source: "local_implicit",
  isInstanceAdmin: false,
}) {
  const app = express();
  app.use(express.json());
  app.use((req, _res, next) => {
    (req as any).actor = actor;
    next();
  });
  app.use("/api", agentRoutes(createDbStub() as any));
  app.use(errorHandler);
  return app;
}

describe("GET /agents/:id/session-health", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockAgentService.getById.mockResolvedValue(baseAgent);
    mockAgentService.resolveByReference.mockResolvedValue({ ambiguous: false, agent: baseAgent });
    mockHeartbeatService.getSessionHealth.mockResolvedValue(healthySession);
  });

  it("returns session health for a healthy session", async () => {
    const res = await request(createApp()).get(`/api/agents/${agentId}/session-health`);

    expect(res.status).toBe(200);
    expect(res.body.healthy).toBe(true);
    expect(res.body.sessionId).toBe("session-abc");
    expect(res.body.sessionAgeHours).toBe(0.5);
    expect(res.body.sessionRunCount).toBe(3);
    expect(res.body.maxSessionAgeHours).toBe(2);
    expect(res.body.warningReason).toBeNull();
    expect(res.body.policySource).toBe("adapter_default");
  });

  it("returns unhealthy status when session exceeds limits", async () => {
    mockHeartbeatService.getSessionHealth.mockResolvedValue(unhealthySession);

    const res = await request(createApp()).get(`/api/agents/${agentId}/session-health`);

    expect(res.status).toBe(200);
    expect(res.body.healthy).toBe(false);
    expect(res.body.warningReason).toContain("exceeds limit");
  });

  it("returns 404 for non-existent agent", async () => {
    mockAgentService.getById.mockResolvedValue(null);

    const res = await request(createApp()).get(
      "/api/agents/99999999-9999-4999-8999-999999999999/session-health",
    );

    expect(res.status).toBe(404);
  });

  it("rejects non-board callers", async () => {
    const agentActor = {
      type: "agent",
      agentId: "other-agent",
      companyId,
      source: "agent_jwt",
      isInstanceAdmin: false,
    };

    const res = await request(createApp(agentActor)).get(`/api/agents/${agentId}/session-health`);

    expect(res.status).toBe(403);
  });

  it("returns null session fields when no active session", async () => {
    mockHeartbeatService.getSessionHealth.mockResolvedValue({
      sessionId: null,
      sessionAgeHours: 0,
      sessionRunCount: 0,
      maxSessionAgeHours: 2,
      maxSessionRuns: 24,
      maxRawInputTokens: 1_000_000,
      healthy: true,
      warningReason: null,
      policySource: "adapter_default",
    });

    const res = await request(createApp()).get(`/api/agents/${agentId}/session-health`);

    expect(res.status).toBe(200);
    expect(res.body.sessionId).toBeNull();
    expect(res.body.sessionAgeHours).toBe(0);
    expect(res.body.healthy).toBe(true);
  });
});

describe("session compaction policy defaults", () => {
  it("claude_local defaults to maxSessionAgeHours of 2", () => {
    const mgmt = ADAPTER_SESSION_MANAGEMENT["claude_local"];
    expect(mgmt.defaultSessionCompaction.maxSessionAgeHours).toBe(2);
    expect(mgmt.defaultSessionCompaction.maxSessionRuns).toBe(24);
    expect(mgmt.defaultSessionCompaction.maxRawInputTokens).toBe(1_000_000);
  });

  it("resolves claude_local policy with adapter defaults", () => {
    const result = resolveSessionCompactionPolicy("claude_local", {});
    expect(result.source).toBe("adapter_default");
    expect(result.policy).toEqual({
      enabled: true,
      maxSessionRuns: 24,
      maxRawInputTokens: 1_000_000,
      maxSessionAgeHours: 2,
    });
  });

  it("allows per-agent override of maxSessionAgeHours", () => {
    const result = resolveSessionCompactionPolicy("claude_local", {
      heartbeat: {
        sessionCompaction: {
          maxSessionAgeHours: 4,
        },
      },
    });
    expect(result.source).toBe("agent_override");
    expect(result.policy.maxSessionAgeHours).toBe(4);
    expect(result.policy.maxSessionRuns).toBe(24);
  });

  it("codex_local uses adapter-managed policy with zero thresholds", () => {
    const result = resolveSessionCompactionPolicy("codex_local", {});
    expect(result.policy.maxSessionAgeHours).toBe(0);
    expect(result.policy.maxSessionRuns).toBe(0);
    expect(result.policy.maxRawInputTokens).toBe(0);
  });
});
