"use client";

import { useState, useRef, useEffect, useCallback } from "react";
import {
  Microscope,
  Upload,
  X,
  CheckCircle,
  Loader2,
  AlertCircle,
  ClipboardList,
  ChevronRight,
  FileText,
  ZoomIn,
  ZoomOut,
  Activity,
  BarChart2,
  TrendingUp,
  TrendingDown,
  Minus,
  Plus,
  Brain,
  Calendar,
  Layers,
  ArrowRight,
  Sparkles,
  Target,
  AlertTriangle,
} from "lucide-react";
import { Card, CardContent } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { toast } from "sonner";
import {
  LabOrchestratorService,
  type OrchestratorStepKey,
  type OrchestratorFinalResult,
} from "@/services/LabOrchestratorService";
import DiagnosticButtons from "./DiagnosticButtons";

// ─── Types ────────────────────────────────────────────────────────────────────

interface LabComparisonItem {
  test: string;
  actualValue: number | string;
  normalRange: string;
  status: "Normal" | "High" | "Low";
}

export interface LabAnalysisResult {
  isMedical: boolean;
  summary: string;
  patientInfo?: { age?: number | null; gender?: string | null };
  labComparison: LabComparisonItem[];
  recommendedTests: string[];
  extractedJsonGroup1?: Record<string, any>;
  extractedJsonGroup2?: Record<string, any>;
  dailyHealthAdvice?: string[];
}

interface LabSession {
  id: string;
  file: File;
  preview: string;
  result: LabAnalysisResult | null;
  analyzing: boolean;
  error: string | null;
  label: string; // e.g. "Report 1", "Report 2"
  uploadDate: Date;
  backendReportId?: string | null;
  ocrJobId?: string | null;
}

interface TrendPoint {
  test: string;
  values: {
    sessionLabel: string;
    value: number | string;
    status: string;
    date: Date;
  }[];
  trend: "improving" | "worsening" | "stable" | "mixed";
}

interface PredictiveInsight {
  title: string;
  description: string;
  urgency: "low" | "medium" | "high";
  tests: string[];
  basedOn: string[];
}

interface LabSuggesterProps {
  patientContext?: string;
  patientName?: string;
  onAnalysisComplete?: (result: LabAnalysisResult) => void;
  initialResult?: LabAnalysisResult;
  patientId?: string;
  isLoggedIn?: boolean;
  onRiskResults?: (diabeticResult: any, heartResult: any) => void;
}

// ─── Constants ────────────────────────────────────────────────────────────────

const GEMINI_API_KEY = process.env.NEXT_PUBLIC_GEMINI_API_KEY ?? "";

const MULTI_ANALYSIS_PROMPT = (summaries: string) => `
You are a medical AI that analyzes TRENDS across multiple lab reports over time.

Given these lab report summaries from multiple reports (ordered oldest to newest):

${summaries}

Your job is to:
1. Identify which values are consistently abnormal across reports
2. Identify which abnormal values are worsening over time
3. Identify which values are improving
4. Based on the TREND PATTERN, predict which tests should be prioritized in the FUTURE

Respond ONLY in valid JSON:

{
  "overallTrend": "improving" | "worsening" | "stable" | "mixed",
  "overallSummary": "string - 2-3 sentence narrative about the patient's health trajectory",
  "persistentAbnormalities": [
    {
      "test": "string",
      "pattern": "string - e.g. consistently high, gradually increasing",
      "riskLevel": "low" | "medium" | "high"
    }
  ],
  "improvingValues": ["string"],
  "worseningValues": ["string"],
  "predictiveInsights": [
    {
      "title": "string",
      "description": "string - why this is predicted",
      "urgency": "low" | "medium" | "high",
      "tests": ["string - specific test recommendations"],
      "basedOn": ["string - which abnormal values drive this prediction"],
      "timeframe": "string - e.g. within 3 months, within 6 months"
    }
  ],
  "lifestylePriorities": ["string - top 3-5 actions based on trends"]
}
`;

const STATUS_CONFIG = {
  Normal: {
    badge: "text-emerald-400 bg-emerald-400/10 border-emerald-400/20",
    row: "hover:bg-emerald-500/5",
    bar: "bg-emerald-400",
  },
  High: {
    badge: "text-rose-400 bg-rose-400/10 border-rose-400/20",
    row: "hover:bg-rose-500/5",
    bar: "bg-rose-400",
  },
  Low: {
    badge: "text-amber-400 bg-amber-400/10 border-amber-400/20",
    row: "hover:bg-amber-500/5",
    bar: "bg-amber-400",
  },
};

const URGENCY_CONFIG = {
  low: {
    color: "text-emerald-400",
    bg: "bg-emerald-400/10 border-emerald-400/20",
    icon: "🟢",
  },
  medium: {
    color: "text-amber-400",
    bg: "bg-amber-400/10 border-amber-400/20",
    icon: "🟡",
  },
  high: {
    color: "text-rose-400",
    bg: "bg-rose-400/10 border-rose-400/20",
    icon: "🔴",
  },
};

const ORCHESTRATION_STEP_ORDER: OrchestratorStepKey[] = [
  "ocr_extraction",
  "risk_models",
  "save_lab_reports",
  "create_lab_agent_job",
  "run_lab_agent_analysis",
];

const ORCHESTRATION_STEP_LABELS: Record<OrchestratorStepKey, string> = {
  ocr_extraction: "OCR + Report Extraction",
  risk_models: "Diabetic + Heart Models",
  save_lab_reports: "Persist Lab Reports",
  create_lab_agent_job: "Create Lab-Agent Job",
  run_lab_agent_analysis: "Run Job Analyze",
};

// ─── Helpers ──────────────────────────────────────────────────────────────────

const conversionFactors: Record<string, number> = {
  Chol: 0.0259,
  TG: 0.0113,
  HDL: 0.0259,
  LDL: 0.0259,
  Cr: 88.4,
  BUN: 0.357,
};

function convertFormDataToMmolL(
  data: Record<string, any>,
): Record<string, any> {
  const converted: Record<string, any> = { ...data };
  for (const key of Object.keys(conversionFactors)) {
    const val = Number(data[key]);
    if (!isNaN(val) && val !== 0) {
      converted[key] = parseFloat((val * conversionFactors[key]).toFixed(2));
    }
  }
  return converted;
}

function buildTrends(sessions: LabSession[]): TrendPoint[] {
  const done = sessions.filter((s) => s.result);
  if (done.length < 2) return [];

  const testMap: Record<string, TrendPoint["values"]> = {};
  done.forEach((s) => {
    s.result!.labComparison.forEach((item) => {
      if (!testMap[item.test]) testMap[item.test] = [];
      testMap[item.test].push({
        sessionLabel: s.label,
        value: item.actualValue,
        status: item.status,
        date: s.uploadDate,
      });
    });
  });

  return Object.entries(testMap)
    .filter(([, vals]) => vals.length >= 2)
    .map(([test, values]) => {
      const statuses = values.map((v) => v.status);
      const abnormals = statuses.filter((s) => s !== "Normal").length;
      const firstAbnormal = statuses[0] !== "Normal";
      const lastAbnormal = statuses[statuses.length - 1] !== "Normal";

      let trend: TrendPoint["trend"] = "stable";
      if (firstAbnormal && !lastAbnormal) trend = "improving";
      else if (!firstAbnormal && lastAbnormal) trend = "worsening";
      else if (abnormals === values.length && values.length > 1)
        trend = "worsening";
      else if (abnormals > 0) trend = "mixed";

      return { test, values, trend };
    });
}

// ─── Mini Sparkline component ─────────────────────────────────────────────────

function TrendSparkline({ values }: { values: TrendPoint["values"] }) {
  const nums = values
    .map((v) => parseFloat(String(v.value)))
    .filter((n) => !isNaN(n));
  if (nums.length < 2)
    return <span className="text-muted-foreground/30 text-xs">—</span>;

  const min = Math.min(...nums);
  const max = Math.max(...nums);
  const range = max - min || 1;
  const w = 80;
  const h = 28;
  const pts = nums.map((n, i) => {
    const x = (i / (nums.length - 1)) * w;
    const y = h - ((n - min) / range) * h;
    return `${x},${y}`;
  });

  const trendColor =
    nums[nums.length - 1] > nums[0]
      ? "#f87171"
      : nums[nums.length - 1] < nums[0]
      ? "#34d399"
      : "#94a3b8";

  return (
    <svg
      width={w}
      height={h}
      viewBox={`0 0 ${w} ${h}`}
      className="overflow-visible"
    >
      <polyline
        points={pts.join(" ")}
        fill="none"
        stroke={trendColor}
        strokeWidth="2"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
      {pts.map((pt, i) => {
        const [x, y] = pt.split(",").map(Number);
        return (
          <circle
            key={i}
            cx={x}
            cy={y}
            r="2.5"
            fill={trendColor}
            opacity={i === pts.length - 1 ? 1 : 0.5}
          />
        );
      })}
    </svg>
  );
}

// ─── Component ────────────────────────────────────────────────────────────────

export default function LabSuggester({
  patientContext,
  patientName,
  onAnalysisComplete,
  initialResult,
  patientId,
  isLoggedIn = true,
  onRiskResults,
}: LabSuggesterProps) {
  const fileInputRef = useRef<HTMLInputElement>(null);
  const [sessions, setSessions] = useState<LabSession[]>([]);
  const [activeSessionId, setActiveSessionId] = useState<string | null>(null);
  const [imageZoomed, setImageZoomed] = useState(false);
  const [multiAnalyzing, setMultiAnalyzing] = useState(false);
  const [multiResult, setMultiResult] = useState<any>(null);
  const [oneClickRunning, setOneClickRunning] = useState(false);
  const [activeTab, setActiveTab] = useState("comparison");
  const [diabeticAutoResult, setDiabeticAutoResult] = useState<any>(null);
  const [heartAutoResult, setHeartAutoResult] = useState<any>(null);
  const [showHistory, setShowHistory] = useState(false);
  const [diagnosticRefresh, setDiagnosticRefresh] = useState(0);
  const [orchestrationCurrentStep, setOrchestrationCurrentStep] =
    useState<OrchestratorStepKey | null>(null);
  const [orchestrationCompletedSteps, setOrchestrationCompletedSteps] =
    useState<OrchestratorStepKey[]>([]);
  const [orchestrationFailedStep, setOrchestrationFailedStep] =
    useState<OrchestratorStepKey | null>(null);
  const [orchestrationStatusText, setOrchestrationStatusText] = useState("");
  const sessionsRef = useRef<LabSession[]>([]);

  useEffect(() => {
    sessionsRef.current = sessions;
  }, [sessions]);

  // Load initialResult as first session
  useEffect(() => {
    if (!initialResult) return;
    const ghost: LabSession = {
      id: "history-" + Date.now(),
      file: null as any,
      preview: "",
      result: initialResult,
      analyzing: false,
      error: null,
      label: "History Record",
      uploadDate: new Date(),
      backendReportId: null,
      ocrJobId: null,
    };
    setSessions([ghost]);
    setActiveSessionId(ghost.id);
  }, [initialResult]);

  const activeSession = sessions.find((s) => s.id === activeSessionId) ?? null;
  const completedSessions = sessions.filter((s) => s.result);
  const trends = buildTrends(completedSessions);

  // Risk scores for active session
  useEffect(() => {
    if (!activeSession?.result) {
      setDiabeticAutoResult(null);
      setHeartAutoResult(null);
      return;
    }
    const r = activeSession.result;

    if (
      r.extractedJsonGroup1 &&
      Object.keys(r.extractedJsonGroup1).length > 0
    ) {
      fetch("https://diabetesnew-1051190728028.asia-south1.run.app", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(convertFormDataToMmolL(r.extractedJsonGroup1)),
      })
        .then((res) => res.json())
        .then((data) => {
          setDiabeticAutoResult(data);
          if (onRiskResults) onRiskResults(data, heartAutoResult);
        })
        .catch(() => setDiabeticAutoResult(null));
    }

    if (
      r.extractedJsonGroup2 &&
      Object.keys(r.extractedJsonGroup2).length > 0
    ) {
      fetch("https://cardiac-1051190728028.asia-south1.run.app", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(convertFormDataToMmolL(r.extractedJsonGroup2)),
      })
        .then((res) => res.json())
        .then((data) => {
          setHeartAutoResult(data);
          if (onRiskResults) onRiskResults(diabeticAutoResult, data);
        })
        .catch(() => setHeartAutoResult(null));
    }
  }, [activeSessionId, activeSession?.result]);

  // ── File handling ─────────────────────────────────────────────────────────

  const handleFiles = (files: FileList | null) => {
    if (!files) return;
    const arr = Array.from(files).filter((f) => f.type.startsWith("image/"));
    if (arr.length === 0) {
      toast.error("Please upload valid image files.");
      return;
    }

    const newSessions: LabSession[] = arr.map((f, i) => ({
      id: Date.now() + "-" + i,
      file: f,
      preview: "",
      result: null,
      analyzing: false,
      error: null,
      label: `Report ${sessions.length + i + 1}`,
      uploadDate: new Date(),
      backendReportId: null,
      ocrJobId: null,
    }));

    // Read previews
    newSessions.forEach((s) => {
      const reader = new FileReader();
      reader.onload = () => {
        setSessions((prev) =>
          prev.map((p) =>
            p.id === s.id ? { ...p, preview: reader.result as string } : p,
          ),
        );
      };
      reader.readAsDataURL(s.file);
    });

    setSessions((prev) => {
      const updated = [...prev, ...newSessions];
      return updated;
    });

    // Auto-select first new
    if (!activeSessionId) setActiveSessionId(newSessions[0].id);

    toast.success(`${arr.length} report${arr.length > 1 ? "s" : ""} added`);
  };

  const removeSession = (id: string) => {
    setSessions((prev) => {
      const next = prev.filter((s) => s.id !== id);
      if (activeSessionId === id) {
        setActiveSessionId(next[0]?.id ?? null);
      }
      return next;
    });
    setMultiResult(null);
  };

  const fileToBase64 = useCallback((file: File) => {
    return new Promise<string>((resolve, reject) => {
      const reader = new FileReader();
      reader.onload = () => {
        const raw = String(reader.result || "");
        const payload = raw.includes(",") ? raw.split(",", 2)[1] : raw;
        resolve(payload);
      };
      reader.onerror = reject;
      reader.readAsDataURL(file);
    });
  }, []);

  const applyOneClickResult = useCallback(
    (finalResult: OrchestratorFinalResult) => {
      const reportMap = new Map(finalResult.reports.map((report) => [report.id, report]));

      setSessions((prev) =>
        prev.map((session) => {
          const report = reportMap.get(session.id);
          if (!report) return session;

          const analyzed = report.analysis as LabAnalysisResult & {
            error?: string;
          };
          return {
            ...session,
            analyzing: false,
            error: analyzed.isMedical
              ? null
              : analyzed.error ?? "The uploaded file is not a medical report.",
            result: analyzed.isMedical ? analyzed : session.result,
            backendReportId: report.backendReportId ?? session.backendReportId ?? null,
            ocrJobId: report.ocrJobId ?? session.ocrJobId ?? null,
          };
        }),
      );

      const completed = finalResult.reports
        .map((report) => report.analysis as LabAnalysisResult)
        .filter((analysis) => analysis.isMedical);

      if (completed.length > 0) {
        const latest = completed[completed.length - 1];

        const labCompMap = new Map<string, LabComparisonItem>();
        for (const result of completed) {
          for (const item of result.labComparison ?? []) {
            labCompMap.set(item.test, item);
          }
        }
        const mergedLabComparison = Array.from(labCompMap.values());

        const mergedGroup1 = completed.reduce(
          (acc, result) => ({ ...acc, ...(result.extractedJsonGroup1 ?? {}) }),
          {} as Record<string, unknown>,
        );
        const mergedGroup2 = completed.reduce(
          (acc, result) => ({ ...acc, ...(result.extractedJsonGroup2 ?? {}) }),
          {} as Record<string, unknown>,
        );

        onAnalysisComplete?.({
          ...latest,
          labComparison: mergedLabComparison,
          extractedJsonGroup1: Object.keys(mergedGroup1).length
            ? mergedGroup1
            : latest.extractedJsonGroup1,
          extractedJsonGroup2: Object.keys(mergedGroup2).length
            ? mergedGroup2
            : latest.extractedJsonGroup2,
        });
      }

      const activeReport =
        finalResult.reports.find((report) => report.id === activeSessionId) ??
        finalResult.reports[0];
      if (activeReport) {
        setDiabeticAutoResult(activeReport.diabeticModelResult ?? null);
        setHeartAutoResult(activeReport.heartModelResult ?? null);
        onRiskResults?.(
          activeReport.diabeticModelResult ?? null,
          activeReport.heartModelResult ?? null,
        );
      }
    },
    [activeSessionId, onAnalysisComplete, onRiskResults],
  );

  const analyzeReportsOneClick = async () => {
    const resolvedPatientId = String(patientId || "").trim();

    if (sessionsRef.current.some((session) => session.analyzing)) {
      toast.info("Wait for the current lab analysis to finish first.");
      return;
    }

    const uploadSessions = sessionsRef.current.filter((session) => session.file instanceof File);
    if (uploadSessions.length === 0) {
      toast.error("Upload at least one lab report image before one-click analysis.");
      return;
    }

    setOneClickRunning(true);
    setOrchestrationFailedStep(null);
    setOrchestrationCurrentStep(null);
    setOrchestrationCompletedSteps([]);
    setOrchestrationStatusText("Preparing reports for orchestration...");

    try {
      const reports = await Promise.all(
        uploadSessions.map(async (session) => ({
          id: session.id,
          label: session.label,
          reportDate: session.uploadDate.toISOString().slice(0, 10),
          fileName: session.file.name,
          mimeType: session.file.type || "application/octet-stream",
          contentBase64: await fileToBase64(session.file),
        })),
      );

      const finalResult = await LabOrchestratorService.run(
        {
          patientId: resolvedPatientId,
          patientName,
          reports,
          options: {
            minReportsForTrend: 2,
            topK: 8,
            force: true,
            notes: "one_click_analyze_reports",
          },
        },
        {
          onStep: (event) => {
            if (event.status === "running") {
              setOrchestrationCurrentStep(event.step);
              setOrchestrationStatusText(
                event.message || `Running ${ORCHESTRATION_STEP_LABELS[event.step]}...`,
              );
              return;
            }

            setOrchestrationCompletedSteps((prev) =>
              prev.includes(event.step) ? prev : [...prev, event.step],
            );
            setOrchestrationCurrentStep((prev) =>
              prev === event.step ? null : prev,
            );
            setOrchestrationStatusText(
              event.message || `${ORCHESTRATION_STEP_LABELS[event.step]} completed.`,
            );
          },
        },
      );

      applyOneClickResult(finalResult);
      setOrchestrationCompletedSteps(ORCHESTRATION_STEP_ORDER);
      setOrchestrationCurrentStep(null);
      setOrchestrationStatusText("One-click orchestration completed.");

      const trendPatterns = Array.isArray(
        finalResult.labAgent?.result?.trendPatterns,
      )
        ? finalResult.labAgent.result.trendPatterns
        : [];
      if (trendPatterns.length > 0) {
        setActiveTab("trends");
      }

      const categoryLabel = String(
        (finalResult.labAgent?.result?.patientCategory as Record<string, unknown> | undefined)
          ?.label || "unknown",
      ).toUpperCase();
      toast.success(`Analyze Reports complete. Agent category: ${categoryLabel}`);
    } catch (error: any) {
      setOrchestrationCurrentStep(null);
      setOrchestrationFailedStep(
        orchestrationCurrentStep || ORCHESTRATION_STEP_ORDER[0],
      );
      setOrchestrationStatusText(error?.message || "One-click orchestration failed");
      toast.error(error?.message || "One-click orchestration failed");
    } finally {
      setOneClickRunning(false);
    }
  };

  // ── Multi-report AI trend analysis ────────────────────────────────────────

  const runMultiAnalysis = async () => {
    const done = sessions.filter((s) => s.result);
    if (done.length < 2) {
      toast.error("Need at least 2 analyzed reports for trend analysis.");
      return;
    }

    setMultiAnalyzing(true);
    toast.info("Running cross-report trend analysis…");

    try {
      const summaries = done
        .map(
          (s, i) =>
            `Report ${i + 1} (${s.label}):\nSummary: ${
              s.result!.summary
            }\nAbnormal values: ${
              s
                .result!.labComparison.filter((v) => v.status !== "Normal")
                .map((v) => `${v.test}: ${v.actualValue} (${v.status})`)
                .join(", ") || "None"
            }`,
        )
        .join("\n\n---\n\n");

      const geminiRes = await fetch(
        `https://generativelanguage.googleapis.com/v1/models/gemini-2.5-flash:generateContent?key=${GEMINI_API_KEY}`,
        {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            contents: [{ parts: [{ text: MULTI_ANALYSIS_PROMPT(summaries) }] }],
          }),
        },
      );

      if (!geminiRes.ok) throw new Error(`Gemini error: ${geminiRes.status}`);

      const raw = await geminiRes.json();
      const text = raw.candidates?.[0]?.content?.parts?.[0]?.text ?? "";
      const cleaned = text
        .replace(/```json/g, "")
        .replace(/```/g, "")
        .trim();
      const parsed = JSON.parse(cleaned);
      setMultiResult(parsed);
      setActiveTab("trends");
      toast.success("Trend analysis complete");
    } catch (e) {
      console.error(e);
      toast.error("Trend analysis failed");
    } finally {
      setMultiAnalyzing(false);
    }
  };

  const abnormalCount = activeSession?.result
    ? activeSession.result.labComparison.filter((r) => r.status !== "Normal")
        .length
    : 0;

  // ─── Empty state ──────────────────────────────────────────────────────────

  if (sessions.length === 0) {
    return (
      <div
        onDrop={(e) => {
          e.preventDefault();
          handleFiles(e.dataTransfer.files);
        }}
        onDragOver={(e) => e.preventDefault()}
        className="relative glass rounded-[3rem] border-2 border-dashed border-white/10 hover:border-primary/30 transition-all duration-500 p-16 flex flex-col items-center justify-center text-center gap-8"
      >
        <div className="h-28 w-28 rounded-[2rem] bg-primary/10 flex items-center justify-center text-primary">
          <Layers className="h-14 w-14" />
        </div>
        <div>
          <h3 className="text-3xl font-black tracking-tight mb-3">
            Multi-Report Lab Analysis
          </h3>
          <p className="text-base text-muted-foreground max-w-sm leading-relaxed">
            Upload one or more lab report images. Analyze them individually,
            then run a cross-report trend analysis to predict future tests.
          </p>
        </div>
        <div className="flex flex-col sm:flex-row gap-3">
          <Button
            onClick={() => fileInputRef.current?.click()}
            className="h-16 px-14 rounded-2xl bg-primary text-primary-foreground font-black uppercase tracking-widest border-none hover:scale-105 transition-all text-sm"
          >
            <Upload className="h-5 w-5 mr-3" /> Select Reports
          </Button>
        </div>
        <p className="text-xs text-muted-foreground/40 uppercase tracking-widest">
          Drag & drop multiple files · JPG, PNG accepted
        </p>
        <input
          ref={fileInputRef}
          type="file"
          accept="image/*"
          multiple
          className="hidden"
          onChange={(e) => handleFiles(e.target.files)}
        />
      </div>
    );
  }

  // ─── Main UI ──────────────────────────────────────────────────────────────

  const trendIcon = (t: TrendPoint["trend"]) => {
    if (t === "improving")
      return <TrendingDown className="h-4 w-4 text-emerald-400" />;
    if (t === "worsening")
      return <TrendingUp className="h-4 w-4 text-rose-400" />;
    if (t === "mixed") return <Activity className="h-4 w-4 text-amber-400" />;
    return <Minus className="h-4 w-4 text-slate-400" />;
  };

  return (
    <div className="space-y-6 animate-in fade-in duration-700">
      {/* ── Session strip ─────────────────────────────────────────────────── */}
      <div className="glass rounded-[2rem] border border-white/5 p-4">
        <div className="flex items-center gap-3 flex-wrap">
          {/* Session thumbnails */}
          <div className="flex items-center gap-2 flex-wrap flex-1">
            {sessions.map((s) => (
              <button
                key={s.id}
                onClick={() => {
                  setActiveSessionId(s.id);
                  setImageZoomed(false);
                }}
                className={`relative group flex items-center gap-2 px-3 py-2 rounded-xl border transition-all text-xs font-black uppercase tracking-wider
                  ${
                    activeSessionId === s.id
                      ? "bg-primary/20 border-primary/40 text-primary"
                      : "bg-white/[0.03] border-white/10 text-muted-foreground hover:border-white/20 hover:text-white"
                  }`}
              >
                {s.preview ? (
                  <img
                    src={s.preview}
                    alt=""
                    className="h-6 w-6 rounded object-cover"
                  />
                ) : (
                  <FileText className="h-4 w-4" />
                )}
                <span>{s.label}</span>
                {s.analyzing && <Loader2 className="h-3 w-3 animate-spin" />}
                {s.result && !s.analyzing && (
                  <CheckCircle className="h-3 w-3 text-emerald-400" />
                )}
                {s.error && <AlertCircle className="h-3 w-3 text-rose-400" />}
                <span
                  onClick={(e) => {
                    e.stopPropagation();
                    removeSession(s.id);
                  }}
                  className="ml-1 opacity-0 group-hover:opacity-100 transition-opacity text-muted-foreground hover:text-rose-400"
                >
                  <X className="h-3 w-3" />
                </span>
              </button>
            ))}

            {/* Add more button */}
            <button
              onClick={() => fileInputRef.current?.click()}
              className="flex items-center gap-1 px-3 py-2 rounded-xl border border-dashed border-white/10 text-muted-foreground hover:border-primary/30 hover:text-primary transition-all text-xs font-black uppercase tracking-wider"
            >
              <Plus className="h-3.5 w-3.5" /> Add
            </button>
            <input
              ref={fileInputRef}
              type="file"
              accept="image/*"
              multiple
              className="hidden"
              onChange={(e) => handleFiles(e.target.files)}
            />
          </div>

          {/* Action buttons */}
          <div className="flex items-center gap-2">
            <Button
              onClick={analyzeReportsOneClick}
              disabled={oneClickRunning}
              size="sm"
              title={undefined}
              className="h-9 px-4 rounded-xl font-black uppercase tracking-wider text-xs bg-primary text-primary-foreground"
            >
              {oneClickRunning ? (
                <>
                  <Loader2 className="h-3.5 w-3.5 mr-1.5 animate-spin" />
                  {orchestrationCurrentStep
                    ? ORCHESTRATION_STEP_LABELS[orchestrationCurrentStep]
                    : "Running All..."}
                </>
              ) : (
                <>
                  <Sparkles className="h-3.5 w-3.5 mr-1.5" />
                  Analyze Reports
                </>
              )}
            </Button>
            {completedSessions.length >= 2 && (
              <Button
                onClick={runMultiAnalysis}
                disabled={multiAnalyzing}
                size="sm"
                variant="outline"
                className="h-9 px-4 rounded-xl font-black uppercase tracking-wider text-xs border-violet-500/30 text-violet-400 hover:bg-violet-500/10"
              >
                {multiAnalyzing ? (
                  <>
                    <Loader2 className="h-3.5 w-3.5 mr-1.5 animate-spin" />{" "}
                    Analyzing Trends…
                  </>
                ) : (
                  <>
                    <Brain className="h-3.5 w-3.5 mr-1.5" /> Trend Analysis
                  </>
                )}
              </Button>
            )}
          </div>
        </div>
      </div>

      {(oneClickRunning ||
        orchestrationCompletedSteps.length > 0 ||
        orchestrationFailedStep) && (
        <div className="rounded-2xl border border-primary/20 bg-primary/[0.03] p-5 space-y-4">
          <div className="flex items-center justify-between gap-3">
            <h4 className="text-[10px] font-black uppercase tracking-widest text-primary/70">
              One-Click Orchestration Pipeline
            </h4>
            <span
              className={`text-[10px] font-black uppercase tracking-widest ${
                orchestrationFailedStep
                  ? "text-rose-400"
                  : oneClickRunning
                  ? "text-primary"
                  : "text-emerald-400"
              }`}
            >
              {orchestrationFailedStep
                ? "Failed"
                : oneClickRunning
                ? "Running"
                : "Completed"}
            </span>
          </div>

          {orchestrationStatusText && (
            <p className="text-xs text-muted-foreground">{orchestrationStatusText}</p>
          )}

          <div className="space-y-2">
            {ORCHESTRATION_STEP_ORDER.map((step) => {
              const isCompleted = orchestrationCompletedSteps.includes(step);
              const isRunning = orchestrationCurrentStep === step;
              const isFailed = orchestrationFailedStep === step;

              return (
                <div key={step} className="flex items-center gap-3">
                  <div className="w-5 flex justify-center">
                    {isCompleted ? (
                      <CheckCircle className="h-4 w-4 text-emerald-400" />
                    ) : isRunning ? (
                      <Loader2 className="h-4 w-4 text-primary animate-spin" />
                    ) : isFailed ? (
                      <AlertCircle className="h-4 w-4 text-rose-400" />
                    ) : (
                      <div className="h-2 w-2 rounded-full bg-white/15" />
                    )}
                  </div>
                  <span
                    className={`text-xs transition-colors ${
                      isCompleted
                        ? "text-emerald-400/80"
                        : isRunning
                        ? "text-primary font-bold"
                        : isFailed
                        ? "text-rose-400"
                        : "text-muted-foreground/50"
                    }`}
                  >
                    {ORCHESTRATION_STEP_LABELS[step]}
                  </span>
                </div>
              );
            })}
          </div>

          <div className="h-1.5 rounded-full bg-white/5 overflow-hidden">
            <div
              className="h-full rounded-full bg-primary transition-all duration-700 ease-out"
              style={{
                width: `${Math.max(
                  5,
                  (orchestrationCompletedSteps.length /
                    ORCHESTRATION_STEP_ORDER.length) *
                    100,
                )}%`,
              }}
            />
          </div>
        </div>
      )}

      {/* ── Active session header ─────────────────────────────────────────── */}
      {activeSession && (
        <div className="flex items-center justify-between flex-wrap gap-3">
          <div className="flex items-center gap-3 flex-wrap">
            {activeSession.result?.patientInfo?.age && (
              <div className="px-4 py-2 glass rounded-xl border border-white/5 text-xs font-black uppercase tracking-widest text-muted-foreground">
                Age{" "}
                <span className="text-white ml-1">
                  {activeSession.result.patientInfo.age}y
                </span>
              </div>
            )}
            {activeSession.result?.patientInfo?.gender && (
              <div className="px-4 py-2 glass rounded-xl border border-white/5 text-xs font-black uppercase tracking-widest text-muted-foreground">
                Gender{" "}
                <span className="text-white ml-1">
                  {activeSession.result.patientInfo.gender}
                </span>
              </div>
            )}
            {diabeticAutoResult?.diabetes_risk_percentage && (
              <div className="px-4 py-2 border border-amber-500/30 rounded-xl text-xs text-amber-400 font-black">
                Diabetic Risk{" "}
                {diabeticAutoResult.diabetes_risk_percentage.toFixed(1)}%
              </div>
            )}
            {heartAutoResult?.confidence && (
              <div className="px-4 py-2 border border-rose-500/30 rounded-xl text-xs text-rose-400 font-black">
                Heart Risk {heartAutoResult.confidence.toFixed(1)}%
              </div>
            )}
            {abnormalCount > 0 && (
              <div className="px-4 py-2 rounded-xl bg-rose-500/10 border border-rose-500/20 text-xs font-black uppercase tracking-widest text-rose-400">
                {abnormalCount} Abnormal{" "}
                {abnormalCount === 1 ? "Value" : "Values"}
              </div>
            )}
          </div>
        </div>
      )}

      {/* ── Split view ──────────────────────────────────────────────────────── */}
      {activeSession && (
        <div className="grid grid-cols-1 lg:grid-cols-2 gap-6">
          {/* LEFT: image */}
          <div className="glass rounded-[3rem] border border-white/5 overflow-hidden flex flex-col">
            <div className="flex items-center justify-between px-8 py-5 border-b border-white/5">
              <div className="flex items-center gap-3">
                <div className="h-10 w-10 rounded-lg bg-primary/10 flex items-center justify-center text-primary">
                  <FileText className="h-5 w-5" />
                </div>
                <span className="text-xs font-black uppercase tracking-widest text-muted-foreground">
                  {activeSession.label}
                </span>
              </div>
              <div className="flex items-center gap-2">
                {activeSession.preview && (
                  <button
                    onClick={() => setImageZoomed((z) => !z)}
                    className="h-10 w-10 rounded-lg border border-white/10 flex items-center justify-center text-muted-foreground hover:text-primary hover:border-primary/30 transition-all"
                  >
                    {imageZoomed ? (
                      <ZoomOut className="h-4 w-4" />
                    ) : (
                      <ZoomIn className="h-4 w-4" />
                    )}
                  </button>
                )}
                {activeSession.analyzing && (
                  <div className="flex items-center gap-2 text-xs text-primary font-black uppercase tracking-wider">
                    <Loader2 className="h-4 w-4 animate-spin" /> Analyzing…
                  </div>
                )}
              </div>
            </div>

            <div
              className={`relative flex-1 overflow-auto bg-black/20 ${
                activeSession.preview
                  ? imageZoomed
                    ? "cursor-zoom-out"
                    : "cursor-zoom-in"
                  : ""
              }`}
              onClick={() => activeSession.preview && setImageZoomed((z) => !z)}
              style={{ minHeight: "280px" }}
            >
              {activeSession.preview ? (
                <img
                  src={activeSession.preview}
                  alt="Lab report"
                  className={`transition-all duration-500 ${
                    imageZoomed
                      ? "w-full object-cover"
                      : "w-full h-full object-contain p-4"
                  }`}
                />
              ) : (
                <div className="flex flex-col items-center justify-center h-full gap-4 p-8 text-center">
                  <BarChart2 className="h-14 w-14 text-muted-foreground/20" />
                  <p className="text-xs font-black uppercase tracking-widest text-muted-foreground/30">
                    Loaded from patient history
                  </p>
                  {activeSession.result?.summary && (
                    <p className="text-sm text-muted-foreground/50 italic leading-relaxed max-w-xs line-clamp-4">
                      &quot;{activeSession.result.summary}&quot;
                    </p>
                  )}
                </div>
              )}
            </div>

            {activeSession.error && (
              <div className="px-6 py-4 border-t border-white/5 flex items-center gap-3 bg-destructive/5">
                <AlertCircle className="h-5 w-5 text-destructive shrink-0" />
                <p className="text-sm text-destructive">
                  {activeSession.error}
                </p>
              </div>
            )}

            {activeSession.preview && (
              <div className="px-8 py-4 border-t border-white/5 flex items-center justify-center">
                <p className="text-xs text-muted-foreground/30 uppercase tracking-widest font-black">
                  {imageZoomed ? "Click to Fit" : "Click to Zoom"}
                </p>
              </div>
            )}
          </div>

          {/* RIGHT: summary + tabs */}
          <div className="flex flex-col gap-6">
            {activeSession.result ? (
              <>
                {/* Clinical Summary */}
                <Card className="glass border-white/5 bg-white/[0.02] rounded-[2.5rem]">
                  <CardContent className="p-8">
                    <div className="flex items-center gap-4 mb-5">
                      <div className="h-12 w-12 rounded-xl bg-primary/10 flex items-center justify-center text-primary">
                        <Activity className="h-6 w-6" />
                      </div>
                      <h3 className="text-sm font-black uppercase tracking-widest text-muted-foreground">
                        Clinical Summary
                      </h3>
                    </div>
                    <p className="text-sm md:text-lg text-foreground/80 leading-loose">
                      &quot;{activeSession.result.summary}&quot;
                    </p>

                    {activeSession.result.dailyHealthAdvice &&
                      activeSession.result.dailyHealthAdvice.length > 0 && (
                        <div className="mt-6 pt-6 border-t border-white/5">
                          <div className="flex items-center gap-3 mb-4">
                            <div className="h-10 w-10 rounded-lg bg-emerald-500/10 flex items-center justify-center text-emerald-400">
                              <CheckCircle className="h-5 w-5" />
                            </div>
                            <h4 className="text-sm font-black uppercase tracking-widest text-emerald-400">
                              Daily Health Guidance
                            </h4>
                          </div>
                          <ul className="space-y-3">
                            {activeSession.result.dailyHealthAdvice.map(
                              (advice, idx) => (
                                <li
                                  key={idx}
                                  className="flex items-start gap-3 text-sm text-foreground/70 leading-relaxed"
                                >
                                  <ChevronRight className="h-4 w-4 text-emerald-400 mt-1 shrink-0" />
                                  <span className="text-sm md:text-lg">
                                    {advice}
                                  </span>
                                </li>
                              ),
                            )}
                          </ul>
                        </div>
                      )}
                  </CardContent>
                </Card>

                {/* Tabs */}
                <div className="flex-1">
                  <Tabs
                    value={activeTab}
                    onValueChange={(v) => {
                      setActiveTab(v);
                      if (v === "recommended")
                        setDiagnosticRefresh((r) => r + 1);
                    }}
                    className="h-full flex flex-col"
                  >
                    <TabsList className="h-14 bg-white/5 border border-white/5 rounded-2xl p-1.5 gap-1 self-start mb-4 w-full flex">
                      <TabsTrigger
                        value="comparison"
                        className="flex-1 flex items-center gap-1.5 rounded-xl text-xs font-black uppercase tracking-widest data-[state=active]:bg-primary data-[state=active]:text-primary-foreground"
                      >
                        <Microscope className="h-3.5 w-3.5" /> Lab Values
                      </TabsTrigger>
                      <TabsTrigger
                        value="recommended"
                        className="flex-1 flex items-center gap-1.5 rounded-xl text-xs font-black uppercase tracking-widest data-[state=active]:bg-primary data-[state=active]:text-primary-foreground"
                      >
                        <ClipboardList className="h-3.5 w-3.5" /> Next Tests
                        {activeSession.result.recommendedTests?.length > 0 && (
                          <span className="ml-0.5 h-5 w-5 rounded-full bg-primary/20 text-primary flex items-center justify-center text-xs font-black">
                            {activeSession.result.recommendedTests.length}
                          </span>
                        )}
                      </TabsTrigger>
                      {trends.length > 0 && (
                        <TabsTrigger
                          value="trends"
                          className="flex-1 flex items-center gap-1.5 rounded-xl text-xs font-black uppercase tracking-widest data-[state=active]:bg-violet-500 data-[state=active]:text-white"
                        >
                          <TrendingUp className="h-3.5 w-3.5" /> Trends
                        </TabsTrigger>
                      )}
                      {multiResult && (
                        <TabsTrigger
                          value="predict"
                          className="flex-1 flex items-center gap-1.5 rounded-xl text-xs font-black uppercase tracking-widest data-[state=active]:bg-amber-500 data-[state=active]:text-black"
                        >
                          <Sparkles className="h-3.5 w-3.5" /> Predict
                        </TabsTrigger>
                      )}
                    </TabsList>

                    {/* Lab Values */}
                    <TabsContent value="comparison" className="flex-1 mt-0">
                      <div className="glass rounded-[2rem] border border-white/5 overflow-hidden">
                        {activeSession.result.labComparison?.length > 0 ? (
                          <div className="overflow-y-auto max-h-[480px]">
                            <table className="w-full text-sm">
                              <thead className="sticky top-0 z-10">
                                <tr className="border-b border-white/5 bg-background/80 backdrop-blur-xl">
                                  <th className="text-left px-6 py-4 font-black uppercase tracking-widest text-muted-foreground text-xs">
                                    Test
                                  </th>
                                  <th className="text-left px-4 py-4 font-black uppercase tracking-widest text-muted-foreground text-xs">
                                    Result
                                  </th>
                                  <th className="text-left px-4 py-4 font-black uppercase tracking-widest text-muted-foreground text-xs">
                                    Range
                                  </th>
                                  <th className="text-left px-4 py-4 font-black uppercase tracking-widest text-muted-foreground text-xs">
                                    Status
                                  </th>
                                  {trends.length > 0 && (
                                    <th className="text-left px-4 py-4 font-black uppercase tracking-widest text-muted-foreground text-xs">
                                      Trend
                                    </th>
                                  )}
                                </tr>
                              </thead>
                              <tbody>
                                {activeSession.result.labComparison.map(
                                  (row, i) => {
                                    const cfg =
                                      STATUS_CONFIG[row.status] ??
                                      STATUS_CONFIG.Normal;
                                    const trend = trends.find(
                                      (t) => t.test === row.test,
                                    );
                                    return (
                                      <tr
                                        key={i}
                                        className={`border-b border-white/5 last:border-0 transition-colors ${cfg.row}`}
                                      >
                                        <td className="px-6 py-4 font-bold text-sm">
                                          {row.test}
                                        </td>
                                        <td className="px-4 py-4 font-black text-sm">
                                          {row.actualValue}
                                        </td>
                                        <td className="px-4 py-4 text-muted-foreground/60 font-medium text-sm">
                                          {row.normalRange}
                                        </td>
                                        <td className="px-4 py-4">
                                          <span
                                            className={`px-3 py-1.5 rounded-full text-xs font-black uppercase tracking-widest border ${cfg.badge}`}
                                          >
                                            {row.status}
                                          </span>
                                        </td>
                                        {trends.length > 0 && (
                                          <td className="px-4 py-4">
                                            {trend ? (
                                              <div className="flex items-center gap-2">
                                                {trendIcon(trend.trend)}
                                                <TrendSparkline
                                                  values={trend.values}
                                                />
                                              </div>
                                            ) : (
                                              <span className="text-muted-foreground/20 text-xs">
                                                —
                                              </span>
                                            )}
                                          </td>
                                        )}
                                      </tr>
                                    );
                                  },
                                )}
                              </tbody>
                            </table>
                          </div>
                        ) : (
                          <div className="p-12 text-center text-muted-foreground/30 italic text-sm">
                            No lab values could be extracted.
                          </div>
                        )}
                      </div>
                    </TabsContent>

                    {/* Recommended tests */}
                    <TabsContent value="recommended" className="flex-1 mt-0">
                      <div className="glass rounded-[2rem] border border-white/5 overflow-hidden p-6">
                        <DiagnosticButtons
                          key={
                            diagnosticRefresh +
                            "-" +
                            JSON.stringify(
                              activeSession.result?.extractedJsonGroup1,
                            ) +
                            JSON.stringify(
                              activeSession.result?.extractedJsonGroup2,
                            )
                          }
                          extractedGroup1={
                            activeSession.result?.extractedJsonGroup1
                          }
                          extractedGroup2={
                            activeSession.result?.extractedJsonGroup2
                          }
                        />
                        {!activeSession.result.recommendedTests?.length ? (
                          <div className="text-center py-10">
                            <CheckCircle className="h-16 w-16 text-emerald-400 mx-auto mb-4 opacity-50" />
                            <p className="font-black text-emerald-400 uppercase tracking-widest text-base mb-2">
                              All Values Normal
                            </p>
                            <p className="text-sm text-muted-foreground">
                              No follow-up tests required at this time.
                            </p>
                          </div>
                        ) : (
                          <div className="space-y-4 overflow-y-auto max-h-[460px]">
                            {activeSession.result.recommendedTests.map(
                              (test, i) => {
                                const dashIdx = test.indexOf(" - ");
                                const name =
                                  dashIdx !== -1
                                    ? test.slice(0, dashIdx)
                                    : test;
                                const reason =
                                  dashIdx !== -1 ? test.slice(dashIdx + 3) : "";
                                return (
                                  <div
                                    key={i}
                                    className="flex items-start gap-4 p-6 rounded-[1.5rem] bg-white/[0.02] border border-white/5 hover:border-primary/20 transition-all group cursor-default"
                                  >
                                    <div className="h-10 w-10 rounded-full bg-primary/10 flex items-center justify-center text-primary text-sm font-black shrink-0 mt-0.5 group-hover:bg-primary group-hover:text-primary-foreground transition-all">
                                      {i + 1}
                                    </div>
                                    <div className="flex-1 min-w-0">
                                      <p className="font-black text-base mb-1">
                                        {name}
                                      </p>
                                      {reason && (
                                        <p className="text-sm text-muted-foreground leading-relaxed">
                                          {reason}
                                        </p>
                                      )}
                                    </div>
                                    <ChevronRight className="h-5 w-5 text-muted-foreground/20 group-hover:text-primary/60 transition-all shrink-0 mt-1" />
                                  </div>
                                );
                              },
                            )}
                          </div>
                        )}
                      </div>
                    </TabsContent>

                    {/* Trends tab */}
                    {trends.length > 0 && (
                      <TabsContent value="trends" className="flex-1 mt-0">
                        <div className="glass rounded-[2rem] border border-white/5 p-6 space-y-3 overflow-y-auto max-h-[520px]">
                          <p className="text-xs font-black uppercase tracking-widest text-muted-foreground mb-4">
                            Cross-Report Value Trends (
                            {completedSessions.length} reports)
                          </p>
                          {trends.map((trend, i) => (
                            <div
                              key={i}
                              className="flex items-center gap-4 p-4 rounded-2xl bg-white/[0.02] border border-white/5 hover:border-white/10 transition-all"
                            >
                              <div className="flex items-center gap-2 w-36 shrink-0">
                                {trendIcon(trend.trend)}
                                <span className="text-xs font-black text-foreground/80 truncate">
                                  {trend.test}
                                </span>
                              </div>
                              <TrendSparkline values={trend.values} />
                              <div className="flex gap-1.5 flex-wrap flex-1">
                                {trend.values.map((v, j) => (
                                  <span
                                    key={j}
                                    className={`px-2 py-1 rounded-lg text-xs font-black border ${
                                      STATUS_CONFIG[
                                        v.status as keyof typeof STATUS_CONFIG
                                      ]?.badge ?? STATUS_CONFIG.Normal.badge
                                    }`}
                                  >
                                    {v.sessionLabel}: {v.value}
                                  </span>
                                ))}
                              </div>
                              <span
                                className={`text-xs font-black uppercase tracking-wider shrink-0 ${
                                  trend.trend === "improving"
                                    ? "text-emerald-400"
                                    : trend.trend === "worsening"
                                    ? "text-rose-400"
                                    : trend.trend === "mixed"
                                    ? "text-amber-400"
                                    : "text-slate-400"
                                }`}
                              >
                                {trend.trend}
                              </span>
                            </div>
                          ))}

                          {!multiResult && completedSessions.length >= 2 && (
                            <div className="pt-4 border-t border-white/5">
                              <Button
                                onClick={runMultiAnalysis}
                                disabled={multiAnalyzing}
                                className="w-full h-14 rounded-2xl font-black uppercase tracking-widest text-sm bg-violet-600 hover:bg-violet-500 text-white border-none"
                              >
                                {multiAnalyzing ? (
                                  <>
                                    <Loader2 className="h-4 w-4 mr-2 animate-spin" />{" "}
                                    Running AI Trend Analysis…
                                  </>
                                ) : (
                                  <>
                                    <Brain className="h-4 w-4 mr-2" /> Run AI
                                    Predictive Analysis
                                  </>
                                )}
                              </Button>
                            </div>
                          )}
                        </div>
                      </TabsContent>
                    )}

                    {/* Predictive Insights tab */}
                    {multiResult && (
                      <TabsContent value="predict" className="flex-1 mt-0">
                        <div className="glass rounded-[2rem] border border-white/5 p-6 space-y-5 overflow-y-auto max-h-[520px]">
                          {/* Overall trajectory */}
                          <div className="p-5 rounded-2xl bg-violet-500/10 border border-violet-500/20">
                            <div className="flex items-center gap-3 mb-3">
                              <Brain className="h-5 w-5 text-violet-400" />
                              <span className="text-xs font-black uppercase tracking-widest text-violet-400">
                                Health Trajectory
                              </span>
                              <span
                                className={`ml-auto px-3 py-1 rounded-full text-xs font-black uppercase border
                                ${
                                  multiResult.overallTrend === "improving"
                                    ? "text-emerald-400 border-emerald-400/30 bg-emerald-400/10"
                                    : multiResult.overallTrend === "worsening"
                                    ? "text-rose-400 border-rose-400/30 bg-rose-400/10"
                                    : "text-amber-400 border-amber-400/30 bg-amber-400/10"
                                }`}
                              >
                                {multiResult.overallTrend}
                              </span>
                            </div>
                            <p className="text-sm text-foreground/80 leading-relaxed">
                              {multiResult.overallSummary}
                            </p>
                          </div>

                          {/* Persistent abnormalities */}
                          {multiResult.persistentAbnormalities?.length > 0 && (
                            <div>
                              <p className="text-xs font-black uppercase tracking-widest text-muted-foreground mb-3 flex items-center gap-2">
                                <AlertTriangle className="h-3.5 w-3.5 text-amber-400" />{" "}
                                Persistent Concerns
                              </p>
                              <div className="space-y-2">
                                {multiResult.persistentAbnormalities.map(
                                  (item: any, i: number) => (
                                    <div
                                      key={i}
                                      className={`flex items-center justify-between p-4 rounded-xl border ${
                                        URGENCY_CONFIG[
                                          item.riskLevel as keyof typeof URGENCY_CONFIG
                                        ]?.bg
                                      }`}
                                    >
                                      <div>
                                        <p className="font-black text-sm">
                                          {item.test}
                                        </p>
                                        <p className="text-xs text-muted-foreground mt-0.5">
                                          {item.pattern}
                                        </p>
                                      </div>
                                      <span
                                        className={`text-xs font-black uppercase ${
                                          URGENCY_CONFIG[
                                            item.riskLevel as keyof typeof URGENCY_CONFIG
                                          ]?.color
                                        }`}
                                      >
                                        {
                                          URGENCY_CONFIG[
                                            item.riskLevel as keyof typeof URGENCY_CONFIG
                                          ]?.icon
                                        }{" "}
                                        {item.riskLevel}
                                      </span>
                                    </div>
                                  ),
                                )}
                              </div>
                            </div>
                          )}

                          {/* Improving / worsening quick view */}
                          {(multiResult.improvingValues?.length > 0 ||
                            multiResult.worseningValues?.length > 0) && (
                            <div className="grid grid-cols-2 gap-3">
                              {multiResult.improvingValues?.length > 0 && (
                                <div className="p-4 rounded-xl bg-emerald-500/5 border border-emerald-500/20">
                                  <p className="text-xs font-black uppercase tracking-widest text-emerald-400 mb-2 flex items-center gap-1.5">
                                    <TrendingDown className="h-3.5 w-3.5" />{" "}
                                    Improving
                                  </p>
                                  {multiResult.improvingValues.map(
                                    (v: string, i: number) => (
                                      <p
                                        key={i}
                                        className="text-xs text-foreground/70 leading-relaxed"
                                      >
                                        • {v}
                                      </p>
                                    ),
                                  )}
                                </div>
                              )}
                              {multiResult.worseningValues?.length > 0 && (
                                <div className="p-4 rounded-xl bg-rose-500/5 border border-rose-500/20">
                                  <p className="text-xs font-black uppercase tracking-widest text-rose-400 mb-2 flex items-center gap-1.5">
                                    <TrendingUp className="h-3.5 w-3.5" />{" "}
                                    Worsening
                                  </p>
                                  {multiResult.worseningValues.map(
                                    (v: string, i: number) => (
                                      <p
                                        key={i}
                                        className="text-xs text-foreground/70 leading-relaxed"
                                      >
                                        • {v}
                                      </p>
                                    ),
                                  )}
                                </div>
                              )}
                            </div>
                          )}

                          {/* Predictive insights */}
                          {multiResult.predictiveInsights?.length > 0 && (
                            <div>
                              <p className="text-xs font-black uppercase tracking-widest text-muted-foreground mb-3 flex items-center gap-2">
                                <Target className="h-3.5 w-3.5 text-amber-400" />{" "}
                                Predicted Future Tests
                              </p>
                              <div className="space-y-4">
                                {multiResult.predictiveInsights.map(
                                  (
                                    insight: PredictiveInsight & {
                                      timeframe?: string;
                                    },
                                    i: number,
                                  ) => (
                                    <div
                                      key={i}
                                      className={`p-5 rounded-2xl border ${
                                        URGENCY_CONFIG[insight.urgency]?.bg
                                      }`}
                                    >
                                      <div className="flex items-start justify-between gap-3 mb-2">
                                        <p className="font-black text-sm">
                                          {insight.title}
                                        </p>
                                        <div className="flex flex-col items-end gap-1 shrink-0">
                                          <span
                                            className={`text-xs font-black uppercase ${
                                              URGENCY_CONFIG[insight.urgency]
                                                ?.color
                                            }`}
                                          >
                                            {
                                              URGENCY_CONFIG[insight.urgency]
                                                ?.icon
                                            }{" "}
                                            {insight.urgency} priority
                                          </span>
                                          {(insight as any).timeframe && (
                                            <span className="flex items-center gap-1 text-xs text-muted-foreground">
                                              <Calendar className="h-3 w-3" />{" "}
                                              {(insight as any).timeframe}
                                            </span>
                                          )}
                                        </div>
                                      </div>
                                      <p className="text-xs text-foreground/60 mb-3 leading-relaxed">
                                        {insight.description}
                                      </p>
                                      <div className="space-y-1.5">
                                        {insight.tests.map((test, j) => (
                                          <div
                                            key={j}
                                            className="flex items-center gap-2 text-xs"
                                          >
                                            <ArrowRight className="h-3 w-3 text-primary shrink-0" />
                                            <span className="font-bold">
                                              {test}
                                            </span>
                                          </div>
                                        ))}
                                      </div>
                                      {insight.basedOn?.length > 0 && (
                                        <p className="text-xs text-muted-foreground/40 mt-3">
                                          Based on: {insight.basedOn.join(", ")}
                                        </p>
                                      )}
                                    </div>
                                  ),
                                )}
                              </div>
                            </div>
                          )}

                          {/* Lifestyle priorities */}
                          {multiResult.lifestylePriorities?.length > 0 && (
                            <div>
                              <p className="text-xs font-black uppercase tracking-widest text-muted-foreground mb-3 flex items-center gap-2">
                                <Sparkles className="h-3.5 w-3.5 text-emerald-400" />{" "}
                                Top Lifestyle Priorities
                              </p>
                              <ul className="space-y-2">
                                {multiResult.lifestylePriorities.map(
                                  (p: string, i: number) => (
                                    <li
                                      key={i}
                                      className="flex items-start gap-3 text-sm text-foreground/70"
                                    >
                                      <ChevronRight className="h-4 w-4 text-emerald-400 mt-0.5 shrink-0" />
                                      {p}
                                    </li>
                                  ),
                                )}
                              </ul>
                            </div>
                          )}
                        </div>
                      </TabsContent>
                    )}
                  </Tabs>
                </div>
              </>
            ) : (
              <div className="glass rounded-[3rem] border border-white/5 overflow-hidden flex flex-col min-h-[24rem]">
                <div className="px-8 py-5 border-b border-white/5 flex items-center justify-between gap-3">
                  <div className="flex items-center gap-3">
                    <div className="h-10 w-10 rounded-lg bg-primary/10 flex items-center justify-center text-primary">
                      <FileText className="h-5 w-5" />
                    </div>
                    <span className="text-xs font-black uppercase tracking-widest text-muted-foreground">
                      Analysis Pending
                    </span>
                  </div>
                  {activeSession.analyzing && (
                    <div className="flex items-center gap-2 text-xs text-primary font-black uppercase tracking-wider shrink-0">
                      <Loader2 className="h-4 w-4 animate-spin" /> Analyzing…
                    </div>
                  )}
                </div>

                <div className="flex-1 flex items-center justify-center p-8 bg-black/20">
                  <div className="text-center max-w-sm space-y-3">
                    <BarChart2 className="h-14 w-14 text-muted-foreground/20 mx-auto" />
                    <p className="text-sm text-muted-foreground/60 leading-relaxed">
                      The uploaded report is shown in the left preview. Once analysis finishes, the extracted findings and recommendations will appear here.
                    </p>
                  </div>
                </div>

                {activeSession.error && (
                  <div className="px-6 py-4 border-t border-white/5 flex items-center gap-3 bg-destructive/5">
                    <AlertCircle className="h-5 w-5 text-destructive shrink-0" />
                    <p className="text-sm text-destructive">
                      {activeSession.error}
                    </p>
                  </div>
                )}
              </div>
            )}
          </div>
        </div>
      )}
    </div>
  );
}
