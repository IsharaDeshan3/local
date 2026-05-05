import { NextRequest } from "next/server";

const LAB_BACKEND_URL = process.env.LAB_BACKEND_URL ?? "http://127.0.0.1:8000";
const GEMINI_API_KEY =
  process.env.GEMINI_API_KEY ?? process.env.NEXT_PUBLIC_GEMINI_API_KEY ?? "";
const GEMINI_MODEL = process.env.GEMINI_MODEL ?? "gemini-2.5-flash";

const DIABETIC_MODEL_URL =
  process.env.DIABETIC_MODEL_URL ??
  "https://diabetesnew-1051190728028.asia-south1.run.app";
const HEART_MODEL_URL =
  process.env.HEART_MODEL_URL ??
  "https://cardiac-1051190728028.asia-south1.run.app";

type StepKey =
  | "ocr_extraction"
  | "risk_models"
  | "save_lab_reports"
  | "create_lab_agent_job"
  | "run_lab_agent_analysis";

interface UploadedReportInput {
  id: string;
  label: string;
  reportDate?: string;
  fileName?: string;
  mimeType: string;
  contentBase64: string;
}

interface OrchestrateRequest {
  patientId?: string;
  patientName?: string;
  reports: UploadedReportInput[];
  options?: {
    minReportsForTrend?: number;
    topK?: number;
    force?: boolean;
    notes?: string;
    evidenceSourceIds?: string[];
  };
}

interface LabComparisonItem {
  test: string;
  actualValue: number | string;
  normalRange: string;
  status: "Normal" | "High" | "Low";
}

interface LabAnalysisResult {
  isMedical: boolean;
  summary: string;
  patientInfo?: { age?: number | null; gender?: string | null };
  labComparison: LabComparisonItem[];
  recommendedTests: string[];
  extractedJsonGroup1?: Record<string, unknown>;
  extractedJsonGroup2?: Record<string, unknown>;
  dailyHealthAdvice?: string[];
  error?: string;
}

interface ReportOrchestrationResult {
  id: string;
  label: string;
  reportDate: string;
  analysis: LabAnalysisResult;
  diabeticModelResult: unknown;
  heartModelResult: unknown;
  backendReportId: string | null;
  ocrJobId: string | null;
}

interface OcrExtractionResult {
  jobId: string | null;
  status: string;
  extractedText: string;
  error: string | null;
}

const EXTRACTION_PROMPT = `
You are a medical lab report analysis system focused on cardiovascular screening.

Rules:
- Return ONLY valid JSON.
- If the image is not a medical/lab report, return:
  {"isMedical": false, "error": "The uploaded file is not a medical report"}
- If it is medical, return:
  {
    "isMedical": true,
    "patientInfo": {"age": number|null, "gender": string|null},
    "labComparison": [
      {"test": string, "actualValue": number|string, "normalRange": string, "status": "Normal"|"High"|"Low"}
    ],
    "extractedJsonGroup1": {
      "Age": number|null,
      "Gender": "M"|"F"|null,
      "BMI": number|null,
      "Chol": number|null,
      "TG": number|null,
      "HDL": number|null,
      "LDL": number|null,
      "Cr": number|null,
      "BUN": number|null
    },
    "extractedJsonGroup2": {
      "age": number|null,
      "sex": number|null,
      "cp": number|null,
      "trestbps": number|null,
      "chol": number|null,
      "fbs": number|null,
      "restecg": number|null,
      "thalach": number|null,
      "exang": number|null,
      "oldpeak": number|null,
      "slope": number|null,
      "ca": number|null,
      "thal": number|null
    },
    "summary": string,
    "dailyHealthAdvice": [string],
    "recommendedTests": [string]
  }
`;

const conversionFactors: Record<string, number> = {
  Chol: 0.0259,
  TG: 0.0113,
  HDL: 0.0259,
  LDL: 0.0259,
  Cr: 88.4,
  BUN: 0.357,
};

function convertFormDataToMmolL(data: Record<string, unknown>): Record<string, unknown> {
  const converted: Record<string, unknown> = { ...data };
  for (const key of Object.keys(conversionFactors)) {
    const val = Number(data[key]);
    if (!Number.isNaN(val) && val !== 0) {
      converted[key] = Number((val * conversionFactors[key]).toFixed(2));
    }
  }
  return converted;
}

function buildBackendCandidates() {
  const primary = LAB_BACKEND_URL;
  const candidates = [primary];

  if (primary.includes("localhost")) {
    candidates.push(primary.replace("localhost", "127.0.0.1"));
  } else if (primary.includes("127.0.0.1")) {
    candidates.push(primary.replace("127.0.0.1", "localhost"));
  }

  return [...new Set(candidates)];
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

async function fetchLabBackend(path: string, init: RequestInit): Promise<Response> {
  let lastError: unknown = null;
  for (const base of buildBackendCandidates()) {
    try {
      const res = await fetch(`${base}${path}`, init);
      return res;
    } catch (error: unknown) {
      lastError = error;
    }
  }
  const message =
    typeof lastError === "object" &&
    lastError !== null &&
    typeof Reflect.get(lastError, "message") === "string"
      ? (Reflect.get(lastError, "message") as string)
      : "Failed to contact lab backend";
  throw new Error(message);
}

function extractJsonFromText(text: string): Record<string, unknown> {
  const cleaned = text.replace(/```json/g, "").replace(/```/g, "").trim();
  try {
    const parsed = JSON.parse(cleaned);
    if (isRecord(parsed)) {
      return parsed;
    }
  } catch {
    // Continue to regex extraction.
  }

  const match = cleaned.match(/\{[\s\S]*\}/);
  if (!match) {
    throw new Error("Gemini response did not include JSON content");
  }

  const parsed = JSON.parse(match[0]);
  if (!isRecord(parsed)) {
    throw new Error("Gemini JSON payload is invalid");
  }
  return parsed;
}

async function extractGeminiError(response: Response): Promise<string> {
  let raw = "";
  try {
    raw = (await response.text()).trim();
  } catch {
    raw = "";
  }
  if (!raw) {
    return `Gemini extraction failed (${response.status})`;
  }
  const compact = raw.replace(/\s+/g, " ").slice(0, 500);
  return `Gemini extraction failed (${response.status}): ${compact}`;
}

async function analyzeWithGemini(report: UploadedReportInput): Promise<LabAnalysisResult> {
  if (!GEMINI_API_KEY) {
    throw new Error("Gemini API key is missing on the server");
  }

  const geminiRes = await fetch(
    `https://generativelanguage.googleapis.com/v1/models/${encodeURIComponent(GEMINI_MODEL)}:generateContent?key=${GEMINI_API_KEY}`,
    {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        contents: [
          {
            parts: [
              { text: EXTRACTION_PROMPT },
              {
                inlineData: {
                  mimeType: report.mimeType,
                  data: report.contentBase64,
                },
              },
            ],
          },
        ],
      }),
    },
  );

  if (!geminiRes.ok) {
    throw new Error(await extractGeminiError(geminiRes));
  }

  const raw = (await geminiRes.json()) as Record<string, unknown>;
  const text =
    ((raw.candidates as Array<Record<string, unknown>> | undefined)?.[0]
      ?.content as Record<string, unknown> | undefined)?.parts as
      | Array<Record<string, unknown>>
      | undefined;
  const responseText = String(text?.[0]?.text ?? "").trim();
  if (!responseText) {
    throw new Error("Gemini returned an empty extraction payload");
  }

  const parsed = extractJsonFromText(responseText);
  return {
    isMedical: Boolean(parsed.isMedical),
    summary: String(parsed.summary ?? ""),
    patientInfo: isRecord(parsed.patientInfo)
      ? {
          age:
            parsed.patientInfo.age === null || parsed.patientInfo.age === undefined
              ? null
              : Number(parsed.patientInfo.age),
          gender:
            parsed.patientInfo.gender === null || parsed.patientInfo.gender === undefined
              ? null
              : String(parsed.patientInfo.gender),
        }
      : undefined,
    labComparison: Array.isArray(parsed.labComparison)
      ? (parsed.labComparison as LabComparisonItem[])
      : [],
    recommendedTests: Array.isArray(parsed.recommendedTests)
      ? parsed.recommendedTests.map((item) => String(item))
      : [],
    extractedJsonGroup1: isRecord(parsed.extractedJsonGroup1)
      ? parsed.extractedJsonGroup1
      : {},
    extractedJsonGroup2: isRecord(parsed.extractedJsonGroup2)
      ? parsed.extractedJsonGroup2
      : {},
    dailyHealthAdvice: Array.isArray(parsed.dailyHealthAdvice)
      ? parsed.dailyHealthAdvice.map((item) => String(item))
      : [],
    error: parsed.error ? String(parsed.error) : undefined,
  };
}

async function analyzeWithGeminiText(
  extractedText: string,
  label: string,
): Promise<LabAnalysisResult> {
  if (!GEMINI_API_KEY) {
    throw new Error("Gemini API key is missing on the server");
  }

  const textPrompt = `${EXTRACTION_PROMPT}\n\nThe following OCR text belongs to report: ${label}.\nUse only this text as source data.\nOCR_TEXT_START\n${extractedText}\nOCR_TEXT_END`;

  const geminiRes = await fetch(
    `https://generativelanguage.googleapis.com/v1/models/${encodeURIComponent(GEMINI_MODEL)}:generateContent?key=${GEMINI_API_KEY}`,
    {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        contents: [
          {
            parts: [{ text: textPrompt }],
          },
        ],
      }),
    },
  );

  if (!geminiRes.ok) {
    throw new Error(await extractGeminiError(geminiRes));
  }

  const raw = (await geminiRes.json()) as Record<string, unknown>;
  const text =
    ((raw.candidates as Array<Record<string, unknown>> | undefined)?.[0]
      ?.content as Record<string, unknown> | undefined)?.parts as
      | Array<Record<string, unknown>>
      | undefined;
  const responseText = String(text?.[0]?.text ?? "").trim();
  if (!responseText) {
    throw new Error("Gemini returned an empty extraction payload");
  }

  const parsed = extractJsonFromText(responseText);
  return {
    isMedical: Boolean(parsed.isMedical),
    summary: String(parsed.summary ?? ""),
    patientInfo: isRecord(parsed.patientInfo)
      ? {
          age:
            parsed.patientInfo.age === null || parsed.patientInfo.age === undefined
              ? null
              : Number(parsed.patientInfo.age),
          gender:
            parsed.patientInfo.gender === null || parsed.patientInfo.gender === undefined
              ? null
              : String(parsed.patientInfo.gender),
        }
      : undefined,
    labComparison: Array.isArray(parsed.labComparison)
      ? (parsed.labComparison as LabComparisonItem[])
      : [],
    recommendedTests: Array.isArray(parsed.recommendedTests)
      ? parsed.recommendedTests.map((item) => String(item))
      : [],
    extractedJsonGroup1: isRecord(parsed.extractedJsonGroup1)
      ? parsed.extractedJsonGroup1
      : {},
    extractedJsonGroup2: isRecord(parsed.extractedJsonGroup2)
      ? parsed.extractedJsonGroup2
      : {},
    dailyHealthAdvice: Array.isArray(parsed.dailyHealthAdvice)
      ? parsed.dailyHealthAdvice.map((item) => String(item))
      : [],
    error: parsed.error ? String(parsed.error) : undefined,
  };
}

function sanitizeStatus(value: unknown): "Normal" | "High" | "Low" {
  const normalized = String(value ?? "").toLowerCase();
  if (normalized === "high") return "High";
  if (normalized === "low") return "Low";
  return "Normal";
}

function normalizeAnalysis(result: LabAnalysisResult): LabAnalysisResult {
  return {
    ...result,
    labComparison: (result.labComparison ?? []).map((item) => ({
      test: String(item.test ?? ""),
      actualValue: item.actualValue,
      normalRange: String(item.normalRange ?? ""),
      status: sanitizeStatus(item.status),
    })),
  };
}

async function createOcrJobAndWait(
  report: UploadedReportInput,
  patientId: string,
): Promise<OcrExtractionResult> {
  const createRes = await fetchLabBackend("/api/lab-agent/ocr/jobs", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      patientId,
      fileName: report.fileName,
      mimeType: report.mimeType,
      contentBase64: report.contentBase64,
    }),
  });

  if (!createRes.ok) {
    let detail = "Failed to create OCR job";
    try {
      detail = (await createRes.text()).trim() || detail;
    } catch {
      detail = "Failed to create OCR job";
    }
    return {
      jobId: null,
      status: "failed",
      extractedText: "",
      error: detail,
    };
  }

  const created = (await createRes.json()) as Record<string, unknown>;
  const jobId = String(created.id ?? "").trim();
  if (!jobId) {
    return {
      jobId: null,
      status: "failed",
      extractedText: "",
      error: "OCR job response missing id",
    };
  }

  const deadline = Date.now() + 120_000;
  while (Date.now() < deadline) {
    const pollRes = await fetchLabBackend(`/api/lab-agent/ocr/jobs/${encodeURIComponent(jobId)}`, {
      method: "GET",
      headers: { Accept: "application/json" },
      cache: "no-store",
    });

    if (!pollRes.ok) {
      let detail = "OCR poll failed";
      try {
        detail = (await pollRes.text()).trim() || detail;
      } catch {
        detail = "OCR poll failed";
      }
      return {
        jobId,
        status: "failed",
        extractedText: "",
        error: detail,
      };
    }

    const poll = (await pollRes.json()) as Record<string, unknown>;
    const status = String(poll.status ?? "").toLowerCase();
    if (status === "completed" || status === "failed") {
      return {
        jobId,
        status,
        extractedText: String(poll.extractedText ?? ""),
        error: poll.error ? String(poll.error) : null,
      };
    }

    await new Promise((resolve) => setTimeout(resolve, 1500));
  }

  return {
    jobId,
    status: "timeout",
    extractedText: "",
    error: "OCR polling timed out",
  };
}

async function postRiskModel(url: string, body: Record<string, unknown>): Promise<unknown> {
  const res = await fetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  if (!res.ok) {
    return null;
  }
  try {
    return await res.json();
  } catch {
    return null;
  }
}

function normalizeName(value: string | undefined | null): string {
  return String(value ?? "").trim().toLowerCase().replace(/\s+/g, " ");
}

async function resolveLabBackendPatientId(patientId: string, patientName?: string): Promise<string> {
  if (!patientName?.trim()) {
    return patientId;
  }

  const lookupRes = await fetchLabBackend("/api/patients?skip=0&limit=200", {
    method: "GET",
    headers: { Accept: "application/json" },
    cache: "no-store",
  });

  if (!lookupRes.ok) {
    return patientId;
  }

  let patients: Array<Record<string, unknown>> = [];
  try {
    const parsed = (await lookupRes.json()) as unknown;
    if (Array.isArray(parsed)) {
      patients = parsed.filter((item): item is Record<string, unknown> => item !== null && typeof item === "object");
    }
  } catch {
    return patientId;
  }

  const targetName = normalizeName(patientName);
  if (!targetName) {
    return patientId;
  }

  const match = patients.find((item) => normalizeName(String(item.name ?? item.fullName ?? "")) === targetName);
  const resolvedId = String(match?.id ?? match?._id ?? "").trim();
  if (resolvedId && resolvedId !== patientId) {
    console.info(
      `[lab-orchestrate] Resolved lab backend patient id via name lookup: frontend=${patientId} backend=${resolvedId} name=${patientName}`,
    );
    return resolvedId;
  }

  return patientId;
}

async function createLabAgentJob(
  patientId: string,
  reportIds: string[],
  payload: OrchestrateRequest,
): Promise<Response> {
  return fetchLabBackend("/api/lab-agent/jobs", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      patientId,
      reportIds,
      minReportsForTrend: payload.options?.minReportsForTrend ?? 2,
      notes: payload.options?.notes ?? "ui_one_click_orchestrator",
    }),
  });
}

function createAnonymousLabPatientId(patientName?: string): string {
  const namePart = normalizeName(patientName) || "anonymous";
  const sanitized = namePart.replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "");
  return `lab-${sanitized || "anonymous"}-${Date.now().toString(36)}`;
}

function emit(controller: ReadableStreamDefaultController<Uint8Array>, payload: unknown) {
  const encoder = new TextEncoder();
  controller.enqueue(encoder.encode(`${JSON.stringify(payload)}\n`));
}

function stepStarted(
  controller: ReadableStreamDefaultController<Uint8Array>,
  step: StepKey,
  message: string,
) {
  emit(controller, { type: "step", step, status: "running", message, timestamp: Date.now() });
}

function stepCompleted(
  controller: ReadableStreamDefaultController<Uint8Array>,
  step: StepKey,
  message: string,
) {
  emit(controller, { type: "step", step, status: "completed", message, timestamp: Date.now() });
}

export async function POST(req: NextRequest) {
  const payload = (await req.json()) as OrchestrateRequest;
  if (!Array.isArray(payload.reports) || payload.reports.length === 0) {
    return Response.json({ error: "At least one report is required" }, { status: 400 });
  }

  const stream = new ReadableStream<Uint8Array>({
    start(controller) {
      void (async () => {
        try {
          const startedAt = Date.now();
          const reportResults: ReportOrchestrationResult[] = [];
          const frontendPatientId = String(payload.patientId ?? "").trim();
          const resolvedFrontendPatientId =
            frontendPatientId || createAnonymousLabPatientId(payload.patientName);
          const resolvedLabPatientId = await resolveLabBackendPatientId(
            resolvedFrontendPatientId,
            payload.patientName,
          );

          stepStarted(controller, "ocr_extraction", "Extracting report data and running OCR jobs");
          for (const report of payload.reports) {
            const ocrResult = await createOcrJobAndWait(report, resolvedLabPatientId);

            let analyzed: LabAnalysisResult;
            try {
              analyzed = normalizeAnalysis(await analyzeWithGemini(report));
            } catch (imageError: unknown) {
              const imageMessage =
                typeof imageError === "object" &&
                imageError !== null &&
                typeof Reflect.get(imageError, "message") === "string"
                  ? (Reflect.get(imageError, "message") as string)
                  : "unknown Gemini image extraction error";

              console.error(
                `[lab-orchestrate] Gemini image extraction failed for ${report.label}: ${imageMessage}`,
              );

              if (ocrResult.status === "completed" && ocrResult.extractedText.trim()) {
                analyzed = normalizeAnalysis(
                  await analyzeWithGeminiText(ocrResult.extractedText, report.label),
                );
                emit(controller, {
                  type: "step",
                  step: "ocr_extraction",
                  status: "running",
                  message: `Fell back to OCR-text extraction for ${report.label}`,
                  timestamp: Date.now(),
                });
              } else {
                throw new Error(
                  `Gemini extraction failed for ${report.label}. image_error=${imageMessage}; ocr_status=${ocrResult.status}; ocr_job_id=${ocrResult.jobId ?? "none"}; ocr_error=${ocrResult.error ?? "none"}`,
                );
              }
            }

            if (!analyzed.isMedical) {
              throw new Error(analyzed.error || `${report.label} is not a medical report`);
            }

            reportResults.push({
              id: report.id,
              label: report.label,
              reportDate: report.reportDate ?? new Date().toISOString().slice(0, 10),
              analysis: analyzed,
              diabeticModelResult: null,
              heartModelResult: null,
              backendReportId: null,
              ocrJobId: ocrResult.jobId,
            });

            emit(controller, {
              type: "report_result",
              reportId: report.id,
              label: report.label,
              isMedical: analyzed.isMedical,
              ocrJobId: ocrResult.jobId,
            });
          }
          stepCompleted(controller, "ocr_extraction", "Extraction and OCR completed");

          stepStarted(controller, "risk_models", "Calling diabetic and heart risk models");
          for (const report of reportResults) {
            const group1 = isRecord(report.analysis.extractedJsonGroup1)
              ? report.analysis.extractedJsonGroup1
              : {};
            const group2 = isRecord(report.analysis.extractedJsonGroup2)
              ? report.analysis.extractedJsonGroup2
              : {};

            const diabeticPayload = convertFormDataToMmolL(group1);
            const heartPayload = convertFormDataToMmolL(group2);

            report.diabeticModelResult = await postRiskModel(DIABETIC_MODEL_URL, diabeticPayload);
            report.heartModelResult = await postRiskModel(HEART_MODEL_URL, heartPayload);
          }
          stepCompleted(controller, "risk_models", "Risk model calls completed");

          stepStarted(controller, "save_lab_reports", "Persisting lab reports to backend");
          for (const report of reportResults) {
            const saveRes = await fetchLabBackend("/api/lab-reports/", {
              method: "POST",
              headers: { "Content-Type": "application/json" },
              body: JSON.stringify({
                reportDate: report.reportDate,
                reportLabel: report.label,
                extractedJsonGroup1: report.analysis.extractedJsonGroup1 ?? {},
                extractedJsonGroup2: report.analysis.extractedJsonGroup2 ?? {},
                labComparison: report.analysis.labComparison ?? [],
                summary: report.analysis.summary,
                recommendedTests: report.analysis.recommendedTests ?? [],
                dailyHealthAdvice: report.analysis.dailyHealthAdvice ?? [],
                patientInfo: report.analysis.patientInfo ?? {},
                patientId: resolvedLabPatientId,
              }),
            });

            if (!saveRes.ok) {
              throw new Error(`Failed to save report ${report.label}`);
            }

            const saved = (await saveRes.json()) as Record<string, unknown>;
            report.backendReportId = saved.id ? String(saved.id) : null;
          }
          stepCompleted(controller, "save_lab_reports", "Lab reports persisted");

          const reportIds = reportResults
            .map((report) => report.backendReportId)
            .filter((value): value is string => Boolean(value));

          if (reportIds.length === 0) {
            throw new Error("No report IDs were persisted; cannot continue to lab-agent job");
          }

          stepStarted(controller, "create_lab_agent_job", "Creating lab-agent orchestration job");
          let createJobRes = await createLabAgentJob(resolvedLabPatientId, reportIds, payload);

          if (!createJobRes.ok) {
            let bodyText = "";
            try {
              bodyText = (await createJobRes.text()).trim();
            } catch {
              bodyText = "";
            }
            const compactBody = bodyText ? bodyText.replace(/\s+/g, " ").slice(0, 500) : "<empty>";
            console.error(
              `[lab-orchestrate] Failed to create lab-agent job at ${LAB_BACKEND_URL}/api/lab-agent/jobs status=${createJobRes.status} body=${compactBody}`,
            );
            throw new Error(
              `Failed to create lab-agent job (${createJobRes.status})${bodyText ? `: ${compactBody}` : ""}`,
            );
          }
          const labAgentJob = (await createJobRes.json()) as Record<string, unknown>;
          const jobId = String(labAgentJob.id ?? "");
          if (!jobId) {
            throw new Error("Lab-agent job did not return an id");
          }
          stepCompleted(controller, "create_lab_agent_job", "Lab-agent job created");

          stepStarted(controller, "run_lab_agent_analysis", "Running lab-agent analyze");
          const analyzeRes = await fetchLabBackend(
            `/api/lab-agent/jobs/${encodeURIComponent(jobId)}/analyze`,
            {
              method: "POST",
              headers: { "Content-Type": "application/json" },
              body: JSON.stringify({
                evidenceSourceIds: payload.options?.evidenceSourceIds ?? [],
                topK: payload.options?.topK ?? 8,
                force: payload.options?.force ?? true,
              }),
            },
          );

          if (!analyzeRes.ok) {
            let bodyText = "";
            try {
              bodyText = (await analyzeRes.text()).trim();
            } catch {
              bodyText = "";
            }
            const compactBody = bodyText ? bodyText.replace(/\s+/g, " ").slice(0, 500) : "<empty>";
            console.error(
              `[lab-orchestrate] Failed to analyze lab-agent job at ${LAB_BACKEND_URL}/api/lab-agent/jobs/${jobId}/analyze status=${analyzeRes.status} body=${compactBody}`,
            );
            throw new Error(
              `Lab-agent analyze failed (${analyzeRes.status})${bodyText ? `: ${compactBody}` : ""}`,
            );
          }
          const labAgentResult = (await analyzeRes.json()) as Record<string, unknown>;
          stepCompleted(controller, "run_lab_agent_analysis", "Lab-agent analysis completed");

          emit(controller, {
            type: "final",
            result: {
              status: "COMPLETED",
              startedAt,
              finishedAt: Date.now(),
              durationMs: Date.now() - startedAt,
              patientId: resolvedFrontendPatientId,
              reports: reportResults,
              labAgent: {
                job: labAgentJob,
                result: labAgentResult,
              },
            },
          });
          controller.close();
        } catch (error: unknown) {
          const message =
            typeof error === "object" &&
            error !== null &&
            typeof Reflect.get(error, "message") === "string"
              ? (Reflect.get(error, "message") as string)
              : "One-click orchestration failed";
          emit(controller, {
            type: "error",
            status: "failed",
            message,
            timestamp: Date.now(),
          });
          controller.close();
        }
      })();
    },
  });

  return new Response(stream, {
    headers: {
      "Content-Type": "application/x-ndjson; charset=utf-8",
      "Cache-Control": "no-cache, no-transform",
      Connection: "keep-alive",
    },
  });
}
