import { z } from "zod";
import { AGENT_ROLES, ISSUE_PRIORITIES } from "../constants.js";

export const debtItemSchema = z.object({
  key: z.string().min(1),
  title: z.string().min(1),
  description: z.string().min(1),
  priority: z.enum(ISSUE_PRIORITIES),
  assigneeRole: z.enum(AGENT_ROLES).optional(),
  labels: z.array(z.string().min(1)).optional(),
  parentKey: z.string().optional(),
});

export const factorySourceSchema = z.object({
  issueId: z.string().uuid(),
  companyId: z.string().uuid(),
  identifier: z.string().min(1),
});

export const factoryTargetSchema = z.object({
  companyId: z.string().uuid(),
  projectId: z.string().uuid().optional(),
  goalId: z.string().uuid().optional(),
});

export const factoryManifestSchema = z.object({
  version: z.literal("1"),
  source: factorySourceSchema,
  target: factoryTargetSchema,
  items: z.array(debtItemSchema).min(1),
});

export const lowerRequestSchema = z.object({
  sourceIssueId: z.string().uuid(),
  targetCompanyId: z.string().uuid(),
  targetProjectId: z.string().uuid().optional(),
  targetGoalId: z.string().uuid().optional(),
});

export const executeRequestSchema = z.object({
  sourceIssueId: z.string().uuid(),
});

export type LowerRequest = z.infer<typeof lowerRequestSchema>;
export type ExecuteRequest = z.infer<typeof executeRequestSchema>;
