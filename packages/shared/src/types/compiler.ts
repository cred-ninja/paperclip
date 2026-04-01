import type { AgentRole, IssuePriority } from "../constants.js";

/** A single technical debt item extracted by the lowering pass. */
export interface DebtItem {
  /** Unique key within the manifest (e.g., "DEBT-001"). */
  key: string;
  /** Issue title. */
  title: string;
  /** Detailed description / spec for the issue body. */
  description: string;
  /** Issue priority. */
  priority: IssuePriority;
  /** Role-based assignment hint (resolved to an agent at execution time). */
  assigneeRole?: AgentRole;
  /** Label names to apply on the created issue. */
  labels?: string[];
  /** Reference to another debt item key to set as parent. */
  parentKey?: string;
}

/** Source reference for traceability. */
export interface FactorySource {
  issueId: string;
  companyId: string;
  identifier: string;
}

/** Target configuration for issue creation. */
export interface FactoryTarget {
  companyId: string;
  projectId?: string;
  goalId?: string;
}

/** Machine-readable manifest produced by the lowering pass. */
export interface FactoryManifest {
  version: "1";
  source: FactorySource;
  target: FactoryTarget;
  items: DebtItem[];
}

/** Output of the lowering pass before execution. */
export interface LoweringResult {
  /** Human-readable DEBT.md content. */
  debtMarkdown: string;
  /** Structured manifest for the factory. */
  manifest: FactoryManifest;
}

/** Summary of a single issue created by the factory. */
export interface FactoryCreatedIssue {
  debtKey: string;
  issueId: string;
  identifier: string;
}

/** Result of executing the factory manifest. */
export interface FactoryExecutionResult {
  createdIssues: FactoryCreatedIssue[];
  sourceIssueId: string;
  targetCompanyId: string;
}
