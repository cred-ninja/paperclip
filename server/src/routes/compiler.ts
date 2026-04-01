import { Router } from "express";
import type { Db } from "@paperclipai/db";
import { lowerRequestSchema, executeRequestSchema } from "@paperclipai/shared";
import { validate } from "../middleware/validate.js";
import {
  compilerPipelineService,
  heartbeatService,
  issueService,
  logActivity,
} from "../services/index.js";
import { assertCompanyAccess, getActorInfo } from "./authz.js";
import { queueIssueAssignmentWakeup } from "../services/issue-assignment-wakeup.js";

export function compilerRoutes(db: Db) {
  const router = Router();
  const pipeline = compilerPipelineService(db);
  const heartbeat = heartbeatService(db);
  const issueSvc = issueService(db);

  /**
   * POST /api/companies/:companyId/compiler/lower
   *
   * Run the lowering pass on a source issue. Parses the research brief,
   * produces DEBT.md + factory manifest, stores them as issue documents.
   */
  router.post(
    "/companies/:companyId/compiler/lower",
    validate(lowerRequestSchema),
    async (req, res) => {
      const companyId = req.params.companyId as string;
      assertCompanyAccess(req, companyId);
      const actor = getActorInfo(req);

      const result = await pipeline.lower({
        sourceIssueId: req.body.sourceIssueId,
        targetCompanyId: req.body.targetCompanyId,
        targetProjectId: req.body.targetProjectId,
        targetGoalId: req.body.targetGoalId,
        actorType: actor.actorType,
        actorId: actor.actorId,
        agentId: actor.agentId,
        runId: actor.runId,
      });

      res.status(200).json({
        itemCount: result.manifest.items.length,
        items: result.manifest.items.map((i) => ({
          key: i.key,
          title: i.title,
          priority: i.priority,
        })),
        sourceIssueId: req.body.sourceIssueId,
        targetCompanyId: req.body.targetCompanyId,
      });
    },
  );

  /**
   * POST /api/companies/:companyId/compiler/request-approval
   *
   * Create an approval request for the lowering results.
   * Body: { sourceIssueId: string }
   */
  router.post(
    "/companies/:companyId/compiler/request-approval",
    validate(executeRequestSchema),
    async (req, res) => {
      const companyId = req.params.companyId as string;
      assertCompanyAccess(req, companyId);
      const actor = getActorInfo(req);

      const approval = await pipeline.requestApproval({
        sourceIssueId: req.body.sourceIssueId,
        actorType: actor.actorType,
        actorId: actor.actorId,
        agentId: actor.agentId,
        runId: actor.runId,
      });

      res.status(201).json(approval);
    },
  );

  /**
   * POST /api/companies/:companyId/compiler/execute
   *
   * Execute the factory manifest: create issues from the stored manifest.
   * Requires a prior approved compiler_execution approval.
   * Body: { sourceIssueId: string }
   */
  router.post(
    "/companies/:companyId/compiler/execute",
    validate(executeRequestSchema),
    async (req, res) => {
      const companyId = req.params.companyId as string;
      assertCompanyAccess(req, companyId);
      const actor = getActorInfo(req);

      const result = await pipeline.execute({
        sourceIssueId: req.body.sourceIssueId,
        actorType: actor.actorType,
        actorId: actor.actorId,
        agentId: actor.agentId,
        runId: actor.runId,
      });

      for (const created of result.createdIssues) {
        const issue = await issueSvc.getById(created.issueId);
        if (issue?.assigneeAgentId) {
          void queueIssueAssignmentWakeup({
            heartbeat,
            issue,
            reason: "issue_assigned",
            mutation: "create",
            contextSource: "compiler.execute",
            requestedByActorType: actor.actorType,
            requestedByActorId: actor.actorId,
          });
        }
      }

      res.status(201).json(result);
    },
  );

  /**
   * GET /api/companies/:companyId/compiler/manifest/:sourceIssueId
   *
   * Retrieve the factory manifest from a source issue.
   */
  router.get(
    "/companies/:companyId/compiler/manifest/:sourceIssueId",
    async (req, res) => {
      const companyId = req.params.companyId as string;
      assertCompanyAccess(req, companyId);

      const manifest = await pipeline.getManifest(req.params.sourceIssueId as string);
      if (!manifest) {
        res.status(404).json({ error: "No factory manifest found for this issue" });
        return;
      }

      res.json(manifest);
    },
  );

  return router;
}
