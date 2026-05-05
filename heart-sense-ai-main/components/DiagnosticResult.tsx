"use client";

import {
  CheckCircle2,
  AlertTriangle,
  XCircle,
  Clock,
  FileText,
  BrainCircuit,
  ShieldAlert,
  Timer,
  ExternalLink,
  ChevronRight,
  FlaskConical,
  Stethoscope,
  Lightbulb,
  TriangleAlert,
  ShieldCheck,
} from "lucide-react";
import { Card, CardContent } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import type {
  AnalysisResponse,
  PipelineStep,
  RareCaseAlert,
} from "@/services/DiagnosticService";

// ─── Status helpers ─────────────────────────────────────────────────────────

const STATUS_STYLE: Record<
  string,
  { color: string; icon: React.ReactNode; label: string }
> = {
  COMPLETED: {
    color: "bg-emerald-500/10 border-emerald-500/20 text-emerald-400",
    icon: <CheckCircle2 className="h-5 w-5 text-emerald-400" />,
    label: "Analysis Complete",
  },
  PARTIAL: {
    color: "bg-amber-500/10 border-amber-500/20 text-amber-400",
    icon: <AlertTriangle className="h-5 w-5 text-amber-400" />,
    label: "Partial Result",
  },
  FAILED: {
    color: "bg-rose-500/10 border-rose-500/20 text-rose-400",
    icon: <XCircle className="h-5 w-5 text-rose-400" />,
    label: "Analysis Failed",
  },
};

// ─── Sub-components ─────────────────────────────────────────────────────────

function StatusBanner({
  status,
  durationMs,
}: {
  status: string;
  durationMs?: number;
}) {
  const s = STATUS_STYLE[status] ?? STATUS_STYLE.FAILED;
  return (
    <div
      className={`flex items-center justify-between rounded-2xl border p-4 ${s.color}`}
    >
      <div className="flex items-center gap-3">
        {s.icon}
        <span className="font-bold text-sm uppercase tracking-wider">
          {s.label}
        </span>
      </div>
      {durationMs != null && (
        <div className="flex items-center gap-1.5 text-xs text-muted-foreground">
          <Timer className="h-3.5 w-3.5" />
          {(durationMs / 1000).toFixed(1)}s
        </div>
      )}
    </div>
  );
}

function RareCaseAlertCard({ alert }: { alert: RareCaseAlert }) {
  if (!alert.triggered) return null;
  return (
    <div className="rounded-2xl border border-rose-500/30 bg-rose-500/5 p-6 space-y-4">
      <div className="flex items-center gap-3">
        <ShieldAlert className="h-6 w-6 text-rose-400" />
        <h3 className="font-black text-rose-400 text-sm uppercase tracking-wider">
          Rare Pathology Alert
        </h3>
        <Badge className="bg-rose-500/10 text-rose-400 border-rose-500/20 ml-auto text-[10px]">
          {(alert.similarity_score * 100).toFixed(0)}% match
        </Badge>
      </div>
      <p className="text-lg font-bold text-foreground">{alert.condition}</p>

      {alert.diseases.length > 0 && (
        <div>
          <p className="text-[10px] font-bold text-muted-foreground uppercase tracking-widest mb-2">
            Associated Diseases
          </p>
          <div className="flex flex-wrap gap-1.5">
            {alert.diseases.map((d, i) => (
              <Badge
                key={i}
                variant="outline"
                className="border-rose-500/20 text-rose-300 text-[9px]"
              >
                {d}
              </Badge>
            ))}
          </div>
        </div>
      )}

      {alert.contradictions.length > 0 && (
        <div>
          <p className="text-[10px] font-bold text-muted-foreground uppercase tracking-widest mb-2">
            Contradictions / Cautions
          </p>
          <ul className="list-disc list-inside text-xs text-rose-300/80 space-y-1">
            {alert.contradictions.map((c, i) => (
              <li key={i}>{c}</li>
            ))}
          </ul>
        </div>
      )}

      {alert.missing_data.length > 0 && (
        <div>
          <p className="text-[10px] font-bold text-muted-foreground uppercase tracking-widest mb-2">
            Missing Data Points
          </p>
          <ul className="list-disc list-inside text-xs text-amber-300/80 space-y-1">
            {alert.missing_data.map((m, i) => (
              <li key={i}>{m}</li>
            ))}
          </ul>
        </div>
      )}

      {alert.reasoning && (
        <div className="pt-2 border-t border-rose-500/10">
          <p className="text-[10px] font-bold text-muted-foreground uppercase tracking-widest mb-2">
            Reasoning
          </p>
          <p className="text-xs text-muted-foreground leading-relaxed">
            {alert.reasoning}
          </p>
        </div>
      )}

      {alert.source_url && (
        <a
          href={alert.source_url}
          target="_blank"
          rel="noopener noreferrer"
          className="inline-flex items-center gap-1.5 text-[10px] font-bold text-rose-400 hover:underline uppercase tracking-widest"
        >
          View Source <ExternalLink className="h-3 w-3" />
        </a>
      )}
    </div>
  );
}

function PipelineTimeline({ steps }: { steps: PipelineStep[] }) {
  return (
    <div className="space-y-3">
      {steps.map((step, i) => {
        const isOk = step.status === "success" || step.status === "ok";
        const isFail = step.status === "failed" || step.status === "error";
        return (
          <div
            key={i}
            className={`flex items-center gap-4 rounded-xl border p-3 ${
              isOk
                ? "border-emerald-500/10 bg-emerald-500/[0.02]"
                : isFail
                  ? "border-rose-500/10 bg-rose-500/[0.02]"
                  : "border-border bg-muted/20"
            }`}
          >
            <div
              className={`h-8 w-8 rounded-lg flex items-center justify-center shrink-0 ${
                isOk
                  ? "bg-emerald-500/10 text-emerald-400"
                  : isFail
                    ? "bg-rose-500/10 text-rose-400"
                    : "bg-muted text-muted-foreground"
              }`}
            >
              {isOk ? (
                <CheckCircle2 className="h-4 w-4" />
              ) : isFail ? (
                <XCircle className="h-4 w-4" />
              ) : (
                <Clock className="h-4 w-4" />
              )}
            </div>
            <div className="flex-1">
              <p className="text-xs font-bold capitalize">
                {step.step.replace(/_/g, " ")}
              </p>
            </div>
            {step.duration_ms != null && (
              <span className="text-[10px] text-muted-foreground font-mono">
                {step.duration_ms}ms
              </span>
            )}
            <Badge
              className={`text-[8px] font-black uppercase tracking-widest ${
                isOk
                  ? "bg-emerald-500/10 text-emerald-400 border-emerald-500/20"
                  : isFail
                    ? "bg-rose-500/10 text-rose-400 border-rose-500/20"
                    : "bg-muted text-muted-foreground border-border"
              }`}
            >
              {step.status}
            </Badge>
          </div>
        );
      })}
    </div>
  );
}

function MarkdownContent({ content }: { content: string }) {
  const cleanedContent = sanitizeReportText(content);
  const blocks = parseContentBlocks(cleanedContent);
  const sections = groupBlocks(blocks);
  return (
    <div className="space-y-5">
      {sections.map((section, i) => {
        if (!section.titleBlock) {
          return (
            <div key={`plain-${i}`} className="space-y-5">
              {section.blocks.map((block, bi) =>
                renderBlock(block, i * 1000 + bi),
              )}
            </div>
          );
        }

        const titleText = getSectionTitle(section.titleBlock).toLowerCase();
        const collapseByDefault =
          titleText.includes("diagnostic gaps") ||
          titleText.includes("references");

        if (!collapseByDefault) {
          return (
            <div key={`section-${i}`} className="space-y-4">
              {renderBlock(section.titleBlock, i * 1000)}
              {section.blocks.map((block, bi) =>
                renderBlock(block, i * 1000 + bi + 1),
              )}
            </div>
          );
        }

        return (
          <details
            key={`collapse-${i}`}
            className="rounded-xl border border-border bg-muted/20 px-4 py-3"
          >
            <summary className="cursor-pointer list-none text-sm font-bold text-foreground flex items-center gap-2">
              <ChevronRight className="h-4 w-4 text-muted-foreground" />
              {getSectionTitle(section.titleBlock)}
            </summary>
            <div className="mt-4 space-y-4 pl-1">
              {section.blocks.map((block, bi) =>
                renderBlock(block, i * 1000 + bi + 1),
              )}
            </div>
          </details>
        );
      })}
    </div>
  );
}

type BlockSection = {
  titleBlock?: Block;
  blocks: Block[];
};

function getSectionTitle(block: Block): string {
  if (block.type === "EMOJI_SECTION") return block.title;
  if (block.type === "HEADING") return block.text;
  return "Section";
}

function isSectionStarter(block: Block): boolean {
  return (
    block.type === "EMOJI_SECTION" ||
    (block.type === "HEADING" && block.level <= 3)
  );
}

function groupBlocks(blocks: Block[]): BlockSection[] {
  const sections: BlockSection[] = [];
  let current: BlockSection = { blocks: [] };

  for (const block of blocks) {
    if (isSectionStarter(block)) {
      if (current.titleBlock || current.blocks.length > 0) {
        sections.push(current);
      }
      current = { titleBlock: block, blocks: [] };
      continue;
    }
    current.blocks.push(block);
  }

  if (current.titleBlock || current.blocks.length > 0) {
    sections.push(current);
  }

  return sections;
}

// ─── Block parser ────────────────────────────────────────────────────────────

type Block =
  | { type: "BLANK" }
  | { type: "HEADING"; level: number; text: string }
  | { type: "EMOJI_SECTION"; emoji: string; title: string }
  | { type: "TABLE"; rows: string[][] }
  | { type: "LABEL_VALUE"; label: string; value: string }
  | { type: "LIST"; ordered: boolean; items: string[] }
  | { type: "PARAGRAPH"; text: string }
  | { type: "DISCLAIMER"; text: string };

const SECTION_EMOJI_RE =
  /^([\u{1F300}-\u{1FAFF}\u{2600}-\u{26FF}\u{2700}-\u{27BF}⚠️⚡🔍🩺])/u;

function isTableRow(line: string) {
  return line.trim().startsWith("|") && line.trim().endsWith("|");
}
function isSeparatorRow(row: string[]) {
  return row.every((c) => /^:?-+:?$/.test(c.trim()));
}
function splitTableRow(line: string): string[] {
  return line
    .trim()
    .slice(1, -1)
    .split("|")
    .map((c) => c.trim());
}

function parseContentBlocks(content: string): Block[] {
  const lines = content.split("\n");
  const blocks: Block[] = [];
  let i = 0;

  while (i < lines.length) {
    const raw = lines[i];
    const trimmed = raw.trim();

    // Blank
    if (!trimmed) {
      blocks.push({ type: "BLANK" });
      i++;
      continue;
    }

    // Markdown table — collect all consecutive table rows
    if (isTableRow(trimmed)) {
      const tableLines: string[] = [];
      while (i < lines.length && isTableRow(lines[i].trim())) {
        tableLines.push(lines[i]);
        i++;
      }
      const parsed = tableLines.map(splitTableRow);
      // Remove separator rows
      const clean = parsed.filter((r) => !isSeparatorRow(r));
      if (clean.length > 0) blocks.push({ type: "TABLE", rows: clean });
      continue;
    }

    // Disclaimer line
    if (
      trimmed.toLowerCase().startsWith("⚠️ disclaimer") ||
      trimmed.toLowerCase().startsWith("disclaimer:")
    ) {
      const text = trimmed
        .replace(/^⚠️\s*/i, "")
        .replace(/^disclaimer:?\s*/i, "")
        .replace(/\*+/g, "")
        .trim();
      blocks.push({ type: "DISCLAIMER", text });
      i++;
      continue;
    }

    // Emoji section header (e.g. "🩺 DIFFERENTIAL DIAGNOSIS")
    const emojiMatch = trimmed.match(SECTION_EMOJI_RE);
    if (emojiMatch && trimmed.length < 100) {
      const emoji = emojiMatch[1];
      const title = trimmed.replace(emoji, "").trim();
      blocks.push({ type: "EMOJI_SECTION", emoji, title });
      i++;
      continue;
    }

    // ATX headings
    if (/^#{1,4}\s/.test(trimmed)) {
      const m = trimmed.match(/^(#+)\s+(.*)/)!;
      blocks.push({ type: "HEADING", level: m[1].length, text: m[2] });
      i++;
      continue;
    }

    // Label: Value  (e.g. "Missing Data Point: ...")
    if (
      trimmed.includes(":") &&
      !trimmed.startsWith("-") &&
      !trimmed.startsWith("*")
    ) {
      const colonIdx = trimmed.indexOf(":");
      const label = trimmed.slice(0, colonIdx).trim();
      const value = trimmed.slice(colonIdx + 1).trim();
      if (label.length <= 40 && value.length > 0) {
        blocks.push({ type: "LABEL_VALUE", label, value });
        i++;
        continue;
      }
    }

    // List items — collect consecutive bullets/numbers
    if (
      trimmed.startsWith("- ") ||
      trimmed.startsWith("* ") ||
      /^\d+\.\s/.test(trimmed)
    ) {
      const ordered = /^\d+\./.test(trimmed);
      const items: string[] = [];
      while (i < lines.length) {
        const t = lines[i].trim();
        if (t.startsWith("- ") || t.startsWith("* ") || /^\d+\.\s/.test(t)) {
          items.push(t.replace(/^[-*]\s|^\d+\.\s/, ""));
          i++;
        } else break;
      }
      blocks.push({ type: "LIST", ordered, items });
      continue;
    }

    // Fallback paragraph
    blocks.push({ type: "PARAGRAPH", text: trimmed });
    i++;
  }

  return blocks;
}

// ─── Badge helpers ────────────────────────────────────────────────────────────

function SeverityBadge({ value }: { value: string }) {
  const v = value.toUpperCase();
  const cls =
    v === "CRITICAL" || v === "HIGH" || v === "SEVERE"
      ? "bg-rose-500/15 text-rose-400 border-rose-500/30"
      : v === "MODERATE"
        ? "bg-amber-500/15 text-amber-400 border-amber-500/30"
        : v === "LOW" || v === "MILD" || v === "NORMAL"
          ? "bg-emerald-500/15 text-emerald-400 border-emerald-500/30"
          : "bg-muted text-muted-foreground border-border";
  return (
    <span
      className={`inline-flex items-center px-2 py-0.5 rounded-lg border text-[10px] font-black uppercase tracking-wider ${cls}`}
    >
      {value}
    </span>
  );
}

function ConfidenceBadge({ value }: { value: string }) {
  const num = parseFloat(value);
  let cls = "bg-muted text-muted-foreground border-border";
  let display = value;
  if (!isNaN(num)) {
    const pct = num <= 1 ? num : num / 100;
    display = `${Math.round(pct * 100)}%`;
    cls =
      pct >= 0.7
        ? "bg-emerald-500/15 text-emerald-400 border-emerald-500/30"
        : pct >= 0.4
          ? "bg-amber-500/15 text-amber-400 border-amber-500/30"
          : "bg-rose-500/15 text-rose-400 border-rose-500/30";
  }
  return (
    <span
      className={`inline-flex items-center px-2 py-0.5 rounded-lg border text-[10px] font-black ${cls}`}
    >
      {display}
    </span>
  );
}

function PriorityBadge({ value }: { value: string }) {
  const v = value.toUpperCase();
  const cls =
    v === "STAT"
      ? "bg-rose-500/15 text-rose-400 border-rose-500/30"
      : v === "URGENT"
        ? "bg-amber-500/15 text-amber-400 border-amber-500/30"
        : "bg-blue-500/15 text-blue-400 border-blue-500/30";
  return (
    <span
      className={`inline-flex items-center px-2 py-0.5 rounded-lg border text-[10px] font-black uppercase tracking-wider ${cls}`}
    >
      {value}
    </span>
  );
}

function smartCell(header: string, value: string) {
  const h = header.toLowerCase();
  if (h === "severity") return <SeverityBadge value={value} />;
  if (h === "confidence") return <ConfidenceBadge value={value} />;
  if (h === "priority") return <PriorityBadge value={value} />;
  if (h === "rank")
    return (
      <span className="inline-flex h-6 w-6 items-center justify-center rounded-full bg-primary/20 text-primary text-[10px] font-black">
        {value}
      </span>
    );
  return (
    <span className="text-xs text-foreground/90">{formatBold(value)}</span>
  );
}

// ─── Section icon map ─────────────────────────────────────────────────────────

function sectionIcon(title: string) {
  const t = title.toLowerCase();
  if (t.includes("differential")) return <Stethoscope className="h-4 w-4" />;
  if (t.includes("workup") || t.includes("investigation"))
    return <FlaskConical className="h-4 w-4" />;
  if (t.includes("gap") || t.includes("limit"))
    return <TriangleAlert className="h-4 w-4" />;
  if (t.includes("clinical") || t.includes("evidence"))
    return <Lightbulb className="h-4 w-4" />;
  if (t.includes("reference")) return <FileText className="h-4 w-4" />;
  if (t.includes("disclaimer")) return <ShieldCheck className="h-4 w-4" />;
  return <ChevronRight className="h-4 w-4" />;
}

function sectionColor(title: string): string {
  const t = title.toLowerCase();
  if (t.includes("differential"))
    return "border-primary/30 bg-primary/10 text-primary";
  if (t.includes("workup") || t.includes("investigation"))
    return "border-blue-500/30 bg-blue-500/10 text-blue-700 dark:text-blue-300";
  if (t.includes("gap") || t.includes("limit"))
    return "border-amber-500/30 bg-amber-500/10 text-amber-700 dark:text-amber-300";
  if (t.includes("reference"))
    return "border-slate-500/30 bg-slate-500/10 text-slate-700 dark:text-slate-300";
  if (t.includes("disclaimer"))
    return "border-amber-500/30 bg-amber-500/10 text-amber-700 dark:text-amber-300";
  return "border-border bg-muted/20 text-muted-foreground";
}

function normalizeHeader(header: string): string {
  return header.toLowerCase().replace(/\s+/g, " ").trim();
}

function detectOraMode(content: string): "newbie" | "seasoned" | "unknown" {
  const text = (content || "").toLowerCase();
  if (text.includes("diagnostic summary")) return "newbie";
  if (text.includes("clinical assessment brief")) return "seasoned";
  return "unknown";
}

function extractOverview(content: string): string {
  const match = content.match(/\*\*Overview:\*\*\s*(.+)/i);
  return match?.[1]?.trim() || "Clinical report generated from current multimodal evidence.";
}

function extractTopDiagnosis(content: string): string {
  const match = content.match(/\|\s*(?:\d+\s*\|\s*)?\*\*([^*|]+)\*\*/);
  return (
    sanitizeLegacyDictText(match?.[1]?.trim() || "") ||
    "Top diagnosis not explicitly provided"
  );
}

function extractPrimaryAction(content: string): string {
  const match = content.match(/\d+\.\s+\*\*([^*]+)\*\*/);
  return (
    sanitizeLegacyDictText(match?.[1]?.trim() || "") ||
    "Prioritize immediate workup and clinical correlation."
  );
}

function extractReferenceCount(content: string): number {
  const refs = content.match(/\[R\d+\]/g) || [];
  return refs.length;
}

// ─── Block renderer ───────────────────────────────────────────────────────────

function renderBlock(block: Block, key: number): React.ReactNode {
  switch (block.type) {
    case "BLANK":
      return null;

    case "EMOJI_SECTION": {
      const colorCls = sectionColor(block.title);
      const icon = sectionIcon(block.title);
      return (
        <div
          key={key}
          className={`flex items-center gap-3 rounded-xl border px-5 py-3 mt-6 mb-1 ${colorCls}`}
        >
          {icon}
          <span className="text-sm font-black uppercase tracking-wider">
            {block.title}
          </span>
        </div>
      );
    }

    case "HEADING": {
      const sizes = ["", "text-xl", "text-lg", "text-base", "text-sm"];
      return (
        <p
          key={key}
          className={`${sizes[block.level] ?? "text-sm"} font-black text-foreground mt-4 mb-1`}
        >
          {block.text}
        </p>
      );
    }

    case "TABLE": {
      if (block.rows.length < 2) return null;
      const headers = block.rows[0];
      const dataRows = block.rows.slice(1);

      const normalizedHeaders = headers.map(normalizeHeader);
      const hasDiagnosisColumn =
        normalizedHeaders.includes("condition") ||
        normalizedHeaders.includes("differential");
      const hasSeverity = normalizedHeaders.includes("severity");
      const hasPriority = normalizedHeaders.includes("priority");
      const hasInvestigation = normalizedHeaders.includes("investigation");

      if (hasDiagnosisColumn && hasSeverity) {
        return (
          <div key={key} className="grid gap-3 md:grid-cols-2">
            {dataRows.map((row, ri) => {
              const cells = headers.reduce<Record<string, string>>((acc, header, idx) => {
                acc[normalizeHeader(header)] = row[idx] || "";
                return acc;
              }, {});

              const label = cells.condition || cells.differential || "Diagnosis";
              const clue = cells["key clue"] || cells["decisive finding"] || "No decisive clue provided";

              return (
                <div
                  key={ri}
                  className="rounded-xl border border-border bg-card p-4 space-y-3"
                >
                  <div className="flex items-start justify-between gap-3">
                    <p className="text-sm font-semibold text-foreground leading-snug">
                      {formatBold(label)}
                    </p>
                    <div className="flex items-center gap-2">
                      {cells.confidence ? <ConfidenceBadge value={cells.confidence} /> : null}
                      {cells.severity ? <SeverityBadge value={cells.severity} /> : null}
                    </div>
                  </div>
                  <p className="text-xs text-muted-foreground leading-relaxed">
                    {formatBold(clue)}
                  </p>
                </div>
              );
            })}
          </div>
        );
      }

      if (hasPriority && hasInvestigation) {
        return (
          <div key={key} className="grid gap-3 md:grid-cols-2">
            {dataRows.map((row, ri) => {
              const cells = headers.reduce<Record<string, string>>((acc, header, idx) => {
                acc[normalizeHeader(header)] = row[idx] || "";
                return acc;
              }, {});
              return (
                <div
                  key={ri}
                  className="rounded-xl border border-border bg-card p-4 space-y-2"
                >
                  <div className="flex items-center justify-between gap-2">
                    <p className="text-sm font-semibold text-foreground">
                      {formatBold(cells.investigation || "Investigation")}
                    </p>
                    {cells.priority ? <PriorityBadge value={cells.priority} /> : null}
                  </div>
                  <p className="text-xs text-muted-foreground leading-relaxed">
                    {formatBold(cells["diagnostic target"] || "Diagnostic target not specified")}
                  </p>
                </div>
              );
            })}
          </div>
        );
      }

      return (
        <div
          key={key}
          className="overflow-x-auto rounded-2xl border border-border mt-2 bg-card"
        >
          <table className="w-full text-left">
            <thead>
              <tr className="border-b border-border bg-muted/30">
                {headers.map((h, ci) => (
                  <th
                    key={ci}
                    className="px-4 py-3 text-[9px] font-black uppercase tracking-widest text-muted-foreground"
                  >
                    {h}
                  </th>
                ))}
              </tr>
            </thead>
            <tbody>
              {dataRows.map((row, ri) => (
                <tr
                  key={ri}
                  className="border-b border-border/70 last:border-0 hover:bg-muted/20 transition-colors"
                >
                  {row.map((cell, ci) => (
                    <td key={ci} className="px-4 py-3 align-top">
                      {smartCell(headers[ci] ?? "", cell)}
                    </td>
                  ))}
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      );
    }

    case "LABEL_VALUE":
      return (
        <div key={key} className="flex flex-wrap gap-2 items-baseline">
          <span className="text-[10px] font-black uppercase tracking-widest text-primary">
            {block.label}
          </span>
          <span className="text-sm text-muted-foreground leading-relaxed">
            {formatBold(block.value)}
          </span>
        </div>
      );

    case "LIST":
      return (
        <ul key={key} className="space-y-1.5 pl-1">
          {block.items.map((item, ii) => (
            <li key={ii} className="flex gap-2.5">
              {block.ordered ? (
                <span className="shrink-0 h-5 w-5 rounded-full bg-primary/20 text-primary text-[9px] font-black flex items-center justify-center mt-0.5">
                  {ii + 1}
                </span>
              ) : (
                <ChevronRight className="h-3.5 w-3.5 text-primary shrink-0 mt-1" />
              )}
              <span className="text-sm text-muted-foreground leading-relaxed">
                {formatBold(item)}
              </span>
            </li>
          ))}
        </ul>
      );

    case "PARAGRAPH":
      return (
        <p key={key} className="text-sm text-muted-foreground leading-relaxed">
          {formatBold(block.text)}
        </p>
      );

    case "DISCLAIMER":
      return (
        <div
          key={key}
          className="flex gap-3 rounded-xl border border-amber-500/20 bg-amber-500/5 p-4 mt-4"
        >
          <AlertTriangle className="h-4 w-4 text-amber-400 shrink-0 mt-0.5" />
          <p className="text-xs text-amber-300/80 leading-relaxed">
            {block.text}
          </p>
        </div>
      );

    default:
      return null;
  }
}

function formatBold(text: string): React.ReactNode {
  const cleaned = sanitizeLegacyDictText(text);
  const parts = cleaned.split(/(\*\*[^*]+\*\*)/g);
  return parts.map((part, i) =>
    part.startsWith("**") && part.endsWith("**") ? (
      <strong key={i} className="text-foreground font-bold">
        {part.slice(2, -2)}
      </strong>
    ) : (
      <span key={i}>{part}</span>
    ),
  );
}

function sanitizeLegacyDictText(text: string): string {
  if (!text) return "";
  let cleaned = text;

  cleaned = cleaned.replace(
    /\{[^{}]*'differential'\s*:\s*'([^']+)'[^{}]*\}/gi,
    "$1",
  );
  cleaned = cleaned.replace(
    /\{[^{}]*'condition'\s*:\s*'([^']+)'[^{}]*\}/gi,
    "$1",
  );
  cleaned = cleaned.replace(
    /\{[^{}]*'test(?:_name)?'\s*:\s*'([^']+)'[^{}]*\}/gi,
    "$1",
  );

  cleaned = cleaned.replace(
    /\*\*\s*\{?\s*'rank'\s*:?\s*\d+\s*,\s*'differential'\s*:\s*'([^']+)'[^*|]*\*\*/gi,
    "**$1**",
  );
  cleaned = cleaned.replace(/'rank'\s*:?\s*\d+\s*,?\s*/gi, "");

  return cleaned.replace(/\s{2,}/g, " ").trim();
}

function sanitizeReportText(text: string): string {
  let cleaned = sanitizeLegacyDictText(text);
  if (!cleaned) return cleaned;

  cleaned = cleaned.replace(
    /\*No supporting references were available in the prompt context\.\*/gi,
    "",
  );
  cleaned = cleaned.replace(
    /No supporting references were available in the prompt context\.?/gi,
    "",
  );

  const hasActualReferences = /\[R\d+\]/.test(cleaned);
  if (!hasActualReferences) {
    cleaned = cleaned.replace(
      /(?:\n|^)#{2,3}\s*📚\s*REFERENCES\s*(?:\n[-*]{3,}\n)?[\s\S]*$/i,
      "",
    );
  }

  return cleaned.replace(/\n{3,}/g, "\n\n").trim();
}

// ─── Main Component ─────────────────────────────────────────────────────────

interface DiagnosticResultProps {
  response: AnalysisResponse;
}

export default function DiagnosticResult({ response }: DiagnosticResultProps) {
  const report = response.refined_output || "";
  const oraMode = detectOraMode(report);
  const overview = extractOverview(report);
  const topDiagnosis = extractTopDiagnosis(report);
  const primaryAction = extractPrimaryAction(report);
  const referenceCount = extractReferenceCount(report);
  const modeToneClass =
    oraMode === "newbie"
      ? "border-blue-500/30 bg-blue-500/10"
      : oraMode === "seasoned"
        ? "border-slate-500/30 bg-slate-500/10"
        : "border-border bg-card";

  return (
    <div className="space-y-6 animate-in fade-in slide-in-from-bottom-4 duration-500">
      <StatusBanner
        status={response.status}
        durationMs={response.total_duration_ms}
      />

      {response.rare_case_alert?.triggered && (
        <RareCaseAlertCard alert={response.rare_case_alert} />
      )}

      {response.error && response.status === "FAILED" && (
        <div className="rounded-2xl border border-rose-500/20 bg-rose-500/5 p-6">
          <p className="text-sm text-rose-400 font-bold">{response.error}</p>
        </div>
      )}

      <Tabs defaultValue="primary" className="w-full">
        <TabsList className="h-12 bg-muted/30 border border-border rounded-xl p-1.5 gap-1.5">
          <TabsTrigger
            value="primary"
            className="flex items-center gap-2 rounded-lg text-xs data-[state=active]:bg-primary data-[state=active]:text-primary-foreground"
          >
            <FileText className="h-3.5 w-3.5" /> Clinical Report
          </TabsTrigger>
          <TabsTrigger
            value="kra"
            className="flex items-center gap-2 rounded-lg text-xs data-[state=active]:bg-primary data-[state=active]:text-primary-foreground"
          >
            <BrainCircuit className="h-3.5 w-3.5" /> KRA Analysis
          </TabsTrigger>
          <TabsTrigger
            value="pipeline"
            className="flex items-center gap-2 rounded-lg text-xs data-[state=active]:bg-primary data-[state=active]:text-primary-foreground"
          >
            <Timer className="h-3.5 w-3.5" /> Pipeline Steps
          </TabsTrigger>
        </TabsList>

        {/* ORA Clinical Report */}
        <TabsContent value="primary" className="mt-6">
          <div className="space-y-5">
            <Card className={`rounded-2xl ${modeToneClass}`}>
              <CardContent className="p-6 md:p-7">
                <div className="flex flex-wrap items-start justify-between gap-4">
                  <div className="space-y-2 max-w-3xl">
                    <p className="text-[11px] font-bold uppercase tracking-widest text-muted-foreground">
                      AI Diagnosis Summary
                    </p>
                    <h3 className="text-xl md:text-2xl font-semibold text-foreground leading-tight">
                      {topDiagnosis}
                    </h3>
                    <p className="text-sm text-muted-foreground leading-relaxed">
                      {overview}
                    </p>
                  </div>
                  <div className="flex flex-wrap gap-2">
                    <Badge className="bg-primary/10 text-primary border-primary/30">
                      {oraMode === "newbie"
                        ? "Newbie Mode"
                        : oraMode === "seasoned"
                          ? "Seasoned Mode"
                          : "Clinical Mode"}
                    </Badge>
                    {referenceCount > 0 ? (
                      <Badge variant="outline" className="border-border text-foreground">
                        References: {referenceCount}
                      </Badge>
                    ) : null}
                  </div>
                </div>
              </CardContent>
            </Card>

            <div className="grid gap-5 xl:grid-cols-12">
              <Card className="rounded-2xl border-border bg-card xl:col-span-8">
                <CardContent className="p-6 md:p-8 space-y-6">
                  {response.refined_output ? (
                    <MarkdownContent content={response.refined_output} />
                  ) : (
                    <p className="text-sm text-muted-foreground italic">
                      No clinical report was generated.
                    </p>
                  )}
                </CardContent>
              </Card>

              <div className="xl:col-span-4 space-y-4">
                <Card className="rounded-2xl border-border bg-card">
                  <CardContent className="p-5 space-y-2">
                    <p className="text-[11px] font-bold uppercase tracking-widest text-muted-foreground">
                      Immediate Priority
                    </p>
                    <p className="text-sm font-semibold text-foreground leading-snug">
                      {primaryAction}
                    </p>
                    <p className="text-xs text-muted-foreground">
                      Focus on first actionable investigation to reduce uncertainty quickly.
                    </p>
                  </CardContent>
                </Card>

                <Card className="rounded-2xl border-border bg-card">
                  <CardContent className="p-5 space-y-2">
                    <p className="text-[11px] font-bold uppercase tracking-widest text-muted-foreground">
                      Reading Style
                    </p>
                    <p className="text-sm text-foreground">
                      {oraMode === "newbie"
                        ? "Human-friendly teaching narrative"
                        : "Strict medical brief for advanced readers"}
                    </p>
                    <p className="text-xs text-muted-foreground">
                      Toggle mode in ORA Output Mode for alternate presentation.
                    </p>
                  </CardContent>
                </Card>

                {response.disclaimer ? (
                  <Card className="rounded-2xl border-amber-500/30 bg-amber-500/10">
                    <CardContent className="p-4">
                      <p className="text-[11px] font-bold uppercase tracking-widest text-amber-800 dark:text-amber-300 mb-2">
                        Disclaimer
                      </p>
                      <p className="text-xs text-amber-900/80 dark:text-amber-200/90 leading-relaxed">
                        {response.disclaimer}
                      </p>
                    </CardContent>
                  </Card>
                ) : null}
              </div>
            </div>
          </div>
        </TabsContent>

        {/* KRA Raw Analysis */}
        <TabsContent value="kra" className="mt-6">
          <Card className="border-border bg-card rounded-2xl">
            <CardContent className="p-8">
              {response.kra_raw ? (
                <MarkdownContent content={response.kra_raw} />
              ) : (
                <p className="text-sm text-muted-foreground italic">
                  No KRA raw output available.
                </p>
              )}
            </CardContent>
          </Card>
        </TabsContent>

        {/* Pipeline Steps */}
        <TabsContent value="pipeline" className="mt-6">
          <Card className="border-border bg-card rounded-2xl">
            <CardContent className="p-6">
              <div className="flex items-center justify-between mb-6">
                <h3 className="text-xs font-black uppercase tracking-widest text-muted-foreground">
                  Pipeline Execution
                </h3>
                <Badge className="bg-muted text-muted-foreground border-border text-[9px]">
                  Session: {response.session_id.slice(0, 8)}…
                </Badge>
              </div>
              <PipelineTimeline steps={response.processing_steps} />
            </CardContent>
          </Card>
        </TabsContent>
      </Tabs>
    </div>
  );
}
