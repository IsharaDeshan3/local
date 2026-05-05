"""
Remote ORA refinement client using Gemini API calls.
"""

from __future__ import annotations

import logging
import os
import re
import threading
import time
from typing import Any, Dict, Optional

import requests
from requests.adapters import HTTPAdapter
from urllib3.util.retry import Retry

logger = logging.getLogger(__name__)

_VALID_LEVELS = {"NEWBIE", "SEASONED"}

_PROMPT_LEAK_MARKERS = (
    "RULES:",
    "RULES",
    "Internal authoring constraints",
    "═══ INPUT DATA ═══",
    "PATIENT PRESENTATION:",
    "KRA INPUT OBJECT:",
    "KRA OUTPUT OBJECT:",
    "KRA ANALYSIS:",
    "═══ TASK ═══",
)

_PROMPT_LEAK_LINE_RE = re.compile(
    r"(?im)^\s*(RULES:?|INTERNAL AUTHORING CONSTRAINTS(?:\s*\(.*\))?:?|═══ INPUT DATA ═══|PATIENT PRESENTATION:|KRA INPUT OBJECT:|KRA OUTPUT OBJECT:|KRA ANALYSIS:|═══ TASK ═══)\s*$"
)

_CONTEXT_REFERENCE_RE = re.compile(r"^\[(\d+)\]\s+source=(\w+)\s+score=([0-9.]+)(.*)$")


def _strip_prompt_scaffold(text: str) -> str:
    """Trim trailing leaked prompt scaffolding if the model echoes it."""
    match = _PROMPT_LEAK_LINE_RE.search(text)
    if match and match.start() > 0:
        return text[: match.start()].rstrip()
    return text


def _deobjectify_text(text: str) -> str:
    """Replace Python-dict-like fragments with human-readable labels."""
    if not text:
        return ""

    cleaned = text

    # Typical KRA dict fragments copied into ORA outputs.
    replacements = [
        (r"\{[^{}]*'differential'\s*:\s*'([^']+)'[^{}]*\}", r"\1"),
        (r"\{[^{}]*'condition'\s*:\s*'([^']+)'[^{}]*\}", r"\1"),
        (r"\{[^{}]*'diagnosis'\s*:\s*'([^']+)'[^{}]*\}", r"\1"),
        (r"\{[^{}]*'test(?:_name)?'\s*:\s*'([^']+)'[^{}]*\}", r"\1"),
    ]
    for pattern, repl in replacements:
        cleaned = re.sub(pattern, repl, cleaned, flags=re.IGNORECASE | re.DOTALL)

    # Handle malformed rank/differential fragments that may miss braces formatting.
    cleaned = re.sub(
        r"\*\*\s*\{?\s*'rank'\s*:?\s*\d+\s*,\s*'differential'\s*:\s*'([^']+)'[^*|]*\*\*",
        r"**\1**",
        cleaned,
        flags=re.IGNORECASE | re.DOTALL,
    )

    # Remove noisy rank key leftovers.
    cleaned = re.sub(r"'rank'\s*:?\s*\d+\s*,?\s*", "", cleaned, flags=re.IGNORECASE)

    cleaned = re.sub(r"\s{2,}", " ", cleaned)
    return cleaned.strip()


def _sanitize_refined_output(text: str) -> str:
    cleaned = (text or "").strip()
    if not cleaned:
        return cleaned

    cleaned = cleaned.replace("```markdown", "").replace("```", "").strip()

    if any(marker in cleaned for marker in _PROMPT_LEAK_MARKERS):
        anchors = [
            "# CLINICAL ASSESSMENT BRIEF",
            "## 📋 DIAGNOSTIC SUMMARY",
            "### 🩺 DIFFERENTIAL DIAGNOSIS",
            "**Overview:**",
        ]
        anchor_positions = [cleaned.find(anchor) for anchor in anchors if cleaned.find(anchor) >= 0]
        if anchor_positions:
            cleaned = cleaned[min(anchor_positions):].strip()
        else:
            filtered_lines: list[str] = []
            for line in cleaned.splitlines():
                stripped = line.strip()
                if not stripped:
                    filtered_lines.append(line)
                    continue
                if any(stripped.startswith(marker) for marker in _PROMPT_LEAK_MARKERS):
                    continue
                if stripped.startswith(tuple(f"{i}." for i in range(1, 10))):
                    continue
                filtered_lines.append(line)
            cleaned = "\n".join(filtered_lines).strip()

    cleaned = _strip_prompt_scaffold(cleaned)
    cleaned = re.sub(r"(?im)^\s*Return only the final report content\..*$", "", cleaned).strip()
    cleaned = _deobjectify_text(cleaned)

    if "No supporting references were available in the prompt context" in cleaned and "[R" not in cleaned:
        cleaned = re.sub(
            r"(?is)\n?(?:###|##)\s*📚\s*REFERENCES\s*(?:---)?\s*.*$",
            "",
            cleaned,
        ).strip()
        cleaned = cleaned.replace(
            "*No supporting references were available in the prompt context.*",
            "",
        ).strip()

    return cleaned


def _extract_gemini_text(payload: Dict[str, Any]) -> str:
    candidates = payload.get("candidates")
    if not isinstance(candidates, list):
        return ""

    for candidate in candidates:
        if not isinstance(candidate, dict):
            continue
        content = candidate.get("content") or {}
        parts = content.get("parts") or []
        text_chunks: list[str] = []
        for part in parts:
            if isinstance(part, dict):
                chunk = str(part.get("text") or "").strip()
                if chunk:
                    text_chunks.append(chunk)
        if text_chunks:
            return "\n".join(text_chunks).strip()

    return ""


def _to_text_list(value: Any, *, max_items: int = 6) -> list[str]:
    """Normalize KRA fields into short plain-text lists."""

    def _dict_to_text(entry: Dict[str, Any]) -> str:
        """Render common KRA dict payloads into concise clinical text."""
        if not isinstance(entry, dict):
            return str(entry or "").strip()

        primary = (
            entry.get("differential")
            or entry.get("condition")
            or entry.get("diagnosis")
            or entry.get("name")
            or entry.get("test")
            or entry.get("test_name")
            or entry.get("finding")
            or ""
        )
        primary_text = str(primary).strip()

        extras: list[str] = []
        confidence = entry.get("confidence")
        if confidence not in (None, ""):
            extras.append(f"confidence={confidence}")
        severity = entry.get("severity")
        if severity not in (None, ""):
            extras.append(f"severity={severity}")
        decisive = entry.get("decisiveFinding") or entry.get("decisive_finding")
        if decisive not in (None, ""):
            extras.append(f"clue={str(decisive).strip()}")

        if primary_text and extras:
            return f"{primary_text} ({'; '.join(extras)})"
        if primary_text:
            return primary_text

        # Fallback for unknown dict schema.
        rendered = [
            f"{k}={v}"
            for k, v in entry.items()
            if v not in (None, "", [], {})
        ]
        return "; ".join(rendered)

    if value is None:
        items: list[Any] = []
    elif isinstance(value, list):
        items = value
    elif isinstance(value, dict):
        items = [f"{k}: {v}" for k, v in value.items()]
    else:
        items = [value]

    out: list[str] = []
    for item in items:
        if isinstance(item, dict):
            text = _dict_to_text(item)
        else:
            text = str(item).strip()
        if not text:
            continue
        out.append(text)
        if len(out) >= max_items:
            break
    return out


def _reference_lines_from_context(context_text: str, *, max_items: int = 6) -> list[str]:
    references: list[str] = []
    for line in (context_text or "").splitlines():
        match = _CONTEXT_REFERENCE_RE.match(line.strip())
        if not match:
            continue
        ref_num = match.group(1)
        source = match.group(2)
        score = match.group(3)
        tail = match.group(4).strip().lstrip("|").strip()
        label = f"[R{ref_num}] {source} | score={score}"
        if tail:
            label = f"{label} | {tail}"
        references.append(label)
        if len(references) >= max_items:
            break
    return references


def _is_report_incomplete(text: str, level: str) -> bool:
    """Heuristic guard: detect short or structurally incomplete ORA reports."""
    cleaned = (text or "").strip()
    if not cleaned:
        return True

    min_chars = 1200 if level == "NEWBIE" else 900
    if len(cleaned) < min_chars:
        return True

    required_headings = (
        [
            "## AI Diagnosis",
            "## 📋 DIAGNOSTIC SUMMARY",
            "## 🔍 KEY FINDINGS",
            "## 📝 DIAGNOSTIC GAPS",
            "## 🧪 RECOMMENDED WORKUP",
            "## 📚 REFERENCES",
        ]
        if level == "NEWBIE"
        else [
            "## AI Diagnosis",
            "# CLINICAL ASSESSMENT BRIEF",
            "### 🩺 DIFFERENTIAL DIAGNOSIS",
            "### 🔍 DIAGNOSTIC GAPS & LIMITATIONS",
            "### ⚡ RECOMMENDED WORKUP (PRIORITIZED)",
            "### 📚 REFERENCES",
        ]
    )
    missing = [heading for heading in required_headings if heading not in cleaned]
    return len(missing) >= 2


def _build_fallback_report(*, level: str, kra_input: Dict[str, Any], kra_result: Dict[str, Any], symptoms_text: str) -> str:
    """Synthesize a complete report from KRA artifacts when ORA text is too short."""
    diagnoses = _to_text_list(kra_result.get("diagnoses"), max_items=3)
    uncertainties = _to_text_list(
        kra_result.get("uncertainties") or kra_result.get("differential"),
        max_items=4,
    )
    recommended_tests = _to_text_list(kra_result.get("recommended_tests"), max_items=6)
    red_flags = _to_text_list(kra_result.get("red_flags"), max_items=4)

    ecg = kra_input.get("ecg") if isinstance(kra_input.get("ecg"), dict) else {}
    labs = kra_input.get("labs") if isinstance(kra_input.get("labs"), dict) else {}
    history_summary = str(kra_input.get("history_summary_text") or "").strip()
    references = _reference_lines_from_context(str(kra_input.get("context_text") or ""))

    evidence: list[str] = []
    if symptoms_text.strip():
        evidence.append(f"Presenting symptoms/history: {symptoms_text.strip()[:220]}")
    if ecg.get("status") == "present":
        ecg_findings = _to_text_list(ecg.get("findings"), max_items=2)
        if ecg_findings:
            evidence.append("ECG findings: " + "; ".join(ecg_findings))
        rhythm = str(ecg.get("rhythm") or "").strip()
        if rhythm:
            evidence.append(f"ECG rhythm: {rhythm}")
    if labs.get("status") == "present":
        lab_findings = _to_text_list(labs.get("findings"), max_items=3)
        if lab_findings:
            evidence.append("Lab findings: " + "; ".join(lab_findings))

    if not evidence:
        evidence.append("Evidence is limited in this run; correlate closely with bedside exam and additional tests.")

    gaps: list[str] = []
    if ecg.get("status") != "present":
        gaps.append("ECG data unavailable or skipped")
    if labs.get("status") != "present":
        gaps.append("Lab panel unavailable or skipped")
    if not history_summary:
        gaps.append("Longitudinal patient history summary unavailable")
    if uncertainties:
        gaps.extend([f"Diagnostic uncertainty: {u}" for u in uncertainties[:2]])
    if not gaps:
        gaps.append("No explicit data gaps reported by KRA")

    if not diagnoses:
        diagnoses = ["Undifferentiated cardiac syndrome (insufficient structured KRA diagnosis list)"]
    if not recommended_tests:
        recommended_tests = [
            "Serial troponin trend",
            "Repeat ECG with dynamic comparison",
            "Urgent echocardiogram",
        ]

    if level == "NEWBIE":
        rows = []
        for idx, diagnosis in enumerate(diagnoses[:3], start=1):
            likelihood = "High" if idx == 1 else "Moderate"
            severity = "HIGH" if idx == 1 else "MODERATE"
            clue = evidence[min(idx - 1, len(evidence) - 1)]
            rows.append(f"| **{diagnosis}** | {likelihood} | **{severity}** | {clue} |")

        workup_lines = [
            f"{idx}. **{test}** — *Why:* Clarifies diagnostic uncertainty and helps prioritize immediate management."
            for idx, test in enumerate(recommended_tests[:5], start=1)
        ]

        red_flag_lines = (
            [f"* **{flag}:** Requires immediate clinical attention and escalation if corroborated clinically." for flag in red_flags]
            if red_flags
            else ["*No immediate life-threatening concerns identified in this presentation.*"]
        )

        newbie_sections = [
            "## AI Diagnosis",
            "## 📋 DIAGNOSTIC SUMMARY",
            "---",
            "**Overview:** KRA indicates a clinically significant cardiopulmonary differential that requires urgent confirmation with targeted testing and close monitoring.",
            "",
            "**Clinical Picture:** " + evidence[0],
            "",
            "## 🔍 KEY FINDINGS",
            "---",
            "| Condition | Likelihood | Severity | Key Clue |",
            "| :--- | :--- | :--- | :--- |",
            *rows,
            "",
            "## ⚠️ URGENT CONCERNS (RED FLAGS)",
            "---",
            *red_flag_lines,
            "",
            "## 📝 DIAGNOSTIC GAPS",
            "---",
            *[f"* **Missing Data:** {gap}\n* **Impact:** Limits diagnostic confidence and should be addressed before definitive decisions." for gap in gaps[:4]],
            "",
            "## 🧪 RECOMMENDED WORKUP",
            "---",
            *workup_lines,
        ]
        if references:
            newbie_sections.extend([
                "",
                "## 📚 REFERENCES",
                "---",
                *[f"- {ref}" for ref in references],
            ])

        return "\n".join(newbie_sections)

    diff_rows = []
    for idx, diagnosis in enumerate(diagnoses[:3], start=1):
        confidence = "70%" if idx == 1 else ("58%" if idx == 2 else "46%")
        severity = "HIGH" if idx == 1 else "MODERATE"
        decisive = evidence[min(idx - 1, len(evidence) - 1)]
        diff_rows.append(f"| {idx} | **{diagnosis}** | {confidence} | **{severity}** | {decisive} |")

    concern_lines = (
        [f"* **{flag}** — Clinically significant; correlate immediately with hemodynamics and serial trend data." for flag in red_flags]
        if red_flags
        else ["* No explicit KRA red flags were emitted in this run; continue standard risk surveillance."]
    )

    workup_rows = [
        f"| {'STAT' if idx == 1 else 'Urgent'} | **{test}** | Refines differential ranking and immediate management decisions. |"
        for idx, test in enumerate(recommended_tests[:5], start=1)
    ]

    seasoned_sections = [
        "## AI Diagnosis",
        "# CLINICAL ASSESSMENT BRIEF",
        "---",
        "### 🩺 DIFFERENTIAL DIAGNOSIS",
        "| Rank | Differential | Confidence | Severity | Decisive Finding |",
        "| :--- | :--- | :--- | :--- | :--- |",
        *diff_rows,
        "",
        "**Clinical Correlation:**",
        "* **Supporting Evidence:** " + "; ".join(evidence[:3]),
        "* **Pathophysiology:** Findings suggest active cardiopulmonary stress/injury pathway that needs rapid etiology confirmation.",
        "* **Against:** Absence of complete multimodal data reduces certainty for definitive single-etiology assignment.",
        "",
        "### 🚩 CLINICAL CONCERNS",
        *concern_lines,
        "",
        "### 🔍 DIAGNOSTIC GAPS & LIMITATIONS",
        *[f"* **{gap}** -> *Impact: could materially shift risk stratification and treatment urgency.*" for gap in gaps[:4]],
        "",
        "### ⚡ RECOMMENDED WORKUP (PRIORITIZED)",
        "| Priority | Investigation | Diagnostic Target |",
        "| :--- | :--- | :--- |",
        *workup_rows,
    ]
    if references:
        seasoned_sections.extend([
            "",
            "### 📚 REFERENCES",
            "---",
            *[f"- {ref}" for ref in references],
        ])

    return "\n".join(seasoned_sections)


class ORAClient:
    """ORA refinement client backed by Google Gemini API."""

    def __init__(self) -> None:
        self._api_keys = self._load_api_keys()
        self._key_index = 0
        self._key_lock = threading.Lock()
        self._model = os.getenv("GEMINI_MODEL", "gemini-2.5-flash").strip()
        self._api_base = os.getenv("GEMINI_API_BASE", "https://generativelanguage.googleapis.com/v1beta").rstrip("/")

        try:
            timeout_raw = os.getenv("ORA_GEMINI_TIMEOUT_SEC") or os.getenv("ORA_TIMEOUT_SEC") or "120"
            self._timeout_sec = max(5.0, float(timeout_raw))
        except ValueError:
            self._timeout_sec = 120.0

        try:
            self._temperature = float(os.getenv("ORA_GEMINI_TEMPERATURE", "0.2"))
        except ValueError:
            self._temperature = 0.2

        try:
            self._top_p = float(os.getenv("ORA_GEMINI_TOP_P", "0.9"))
        except ValueError:
            self._top_p = 0.9

        try:
            self._max_output_tokens = max(512, int(os.getenv("ORA_GEMINI_MAX_OUTPUT_TOKENS", "4096")))
        except ValueError:
            self._max_output_tokens = 4096

        self._session = requests.Session()
        # Disable implicit HTTP retries for POST so request latency stays predictable.
        adapter = HTTPAdapter(max_retries=Retry(total=0, connect=0, read=0, status=0))
        self._session.mount("https://", adapter)
        self._session.mount("http://", adapter)

    @staticmethod
    def _load_api_keys() -> list[str]:
        """Load Gemini keys from env with stable order and duplicate filtering."""
        raw_values: list[str] = []

        key_list_env = os.getenv("GEMINI_API_KEYS", "").strip()
        if key_list_env:
            raw_values.extend(part.strip() for part in key_list_env.split(","))

        raw_values.extend(
            [
                os.getenv("GEMINI_API_KEY", "").strip(),
                os.getenv("GEMINI_API_KEY_2", "").strip(),
            ]
        )

        deduped: list[str] = []
        seen: set[str] = set()
        for value in raw_values:
            if not value or value in seen:
                continue
            deduped.append(value)
            seen.add(value)
        return deduped

    def _next_api_key(self) -> str:
        """Round-robin key selection; safe across concurrent ORA calls."""
        with self._key_lock:
            if not self._api_keys:
                return ""
            key = self._api_keys[self._key_index % len(self._api_keys)]
            self._key_index += 1
            return key

    def _generate_url(self) -> str:
        return f"{self._api_base}/models/{self._model}:generateContent"

    def _model_url(self) -> str:
        return f"{self._api_base}/models/{self._model}"

    def refine(
        self,
        *,
        kra_input: Optional[Dict[str, Any]] = None,
        kra_result: Optional[Dict[str, Any]] = None,
        symptoms_text: str = "",
        experience_level: str = "SEASONED",
        cancel_event: Optional[threading.Event] = None,
        # Legacy kwargs (ignored but kept for backward compat)
        kra_output_id: Optional[str] = None,
        supabase_available: bool = True,
        inline_kra_result: Optional[Dict[str, Any]] = None,
    ) -> Dict[str, Any]:
        """Refine KRA output by calling Gemini generateContent API."""
        from core.ora_prompt import build_ora_prompt

        # WorkflowService is the caller here. It passes the KRA result, the
        # retrieval context assembled by SearchService, and the normalized
        # symptoms text. ORAClient turns that bundle into a prompt, sends it to
        # Gemini, then sanitizes the response before it is saved back to the
        # session history and shown in the UI.
        level = experience_level.upper()
        if level not in _VALID_LEVELS:
            logger.warning("Invalid experience_level '%s', defaulting to 'SEASONED'", experience_level)
            level = "SEASONED"

        if kra_result is None and inline_kra_result is not None:
            kra_result = inline_kra_result
        if kra_result is None:
            kra_result = {}
        if kra_input is None:
            kra_input = {}

        if cancel_event and cancel_event.is_set():
            raise RuntimeError("ANALYSIS_CANCELLED")

        if not self._api_keys:
            raise RuntimeError("GEMINI_API_KEY_NOT_CONFIGURED")

        prompt = build_ora_prompt(
            kra_input=kra_input,
            kra_result=kra_result,
            symptoms_text=symptoms_text,
            experience_level=level,
        )

        # The request body is the raw Gemini call. The prompt already contains
        # the compacted retrieval context and KRA snapshot, so this layer just
        # forwards it as a single text generation request.
        request_body: Dict[str, Any] = {
            "contents": [{"role": "user", "parts": [{"text": prompt}]}],
            "generationConfig": {
                "temperature": self._temperature,
                "topP": self._top_p,
                "maxOutputTokens": self._max_output_tokens,
            },
        }

        started = time.time()
        attempt_errors: list[str] = []
        response_payload: Dict[str, Any] | None = None
        raw_text = ""

        for attempt in range(len(self._api_keys)):
            api_key = self._next_api_key()
            if not api_key:
                break

            try:
                response = self._session.post(
                    self._generate_url(),
                    params={"key": api_key},
                    headers={"User-Agent": "analysis-flow-ora-client/1.0"},
                    json=request_body,
                    timeout=self._timeout_sec,
                )
            except requests.Timeout as exc:
                attempt_errors.append(f"attempt_{attempt + 1}:timeout:{exc}")
                continue
            except requests.RequestException as exc:
                attempt_errors.append(f"attempt_{attempt + 1}:request_failed:{exc}")
                continue

            if cancel_event and cancel_event.is_set():
                raise RuntimeError("ANALYSIS_CANCELLED")

            if response.status_code in {429, 500, 502, 503, 504}:
                detail = response.text[:160].replace("\n", " ")
                attempt_errors.append(f"attempt_{attempt + 1}:http_{response.status_code}:{detail}")
                continue
            if response.status_code >= 400:
                detail = response.text[:500]
                raise RuntimeError(f"ORA_GEMINI_HTTP_{response.status_code}:{detail}")

            try:
                response_payload = response.json()
            except ValueError as exc:
                attempt_errors.append(f"attempt_{attempt + 1}:invalid_json")
                continue

            raw_text = _extract_gemini_text(response_payload)
            if raw_text:
                break

            attempt_errors.append(f"attempt_{attempt + 1}:empty_output")

        if cancel_event and cancel_event.is_set():
            raise RuntimeError("ANALYSIS_CANCELLED")

        if not raw_text:
            error_preview = " | ".join(attempt_errors[:3])
            if error_preview:
                raise RuntimeError(f"ORA_GEMINI_RETRY_EXHAUSTED:{error_preview}")
            raise RuntimeError("ORA_OUTPUT_EMPTY")

        elapsed_ms = int((time.time() - started) * 1000)
        logger.info(
            "ORA Gemini refinement completed (%d ms, level=%s, attempts=%d)",
            elapsed_ms,
            level,
            len(attempt_errors) + 1,
        )

        refined_output = _sanitize_refined_output(raw_text)
        status = "success"

        # If the model response is incomplete, build a deterministic fallback
        # from the same KRA input so the workflow still returns a usable report
        # instead of failing the whole patient analysis run.
        if _is_report_incomplete(refined_output, level):
            logger.warning(
                "ORA output looked incomplete for level=%s (chars=%d); using structured fallback renderer",
                level,
                len(refined_output),
            )
            refined_output = _build_fallback_report(
                level=level,
                kra_input=kra_input,
                kra_result=kra_result,
                symptoms_text=symptoms_text,
            )
            status = "fallback_rendered"

        return {
            "refined_output": refined_output,
            "disclaimer": (
                "⚠️ DISCLAIMER: This is an AI-assisted analysis for clinical "
                "decision support only. It is NOT a medical diagnosis. All "
                "findings must be verified through clinical judgment."
            ),
            "status": status,
        }

    def health_check(self) -> bool:
        """Return True if Gemini model endpoint is reachable."""
        if not self._api_keys:
            return False

        for api_key in self._api_keys:
            try:
                response = self._session.get(
                    self._model_url(),
                    params={"key": api_key},
                    timeout=10,
                )
                if response.status_code < 400:
                    return True
            except requests.RequestException:
                continue
        return False
