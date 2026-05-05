"use client";

import { useRef, useState } from "react";
import {
  Clock,
  Activity,
  Microscope,
  BrainCircuit,
  ChevronDown,
  ChevronUp,
  FileText,
  AlertTriangle,
  Stethoscope,
  HeartPulse,
  TrendingUp,
  TrendingDown,
  Minus,
  CalendarDays,
  User,
  FlaskConical,
  CircleCheck,
  CircleAlert,
  Network,
  Trash2,
  Loader2,
} from "lucide-react";
import { Card, CardContent } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import type {
  PatientDiagnosisRecord,
  PatientHistorySummary,
  WorkflowSession,
} from "@/services/WorkflowService";

// Types

interface PatientInfo {
  _id: string;
  fullName: string;
  patientId: string;
  age?: number;
  gender?: string;
  email?: string;
  phone?: string;
}

interface LabHistoryEntry {
  _id: string;
  testDate?: string;
  labComparison?: Array<{
    test: string;
    actualValue: string | number;
    normalRange: string;
    status: string;
  }>;
  extractedJsonGroup1?: Record<string, unknown>;
  extractedJsonGroup2?: Record<string, unknown>;
}

interface PatientHistoryProps {
  patient: PatientInfo;
  diagnosisHistory: PatientDiagnosisRecord[];
  historySummary?: PatientHistorySummary | null;
  labHistory: LabHistoryEntry[];
  inProgressSessions?: WorkflowSession[];
  onContinueDiagnosis?: (sessionId: string) => void;
  onDeleteActiveSessions?: () => Promise<void> | void;
  deletingActiveSessions?: boolean;
  isLoading?: boolean;
  onDeleteHistoryEntry?: (payloadId: string) => Promise<void> | void;
  deletingPayloadId?: string | null;
}

type TabKey = "timeline" | "labs" | "summary" | "overview";

// Helpers

function formatDate(dateStr: string | null | undefined): string {
  if (!dateStr) return "Unknown date";
  try {
    return new Date(dateStr).toLocaleDateString("en-US", {
      year: "numeric",
      month: "short",
      day: "numeric",
      hour: "2-digit",
      minute: "2-digit",
    });
  } catch {
    return dateStr;
  }
}

function formatDateShort(dateStr: string | null | undefined): string {
  if (!dateStr) return "-";
  try {
    return new Date(dateStr).toLocaleDateString("en-US", {
      month: "short",
      day: "numeric",
      year: "numeric",
    });
  } catch {
    return dateStr;
  }
}

function mapWorkflowStateToResumeLabel(state: string) {
  if (state === "EXTRACTION_DONE") return "Symptoms saved - continue at ECG";
  if (state === "ECG_DONE") return "ECG saved - continue at Lab";
  if (state === "LAB_DONE" || state === "ANALYSIS_RUNNING") {
    return "Lab saved - continue at Analysis";
  }
  return "Continue diagnosis";
}

function InProgressDiagnosesPanel({
  sessions,
  deletingActiveSessions,
  onDeleteActiveSessions,
  onContinueDiagnosis,
}: {
  sessions: WorkflowSession[];
  deletingActiveSessions: boolean;
  onDeleteActiveSessions?: () => Promise<void> | void;
  onContinueDiagnosis?: (sessionId: string) => void;
}) {
  return (
    <Card className="glass border-primary/20 rounded-3xl">
      <CardContent className="p-4 sm:p-5 space-y-3">
        <div className="flex items-start justify-between gap-3">
          <div>
            <p className="text-sm font-black uppercase tracking-wide text-primary/85">
              In-Progress Diagnoses
            </p>
            <p className="text-xs text-foreground/80 mt-1">
              {sessions.length} active session{sessions.length === 1 ? "" : "s"}
            </p>
          </div>
          {sessions.length > 0 && onDeleteActiveSessions && (
            <button
              type="button"
              onClick={() => onDeleteActiveSessions()}
              disabled={deletingActiveSessions}
              className="h-8 rounded-lg border border-rose-500/25 text-rose-400 hover:bg-rose-500/10 disabled:opacity-60 disabled:cursor-not-allowed px-2.5 text-xs font-semibold"
            >
              {deletingActiveSessions ? "Deleting..." : "Delete Active"}
            </button>
          )}
        </div>

        {sessions.length === 0 ? (
          <div className="rounded-xl border border-dashed border-border/30 bg-muted/5 px-3 py-4 text-sm text-muted-foreground">
            No active diagnosis sessions.
          </div>
        ) : (
          <div className="space-y-2.5 max-h-72 overflow-y-auto pr-1">
            {sessions.map((session) => (
              <div
                key={session.session_id}
                className="rounded-xl border border-border/20 bg-background/40 p-3"
              >
                <p className="text-sm font-semibold text-foreground/95 leading-snug">
                  {mapWorkflowStateToResumeLabel(session.current_state)}
                </p>
                <p className="text-xs text-foreground/75 mt-1">
                  State: {session.current_state}
                </p>
                <p className="text-xs text-foreground/75">
                  Updated: {new Date(session.updated_at).toLocaleString()}
                </p>
                <div className="mt-2.5">
                  <button
                    type="button"
                    onClick={() => onContinueDiagnosis?.(session.session_id)}
                    className="h-8 rounded-lg bg-primary text-primary-foreground px-3 text-xs font-semibold"
                  >
                    Continue
                  </button>
                </div>
              </div>
            ))}
          </div>
        )}
      </CardContent>
    </Card>
  );
}

// Sinhala unicode range: 0D80-0DFF
function hasSinhala(s: string): boolean {
  return /[\u0D80-\u0DFF]/.test(s);
}

function isPlainRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function humanizeKey(key: string): string {
  return key.replace(/_/g, " ").replace(/\b\w/g, (match) => match.toUpperCase());
}

function formatDisplayValue(value: unknown): string {
  if (value == null) return "";

  if (typeof value === "string") {
    return value
      .replace(/```(?:json|markdown)?/gi, "")
      .replace(/```/g, "")
      .replace(/\[object Object\]/gi, "")
      .replace(/\s{2,}/g, " ")
      .trim();
  }

  if (
    typeof value === "number" ||
    typeof value === "boolean" ||
    typeof value === "bigint"
  ) {
    return String(value);
  }

  if (Array.isArray(value)) {
    return value.map(formatDisplayValue).filter(Boolean).join(", ");
  }

  if (isPlainRecord(value)) {
    const label =
      formatDisplayValue(value.label) ||
      formatDisplayValue(value.name) ||
      formatDisplayValue(value.test) ||
      formatDisplayValue(value.test_name) ||
      formatDisplayValue(value.parameter);
    const mainValue =
      formatDisplayValue(value.value) ||
      formatDisplayValue(value.result) ||
      formatDisplayValue(value.reading) ||
      formatDisplayValue(value.text) ||
      formatDisplayValue(value.interpretation) ||
      formatDisplayValue(value.severity) ||
      formatDisplayValue(value.actualValue);
    const unit = formatDisplayValue(value.unit) || formatDisplayValue(value.units);

    if (label || mainValue || unit) {
      const parts = [label, mainValue].filter(Boolean);
      const base = parts.join(": ");
      return unit ? `${base}${base ? " " : ""}${unit}`.trim() : base;
    }

    const entries = Object.entries(value)
      .map(([key, entryValue]) => {
        const formatted = formatDisplayValue(entryValue);
        return formatted ? `${humanizeKey(key)}: ${formatted}` : "";
      })
      .filter(Boolean);
    return entries.join(" • ");
  }

  return "";
}

function cleanStr(s: unknown): string | null {
  const text = formatDisplayValue(s);
  if (!text || hasSinhala(text)) return null;
  return text;
}

function sanitizeLegacyObjectText(text: string): string {
  if (!text) return "";

  let cleaned = text;
  cleaned = cleaned.replace(
    /\{[^{}]*['"]differential['"]\s*:\s*['"]([^'"]+)['"][^{}]*\}/gi,
    "$1",
  );
  cleaned = cleaned.replace(
    /\{[^{}]*['"]condition['"]\s*:\s*['"]([^'"]+)['"][^{}]*\}/gi,
    "$1",
  );
  cleaned = cleaned.replace(
    /\{[^{}]*['"]test(?:_name)?['"]\s*:\s*['"]([^'"]+)['"][^{}]*\}/gi,
    "$1",
  );
  cleaned = cleaned.replace(
    /\{[^{}]*['"]value['"]\s*:\s*['"]([^'"]+)['"][^{}]*\}/gi,
    "$1",
  );
  cleaned = cleaned.replace(/^[\s\[{]*(?:'rank'|"rank")[^\n]*$/gim, "");
  cleaned = cleaned.replace(/^[\s\[{]*\{.*\}[\s\]}]*$/gm, "");

  return cleaned.replace(/\s{2,}/g, " ").trim();
}

interface StructuredSymptoms {
  chiefComplaint?: string;
  symptoms: string[];
  riskFactors: string[];
  duration?: string;
  onset?: string;
  severity?: string;
  medicalHistory: string[];
  additionalNotes?: string;
}

function extractStructuredSymptoms(
  symptomsJson: Record<string, unknown> | null,
): StructuredSymptoms {
  const empty: StructuredSymptoms = {
    symptoms: [],
    riskFactors: [],
    medicalHistory: [],
  };
  if (!symptomsJson) return empty;

  // The backend stores symptoms/risk_factors inside an `additional` sub-object.
  // Fall back to top-level keys for older records.
  const additional =
    symptomsJson.additional &&
    typeof symptomsJson.additional === "object" &&
    !Array.isArray(symptomsJson.additional)
      ? (symptomsJson.additional as Record<string, unknown>)
      : null;

  const toList = (val: unknown): string[] => {
    if (Array.isArray(val))
      return val.map((v) => cleanStr(v)).filter(Boolean) as string[];
    const s = cleanStr(val);
    if (!s) return [];
    return s
      .split(/[,;]/)
      .map((p) => p.trim())
      .filter(Boolean);
  };

  return {
    chiefComplaint: cleanStr(symptomsJson.chief_complaint) ?? undefined,
    symptoms: toList(additional?.symptoms ?? symptomsJson.symptoms),
    riskFactors: toList(additional?.risk_factors ?? symptomsJson.risk_factors),
    duration: cleanStr(symptomsJson.duration) ?? undefined,
    onset: cleanStr(symptomsJson.onset) ?? undefined,
    severity: cleanStr(symptomsJson.severity) ?? undefined,
    medicalHistory: toList(
      symptomsJson.medical_history ?? symptomsJson.past_medical_history,
    ),
    additionalNotes:
      cleanStr(symptomsJson.additional_notes ?? symptomsJson.notes) ??
      undefined,
  };
}

function extractSymptomsSummary(
  symptomsJson: Record<string, unknown> | null,
): string {
  if (!symptomsJson) return "No symptoms recorded";
  const s = extractStructuredSymptoms(symptomsJson);
  const parts = [s.chiefComplaint, ...s.symptoms.slice(0, 3)].filter(Boolean);
  if (parts.length) return parts.join(" | ");
  // fallback: cleaned text field
  const raw = cleanStr(symptomsJson.text);
  if (raw) return raw.slice(0, 120);
  return "Symptoms recorded";
}

function extractEcgFields(
  ecgJson: Record<string, unknown> | null,
): Array<{ label: string; value: string }> {
  if (!ecgJson) return [];
  const status = ecgJson.status as string | undefined;
  if (status === "skipped") return [{ label: "Status", value: "Skipped" }];
  const fields: Array<{ label: string; value: string }> = [];
  const map: Record<string, string> = {
    rhythm: "Rhythm",
    heart_rate: "Heart Rate",
    interpretation: "Interpretation",
    pr_interval: "PR Interval",
    qrs_duration: "QRS Duration",
    qt_interval: "QT Interval",
    axis: "Axis",
    st_changes: "ST Changes",
  };
  for (const [key, label] of Object.entries(map)) {
    if (ecgJson[key] !== undefined && ecgJson[key] !== null) {
      const value = cleanStr(ecgJson[key]);
      if (value) fields.push({ label, value });
    }
  }
  return fields.length
    ? fields
    : [{ label: "Status", value: "ECG data available" }];
}

function extractLabFields(
  labsJson: Record<string, unknown> | null,
): Array<{ label: string; value: string; unit?: string }> {
  if (!labsJson) return [];
  const status = labsJson.status as string | undefined;
  if (status === "skipped") return [{ label: "Status", value: "Skipped" }];
  const keys = [
    "troponin",
    "ldh",
    "bnp",
    "creatinine",
    "hemoglobin",
    "wbc",
    "platelets",
    "glucose",
    "sodium",
    "potassium",
  ];
  const fields: Array<{ label: string; value: string }> = [];
  for (const key of keys) {
    if (labsJson[key] !== undefined && labsJson[key] !== null) {
      const value = cleanStr(labsJson[key]);
      if (!value) continue;
      fields.push({
        label: key.charAt(0).toUpperCase() + key.slice(1),
        value,
      });
    }
  }
  return fields.length
    ? fields
    : [{ label: "Status", value: "Lab data available" }];
}

interface DiagSection {
  heading: string;
  content: string;
  isTable: boolean;
  isBullets: boolean;
}

type OraMode = "newbie" | "seasoned";

interface OraModeContent {
  newbie?: string;
  seasoned?: string;
}

function normalizeOraMode(value: unknown): OraMode {
  return String(value ?? "").toLowerCase() === "newbie" ? "newbie" : "seasoned";
}

function cleanDiagnosisOutput(raw: string): string {
  let text = String(raw || "")
    .replace(/```markdown/gi, "")
    .replace(/```/g, "")
    .trim();
  if (!text) return "";

  text = sanitizeLegacyObjectText(text);
  if (!text) return "";

  const leakMatch = text.match(
    /^\s*(RULES:?|INTERNAL AUTHORING CONSTRAINTS(?:\s*\(.*\))?:?|ΓòÉΓòÉΓòÉ INPUT DATA ΓòÉΓòÉΓòÉ|PATIENT PRESENTATION:|KRA INPUT OBJECT:|KRA OUTPUT OBJECT:|KRA ANALYSIS:|ΓòÉΓòÉΓòÉ TASK ΓòÉΓòÉΓòÉ)\s*$/im,
  );
  if (!leakMatch || typeof leakMatch.index !== "number") {
    return text;
  }

  return text.slice(0, leakMatch.index).trim();
}

function resolveOraContent(record: PatientDiagnosisRecord): {
  outputs: OraModeContent;
  disclaimers: OraModeContent;
  defaultMode: OraMode;
} {
  const outputs: OraModeContent = {};
  const disclaimers: OraModeContent = {};

  const persistedOutputs = record.ora_outputs || {};
  const newbieOutput = cleanDiagnosisOutput(
    String(persistedOutputs.newbie || "").trim(),
  );
  const seasonedOutput = cleanDiagnosisOutput(
    String(persistedOutputs.seasoned || "").trim(),
  );
  if (newbieOutput) outputs.newbie = newbieOutput;
  if (seasonedOutput) outputs.seasoned = seasonedOutput;

  const persistedDisclaimers = record.ora_disclaimers || {};
  const newbieDisclaimer = String(persistedDisclaimers.newbie || "").trim();
  const seasonedDisclaimer = String(persistedDisclaimers.seasoned || "").trim();
  if (newbieDisclaimer) disclaimers.newbie = newbieDisclaimer;
  if (seasonedDisclaimer) disclaimers.seasoned = seasonedDisclaimer;

  if (!outputs.newbie && !outputs.seasoned) {
    const fallbackOutput = cleanDiagnosisOutput(
      String(record.refined_output || "").trim(),
    );
    if (fallbackOutput) {
      outputs[normalizeOraMode(record.experience_level)] = fallbackOutput;
    }
  }

  if (!disclaimers.newbie && !disclaimers.seasoned) {
    const fallbackDisclaimer = String(record.disclaimer || "").trim();
    if (fallbackDisclaimer) {
      disclaimers[normalizeOraMode(record.experience_level)] =
        fallbackDisclaimer;
    }
  }

  const defaultMode: OraMode = outputs.seasoned
    ? "seasoned"
    : outputs.newbie
      ? "newbie"
      : normalizeOraMode(record.experience_level);

  return { outputs, disclaimers, defaultMode };
}

function parseDiagnosisOutput(text: string): DiagSection[] {
  if (!text) return [];
  const sections: DiagSection[] = [];
  const lines = text.split("\n");
  let current: { heading: string; lines: string[] } | null = null;

  const flush = () => {
    if (!current) return;
    const content = current.lines.join("\n").trim();
    if (!content) return;
    const isTable = content.split("\n").some((l) => l.trim().startsWith("|"));
    const isBullets =
      !isTable && content.split("\n").some((l) => /^[\*\-]\s/.test(l.trim()));
    sections.push({ heading: current.heading, content, isTable, isBullets });
  };

  for (const line of lines) {
    const headingMatch =
      line.match(/^#{1,3}\s+(.+)/) ||
      line.match(/^├░┼╕┬⌐┬║\s*(.+)/) ||
      line.match(/^\*\*([^*]{3,})\*\*\s*$/) ||
      line.match(/^([A-Z][A-Z\s]{3,}):$/);
    if (headingMatch) {
      flush();
      current = {
        heading: headingMatch[1].replace(/\*\*/g, "").replace(/:/g, "").trim(),
        lines: [],
      };
    } else if (current) {
      current.lines.push(line);
    } else if (line.trim()) {
      current = { heading: "Overview", lines: [line] };
    }
  }
  flush();
  return sections;
}

function parseMdTable(content: string): {
  headers: string[];
  rows: string[][];
} {
  const tableLines = content
    .split("\n")
    .filter((l) => l.trim().startsWith("|"));
  if (tableLines.length < 2) return { headers: [], rows: [] };
  const parseRow = (l: string) =>
    l
      .split("|")
      .slice(1, -1)
      .map((c) => c.trim().replace(/\*\*/g, ""));
  const headers = parseRow(tableLines[0]);
  // tableLines[1] is the separator row (---)
  const rows = tableLines
    .slice(2)
    .map(parseRow)
    .filter((r) => r.some((c) => c));
  return { headers, rows };
}

function severityColor(val: string): string {
  const v = val.toUpperCase();
  if (v === "HIGH" || v === "CRITICAL")
    return "bg-rose-500/10 text-rose-400 border-rose-500/20";
  if (v === "MEDIUM" || v === "MODERATE")
    return "bg-amber-500/10 text-amber-400 border-amber-500/20";
  if (v === "LOW")
    return "bg-emerald-500/10 text-emerald-400 border-emerald-500/20";
  return "bg-muted/10 text-muted-foreground border-border/20";
}

function confidenceBar(val: string): number | null {
  const n = parseFloat(val);
  return isNaN(n) ? null : Math.min(1, n > 1 ? n / 100 : n);
}

function renderInline(text: string): React.ReactNode[] {
  const parts = text.split(/(\*\*.+?\*\*)/);
  return parts.map((p, i) =>
    p.startsWith("**") && p.endsWith("**") ? (
      <strong key={i} className="font-bold text-foreground">
        {p.slice(2, -2)}
      </strong>
    ) : (
      <span key={i}>{p}</span>
    ),
  );
}

// Overview map (interactive SVG radial node chart)

type SelectedNode =
  | { type: "hub"; groupLabel: string }
  | { type: "item"; groupLabel: string; item: string }
  | null;

function DiagnosisOverviewChart({
  diagnosisHistory,
  historySummary,
  patient,
}: {
  diagnosisHistory: PatientDiagnosisRecord[];
  historySummary?: PatientHistorySummary | null;
  patient: PatientInfo;
}) {
  const [hoveredKey, setHoveredKey] = useState<string | null>(null);
  const [selectedNode, setSelectedNode] = useState<SelectedNode>(null);
  const [collapsedGroups, setCollapsedGroups] = useState<Set<string>>(
    new Set(),
  );
  const [viewBox, setViewBox] = useState({ x: 0, y: 0, w: 1100, h: 660 });
  const [isPanning, setIsPanning] = useState(false);
  const panStartRef = useRef<{
    clientX: number;
    clientY: number;
    x: number;
    y: number;
  } | null>(null);

  const W = 1100,
    H = 660;
  const cx = W / 2,
    cy = H / 2;

  // Layout constants
  const HUB_DIST = 210;
  const ITEM_DIST = 120;
  const HUB_R = 44;
  const ITEM_R = 26;
  const CENTER_R = 62;
  const MAX_ITEMS = 6;
  const ARC_SPAN = 110;
  const MIN_VIEW_W = W * 0.5;
  const MAX_VIEW_W = W * 1.5;

  const clampViewBox = (x: number, y: number, w: number) => {
    const nextW = Math.min(MAX_VIEW_W, Math.max(MIN_VIEW_W, w));
    const nextH = (nextW * H) / W;

    const overflowX = Math.max(0, (nextW - W) / 2);
    const overflowY = Math.max(0, (nextH - H) / 2);
    const minX = -overflowX;
    const maxX = W - nextW + overflowX;
    const minY = -overflowY;
    const maxY = H - nextH + overflowY;

    return {
      x: Math.min(maxX, Math.max(minX, x)),
      y: Math.min(maxY, Math.max(minY, y)),
      w: nextW,
      h: nextH,
    };
  };

  const zoomCentered = (factor: number) => {
    setViewBox((prev) => {
      const centerX = prev.x + prev.w / 2;
      const centerY = prev.y + prev.h / 2;
      const nextW = prev.w * factor;
      const nextH = (nextW * H) / W;
      const nextX = centerX - nextW / 2;
      const nextY = centerY - nextH / 2;
      return clampViewBox(nextX, nextY, nextW);
    });
  };

  const resetView = () => {
    setViewBox({ x: 0, y: 0, w: W, h: H });
  };

  // Dynamic fill helper - brightens rgba fill for hover/selected states
  const dynFill = (base: string, state: "normal" | "hover" | "selected") => {
    const op = { normal: 0.18, hover: 0.32, selected: 0.5 }[state];
    return base.replace(/[\d.]+\)$/, op + ")");
  };

  const toRad = (d: number) => (d * Math.PI) / 180;
  const polar = (ox: number, oy: number, r: number, deg: number) => ({
    x: ox + r * Math.cos(toRad(deg)),
    y: oy - r * Math.sin(toRad(deg)),
  });

  function wrapLabel(text: string, maxChars = 8): string[] {
    const words = text.split(" ");
    const lines: string[] = [];
    let cur = "";
    for (const w of words) {
      if ((cur + " " + w).trim().length <= maxChars) {
        cur = (cur + " " + w).trim();
      } else {
        if (cur) lines.push(cur);
        cur = w.slice(0, maxChars) + (w.length > maxChars ? "\u2026" : "");
      }
    }
    if (cur) lines.push(cur);
    return lines.slice(0, 3);
  }

  const allSymptoms = Array.from(
    new Set(
      diagnosisHistory.flatMap(
        (r) =>
          extractStructuredSymptoms(
            r.symptoms_json as Record<string, unknown> | null,
          ).symptoms,
      ),
    ),
  ).slice(0, MAX_ITEMS);

  const allRiskFactors = Array.from(
    new Set(
      diagnosisHistory.flatMap(
        (r) =>
          extractStructuredSymptoms(
            r.symptoms_json as Record<string, unknown> | null,
          ).riskFactors,
      ),
    ),
  ).slice(0, MAX_ITEMS);

  const allDiagnoses = (historySummary?.top_conditions ?? []).slice(
    0,
    MAX_ITEMS,
  );
  const allLabFindings = (historySummary?.key_lab_findings ?? []).slice(
    0,
    MAX_ITEMS,
  );

  const groups = [
    {
      label: "Symptoms",
      angle: 180,
      items: allSymptoms,
      hue: "#818cf8",
      bg: "rgba(99,102,241,0.18)",
      stroke: "#818cf8",
    },
    {
      label: "Diagnoses",
      angle: 0,
      items: allDiagnoses,
      hue: "#f87171",
      bg: "rgba(239,68,68,0.18)",
      stroke: "#f87171",
    },
    {
      label: "Risk Factors",
      angle: 90,
      items: allRiskFactors,
      hue: "#fbbf24",
      bg: "rgba(245,158,11,0.18)",
      stroke: "#fbbf24",
    },
    {
      label: "Lab Findings",
      angle: 270,
      items: allLabFindings,
      hue: "#22d3ee",
      bg: "rgba(6,182,212,0.18)",
      stroke: "#22d3ee",
    },
  ];

  const hasData = groups.some((g) => g.items.length > 0);

  const hubKey = (label: string) => `hub-${label}`;
  const itemKey = (label: string, item: string) => `item-${label}-${item}`;

  const isHubSel = (label: string) =>
    selectedNode?.type === "hub" && selectedNode.groupLabel === label;
  const isItemSel = (label: string, item: string) =>
    selectedNode?.type === "item" &&
    selectedNode.groupLabel === label &&
    selectedNode.item === item;

  const isGroupActive = (label: string) =>
    hoveredKey?.startsWith(`hub-${label}`) ||
    hoveredKey?.startsWith(`item-${label}`) ||
    selectedNode?.groupLabel === label;

  const connOp = (label: string) => (isGroupActive(label) ? 0.7 : 0.3);

  const onHubClick = (label: string) => {
    if (isHubSel(label)) {
      setCollapsedGroups((prev) => {
        const next = new Set(prev);
        if (next.has(label)) next.delete(label);
        else next.add(label);
        return next;
      });
    } else {
      setSelectedNode({ type: "hub", groupLabel: label });
    }
  };

  const onItemClick = (label: string, item: string) => {
    setSelectedNode(
      isItemSel(label, item) ? null : { type: "item", groupLabel: label, item },
    );
  };

  const visitsForItem = (groupLabel: string, item: string) => {
    if (groupLabel === "Symptoms")
      return diagnosisHistory.filter((r) =>
        extractStructuredSymptoms(
          r.symptoms_json as Record<string, unknown> | null,
        ).symptoms.includes(item),
      );
    if (groupLabel === "Risk Factors")
      return diagnosisHistory.filter((r) =>
        extractStructuredSymptoms(
          r.symptoms_json as Record<string, unknown> | null,
        ).riskFactors.includes(item),
      );
    return [];
  };

  if (!hasData) {
    return (
      <div className="flex flex-col items-center justify-center h-56 gap-3 text-muted-foreground/40">
        <Network className="h-10 w-10" />
        <p className="text-sm font-medium">
          Not enough data to render the overview map yet.
        </p>
        <p className="text-xs">
          Complete at least one AI diagnosis session to populate this chart.
        </p>
      </div>
    );
  }

  const selGroup = selectedNode
    ? groups.find((g) => g.label === selectedNode.groupLabel)
    : null;

  return (
    <div className="flex gap-3 items-start">
      {/* ΓöÇΓöÇ Left: chart ΓöÇΓöÇ */}
      <div className="flex-1 min-w-0 relative">
        <div className="absolute top-3 right-3 z-20 flex items-center gap-1.5">
          <button
            type="button"
            onClick={() => zoomCentered(0.85)}
            className="h-7 w-7 rounded-md border border-border/30 bg-background/70 text-foreground/85 text-sm font-bold hover:bg-background"
            aria-label="Zoom in"
            title="Zoom in"
          >
            +
          </button>
          <button
            type="button"
            onClick={() => zoomCentered(1.15)}
            className="h-7 w-7 rounded-md border border-border/30 bg-background/70 text-foreground/85 text-sm font-bold hover:bg-background"
            aria-label="Zoom out"
            title="Zoom out"
          >
            -
          </button>
          <button
            type="button"
            onClick={resetView}
            className="h-7 px-2 rounded-md border border-border/30 bg-background/70 text-foreground/80 text-xs font-semibold hover:bg-background"
            aria-label="Reset view"
            title="Reset view"
          >
            Reset
          </button>
        </div>
        <svg
          viewBox={`${viewBox.x} ${viewBox.y} ${viewBox.w} ${viewBox.h}`}
          className={`w-full h-auto select-none ${isPanning ? "cursor-grabbing" : "cursor-grab"}`}
          xmlns="http://www.w3.org/2000/svg"
          onMouseDown={(e) => {
            setIsPanning(true);
            panStartRef.current = {
              clientX: e.clientX,
              clientY: e.clientY,
              x: viewBox.x,
              y: viewBox.y,
            };
          }}
          onMouseMove={(e) => {
            if (!isPanning || !panStartRef.current) return;
            const rect = e.currentTarget.getBoundingClientRect();
            const dx =
              ((e.clientX - panStartRef.current.clientX) / rect.width) *
              viewBox.w;
            const dy =
              ((e.clientY - panStartRef.current.clientY) / rect.height) *
              viewBox.h;
            setViewBox(
              clampViewBox(
                panStartRef.current.x - dx,
                panStartRef.current.y - dy,
                viewBox.w,
              ),
            );
          }}
          onMouseUp={() => {
            setIsPanning(false);
            panStartRef.current = null;
          }}
          onMouseLeave={() => {
            setIsPanning(false);
            panStartRef.current = null;
          }}
          onWheel={(e) => {
            if (!e.ctrlKey && !e.metaKey) {
              return;
            }
            e.preventDefault();
            const rect = e.currentTarget.getBoundingClientRect();
            const relX = (e.clientX - rect.left) / rect.width;
            const relY = (e.clientY - rect.top) / rect.height;
            const factor = e.deltaY < 0 ? 0.92 : 1.08;

            setViewBox((prev) => {
              const nextW = prev.w * factor;
              const nextH = (nextW * H) / W;
              const worldX = prev.x + relX * prev.w;
              const worldY = prev.y + relY * prev.h;
              const nextX = worldX - relX * nextW;
              const nextY = worldY - relY * nextH;
              return clampViewBox(nextX, nextY, nextW);
            });
          }}
          onClick={(e) => {
            if (isPanning) return;
            if (e.target === e.currentTarget) setSelectedNode(null);
          }}
        >
          <defs>
            <radialGradient id="ovmap-bg" cx="50%" cy="50%" r="50%">
              <stop offset="0%" stopColor="#1e1e2e" />
              <stop offset="100%" stopColor="#13131f" />
            </radialGradient>
            <radialGradient id="ovmap-glow" cx="50%" cy="50%" r="50%">
              <stop offset="0%" stopColor="#6366f1" stopOpacity="0.22" />
              <stop offset="100%" stopColor="#6366f1" stopOpacity="0" />
            </radialGradient>
            <filter
              id="ovmap-shadow"
              x="-30%"
              y="-30%"
              width="160%"
              height="160%"
            >
              <feDropShadow
                dx="0"
                dy="0"
                stdDeviation="6"
                floodColor="#6366f1"
                floodOpacity="0.3"
              />
            </filter>
            <filter
              id="ovmap-bright"
              x="-50%"
              y="-50%"
              width="200%"
              height="200%"
            >
              <feDropShadow
                dx="0"
                dy="0"
                stdDeviation="10"
                floodColor="#ffffff"
                floodOpacity="0.18"
              />
            </filter>
          </defs>

          <rect
            x="0"
            y="0"
            width={W}
            height={H}
            rx="20"
            fill="url(#ovmap-bg)"
          />
          {[90, 190, 290].map((r) => (
            <circle
              key={r}
              cx={cx}
              cy={cy}
              r={r}
              fill="none"
              stroke="rgba(255,255,255,0.03)"
              strokeWidth="1"
            />
          ))}
          <ellipse cx={cx} cy={cy} rx={160} ry={120} fill="url(#ovmap-glow)" />

          <text
            x={W - 14}
            y={H - 10}
            fontSize="9"
            fill="rgba(255,255,255,0.15)"
            textAnchor="end"
          >
            Click hub to select \u00b7 click again to collapse \u00b7 click node
            for details
          </text>

          {groups.map((group) => {
            if (group.items.length === 0) return null;
            const hub = polar(cx, cy, HUB_DIST, group.angle);
            const hKey = hubKey(group.label);
            const isHubHov = hoveredKey === hKey;
            const isCollapsed = collapsedGroups.has(group.label);
            const n = group.items.length;

            const itemNodes = group.items.map((item, i) => {
              const angle =
                n === 1
                  ? group.angle
                  : group.angle - ARC_SPAN / 2 + (i / (n - 1)) * ARC_SPAN;
              return { item, pos: polar(hub.x, hub.y, ITEM_DIST, angle) };
            });

            return (
              <g key={group.label}>
                <line
                  x1={cx}
                  y1={cy}
                  x2={hub.x}
                  y2={hub.y}
                  stroke={group.hue}
                  strokeWidth={isGroupActive(group.label) ? 2 : 1.5}
                  strokeOpacity={connOp(group.label)}
                  strokeDasharray="6 4"
                  style={{
                    transition: "stroke-opacity 0.2s, stroke-width 0.2s",
                  }}
                />

                {!isCollapsed &&
                  itemNodes.map(({ item, pos }, i) => {
                    const iKey = itemKey(group.label, item);
                    const active =
                      hoveredKey === iKey || isItemSel(group.label, item);
                    return (
                      <line
                        key={i}
                        x1={hub.x}
                        y1={hub.y}
                        x2={pos.x}
                        y2={pos.y}
                        stroke={group.hue}
                        strokeWidth={active ? 1.8 : 1}
                        strokeOpacity={active ? 0.65 : 0.25}
                        style={{
                          transition:
                            "stroke-opacity 0.15s, stroke-width 0.15s",
                        }}
                      />
                    );
                  })}

                {!isCollapsed &&
                  itemNodes.map(({ item, pos }, i) => {
                    const iKey = itemKey(group.label, item);
                    const isHov = hoveredKey === iKey;
                    const isSel = isItemSel(group.label, item);
                    const state = isSel
                      ? "selected"
                      : isHov
                        ? "hover"
                        : "normal";
                    const r = ITEM_R + (isSel ? 5 : isHov ? 3 : 0);
                    const lblLines = wrapLabel(item);
                    const lineH = 11;
                    const totalH = lblLines.length * lineH;
                    const startY = pos.y - totalH / 2 + lineH / 2;

                    return (
                      <g
                        key={i}
                        style={{ cursor: "pointer" }}
                        onMouseEnter={() => setHoveredKey(iKey)}
                        onMouseLeave={() => setHoveredKey(null)}
                        onClick={(e) => {
                          e.stopPropagation();
                          onItemClick(group.label, item);
                        }}
                      >
                        {isSel && (
                          <circle
                            cx={pos.x}
                            cy={pos.y}
                            r={r + 7}
                            fill="none"
                            stroke={group.hue}
                            strokeWidth="1"
                            strokeOpacity="0.3"
                          />
                        )}
                        <circle
                          cx={pos.x}
                          cy={pos.y}
                          r={r}
                          fill={dynFill(group.bg, state)}
                          stroke={group.stroke}
                          strokeWidth={isSel ? 2.5 : isHov ? 2 : 1.5}
                          filter={isSel ? "url(#ovmap-bright)" : undefined}
                          style={{
                            transition:
                              "r 0.15s ease, fill 0.15s ease, stroke-width 0.15s",
                          }}
                        />
                        {lblLines.map((line, li) => (
                          <text
                            key={li}
                            x={pos.x}
                            y={startY + li * lineH}
                            fontSize={isSel ? "9" : "8"}
                            fontWeight="700"
                            fill={group.hue}
                            fillOpacity={isSel ? 1 : 0.9}
                            textAnchor="middle"
                            dominantBaseline="middle"
                            style={{ pointerEvents: "none" }}
                          >
                            {line}
                          </text>
                        ))}
                      </g>
                    );
                  })}

                <g
                  style={{ cursor: "pointer" }}
                  onMouseEnter={() => setHoveredKey(hKey)}
                  onMouseLeave={() => setHoveredKey(null)}
                  onClick={(e) => {
                    e.stopPropagation();
                    onHubClick(group.label);
                  }}
                >
                  {isHubSel(group.label) && (
                    <circle
                      cx={hub.x}
                      cy={hub.y}
                      r={HUB_R + 12}
                      fill="none"
                      stroke={group.hue}
                      strokeWidth="1.5"
                      strokeOpacity="0.3"
                    />
                  )}
                  <circle
                    cx={hub.x}
                    cy={hub.y}
                    r={HUB_R + (isHubSel(group.label) ? 6 : isHubHov ? 4 : 0)}
                    fill={dynFill(
                      group.bg,
                      isHubSel(group.label)
                        ? "selected"
                        : isHubHov
                          ? "hover"
                          : "normal",
                    )}
                    stroke={group.stroke}
                    strokeWidth={isHubSel(group.label) ? 3 : isHubHov ? 2.5 : 2}
                    filter="url(#ovmap-shadow)"
                    style={{
                      transition:
                        "r 0.15s ease, fill 0.15s ease, stroke-width 0.15s",
                    }}
                  />
                  <text
                    x={hub.x}
                    y={hub.y - 7}
                    fontSize="11"
                    fontWeight="900"
                    fill={group.hue}
                    fillOpacity={isHubHov || isHubSel(group.label) ? 1 : 0.9}
                    textAnchor="middle"
                    dominantBaseline="middle"
                    style={{ pointerEvents: "none" }}
                  >
                    {group.label}
                  </text>
                  <text
                    x={hub.x}
                    y={hub.y + 8}
                    fontSize="9"
                    fill={group.hue}
                    fillOpacity="0.6"
                    textAnchor="middle"
                    style={{ pointerEvents: "none" }}
                  >
                    {isCollapsed
                      ? `\u25b6 ${group.items.length} hidden`
                      : `\u25bc ${group.items.length} item${group.items.length !== 1 ? "s" : ""}`}
                  </text>
                </g>
              </g>
            );
          })}

          <g
            style={{ cursor: selectedNode ? "pointer" : "default" }}
            onClick={(e) => {
              e.stopPropagation();
              setSelectedNode(null);
            }}
          >
            <circle
              cx={cx}
              cy={cy}
              r={CENTER_R + 14}
              fill="rgba(99,102,241,0.06)"
            />
            <circle
              cx={cx}
              cy={cy}
              r={CENTER_R}
              fill="rgba(30,27,60,0.9)"
              stroke={selectedNode ? "#a78bfa" : "#818cf8"}
              strokeWidth={selectedNode ? 3 : 2.5}
              filter="url(#ovmap-shadow)"
              style={{ transition: "stroke 0.2s, stroke-width 0.2s" }}
            />
            <text
              x={cx}
              y={cy - 14}
              fontSize="15"
              fontWeight="900"
              fill="#c4b5fd"
              textAnchor="middle"
              dominantBaseline="middle"
              style={{ pointerEvents: "none" }}
            >
              {(patient.fullName?.split(" ")[0] ?? "Patient").slice(0, 12)}
            </text>
            <text
              x={cx}
              y={cy + 3}
              fontSize="9"
              fill="rgba(196,181,253,0.5)"
              textAnchor="middle"
              style={{ pointerEvents: "none" }}
            >
              {patient.patientId}
            </text>
            <text
              x={cx}
              y={cy + 16}
              fontSize="9"
              fill="rgba(196,181,253,0.4)"
              textAnchor="middle"
              style={{ pointerEvents: "none" }}
            >
              {selectedNode
                ? "click to deselect"
                : `${diagnosisHistory.length} visit${diagnosisHistory.length !== 1 ? "s" : ""}`}
            </text>
          </g>
        </svg>
      </div>

      {/* ΓöÇΓöÇ Right: detail panel ΓöÇΓöÇ */}
      <div className="w-72 shrink-0 self-stretch max-h-136 overflow-y-auto pr-1">
        {selectedNode && selGroup ? (
          <div
            className="rounded-xl border p-4 space-y-3 h-full bg-card/90 dark:bg-card/60"
            style={{
              borderColor: selGroup.hue + "44",
            }}
          >
            <div className="flex items-center gap-2">
              <span
                className="h-2.5 w-2.5 rounded-full shrink-0"
                style={{ backgroundColor: selGroup.hue }}
              />
              <span className="text-sm font-semibold text-foreground/75">
                {selGroup.label}
              </span>
              {selectedNode.type === "item" && (
                <span
                  className="text-base font-black ml-1"
                  style={{ color: selGroup.hue }}
                >
                  {selectedNode.item}
                </span>
              )}
              {selectedNode.type === "hub" && (
                <span
                  className="text-base font-black ml-1"
                  style={{ color: selGroup.hue }}
                >
                  {selGroup.items.length} entries
                </span>
              )}
              <button
                onClick={() => setSelectedNode(null)}
                className="text-foreground/70 hover:text-foreground text-sm ml-auto transition-colors px-1"
              >
                \u2715
              </button>
            </div>

            {selectedNode.type === "hub" && (
              <>
                <div className="flex flex-wrap gap-2">
                  {selGroup.items.map((item) => (
                    <button
                      key={item}
                      onClick={() => onItemClick(selGroup.label, item)}
                      className="text-sm rounded-full px-3 py-1 font-semibold transition-all hover:scale-105 active:scale-95"
                      style={{
                        background: selGroup.bg,
                        border: `1px solid ${selGroup.hue}66`,
                        color: selGroup.hue,
                      }}
                    >
                      {item}
                    </button>
                  ))}
                </div>
                <p className="text-sm text-foreground/70">
                  Click a pill to drill into that entry \u00b7 click the hub
                  again to collapse its nodes
                </p>
              </>
            )}

            {selectedNode.type === "item" &&
              (() => {
                const visits = visitsForItem(selGroup.label, selectedNode.item);
                return (
                  <div className="space-y-1.5">
                    {visits.length > 0 ? (
                      <>
                        <p className="text-xs font-bold uppercase tracking-wide text-foreground/70">
                          Recorded in {visits.length} visit
                          {visits.length !== 1 ? "s" : ""}
                        </p>
                        {visits.map((v) => {
                          const resolvedVisit = resolveOraContent(v);
                          const hasVisitDiagnosis = Boolean(
                            resolvedVisit.outputs.seasoned ||
                            resolvedVisit.outputs.newbie,
                          );

                          return (
                            <div
                              key={v.payload_id}
                              className="text-sm rounded-lg px-3 py-1.5 flex items-center gap-2"
                              style={{
                                background: selGroup.hue + "18",
                                border: `1px solid ${selGroup.hue}33`,
                              }}
                            >
                              <CalendarDays
                                className="h-3 w-3 shrink-0"
                                style={{ color: selGroup.hue }}
                              />
                              <span className="text-foreground/80">
                                {formatDate(v.created_at)}
                              </span>
                              {hasVisitDiagnosis && (
                                <span className="text-foreground/70 ml-auto text-xs">
                                  has AI diagnosis
                                </span>
                              )}
                            </div>
                          );
                        })}
                      </>
                    ) : (
                      <p className="text-sm text-foreground/70">
                        Sourced from the AI longitudinal summary across all
                        visits.
                      </p>
                    )}
                  </div>
                );
              })()}
          </div>
        ) : (
          <div className="rounded-xl border border-border/15 h-full flex flex-col items-center justify-center gap-3 p-6 text-center min-h-48">
            <Network className="h-8 w-8 text-muted-foreground/20" />
            <p className="text-sm text-foreground/65 leading-relaxed">
              Click a <span className="font-semibold">hub</span> or{" "}
              <span className="font-semibold">node</span> on the map to see
              details here
            </p>
          </div>
        )}
      </div>
    </div>
  );
}

// Component

export default function PatientHistory({
  patient,
  diagnosisHistory,
  historySummary,
  labHistory,
  inProgressSessions = [],
  onContinueDiagnosis,
  onDeleteActiveSessions,
  deletingActiveSessions = false,
  isLoading = false,
  onDeleteHistoryEntry,
  deletingPayloadId = null,
}: PatientHistoryProps) {
  const [expandedId, setExpandedId] = useState<string | null>(null);
  const [expandedLabId, setExpandedLabId] = useState<string | null>(null);
  const [selectedOraModes, setSelectedOraModes] = useState<
    Record<string, OraMode>
  >({});
  const [activeTab, setActiveTab] = useState<TabKey>("timeline");

  const toggleExpand = (id: string) =>
    setExpandedId((prev) => (prev === id ? null : id));
  const toggleLabExpand = (id: string) =>
    setExpandedLabId((prev) => (prev === id ? null : id));
  const selectOraMode = (payloadId: string, mode: OraMode) => {
    setSelectedOraModes((prev) => ({ ...prev, [payloadId]: mode }));
  };

  const lastVisit = diagnosisHistory[0]?.created_at ?? labHistory[0]?.testDate;
  const totalConditions = historySummary?.top_conditions?.length ?? 0;

  const tabs: Array<{
    key: TabKey;
    label: string;
    icon: React.ReactNode;
    count?: number;
  }> = [
    {
      key: "timeline",
      label: "Visit Timeline",
      icon: <Clock className="h-3.5 w-3.5" />,
      count: diagnosisHistory.length,
    },
    {
      key: "labs",
      label: "Lab History",
      icon: <FlaskConical className="h-3.5 w-3.5" />,
      count: labHistory.length,
    },
    {
      key: "summary",
      label: "AI Summary",
      icon: <BrainCircuit className="h-3.5 w-3.5" />,
    },
    {
      key: "overview",
      label: "Overview Map",
      icon: <Network className="h-3.5 w-3.5" />,
    },
  ];

  return (
    <div className="space-y-6">
      {/* Patient Hero Card */}
      <Card className="glass border-border/30 rounded-4xl overflow-hidden">
        <CardContent className="p-0">
          {/* Top accent stripe */}
          <div className="h-1.5 w-full bg-linear-to-r from-primary/60 via-primary/30 to-transparent" />
          <div className="p-6 sm:p-8">
            <div className="flex flex-col sm:flex-row items-start sm:items-center gap-5">
              {/* Avatar */}
              <div className="relative shrink-0">
                <div className="h-20 w-20 rounded-3xl bg-linear-to-br from-primary/20 to-primary/5 flex items-center justify-center text-primary font-black text-3xl border border-primary/20 shadow-lg">
                  {patient.fullName?.charAt(0)?.toUpperCase() || "?"}
                </div>
                <div className="absolute -bottom-1 -right-1 h-5 w-5 rounded-full bg-emerald-500 border-2 border-background" />
              </div>

              {/* Info */}
              <div className="flex-1 min-w-0">
                <h2 className="text-2xl font-black tracking-tight truncate">
                  {patient.fullName}
                </h2>
                <p className="text-xs text-muted-foreground font-mono mt-0.5">
                  {patient.patientId}
                </p>
                <div className="flex flex-wrap gap-2 mt-3">
                  {patient.age && (
                    <div className="flex items-center gap-1.5 text-xs bg-primary/5 border border-primary/10 rounded-full px-3 py-1">
                      <User className="h-3 w-3 text-primary" />
                      <span>{patient.age} yrs</span>
                    </div>
                  )}
                  {patient.gender && (
                    <div className="flex items-center gap-1.5 text-xs bg-muted/10 border border-border/20 rounded-full px-3 py-1">
                      {patient.gender}
                    </div>
                  )}
                  {patient.email && (
                    <div className="flex items-center gap-1.5 text-xs bg-muted/10 border border-border/20 rounded-full px-3 py-1 truncate max-w-50">
                      {patient.email}
                    </div>
                  )}
                </div>
              </div>

              {/* Stats */}
              <div className="flex gap-3 sm:gap-4 shrink-0">
                <div className="text-center">
                  <p className="text-2xl font-black text-primary">
                    {diagnosisHistory.length + labHistory.length}
                  </p>
                  <p className="text-[10px] text-muted-foreground uppercase tracking-wider mt-0.5">
                    Total Visits
                  </p>
                </div>
                <div className="w-px bg-border/20 self-stretch" />
                <div className="text-center">
                  <p className="text-2xl font-black">
                    {totalConditions || "-"}
                  </p>
                  <p className="text-[10px] text-muted-foreground uppercase tracking-wider mt-0.5">
                    Conditions
                  </p>
                </div>
                <div className="w-px bg-border/20 self-stretch" />
                <div className="text-center">
                  <p className="text-sm font-black text-foreground/80">
                    {lastVisit ? formatDateShort(lastVisit) : "-"}
                  </p>
                  <p className="text-[10px] text-muted-foreground uppercase tracking-wider mt-0.5">
                    Last Visit
                  </p>
                </div>
              </div>
            </div>
          </div>
        </CardContent>
      </Card>

      {inProgressSessions.length > 0 && (
        <InProgressDiagnosesPanel
          sessions={inProgressSessions}
          deletingActiveSessions={deletingActiveSessions}
          onDeleteActiveSessions={onDeleteActiveSessions}
          onContinueDiagnosis={onContinueDiagnosis}
        />
      )}

      {/* Tabs */}
      <div className="flex gap-1.5 p-1 bg-muted/10 border border-border/20 rounded-2xl w-fit">
        {tabs.map((tab) => (
          <button
            key={tab.key}
            onClick={() => setActiveTab(tab.key)}
            className={`flex items-center gap-2 px-4 py-2 rounded-xl text-xs font-bold transition-all ${
              activeTab === tab.key
                ? "bg-primary text-primary-foreground shadow-sm"
                : "text-muted-foreground hover:text-foreground hover:bg-white/5"
            }`}
          >
            {tab.icon}
            {tab.label}
            {tab.count !== undefined && tab.count > 0 && (
              <span
                className={`text-[10px] rounded-full px-1.5 py-0.5 font-black ${
                  activeTab === tab.key ? "bg-white/20" : "bg-muted/20"
                }`}
              >
                {tab.count}
              </span>
            )}
          </button>
        ))}
      </div>

      {/* Tab section */}
      {activeTab === "timeline" &&
        (isLoading ? (
          <div className="flex items-center justify-center h-40">
            <div className="animate-spin h-8 w-8 border-2 border-primary border-t-transparent rounded-full" />
          </div>
        ) : diagnosisHistory.length === 0 ? (
          <Card className="glass border-border/20 border-dashed rounded-4xl">
            <CardContent className="p-12 text-center">
              <div className="h-16 w-16 rounded-2xl bg-muted/10 flex items-center justify-center mx-auto mb-4">
                <Stethoscope className="h-8 w-8 text-muted-foreground/40" />
              </div>
              <h4 className="text-lg font-bold text-muted-foreground mb-2">
                No Diagnosis Records
              </h4>
              <p className="text-sm text-muted-foreground/60">
                No AI diagnostic records yet. Start a new diagnosis to build
                this patient&apos;s clinical history.
              </p>
            </CardContent>
          </Card>
        ) : (
          <div className="relative">
            {/* Vertical timeline line */}
            <div className="absolute left-6 top-4 bottom-4 w-0.5 bg-border/20 rounded-full" />

            <div className="space-y-4 pl-16">
              {diagnosisHistory.map((record, idx) => {
                const isExpanded = expandedId === record.payload_id;
                const isDeleting = deletingPayloadId === record.payload_id;
                const ecgFields = extractEcgFields(record.ecg_json);
                const labFields = extractLabFields(record.labs_json);
                const resolvedOra = resolveOraContent(record);
                const selectedMode =
                  selectedOraModes[record.payload_id] ??
                  resolvedOra.defaultMode;
                const selectedOutput =
                  resolvedOra.outputs[selectedMode] ||
                  resolvedOra.outputs.seasoned ||
                  resolvedOra.outputs.newbie ||
                  "";
                const selectedDisclaimer = cleanDiagnosisOutput(
                  resolvedOra.disclaimers[selectedMode] ||
                  resolvedOra.disclaimers.seasoned ||
                  resolvedOra.disclaimers.newbie ||
                  "",
                );
                const hasDualModeOutput = Boolean(
                  resolvedOra.outputs.newbie && resolvedOra.outputs.seasoned,
                );
                const availableModeLabel = hasDualModeOutput
                  ? "newbie + seasoned"
                  : resolvedOra.outputs.seasoned
                    ? "seasoned"
                    : resolvedOra.outputs.newbie
                      ? "newbie"
                      : null;
                const diagnosisSections = parseDiagnosisOutput(
                  cleanDiagnosisOutput(selectedOutput),
                );
                const hasDiagnosisOutput = Boolean(selectedOutput.trim());
                const structuredSymptoms = extractStructuredSymptoms(
                  record.symptoms_json,
                );
                const isCompleted = record.status === "completed";

                return (
                  <div key={record.payload_id} className="relative">
                    {/* Timeline dot */}
                    <div
                      className={`absolute -left-10 top-5 h-4 w-4 rounded-full border-2 z-10 ${
                        isCompleted
                          ? "bg-emerald-500 border-emerald-400 shadow-[0_0_8px_rgba(16,185,129,0.4)]"
                          : "bg-amber-500 border-amber-400"
                      }`}
                    />

                    <Card
                      className={`glass border-border/20 rounded-3xl overflow-hidden transition-all duration-200 ${
                        isExpanded
                          ? "border-primary/30 shadow-lg shadow-primary/5"
                          : "hover:border-border/40"
                      }`}
                    >
                      <CardContent className="p-0">
                        {/* Header row */}
                        <div className="flex items-start gap-3 p-5">
                          <button
                            onClick={() => toggleExpand(record.payload_id)}
                            className="flex-1 min-w-0 flex items-start gap-4 text-left hover:bg-white/2 transition-colors rounded-xl p-1 -m-1"
                          >
                            <div
                              className={`h-10 w-10 rounded-xl flex items-center justify-center shrink-0 mt-0.5 ${
                                isCompleted
                                  ? "bg-emerald-500/10"
                                  : "bg-amber-500/10"
                              }`}
                            >
                              {isCompleted ? (
                                <CircleCheck className="h-5 w-5 text-emerald-400" />
                              ) : (
                                <CircleAlert className="h-5 w-5 text-amber-400" />
                              )}
                            </div>
                            <div className="flex-1 min-w-0">
                              <div className="flex flex-wrap items-center gap-2.5 mb-2">
                                <span className="text-base font-bold">
                                  {formatDate(record.created_at)}
                                </span>
                                <Badge
                                  className={
                                    isCompleted
                                      ? "bg-emerald-500/15 dark:bg-emerald-500/10 text-emerald-700 dark:text-emerald-300 border-emerald-600/30 dark:border-emerald-500/20 text-xs"
                                      : "bg-amber-500/15 dark:bg-amber-500/10 text-amber-700 dark:text-amber-300 border-amber-600/30 dark:border-amber-500/20 text-xs"
                                  }
                                >
                                  {record.status || "unknown"}
                                </Badge>
                                {record.experience_level && (
                                  <Badge variant="outline" className="text-xs">
                                    {record.experience_level}
                                  </Badge>
                                )}
                                {availableModeLabel && (
                                  <Badge variant="outline" className="text-xs">
                                    {availableModeLabel}
                                  </Badge>
                                )}
                                <span className="text-xs text-foreground/70 font-mono">
                                  Visit #{diagnosisHistory.length - idx}
                                </span>
                                {(record.doctor_name || record.doctor_id) && (
                                  <span className="inline-flex items-center gap-1 text-xs text-foreground/75 bg-white/4 border border-border/20 rounded-full px-2 py-0.5">
                                    <Stethoscope className="h-2.5 w-2.5 shrink-0" />
                                    {record.doctor_name ?? record.doctor_id}
                                  </span>
                                )}
                              </div>
                              <p className="text-sm text-foreground/80 leading-relaxed">
                                {extractSymptomsSummary(record.symptoms_json)}
                              </p>
                              {/* Data chips */}
                              <div className="flex gap-2 mt-3 flex-wrap">
                                {record.symptoms_json && (
                                  <span className="inline-flex items-center gap-1 text-xs bg-teal-500/15 dark:bg-teal-500/10 border border-teal-600/30 dark:border-teal-500/25 text-teal-700 dark:text-teal-300 rounded-full px-2.5 py-1">
                                    <FileText className="h-2.5 w-2.5" />{" "}
                                    Symptoms
                                  </span>
                                )}
                                {record.ecg_json && (
                                  <span className="inline-flex items-center gap-1 text-xs bg-violet-500/14 dark:bg-violet-500/10 border border-violet-600/30 dark:border-violet-500/25 text-violet-700 dark:text-violet-300 rounded-full px-2.5 py-1">
                                    <Activity className="h-2.5 w-2.5" /> ECG
                                  </span>
                                )}
                                {record.labs_json && (
                                  <span className="inline-flex items-center gap-1 text-xs bg-cyan-500/14 dark:bg-cyan-500/10 border border-cyan-600/30 dark:border-cyan-500/25 text-cyan-700 dark:text-cyan-300 rounded-full px-2.5 py-1">
                                    <Microscope className="h-2.5 w-2.5" /> Labs
                                  </span>
                                )}
                                {hasDiagnosisOutput && (
                                  <span className="inline-flex items-center gap-1 text-xs bg-primary/14 dark:bg-primary/10 border border-primary/30 dark:border-primary/25 text-primary rounded-full px-2.5 py-1">
                                    <BrainCircuit className="h-2.5 w-2.5" /> AI
                                    Diagnosis
                                  </span>
                                )}
                              </div>
                            </div>
                            <div
                              className={`p-1.5 rounded-lg transition-colors shrink-0 mt-0.5 ${isExpanded ? "bg-primary/10 text-primary" : "text-muted-foreground"}`}
                            >
                              {isExpanded ? (
                                <ChevronUp className="h-4 w-4" />
                              ) : (
                                <ChevronDown className="h-4 w-4" />
                              )}
                            </div>
                          </button>

                          {onDeleteHistoryEntry && (
                            <button
                              type="button"
                              onClick={async (e) => {
                                e.stopPropagation();
                                if (
                                  !window.confirm(
                                    "Delete this history entry? This will remove linked KRA/ORA records.",
                                  )
                                ) {
                                  return;
                                }
                                await onDeleteHistoryEntry(record.payload_id);
                              }}
                              disabled={isDeleting}
                              className="h-9 w-9 shrink-0 rounded-lg border border-rose-500/25 text-rose-400 hover:bg-rose-500/10 disabled:opacity-60 disabled:cursor-not-allowed flex items-center justify-center"
                              title="Delete history entry"
                              aria-label="Delete history entry"
                            >
                              {isDeleting ? (
                                <Loader2 className="h-4 w-4 animate-spin" />
                              ) : (
                                <Trash2 className="h-4 w-4" />
                              )}
                            </button>
                          )}
                        </div>

                        {/* Expanded detail panel */}
                        {isExpanded && (
                          <div className="border-t border-border/10 bg-white/1">
                            <div className="grid grid-cols-1 divide-y divide-border/10">
                              {/* Left: Symptoms & ECG */}
                              <div className="p-5 space-y-5">
                                {/* Symptoms */}
                                <div>
                                  <div className="flex items-center gap-2 mb-3">
                                    <div className="h-7 w-7 rounded-lg bg-teal-500/12 dark:bg-teal-500/10 flex items-center justify-center">
                                      <FileText className="h-4 w-4 text-teal-700 dark:text-teal-300" />
                                    </div>
                                    <span className="text-sm font-black uppercase tracking-[0.12em] text-foreground/75">
                                      Chief Complaint / Symptoms
                                    </span>
                                  </div>
                                  <div className="rounded-xl bg-teal-500/8 dark:bg-teal-500/6 border border-teal-600/20 dark:border-teal-500/20 p-4 space-y-3">
                                    {structuredSymptoms.chiefComplaint && (
                                      <div>
                                        <p className="text-xs font-black uppercase tracking-wide text-teal-700 dark:text-teal-300 mb-1.5">
                                          Chief Complaint
                                        </p>
                                        <p className="text-sm font-semibold text-foreground/90">
                                          {structuredSymptoms.chiefComplaint}
                                        </p>
                                      </div>
                                    )}
                                    {structuredSymptoms.symptoms.length > 0 && (
                                      <div>
                                        <p className="text-xs font-black uppercase tracking-wide text-foreground/75 mb-2">
                                          Symptoms
                                        </p>
                                        <div className="flex flex-wrap gap-1.5">
                                          {structuredSymptoms.symptoms.map(
                                            (sym, i) => (
                                              <span
                                                key={i}
                                                className="inline-flex items-center text-xs bg-teal-500/15 dark:bg-teal-500/10 border border-teal-600/30 dark:border-teal-500/25 text-teal-700 dark:text-teal-300 rounded-full px-2.5 py-1"
                                              >
                                                {sym}
                                              </span>
                                            ),
                                          )}
                                        </div>
                                      </div>
                                    )}
                                    {structuredSymptoms.riskFactors.length >
                                      0 && (
                                      <div>
                                        <p className="text-xs font-black uppercase tracking-wide text-foreground/75 mb-2">
                                          Risk Factors
                                        </p>
                                        <div className="flex flex-wrap gap-1.5">
                                          {structuredSymptoms.riskFactors.map(
                                            (r, i) => (
                                              <span
                                                key={i}
                                                className="inline-flex items-center text-[11px] bg-rose-500/8 border border-rose-500/15 text-rose-300 rounded-full px-2.5 py-1"
                                              >
                                                {r}
                                              </span>
                                            ),
                                          )}
                                        </div>
                                      </div>
                                    )}
                                    <div className="flex flex-wrap gap-x-6 gap-y-2">
                                      {structuredSymptoms.duration && (
                                        <div className="text-sm">
                                          <span className="text-foreground/70">
                                            Duration:{" "}
                                          </span>
                                          <span className="font-semibold">
                                            {structuredSymptoms.duration}
                                          </span>
                                        </div>
                                      )}
                                      {structuredSymptoms.onset && (
                                        <div className="text-sm">
                                          <span className="text-foreground/70">
                                            Onset:{" "}
                                          </span>
                                          <span className="font-semibold">
                                            {structuredSymptoms.onset}
                                          </span>
                                        </div>
                                      )}
                                      {structuredSymptoms.severity && (
                                        <div className="text-sm">
                                          <span className="text-foreground/70">
                                            Severity:{" "}
                                          </span>
                                          <span className="font-semibold">
                                            {structuredSymptoms.severity}
                                          </span>
                                        </div>
                                      )}
                                    </div>
                                    {structuredSymptoms.medicalHistory.length >
                                      0 && (
                                      <div>
                                        <p className="text-xs font-black uppercase tracking-wide text-foreground/75 mb-2">
                                          Medical History
                                        </p>
                                        <div className="flex flex-wrap gap-1.5">
                                          {structuredSymptoms.medicalHistory.map(
                                            (h, i) => (
                                              <span
                                                key={i}
                                                className="inline-flex text-xs bg-muted/10 border border-border/20 text-foreground/75 rounded-full px-2.5 py-1"
                                              >
                                                {h}
                                              </span>
                                            ),
                                          )}
                                        </div>
                                      </div>
                                    )}
                                    {/* all fields empty fallback */}
                                    {!structuredSymptoms.chiefComplaint &&
                                      structuredSymptoms.symptoms.length ===
                                        0 &&
                                      structuredSymptoms.riskFactors.length ===
                                        0 && (
                                        <p className="text-sm text-foreground/70 italic">
                                          Symptom details not available in
                                          structured form.
                                        </p>
                                      )}
                                  </div>
                                </div>

                                {/* ECG */}
                                {ecgFields.length > 0 && (
                                  <div>
                                    <div className="flex items-center gap-2 mb-3">
                                      <div className="h-6 w-6 rounded-lg bg-violet-500/10 flex items-center justify-center">
                                        <Activity className="h-3.5 w-3.5 text-violet-400" />
                                      </div>
                                      <span className="text-sm font-black uppercase tracking-[0.12em] text-foreground/75">
                                        ECG Findings
                                      </span>
                                    </div>
                                    <div className="rounded-xl border border-border/15 overflow-hidden">
                                      {ecgFields.map((f, i) => (
                                        <div
                                          key={i}
                                          className={`flex items-center justify-between px-4 py-2.5 ${i % 2 === 0 ? "bg-white/1" : ""}`}
                                        >
                                          <span className="text-sm text-foreground/70">
                                            {f.label}
                                          </span>
                                          <span className="text-sm font-semibold">
                                            {f.value}
                                          </span>
                                        </div>
                                      ))}
                                    </div>
                                  </div>
                                )}

                                {/* Labs inline */}
                                {labFields.length > 0 && (
                                  <div>
                                    <div className="flex items-center gap-2 mb-3">
                                      <div className="h-6 w-6 rounded-lg bg-cyan-500/10 flex items-center justify-center">
                                        <Microscope className="h-3.5 w-3.5 text-cyan-400" />
                                      </div>
                                      <span className="text-sm font-black uppercase tracking-[0.12em] text-foreground/75">
                                        Lab Values
                                      </span>
                                    </div>
                                    <div className="rounded-xl border border-border/15 overflow-hidden">
                                      {labFields.map((f, i) => (
                                        <div
                                          key={i}
                                          className={`flex items-center justify-between px-4 py-2.5 ${i % 2 === 0 ? "bg-white/1" : ""}`}
                                        >
                                          <span className="text-sm text-foreground/70">
                                            {f.label}
                                          </span>
                                          <span className="text-sm font-semibold font-mono">
                                            {f.value}
                                          </span>
                                        </div>
                                      ))}
                                    </div>
                                  </div>
                                )}
                              </div>

                              {/* Right: AI Diagnosis */}
                              <div className="p-5">
                                <div className="flex items-center gap-2 mb-3">
                                  <div className="h-6 w-6 rounded-lg bg-primary/10 flex items-center justify-center">
                                    <BrainCircuit className="h-3.5 w-3.5 text-primary" />
                                  </div>
                                  <span className="text-sm font-black uppercase tracking-[0.12em] text-foreground/75">
                                    AI Diagnosis
                                  </span>
                                </div>

                                {hasDiagnosisOutput ? (
                                  <div className="space-y-3">
                                    {hasDualModeOutput && (
                                      <div className="rounded-xl border border-border/15 p-2 bg-white/2">
                                        <div className="inline-flex rounded-lg border border-border/20 overflow-hidden">
                                          <button
                                            type="button"
                                            onClick={() =>
                                              selectOraMode(
                                                record.payload_id,
                                                "seasoned",
                                              )
                                            }
                                            className={`px-3 py-1.5 text-xs font-black uppercase tracking-wide transition-colors ${
                                              selectedMode === "seasoned"
                                                ? "bg-primary text-primary-foreground"
                                                : "text-muted-foreground hover:bg-white/5"
                                            }`}
                                          >
                                            Seasoned
                                          </button>
                                          <button
                                            type="button"
                                            onClick={() =>
                                              selectOraMode(
                                                record.payload_id,
                                                "newbie",
                                              )
                                            }
                                            className={`px-3 py-1.5 text-xs font-black uppercase tracking-wide transition-colors ${
                                              selectedMode === "newbie"
                                                ? "bg-primary text-primary-foreground"
                                                : "text-muted-foreground hover:bg-white/5"
                                            }`}
                                          >
                                            Newbie
                                          </button>
                                        </div>
                                      </div>
                                    )}

                                    {diagnosisSections.length > 0 ? (
                                      diagnosisSections.map((section, i) => (
                                        <div
                                          key={i}
                                          className="rounded-xl border border-border/15 overflow-hidden"
                                        >
                                          <div className="flex items-center gap-2 px-4 py-2.5 bg-primary/4 border-b border-border/10">
                                            <HeartPulse className="h-3 w-3 text-primary" />
                                            <span className="text-sm font-black text-primary/85">
                                              {section.heading}
                                            </span>
                                          </div>

                                          {/* Markdown table -> HTML table */}
                                          {section.isTable ? (
                                            (() => {
                                              const { headers, rows } =
                                                parseMdTable(section.content);
                                              const confidenceIdx =
                                                headers.findIndex((h) =>
                                                  /confidence/i.test(h),
                                                );
                                              const severityIdx =
                                                headers.findIndex((h) =>
                                                  /severity/i.test(h),
                                                );
                                              return (
                                                <div className="overflow-x-auto">
                                                  <table className="w-full text-sm">
                                                    <thead>
                                                      <tr className="border-b border-border/10">
                                                        {headers.map(
                                                          (h, hi) => (
                                                            <th
                                                              key={hi}
                                                              className="px-3 py-2 text-left text-xs font-black uppercase tracking-wide text-foreground/70"
                                                            >
                                                              {h}
                                                            </th>
                                                          ),
                                                        )}
                                                      </tr>
                                                    </thead>
                                                    <tbody>
                                                      {rows.map((row, ri) => (
                                                        <tr
                                                          key={ri}
                                                          className={`border-b border-border/6 last:border-0 ${ri % 2 === 0 ? "" : "bg-white/1"}`}
                                                        >
                                                          {row.map(
                                                            (cell, ci) => {
                                                              if (
                                                                ci ===
                                                                severityIdx
                                                              ) {
                                                                return (
                                                                  <td
                                                                    key={ci}
                                                                    className="px-3 py-2.5"
                                                                  >
                                                                    <span
                                                                      className={`inline-flex items-center text-xs font-bold border rounded-full px-2 py-0.5 ${severityColor(cell)}`}
                                                                    >
                                                                      {cell}
                                                                    </span>
                                                                  </td>
                                                                );
                                                              }
                                                              if (
                                                                ci ===
                                                                confidenceIdx
                                                              ) {
                                                                const pct =
                                                                  confidenceBar(
                                                                    cell,
                                                                  );
                                                                return (
                                                                  <td
                                                                    key={ci}
                                                                    className="px-3 py-2.5"
                                                                  >
                                                                    {pct !==
                                                                    null ? (
                                                                      <div className="flex items-center gap-2 min-w-16">
                                                                        <div className="flex-1 h-1.5 rounded-full bg-border/20 overflow-hidden">
                                                                          <div
                                                                            className="h-full rounded-full bg-primary"
                                                                            style={{
                                                                              width: `${pct * 100}%`,
                                                                            }}
                                                                          />
                                                                        </div>
                                                                        <span className="text-xs font-bold text-primary shrink-0">
                                                                          {Math.round(
                                                                            pct *
                                                                              100,
                                                                          )}
                                                                          %
                                                                        </span>
                                                                      </div>
                                                                    ) : (
                                                                      <span>
                                                                        {cell}
                                                                      </span>
                                                                    )}
                                                                  </td>
                                                                );
                                                              }
                                                              return (
                                                                <td
                                                                  key={ci}
                                                                  className="px-3 py-2.5 text-foreground/90 leading-relaxed"
                                                                >
                                                                  {ci === 1 ? (
                                                                    <span className="font-semibold text-foreground">
                                                                      {cell}
                                                                    </span>
                                                                  ) : (
                                                                    cell
                                                                  )}
                                                                </td>
                                                              );
                                                            },
                                                          )}
                                                        </tr>
                                                      ))}
                                                    </tbody>
                                                  </table>
                                                </div>
                                              );
                                            })()
                                          ) : section.isBullets ? (
                                            /* Bullet list section */
                                            <div className="px-4 py-3 space-y-1.5">
                                              {section.content
                                                .split("\n")
                                                .map((line, li) => {
                                                  const indented =
                                                    /^\s+[\*\-]/.test(line);
                                                  const isBullet =
                                                    /^[\*\-]\s/.test(
                                                      line.trim(),
                                                    );
                                                  if (!isBullet && !line.trim())
                                                    return null;
                                                  if (!isBullet)
                                                    return (
                                                      <p
                                                        key={li}
                                                        className="text-sm text-foreground/80 leading-relaxed"
                                                      >
                                                        {renderInline(
                                                          line.trim(),
                                                        )}
                                                      </p>
                                                    );
                                                  const txt = line.replace(
                                                    /^\s*[\*\-]\s/,
                                                    "",
                                                  );
                                                  return (
                                                    <div
                                                      key={li}
                                                      className={`flex gap-2 ${indented ? "pl-4" : ""}`}
                                                    >
                                                      <span
                                                        className={`mt-1.5 shrink-0 rounded-full ${indented ? "h-1 w-1 bg-muted-foreground/40" : "h-1.5 w-1.5 bg-primary/60"}`}
                                                      />
                                                      <p className="text-sm text-foreground/85 leading-relaxed">
                                                        {renderInline(txt)}
                                                      </p>
                                                    </div>
                                                  );
                                                })}
                                            </div>
                                          ) : (
                                            /* Plain text section */
                                            <div className="px-4 py-3">
                                              <p className="text-sm text-foreground/85 leading-relaxed whitespace-pre-wrap">
                                                {section.content}
                                              </p>
                                            </div>
                                          )}
                                        </div>
                                      ))
                                    ) : (
                                      <div className="rounded-xl border border-border/15 p-4">
                                        <pre className="text-sm text-foreground/85 leading-relaxed whitespace-pre-wrap font-sans">
                                          {selectedOutput}
                                        </pre>
                                      </div>
                                    )}

                                    {selectedDisclaimer && (
                                      <div className="flex items-start gap-2 p-3 rounded-xl bg-amber-500/5 border border-amber-500/15">
                                        <AlertTriangle className="h-3.5 w-3.5 text-amber-400 mt-0.5 shrink-0" />
                                        <p className="text-xs text-amber-700 dark:text-amber-300 leading-relaxed">
                                          {selectedDisclaimer}
                                        </p>
                                      </div>
                                    )}
                                  </div>
                                ) : (
                                  <div className="flex items-center justify-center h-24 rounded-xl border border-dashed border-border/20">
                                    <p className="text-xs text-muted-foreground/50">
                                      No diagnosis output
                                    </p>
                                  </div>
                                )}
                              </div>
                            </div>
                          </div>
                        )}
                      </CardContent>
                    </Card>
                  </div>
                );
              })}
            </div>
          </div>
        ))}

      {/* Tab section */}
      {activeTab === "labs" &&
        (labHistory.length === 0 ? (
          <Card className="glass border-border/20 border-dashed rounded-4xl">
            <CardContent className="p-12 text-center">
              <div className="h-16 w-16 rounded-2xl bg-muted/10 flex items-center justify-center mx-auto mb-4">
                <FlaskConical className="h-8 w-8 text-muted-foreground/40" />
              </div>
              <h4 className="text-lg font-bold text-muted-foreground mb-2">
                No Lab Records
              </h4>
              <p className="text-sm text-muted-foreground/60">
                No laboratory tests have been recorded for this patient.
              </p>
            </CardContent>
          </Card>
        ) : (
          <div className="space-y-3">
            {labHistory.map((lab, idx) => {
              const isExpanded = expandedLabId === lab._id;
              const abnormalCount =
                lab.labComparison?.filter((i) => i.status !== "Normal")
                  .length ?? 0;
              const normalCount =
                lab.labComparison?.filter((i) => i.status === "Normal")
                  .length ?? 0;

              return (
                <Card
                  key={lab._id}
                  className={`glass border-border/20 rounded-3xl overflow-hidden transition-all duration-200 ${
                    isExpanded
                      ? "border-cyan-500/25 shadow-lg shadow-cyan-500/5"
                      : "hover:border-border/40"
                  }`}
                >
                  <CardContent className="p-0">
                    <button
                      onClick={() => toggleLabExpand(lab._id)}
                      className="w-full flex items-center gap-4 p-5 text-left hover:bg-white/2 transition-colors"
                    >
                      <div className="h-10 w-10 rounded-xl bg-cyan-500/10 flex items-center justify-center shrink-0">
                        <FlaskConical className="h-5 w-5 text-cyan-400" />
                      </div>
                      <div className="flex-1 min-w-0">
                        <div className="flex flex-wrap items-center gap-2 mb-1">
                          <span className="text-sm font-bold flex items-center gap-1.5">
                            <CalendarDays className="h-3.5 w-3.5 text-muted-foreground" />
                            {lab.testDate
                              ? formatDate(lab.testDate)
                              : `Lab Test #${labHistory.length - idx}`}
                          </span>
                        </div>
                        {lab.labComparison && (
                          <div className="flex items-center gap-3 mt-1">
                            <span className="text-[10px] text-muted-foreground">
                              {lab.labComparison.length} markers
                            </span>
                            {normalCount > 0 && (
                              <span className="inline-flex items-center gap-1 text-[10px] text-emerald-400">
                                <TrendingUp className="h-3 w-3" /> {normalCount}{" "}
                                Normal
                              </span>
                            )}
                            {abnormalCount > 0 && (
                              <span className="inline-flex items-center gap-1 text-[10px] text-rose-400">
                                <TrendingDown className="h-3 w-3" />{" "}
                                {abnormalCount} Abnormal
                              </span>
                            )}
                          </div>
                        )}
                      </div>
                      <div
                        className={`p-1.5 rounded-lg transition-colors shrink-0 ${isExpanded ? "bg-cyan-500/10 text-cyan-400" : "text-muted-foreground"}`}
                      >
                        {isExpanded ? (
                          <ChevronUp className="h-4 w-4" />
                        ) : (
                          <ChevronDown className="h-4 w-4" />
                        )}
                      </div>
                    </button>

                    {isExpanded && lab.labComparison && (
                      <div className="border-t border-border/10 p-5 bg-white/1">
                        <div className="rounded-xl border border-border/15 overflow-hidden">
                          {/* Table header */}
                          <div className="grid grid-cols-4 px-4 py-2.5 bg-muted/10 border-b border-border/10">
                            <span className="text-[10px] font-black uppercase tracking-[0.15em] text-muted-foreground">
                              Test
                            </span>
                            <span className="text-[10px] font-black uppercase tracking-[0.15em] text-muted-foreground text-center">
                              Value
                            </span>
                            <span className="text-[10px] font-black uppercase tracking-[0.15em] text-muted-foreground text-center">
                              Normal Range
                            </span>
                            <span className="text-[10px] font-black uppercase tracking-[0.15em] text-muted-foreground text-right">
                              Status
                            </span>
                          </div>
                          {lab.labComparison.map((item, i) => {
                            const isNormal = item.status === "Normal";
                            const testText = formatDisplayValue(item.test);
                            const actualValueText = formatDisplayValue(
                              item.actualValue,
                            );
                            const normalRangeText = formatDisplayValue(
                              item.normalRange,
                            );
                            const statusText = formatDisplayValue(item.status);
                            return (
                              <div
                                key={i}
                                className={`grid grid-cols-4 items-center px-4 py-3 border-b border-border/6 last:border-0 ${
                                  i % 2 === 0 ? "" : "bg-white/1"
                                } ${!isNormal ? "bg-rose-500/2" : ""}`}
                              >
                                <span className="text-xs font-semibold">
                                  {testText}
                                </span>
                                <span
                                  className={`text-xs font-mono text-center font-bold ${!isNormal ? "text-rose-400" : "text-foreground/80"}`}
                                >
                                  {actualValueText}
                                </span>
                                <span className="text-xs text-muted-foreground text-center font-mono">
                                  {normalRangeText}
                                </span>
                                <div className="flex justify-end">
                                  <Badge
                                    className={
                                      isNormal
                                        ? "bg-emerald-500/10 text-emerald-400 border-emerald-500/20 text-[9px] gap-1"
                                        : "bg-rose-500/10 text-rose-400 border-rose-500/20 text-[9px] gap-1"
                                    }
                                  >
                                    {isNormal ? (
                                      <TrendingUp className="h-2.5 w-2.5" />
                                    ) : (
                                      <TrendingDown className="h-2.5 w-2.5" />
                                    )}
                                    {statusText}
                                  </Badge>
                                </div>
                              </div>
                            );
                          })}
                        </div>
                      </div>
                    )}
                  </CardContent>
                </Card>
              );
            })}
          </div>
        ))}

      {/* Tab section */}
      {activeTab === "summary" &&
        (() => {
          const summarySections = parseDiagnosisOutput(
            cleanDiagnosisOutput(historySummary?.summary_text ?? ""),
          );
          return (
            <div className="space-y-4">
              {/* Stat cards */}
              <div className="grid grid-cols-3 gap-3">
                {[
                  {
                    label: "Total Visits",
                    value:
                      historySummary?.visit_count ?? diagnosisHistory.length,
                    icon: <CalendarDays className="h-5 w-5 text-primary" />,
                    color: "bg-primary/10",
                  },
                  {
                    label: "Conditions Tracked",
                    value: historySummary?.top_conditions?.length ?? 0,
                    icon: <Stethoscope className="h-5 w-5 text-amber-400" />,
                    color: "bg-amber-500/10",
                  },
                  {
                    label: "Lab Findings",
                    value: historySummary?.key_lab_findings?.length ?? 0,
                    icon: <FlaskConical className="h-5 w-5 text-cyan-400" />,
                    color: "bg-cyan-500/10",
                  },
                ].map((stat, i) => (
                  <Card key={i} className="glass border-border/20 rounded-2xl">
                    <CardContent className="p-4 flex items-center gap-3">
                      <div
                        className={`h-10 w-10 rounded-xl flex items-center justify-center shrink-0 ${stat.color}`}
                      >
                        {stat.icon}
                      </div>
                      <div>
                        <p className="text-xl font-black">{stat.value}</p>
                        <p className="text-xs text-foreground/70 uppercase tracking-wide">
                          {stat.label}
                        </p>
                      </div>
                    </CardContent>
                  </Card>
                ))}
              </div>

              {/* Longitudinal AI Summary  rich rendered */}
              <Card className="glass border-border/20 rounded-3xl">
                <CardContent className="p-6 space-y-4">
                  <div className="flex items-center gap-2">
                    <div className="h-7 w-7 rounded-xl bg-primary/10 flex items-center justify-center">
                      <BrainCircuit className="h-4 w-4 text-primary" />
                    </div>
                    <span className="text-sm font-black uppercase tracking-[0.18em] text-foreground/75">
                      Longitudinal AI Summary
                    </span>
                    <Badge variant="secondary" className="text-xs ml-auto">
                      For KRA Reasoning
                    </Badge>
                  </div>

                  {summarySections.length > 0 ? (
                    <div className="space-y-3">
                      {summarySections.map((section, i) => (
                        <div
                          key={i}
                          className="rounded-xl border border-border/15 overflow-hidden"
                        >
                          <div className="flex items-center gap-2 px-4 py-2.5 bg-primary/4 border-b border-border/10">
                            <HeartPulse className="h-3 w-3 text-primary" />
                            <span className="text-sm font-black text-primary/85">
                              {section.heading}
                            </span>
                          </div>
                          {section.isTable ? (
                            (() => {
                              const { headers, rows } = parseMdTable(
                                section.content,
                              );
                              const confidenceIdx = headers.findIndex((h) =>
                                /confidence/i.test(h),
                              );
                              const severityIdx = headers.findIndex((h) =>
                                /severity/i.test(h),
                              );
                              return (
                                <div className="overflow-x-auto">
                                  <table className="w-full text-sm">
                                    <thead>
                                      <tr className="border-b border-border/10">
                                        {headers.map((h, hi) => (
                                          <th
                                            key={hi}
                                            className="px-3 py-2 text-left text-xs font-black uppercase tracking-wider text-foreground/70"
                                          >
                                            {h}
                                          </th>
                                        ))}
                                      </tr>
                                    </thead>
                                    <tbody>
                                      {rows.map((row, ri) => (
                                        <tr
                                          key={ri}
                                          className={`border-b border-border/6 last:border-0 ${ri % 2 === 0 ? "" : "bg-white/1"}`}
                                        >
                                          {row.map((cell, ci) => {
                                            if (ci === severityIdx)
                                              return (
                                                <td
                                                  key={ci}
                                                  className="px-3 py-2.5"
                                                >
                                                  <span
                                                    className={`inline-flex items-center text-xs font-bold border rounded-full px-2.5 py-1 ${severityColor(cell)}`}
                                                  >
                                                    {cell}
                                                  </span>
                                                </td>
                                              );
                                            if (ci === confidenceIdx) {
                                              const pct = confidenceBar(cell);
                                              return (
                                                <td
                                                  key={ci}
                                                  className="px-3 py-2.5"
                                                >
                                                  {pct !== null ? (
                                                    <div className="flex items-center gap-2 min-w-16">
                                                      <div className="flex-1 h-1.5 rounded-full bg-border/20 overflow-hidden">
                                                        <div
                                                          className="h-full rounded-full bg-primary"
                                                          style={{
                                                            width: `${pct * 100}%`,
                                                          }}
                                                        />
                                                      </div>
                                                      <span className="text-xs font-bold text-primary shrink-0">
                                                        {Math.round(pct * 100)}%
                                                      </span>
                                                    </div>
                                                  ) : (
                                                    <span>{cell}</span>
                                                  )}
                                                </td>
                                              );
                                            }
                                            return (
                                              <td
                                                key={ci}
                                                className="px-3 py-2.5 text-foreground/80 leading-relaxed"
                                              >
                                                {ci === 1 ? (
                                                  <span className="font-semibold text-foreground">
                                                    {cell}
                                                  </span>
                                                ) : (
                                                  cell
                                                )}
                                              </td>
                                            );
                                          })}
                                        </tr>
                                      ))}
                                    </tbody>
                                  </table>
                                </div>
                              );
                            })()
                          ) : section.isBullets ? (
                            <div className="px-4 py-3 space-y-1.5">
                              {section.content.split("\n").map((line, li) => {
                                const indented = /^\s+[\*\-]/.test(line);
                                const isBullet = /^[\*\-]\s/.test(line.trim());
                                if (!isBullet && !line.trim()) return null;
                                if (!isBullet)
                                  return (
                                    <p
                                      key={li}
                                      className="text-sm text-foreground/75 leading-relaxed"
                                    >
                                      {renderInline(line.trim())}
                                    </p>
                                  );
                                const txt = line.replace(/^\s*[\*\-]\s/, "");
                                return (
                                  <div
                                    key={li}
                                    className={`flex gap-2 ${indented ? "pl-4" : ""}`}
                                  >
                                    <span
                                      className={`mt-1.5 shrink-0 rounded-full ${indented ? "h-1 w-1 bg-muted-foreground/40" : "h-1.5 w-1.5 bg-primary/60"}`}
                                    />
                                    <p className="text-sm text-foreground/85 leading-relaxed">
                                      {renderInline(txt)}
                                    </p>
                                  </div>
                                );
                              })}
                            </div>
                          ) : (
                            <div className="px-4 py-3">
                              <p className="text-sm text-foreground/85 leading-relaxed whitespace-pre-wrap">
                                {section.content}
                              </p>
                            </div>
                          )}
                        </div>
                      ))}
                    </div>
                  ) : (
                    <div className="rounded-xl border border-border/15 bg-white/2 p-5">
                      <p className="text-sm text-foreground/85 leading-relaxed">
                        {cleanDiagnosisOutput(historySummary?.summary_text ?? "") ||
                          "No prior AI diagnosis or lab history available for this patient."}
                      </p>
                    </div>
                  )}
                </CardContent>
              </Card>

              {/* Conditions + Lab findings */}
              <div className="grid gap-4 md:grid-cols-2">
                <Card className="glass border-border/20 rounded-3xl">
                  <CardContent className="p-6 space-y-4">
                    <div className="flex items-center gap-2">
                      <div className="h-6 w-6 rounded-lg bg-amber-500/10 flex items-center justify-center">
                        <Stethoscope className="h-3.5 w-3.5 text-amber-400" />
                      </div>
                      <span className="text-[11px] font-black uppercase tracking-[0.18em] text-muted-foreground">
                        Prior Conditions
                      </span>
                    </div>
                    {historySummary?.top_conditions?.length ? (
                      <div className="space-y-1.5">
                        {historySummary.top_conditions.map((condition, i) => (
                          <div
                            key={i}
                            className="flex items-center gap-2 p-2.5 rounded-lg bg-amber-500/5 border border-amber-500/10"
                          >
                            <span className="h-1.5 w-1.5 rounded-full bg-amber-400 shrink-0" />
                              <span className="text-xs font-semibold text-foreground/85">
                              {formatDisplayValue(condition)}
                            </span>
                          </div>
                        ))}
                      </div>
                    ) : (
                      <p className="text-xs text-muted-foreground/60 italic">
                        No recurrent conditions captured yet.
                      </p>
                    )}
                  </CardContent>
                </Card>

                <Card className="glass border-border/20 rounded-3xl">
                  <CardContent className="p-6 space-y-4">
                    <div className="flex items-center gap-2">
                      <div className="h-6 w-6 rounded-lg bg-cyan-500/10 flex items-center justify-center">
                        <FlaskConical className="h-3.5 w-3.5 text-cyan-400" />
                      </div>
                      <span className="text-[11px] font-black uppercase tracking-[0.18em] text-muted-foreground">
                        Key Lab Findings
                      </span>
                    </div>
                    {historySummary?.key_lab_findings?.length ? (
                      <div className="space-y-1.5">
                        {historySummary.key_lab_findings.map((finding, i) => (
                          <div
                            key={i}
                            className="flex items-center gap-2 p-2.5 rounded-lg bg-cyan-500/5 border border-cyan-500/10"
                          >
                            <Minus className="h-3 w-3 text-cyan-400 shrink-0" />
                              <span className="text-xs font-semibold text-foreground/85">
                              {formatDisplayValue(finding)}
                            </span>
                          </div>
                        ))}
                      </div>
                    ) : (
                      <p className="text-xs text-muted-foreground/60 italic">
                        No persistent lab abnormalities captured yet.
                      </p>
                    )}
                  </CardContent>
                </Card>
              </div>
            </div>
          );
        })()}

      {/* Tab section */}
      {activeTab === "overview" && (
        <Card className="glass border-border/20 rounded-3xl overflow-hidden">
          <CardContent className="p-6 space-y-4">
            {/* Header */}
            <div className="flex items-center gap-2">
              <div className="h-7 w-7 rounded-xl bg-primary/10 flex items-center justify-center">
                <Network className="h-4 w-4 text-primary" />
              </div>
              <span className="text-sm font-black uppercase tracking-[0.14em] text-foreground/75">
                Patient Overview Map
              </span>
              <Badge
                variant="secondary"
                className="text-xs ml-auto text-foreground/80"
              >
                Interactive
              </Badge>
            </div>

            <p className="text-sm text-foreground/75 leading-relaxed">
              Radial overview of this patient&apos;s{" "}
              <span className="text-[#818cf8] font-semibold">symptoms</span>,{" "}
              <span className="text-[#f87171] font-semibold">diagnoses</span>,{" "}
              <span className="text-[#fbbf24] font-semibold">risk factors</span>{" "}
              and{" "}
              <span className="text-[#22d3ee] font-semibold">lab findings</span>
              . Click any hub or node ΓÇö details appear on the right.
            </p>

            {/* Legend */}
            <div className="flex flex-wrap gap-3">
              {[
                { label: "Symptoms", color: "#818cf8" },
                { label: "Diagnoses", color: "#f87171" },
                { label: "Risk Factors", color: "#fbbf24" },
                { label: "Lab Findings", color: "#22d3ee" },
              ].map(({ label, color }) => (
                <div key={label} className="flex items-center gap-1.5">
                  <span
                    className="h-2.5 w-2.5 rounded-full shrink-0"
                    style={{ backgroundColor: color }}
                  />
                  <span className="text-sm font-semibold text-foreground/75">
                    {label}
                  </span>
                </div>
              ))}
            </div>

            {/* Chart */}
            <div className="rounded-2xl border border-border/15 bg-white/1 overflow-hidden p-2">
              <DiagnosisOverviewChart
                diagnosisHistory={diagnosisHistory}
                historySummary={historySummary}
                patient={patient}
              />
            </div>
          </CardContent>
        </Card>
      )}
    </div>
  );
}
