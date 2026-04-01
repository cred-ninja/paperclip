import express from "express";
import request from "supertest";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { parseResearchBrief, renderDebtMarkdown } from "../services/compiler-pipeline.js";
import { compilerRoutes } from "../routes/compiler.js";
import { errorHandler } from "../middleware/index.js";

// ---------------------------------------------------------------------------
// Unit tests: parseResearchBrief
// ---------------------------------------------------------------------------

describe("parseResearchBrief", () => {
  it("parses a single debt item with all metadata", () => {
    const content = `
## Findings

### Fix memory leak in worker pool
Priority: high
Role: engineer
Labels: perf, backend

The worker pool leaks connections when tasks timeout.
Connections should be cleaned up on error.

---
`.trim();

    const items = parseResearchBrief(content);
    expect(items).toHaveLength(1);
    expect(items[0]).toMatchObject({
      key: "DEBT-001",
      title: "Fix memory leak in worker pool",
      priority: "high",
      assigneeRole: "engineer",
      labels: ["perf", "backend"],
    });
    expect(items[0].description).toContain("worker pool leaks connections");
  });

  it("parses multiple debt items separated by ---", () => {
    const content = `
### Add rate limiting to public API
Priority: critical
Role: engineer

Public endpoints have no rate limiting.

---

### Write integration tests for auth flow
Priority: medium
Role: qa

Auth flow has no integration test coverage.

---
`.trim();

    const items = parseResearchBrief(content);
    expect(items).toHaveLength(2);
    expect(items[0].key).toBe("DEBT-001");
    expect(items[0].title).toBe("Add rate limiting to public API");
    expect(items[0].priority).toBe("critical");
    expect(items[1].key).toBe("DEBT-002");
    expect(items[1].title).toBe("Write integration tests for auth flow");
    expect(items[1].priority).toBe("medium");
    expect(items[1].assigneeRole).toBe("qa");
  });

  it("defaults priority to medium when not specified", () => {
    const content = `
### Refactor config loader

Config loading is scattered across multiple files.

---
`.trim();

    const items = parseResearchBrief(content);
    expect(items).toHaveLength(1);
    expect(items[0].priority).toBe("medium");
    expect(items[0].assigneeRole).toBeUndefined();
  });

  it("returns empty array for content with no ### headings", () => {
    const content = "Just some plain text with no structured headings.";
    const items = parseResearchBrief(content);
    expect(items).toHaveLength(0);
  });

  it("parses parent key references", () => {
    const content = `
### Set up monitoring dashboard
Priority: medium
Role: devops

---

### Add alerting rules
Priority: medium
Role: devops
Parent: DEBT-001

Alerting depends on the monitoring dashboard.

---
`.trim();

    const items = parseResearchBrief(content);
    expect(items).toHaveLength(2);
    expect(items[1].parentKey).toBe("DEBT-001");
  });
});

// ---------------------------------------------------------------------------
// Unit tests: renderDebtMarkdown
// ---------------------------------------------------------------------------

describe("renderDebtMarkdown", () => {
  it("renders a well-formatted markdown document", () => {
    const items = [
      {
        key: "DEBT-001",
        title: "Fix SQL injection in search",
        description: "User input is concatenated into SQL queries.",
        priority: "critical" as const,
        assigneeRole: "engineer" as const,
        labels: ["security"],
      },
      {
        key: "DEBT-002",
        title: "Add logging to payment flow",
        description: "No observability in payment processing.",
        priority: "high" as const,
      },
    ];

    const md = renderDebtMarkdown(items, "RES-6");
    expect(md).toContain("# Technical Debt — Lowered from RES-6");
    expect(md).toContain("## DEBT-001: Fix SQL injection in search");
    expect(md).toContain("**Priority:** critical");
    expect(md).toContain("**Assigned Role:** engineer");
    expect(md).toContain("**Labels:** security");
    expect(md).toContain("## DEBT-002: Add logging to payment flow");
    expect(md).toContain("2 item(s) extracted");
  });
});

// ---------------------------------------------------------------------------
// Route-level tests
// ---------------------------------------------------------------------------

const companyId = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const sourceIssueId = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";
const targetCompanyId = "cccccccc-cccc-4ccc-8ccc-cccccccccccc";
const agentId = "dddddddd-dddd-4ddd-8ddd-dddddddddddd";
const approvalId = "eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee";

const sampleManifest = {
  version: "1" as const,
  source: { issueId: sourceIssueId, companyId, identifier: "RES-6" },
  target: { companyId: targetCompanyId },
  items: [
    {
      key: "DEBT-001",
      title: "Fix leak",
      description: "Memory leak in pool",
      priority: "high" as const,
    },
  ],
};

const mockPipelineService = vi.hoisted(() => ({
  lower: vi.fn(),
  requestApproval: vi.fn(),
  execute: vi.fn(),
  getManifest: vi.fn(),
}));

const mockHeartbeatService = vi.hoisted(() => ({
  wakeup: vi.fn(async () => undefined),
}));

const mockIssueService = vi.hoisted(() => ({
  getById: vi.fn(),
}));

const mockLogActivity = vi.hoisted(() => vi.fn(async () => undefined));

vi.mock("../services/index.js", () => ({
  compilerPipelineService: () => mockPipelineService,
  heartbeatService: () => mockHeartbeatService,
  issueService: () => mockIssueService,
  logActivity: mockLogActivity,
}));

vi.mock("../services/issue-assignment-wakeup.js", () => ({
  queueIssueAssignmentWakeup: vi.fn(),
}));

function createApp() {
  const app = express();
  app.use(express.json());
  app.use((req, _res, next) => {
    (req as any).actor = {
      type: "agent",
      agentId,
      companyId,
      source: "agent_jwt",
      isInstanceAdmin: false,
      runId: "run-1",
    };
    next();
  });
  app.use("/api", compilerRoutes({} as any));
  app.use(errorHandler);
  return app;
}

describe("compiler routes", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  describe("POST /api/companies/:companyId/compiler/lower", () => {
    it("returns 200 with lowered items on success", async () => {
      mockPipelineService.lower.mockResolvedValue({
        debtMarkdown: "# Debt",
        manifest: sampleManifest,
      });

      const app = createApp();
      const res = await request(app)
        .post(`/api/companies/${companyId}/compiler/lower`)
        .send({ sourceIssueId, targetCompanyId })
        .expect(200);

      expect(res.body.itemCount).toBe(1);
      expect(res.body.items[0].key).toBe("DEBT-001");
      expect(res.body.sourceIssueId).toBe(sourceIssueId);
      expect(mockPipelineService.lower).toHaveBeenCalledOnce();
    });

    it("validates required fields", async () => {
      const app = createApp();
      await request(app)
        .post(`/api/companies/${companyId}/compiler/lower`)
        .send({})
        .expect(400);
    });
  });

  describe("POST /api/companies/:companyId/compiler/request-approval", () => {
    it("returns 201 with approval on success", async () => {
      const mockApproval = {
        id: approvalId,
        companyId,
        type: "compiler_execution",
        status: "pending",
        payload: { sourceIssueId },
      };
      mockPipelineService.requestApproval.mockResolvedValue(mockApproval);

      const app = createApp();
      const res = await request(app)
        .post(`/api/companies/${companyId}/compiler/request-approval`)
        .send({ sourceIssueId })
        .expect(201);

      expect(res.body.id).toBe(approvalId);
      expect(res.body.type).toBe("compiler_execution");
    });
  });

  describe("POST /api/companies/:companyId/compiler/execute", () => {
    it("returns 201 with created issues on success", async () => {
      const mockResult = {
        createdIssues: [
          { debtKey: "DEBT-001", issueId: "new-issue-1", identifier: "FAC-1" },
        ],
        sourceIssueId,
        targetCompanyId,
      };
      mockPipelineService.execute.mockResolvedValue(mockResult);
      mockIssueService.getById.mockResolvedValue({
        id: "new-issue-1",
        assigneeAgentId: agentId,
        status: "todo",
      });

      const app = createApp();
      const res = await request(app)
        .post(`/api/companies/${companyId}/compiler/execute`)
        .send({ sourceIssueId })
        .expect(201);

      expect(res.body.createdIssues).toHaveLength(1);
      expect(res.body.createdIssues[0].identifier).toBe("FAC-1");
    });

    it("creates issues without wakeup when no assignee", async () => {
      const mockResult = {
        createdIssues: [
          { debtKey: "DEBT-001", issueId: "new-issue-1", identifier: "FAC-1" },
        ],
        sourceIssueId,
        targetCompanyId,
      };
      mockPipelineService.execute.mockResolvedValue(mockResult);
      mockIssueService.getById.mockResolvedValue({
        id: "new-issue-1",
        assigneeAgentId: null,
        status: "todo",
      });

      const app = createApp();
      await request(app)
        .post(`/api/companies/${companyId}/compiler/execute`)
        .send({ sourceIssueId })
        .expect(201);

      const { queueIssueAssignmentWakeup } = await import(
        "../services/issue-assignment-wakeup.js"
      );
      expect(queueIssueAssignmentWakeup).not.toHaveBeenCalled();
    });
  });

  describe("GET /api/companies/:companyId/compiler/manifest/:sourceIssueId", () => {
    it("returns the manifest when it exists", async () => {
      mockPipelineService.getManifest.mockResolvedValue(sampleManifest);

      const app = createApp();
      const res = await request(app)
        .get(`/api/companies/${companyId}/compiler/manifest/${sourceIssueId}`)
        .expect(200);

      expect(res.body.version).toBe("1");
      expect(res.body.items).toHaveLength(1);
    });

    it("returns 404 when no manifest exists", async () => {
      mockPipelineService.getManifest.mockResolvedValue(null);

      const app = createApp();
      await request(app)
        .get(`/api/companies/${companyId}/compiler/manifest/${sourceIssueId}`)
        .expect(404);
    });
  });
});
