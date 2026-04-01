import { and, eq } from "drizzle-orm";
import type { Db } from "@paperclipai/db";
import { agents, approvals, documents, issueDocuments, issues } from "@paperclipai/db";
import { factoryManifestSchema } from "@paperclipai/shared";
import type {
  DebtItem,
  FactoryCreatedIssue,
  FactoryExecutionResult,
  FactoryManifest,
  LoweringResult,
} from "@paperclipai/shared";
import { notFound, unprocessable } from "../errors.js";
import { issueService } from "./issues.js";
import { documentService } from "./documents.js";
import { logActivity, type LogActivityInput } from "./activity-log.js";
import { logger } from "../middleware/logger.js";

const DEBT_DOCUMENT_KEY = "debt";
const MANIFEST_DOCUMENT_KEY = "factory-manifest";

/**
 * Parse a research brief issue description/document into structured debt items.
 *
 * Expected format in the issue description or "research" document:
 *
 * ## Findings
 *
 * ### <Title>
 * Priority: <critical|high|medium|low>
 * Role: <engineer|qa|...>
 * Labels: <label1>, <label2>
 *
 * <description paragraph(s)>
 *
 * ---
 */
export function parseResearchBrief(content: string): DebtItem[] {
  const items: DebtItem[] = [];
  const sections = content.split(/^---$/m);

  let counter = 1;
  for (const section of sections) {
    const titleMatch = /^###\s+(.+)$/m.exec(section);
    if (!titleMatch) continue;

    const title = titleMatch[1].trim();
    const priorityMatch = /^Priority:\s*(critical|high|medium|low)$/im.exec(section);
    const roleMatch = /^Role:\s*(\w+)$/im.exec(section);
    const labelsMatch = /^Labels:\s*(.+)$/im.exec(section);
    const parentMatch = /^Parent:\s*(\S+)$/im.exec(section);

    const descLines: string[] = [];
    const lines = section.split("\n");
    let pastMetadata = false;
    for (const line of lines) {
      if (titleMatch && line.includes(titleMatch[1])) {
        pastMetadata = false;
        continue;
      }
      if (/^(Priority|Role|Labels|Parent):/i.test(line)) {
        pastMetadata = true;
        continue;
      }
      if (pastMetadata || (!titleMatch && !line.startsWith("#"))) {
        const trimmed = line.trim();
        if (trimmed) descLines.push(trimmed);
      }
    }

    const key = `DEBT-${String(counter).padStart(3, "0")}`;
    counter++;

    items.push({
      key,
      title,
      description: descLines.join("\n") || title,
      priority: (priorityMatch?.[1] as DebtItem["priority"]) ?? "medium",
      ...(roleMatch?.[1] ? { assigneeRole: roleMatch[1] as DebtItem["assigneeRole"] } : {}),
      ...(labelsMatch?.[1] ? { labels: labelsMatch[1].split(",").map((l) => l.trim()).filter(Boolean) } : {}),
      ...(parentMatch?.[1] ? { parentKey: parentMatch[1] } : {}),
    });
  }

  return items;
}

/** Render debt items as a human-readable DEBT.md markdown document. */
export function renderDebtMarkdown(items: DebtItem[], sourceIdentifier: string): string {
  const lines: string[] = [
    `# Technical Debt — Lowered from ${sourceIdentifier}`,
    "",
    `> ${items.length} item(s) extracted from research brief.`,
    "",
  ];

  for (const item of items) {
    lines.push(`## ${item.key}: ${item.title}`);
    lines.push("");
    lines.push(`- **Priority:** ${item.priority}`);
    if (item.assigneeRole) lines.push(`- **Assigned Role:** ${item.assigneeRole}`);
    if (item.labels?.length) lines.push(`- **Labels:** ${item.labels.join(", ")}`);
    if (item.parentKey) lines.push(`- **Parent:** ${item.parentKey}`);
    lines.push("");
    lines.push(item.description);
    lines.push("");
    lines.push("---");
    lines.push("");
  }

  return lines.join("\n");
}

export function compilerPipelineService(db: Db) {
  const issueSvc = issueService(db);
  const documentSvc = documentService(db);

  async function getSourceIssueContent(issueId: string): Promise<{ issue: typeof issues.$inferSelect; content: string }> {
    const issue = await db
      .select()
      .from(issues)
      .where(eq(issues.id, issueId))
      .then((rows) => rows[0] ?? null);
    if (!issue) throw notFound("Source issue not found");

    const researchDoc = await db
      .select({
        body: documents.latestBody,
      })
      .from(issueDocuments)
      .innerJoin(documents, eq(issueDocuments.documentId, documents.id))
      .where(
        and(
          eq(issueDocuments.issueId, issueId),
          eq(issueDocuments.key, "research"),
        ),
      )
      .then((rows) => rows[0] ?? null);

    const content = researchDoc?.body ?? issue.description ?? "";
    if (!content.trim()) {
      throw unprocessable("Source issue has no research brief content (check issue description or 'research' document)");
    }

    return { issue, content };
  }

  async function resolveAgentByRole(companyId: string, role: string): Promise<string | null> {
    const agent = await db
      .select({ id: agents.id })
      .from(agents)
      .where(and(eq(agents.companyId, companyId), eq(agents.role, role), eq(agents.status, "active")))
      .then((rows) => rows[0] ?? null);
    return agent?.id ?? null;
  }

  return {
    /**
     * Lowering pass: read the source issue, parse its research brief, produce
     * DEBT.md and factory manifest, store them as documents on the source issue.
     */
    lower: async (input: {
      sourceIssueId: string;
      targetCompanyId: string;
      targetProjectId?: string;
      targetGoalId?: string;
      actorType: LogActivityInput["actorType"];
      actorId: string;
      agentId?: string | null;
      runId?: string | null;
    }): Promise<LoweringResult> => {
      const { issue, content } = await getSourceIssueContent(input.sourceIssueId);
      const items = parseResearchBrief(content);

      if (items.length === 0) {
        throw unprocessable("Lowering produced zero debt items — check the research brief format");
      }

      const manifest: FactoryManifest = {
        version: "1",
        source: {
          issueId: issue.id,
          companyId: issue.companyId,
          identifier: issue.identifier ?? issue.id,
        },
        target: {
          companyId: input.targetCompanyId,
          projectId: input.targetProjectId,
          goalId: input.targetGoalId,
        },
        items,
      };

      const debtMarkdown = renderDebtMarkdown(items, issue.identifier ?? issue.id);

      await documentSvc.upsertIssueDocument({
        issueId: issue.id,
        key: DEBT_DOCUMENT_KEY,
        title: "Technical Debt (Lowered)",
        format: "markdown",
        body: debtMarkdown,
        changeSummary: "Lowering pass completed",
        createdByAgentId: input.agentId ?? null,
        createdByUserId: input.actorType === "user" ? input.actorId : null,
      });

      await documentSvc.upsertIssueDocument({
        issueId: issue.id,
        key: MANIFEST_DOCUMENT_KEY,
        title: "Factory Manifest",
        format: "markdown",
        body: JSON.stringify(manifest, null, 2),
        changeSummary: "Factory manifest generated",
        createdByAgentId: input.agentId ?? null,
        createdByUserId: input.actorType === "user" ? input.actorId : null,
      });

      await logActivity(db, {
        companyId: issue.companyId,
        actorType: input.actorType,
        actorId: input.actorId,
        agentId: input.agentId ?? null,
        runId: input.runId ?? null,
        action: "compiler.lowering_completed",
        entityType: "issue",
        entityId: issue.id,
        details: {
          itemCount: items.length,
          targetCompanyId: input.targetCompanyId,
          sourceIdentifier: issue.identifier,
        },
      });

      logger.info(
        { sourceIssueId: issue.id, itemCount: items.length, targetCompanyId: input.targetCompanyId },
        "Compiler lowering pass completed",
      );

      return { debtMarkdown, manifest };
    },

    /**
     * Create an approval request for the lowering results before execution.
     */
    requestApproval: async (input: {
      sourceIssueId: string;
      actorType: LogActivityInput["actorType"];
      actorId: string;
      agentId?: string | null;
      runId?: string | null;
    }): Promise<typeof approvals.$inferSelect> => {
      const issue = await db
        .select()
        .from(issues)
        .where(eq(issues.id, input.sourceIssueId))
        .then((rows) => rows[0] ?? null);
      if (!issue) throw notFound("Source issue not found");

      const manifestDoc = await db
        .select({ body: documents.latestBody })
        .from(issueDocuments)
        .innerJoin(documents, eq(issueDocuments.documentId, documents.id))
        .where(
          and(
            eq(issueDocuments.issueId, input.sourceIssueId),
            eq(issueDocuments.key, MANIFEST_DOCUMENT_KEY),
          ),
        )
        .then((rows) => rows[0] ?? null);

      if (!manifestDoc) {
        throw unprocessable("No factory manifest found — run lowering first");
      }

      const manifest = factoryManifestSchema.parse(JSON.parse(manifestDoc.body));

      const [approval] = await db
        .insert(approvals)
        .values({
          companyId: issue.companyId,
          type: "compiler_execution",
          status: "pending",
          requestedByAgentId: input.agentId ?? null,
          payload: {
            sourceIssueId: issue.id,
            sourceIdentifier: issue.identifier,
            targetCompanyId: manifest.target.companyId,
            itemCount: manifest.items.length,
            items: manifest.items.map((i) => ({ key: i.key, title: i.title, priority: i.priority })),
          },
        })
        .returning();

      await logActivity(db, {
        companyId: issue.companyId,
        actorType: input.actorType,
        actorId: input.actorId,
        agentId: input.agentId ?? null,
        runId: input.runId ?? null,
        action: "compiler.approval_requested",
        entityType: "approval",
        entityId: approval.id,
        details: {
          sourceIssueId: issue.id,
          sourceIdentifier: issue.identifier,
          itemCount: manifest.items.length,
        },
      });

      return approval;
    },

    /**
     * Execute the factory manifest: create issues in the target company from the
     * stored manifest on the source issue. Requires a prior approved approval.
     */
    execute: async (input: {
      sourceIssueId: string;
      actorType: LogActivityInput["actorType"];
      actorId: string;
      agentId?: string | null;
      runId?: string | null;
    }): Promise<FactoryExecutionResult> => {
      const issue = await db
        .select()
        .from(issues)
        .where(eq(issues.id, input.sourceIssueId))
        .then((rows) => rows[0] ?? null);
      if (!issue) throw notFound("Source issue not found");

      const existingApproval = await db
        .select()
        .from(approvals)
        .where(
          and(
            eq(approvals.companyId, issue.companyId),
            eq(approvals.type, "compiler_execution"),
            eq(approvals.status, "approved"),
          ),
        )
        .then((rows) => {
          const payload = rows.find(
            (r) =>
              (r.payload as Record<string, unknown>)?.sourceIssueId === input.sourceIssueId,
          );
          return payload ?? null;
        });

      if (!existingApproval) {
        throw unprocessable("No approved compiler_execution approval found for this source issue");
      }

      const manifestDoc = await db
        .select({ body: documents.latestBody })
        .from(issueDocuments)
        .innerJoin(documents, eq(issueDocuments.documentId, documents.id))
        .where(
          and(
            eq(issueDocuments.issueId, input.sourceIssueId),
            eq(issueDocuments.key, MANIFEST_DOCUMENT_KEY),
          ),
        )
        .then((rows) => rows[0] ?? null);

      if (!manifestDoc) {
        throw unprocessable("No factory manifest document found on the source issue");
      }

      const manifest = factoryManifestSchema.parse(JSON.parse(manifestDoc.body));
      const createdIssues: FactoryCreatedIssue[] = [];
      const keyToIssueId = new Map<string, string>();

      for (const item of manifest.items) {
        let assigneeAgentId: string | null = null;
        if (item.assigneeRole) {
          assigneeAgentId = await resolveAgentByRole(manifest.target.companyId, item.assigneeRole);
        }

        let parentId: string | null = null;
        if (item.parentKey) {
          parentId = keyToIssueId.get(item.parentKey) ?? null;
        }

        const created = await issueSvc.create(manifest.target.companyId, {
          title: item.title,
          description: item.description,
          priority: item.priority,
          status: "todo",
          originKind: "compiler_lowering",
          originId: input.sourceIssueId,
          ...(assigneeAgentId ? { assigneeAgentId } : {}),
          ...(manifest.target.projectId ? { projectId: manifest.target.projectId } : {}),
          ...(manifest.target.goalId ? { goalId: manifest.target.goalId } : {}),
          ...(parentId ? { parentId } : {}),
        });

        keyToIssueId.set(item.key, created.id);
        createdIssues.push({
          debtKey: item.key,
          issueId: created.id,
          identifier: created.identifier,
        });

        await logActivity(db, {
          companyId: manifest.target.companyId,
          actorType: input.actorType,
          actorId: input.actorId,
          agentId: input.agentId ?? null,
          runId: input.runId ?? null,
          action: "compiler.issue_created",
          entityType: "issue",
          entityId: created.id,
          details: {
            debtKey: item.key,
            sourceIssueId: input.sourceIssueId,
            sourceIdentifier: issue.identifier,
            sourceCompanyId: issue.companyId,
          },
        });

        // Wakeup is handled by the route handler after execution completes.
      }

      await logActivity(db, {
        companyId: issue.companyId,
        actorType: input.actorType,
        actorId: input.actorId,
        agentId: input.agentId ?? null,
        runId: input.runId ?? null,
        action: "compiler.execution_completed",
        entityType: "issue",
        entityId: issue.id,
        details: {
          targetCompanyId: manifest.target.companyId,
          createdCount: createdIssues.length,
          createdIssues: createdIssues.map((i) => ({ key: i.debtKey, identifier: i.identifier })),
          approvalId: existingApproval.id,
        },
      });

      logger.info(
        {
          sourceIssueId: input.sourceIssueId,
          targetCompanyId: manifest.target.companyId,
          createdCount: createdIssues.length,
        },
        "Compiler factory execution completed",
      );

      return {
        createdIssues,
        sourceIssueId: input.sourceIssueId,
        targetCompanyId: manifest.target.companyId,
      };
    },

    /** Read the factory manifest from a source issue's documents. */
    getManifest: async (sourceIssueId: string): Promise<FactoryManifest | null> => {
      const manifestDoc = await db
        .select({ body: documents.latestBody })
        .from(issueDocuments)
        .innerJoin(documents, eq(issueDocuments.documentId, documents.id))
        .where(
          and(
            eq(issueDocuments.issueId, sourceIssueId),
            eq(issueDocuments.key, MANIFEST_DOCUMENT_KEY),
          ),
        )
        .then((rows) => rows[0] ?? null);

      if (!manifestDoc) return null;
      return factoryManifestSchema.parse(JSON.parse(manifestDoc.body));
    },
  };
}
