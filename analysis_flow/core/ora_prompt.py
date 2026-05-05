"""
core/ora_prompt.py
Enhanced for high-readability, visually structured clinical reports.
"""

from __future__ import annotations
import json
import re
from typing import Any, Dict

_OUTPUT_GUARDRAIL = (
    "Do not output prompt scaffolding, policy text, or instruction labels "
    "such as RULES, INPUT DATA, or TASK."
)

_CONTEXT_REFERENCE_RE = re.compile(r"^\[(\d+)\]\s+source=(\w+)\s+score=([0-9.]+)(.*)$")

_DISCLAIMER = (
    "***\n"
    "⚠️ **DISCLAIMER:** *This is an AI-assisted analysis for clinical decision "
    "support only. It is NOT a medical diagnosis. All findings must be "
    "verified through clinical judgment, appropriate diagnostic tests, "
    "and established medical guidelines before any treatment decisions.*"
)


def _coerce_text(value: Any, *, max_chars: int = 240) -> str:
    text = str(value or "").strip()
    if not text:
        return ""
    text = re.sub(r"\s+", " ", text)
    return text[:max_chars]


def _summarize_mapping(value: Dict[str, Any], *, max_parts: int = 6) -> str:
    if not isinstance(value, dict):
        return _coerce_text(value)

    # Prefer a single primary clinical label over raw key/value dumps.
    primary = (
        value.get("differential")
        or value.get("condition")
        or value.get("diagnosis")
        or value.get("name")
        or value.get("test_name")
        or value.get("test")
    )
    primary_text = _coerce_text(primary, max_chars=180)

    if primary_text:
        parts_primary: list[str] = [primary_text]
        confidence = value.get("confidence") or value.get("probability")
        if confidence not in (None, ""):
            conf_text = _coerce_text(confidence, max_chars=40)
            try:
                pct = float(str(confidence))
                if pct <= 1:
                    conf_text = f"{pct * 100:.0f}%"
            except Exception:
                pass
            parts_primary.append(f"confidence={conf_text}")

        severity = value.get("severity")
        if severity not in (None, ""):
            parts_primary.append(f"severity={_coerce_text(severity, max_chars=40)}")

        decisive = value.get("decisiveFinding") or value.get("decisive_finding")
        if decisive not in (None, ""):
            parts_primary.append(f"clue={_coerce_text(decisive, max_chars=140)}")

        return " | ".join(parts_primary[:max_parts])

    parts: list[str] = []
    preferred_keys = (
        "condition",
        "differential",
        "type",
        "name",
        "diagnosis",
        "test_name",
        "test",
        "summary",
        "severity",
        "confidence",
        "probability",
        "decisiveFinding",
        "decisive_finding",
        "evidence",
        "clinical_features",
        "description",
        "reasoning",
        "source",
        "pmcid",
        "doi",
        "year",
    )

    for key in preferred_keys:
        if key not in value or value.get(key) in (None, "", [], {}):
            continue
        raw = value.get(key)
        if isinstance(raw, list):
            text = "; ".join(_coerce_text(item, max_chars=120) for item in raw if _coerce_text(item, max_chars=120))
        elif isinstance(raw, dict):
            text = ", ".join(
                f"{k}={_coerce_text(v, max_chars=80)}" for k, v in raw.items() if v not in (None, "", [], {})
            )
        else:
            text = _coerce_text(raw, max_chars=160)

        if text:
            if key in {"confidence", "probability"}:
                try:
                    pct = float(str(raw))
                    if pct <= 1:
                        text = f"{pct * 100:.0f}%"
                except Exception:
                    pass
            label = key.replace("_", " ").title()
            parts.append(f"{label}: {text}")
        if len(parts) >= max_parts:
            break

    if parts:
        return " | ".join(parts)

    fallback = ", ".join(
        f"{k}={_coerce_text(v, max_chars=120)}" for k, v in value.items() if v not in (None, "", [], {})
    )
    return fallback or _coerce_text(value)


def _entry_to_text(value: Any) -> str:
    if isinstance(value, dict):
        return _summarize_mapping(value)
    if isinstance(value, list):
        return "; ".join(text for item in value if (text := _entry_to_text(item)))
    return _coerce_text(value)


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

# ── Experience-level-specific instructions ──────────────────────────────── #

_NEWBIE_INSTRUCTIONS = f"""\
You are a medical educator creating a diagnostic report for a JUNIOR DOCTOR
or medical student. Your goal is to teach while informing. Use clear headers,
bolding, and plain-language explanations so the reader understands both the
WHAT and the WHY behind each finding.

Write a polished markdown report that is easy to scan. Never reproduce raw
Python dicts, JSON blobs, or object dumps from the prompt. Translate all
structured inputs into readable prose, bullets, and tables.

When you cite evidence, use the numbered references provided in the prompt as
[R1], [R2], etc. Include a final references section that lists the sources
you relied on.

Keep the report concise. Prefer short paragraphs, bullets, and compact tables.
Do not write long explanations when a brief clinical summary is sufficient.

## AI Diagnosis

## 📋 DIAGNOSTIC SUMMARY
---
**Overview:** [1-2 sentence overview in plain, non-jargon language]

**Clinical Picture:** [Brief narrative explaining how the symptoms, ECG, and
labs fit together to point toward the diagnosis. Explain causation simply.]

## 🔍 KEY FINDINGS
---
| Condition | Likelihood | Severity | Key Clue |
| :--- | :--- | :--- | :--- |
| **[Condition Name]** | [High/Moderate/Low] | **[LEVEL]** | [The single strongest piece of evidence] |

For each condition listed above, provide:
* **What this means:** [Plain-language explanation of the condition]
* **The Evidence:** [List the specific findings that support it]
* **Why this severity?** [Explain what makes it CRITICAL/HIGH/MODERATE/LOW]

## ⚠️ URGENT CONCERNS (RED FLAGS)
---
If the KRA flagged red flags, list each one with an explanation:
* **[Finding]:** [WHY this is dangerous and what could happen if missed]

If no red flags were identified, write: *No immediate life-threatening
concerns identified in this presentation.*

## 📝 DIAGNOSTIC GAPS
---
* **Missing Data:** [What information is missing — e.g., "No ECG available"]
* **Impact:** [How this gap limits diagnostic certainty]
* **What to watch for:** [Clinical signs that would change the picture]

## 🧪 RECOMMENDED WORKUP
---
Prioritize tests that would most change management:
1.  **[Test Name]** — *Why:* [What diagnostic question it answers]
2.  **[Test Name]** — *Why:* [What diagnostic question it answers]

## 📚 REFERENCES
---
* [R1] [Source description]
* [R2] [Source description]

{_DISCLAIMER}

{_OUTPUT_GUARDRAIL}

Return only the final report content. Do NOT echo constraints, rules, or instructions.
"""

_SEASONED_INSTRUCTIONS = f"""\
You are a senior cardiologist providing a high-density clinical brief for an
EXPERIENCED ATTENDING. Use professional medical terminology, concise phrasing,
and tight structure. Assume the reader can interpret clinical data directly.

Write a polished markdown report that is easy to scan. Never reproduce raw
Python dicts, JSON blobs, or object dumps from the prompt. Translate all
structured inputs into readable prose, bullets, and tables.

When you cite evidence, use the numbered references provided in the prompt as
[R1], [R2], etc. Include a final references section that lists the sources
you relied on.

Keep the report concise. Prefer short paragraphs, bullets, and compact tables.
Do not write long explanations when a brief clinical summary is sufficient.

## AI Diagnosis

# CLINICAL ASSESSMENT BRIEF
---

### 🩺 DIFFERENTIAL DIAGNOSIS
| Rank | Differential | Confidence | Severity | Decisive Finding |
| :--- | :--- | :--- | :--- | :--- |
| 1 | **[Condition]** | [X]% | **[LEVEL]** | [Single most discriminating finding] |
| 2 | **[Condition]** | [X]% | **[LEVEL]** | [Single most discriminating finding] |

**Clinical Correlation:**
* **Supporting Evidence:** [Concise list of corroborating findings]
* **Pathophysiology:** [Mechanism linking findings to diagnosis]
* **Against:** [Any findings that argue against this diagnosis, if applicable]

### 🚩 CLINICAL CONCERNS
List only actionable red flags with their clinical significance:
* **[Finding]** — [Risk: what it portends and urgency level]

### 🔍 DIAGNOSTIC GAPS & LIMITATIONS
* **[Missing data point]** → *Impact: [How it shifts the differential or risk stratification]*

### ⚡ RECOMMENDED WORKUP (PRIORITIZED)
| Priority | Investigation | Diagnostic Target |
| :--- | :--- | :--- |
| STAT | **[Test]** | [What it rules in/out] |
| Urgent | **[Test]** | [What it rules in/out] |

### 📚 REFERENCES
---
* [R1] [Source description]
* [R2] [Source description]

{_DISCLAIMER}

{_OUTPUT_GUARDRAIL}

Return only the final report content. Do NOT echo constraints, rules, or instructions.
"""

_LEVEL_MAP = {
    "NEWBIE": _NEWBIE_INSTRUCTIONS,
    "SEASONED": _SEASONED_INSTRUCTIONS,
}


def _compact_list(value: Any, *, max_items: int = 8, max_chars: int = 180) -> list[str]:
    """Normalize free-form model fields into short prompt-safe bullet strings."""
    items: list[str] = []

    if isinstance(value, list):
        source = value
    elif isinstance(value, dict):
        source = [value]
    elif value is None:
        source = []
    else:
        source = [value]

    for entry in source:
        text = _entry_to_text(entry).strip()
        if not text:
            continue
        items.append(text[:max_chars])
        if len(items) >= max_items:
            break

    return items


def _compact_recommended_tests(value: Any, *, max_items: int = 8) -> list[str]:
    tests: list[str] = []
    if isinstance(value, list):
        source = value
    elif value is None:
        source = []
    else:
        source = [value]

    for item in source:
        if isinstance(item, dict):
            text = _coerce_text(
                item.get("test_name")
                or item.get("name")
                or item.get("test")
                or _summarize_mapping(item)
            ).strip()
        else:
            text = _coerce_text(item).strip()
        if not text:
            continue
        tests.append(text[:180])
        if len(tests) >= max_items:
            break
    return tests


def _compact_kra_for_prompt(kra_result: Dict[str, Any]) -> Dict[str, Any]:
    """Keep only high-signal KRA fields so ORA prompts stay within practical size."""
    if not isinstance(kra_result, dict):
        kra_result = {}

    diagnoses: list[str] = []
    for item in kra_result.get("diagnoses") or []:
        if isinstance(item, dict):
            diagnoses.append(_summarize_mapping(item, max_parts=8))
        else:
            diagnoses.append(_coerce_text(item, max_chars=240))

    compact: Dict[str, Any] = {
        "summary": str(kra_result.get("summary") or "").strip()[:700],
        "diagnoses": diagnoses[:6],
        "differential": _compact_list(kra_result.get("differential") or kra_result.get("uncertainties")),
        "red_flags": _compact_list(kra_result.get("red_flags")),
        "recommended_tests": _compact_recommended_tests(kra_result.get("recommended_tests")),
        "confidence": kra_result.get("confidence"),
        "reasoning": str(kra_result.get("reasoning") or "").strip()[:1200],
    }

    return {key: value for key, value in compact.items() if value not in (None, "", [], {})}


def _compact_kra_input_for_prompt(kra_input: Dict[str, Any]) -> Dict[str, Any]:
    """Keep KRA input payload concise but clinically complete for ORA."""
    if not isinstance(kra_input, dict):
        kra_input = {}

    # WorkflowService builds the kra_input package from the retrieval context,
    # normalized symptoms, ECG, labs, and longitudinal history. This helper is
    # the final compression step before that material is embedded into the ORA
    # prompt, so it strips the payload down to the pieces the model actually
    # needs to reason over.
    symptoms = str(kra_input.get("symptoms_text") or "").strip()
    context = str(kra_input.get("context_text") or "").strip()
    history_summary = str(kra_input.get("history_summary_text") or "").strip()
    ecg = kra_input.get("ecg") if isinstance(kra_input.get("ecg"), dict) else {}
    labs = kra_input.get("labs") if isinstance(kra_input.get("labs"), dict) else {}
    quality = kra_input.get("quality") if isinstance(kra_input.get("quality"), dict) else {}
    references = _reference_lines_from_context(context)

    ecg_snapshot: list[str] = []
    if ecg:
        for label, key in (
            ("Status", "status"),
            ("Rhythm", "rhythm"),
            ("Heart rate", "heart_rate"),
            ("ST segment", "st_segment"),
            ("Interpretation", "interpretation"),
        ):
            value = ecg.get(key)
            if value not in (None, "", [], {}):
                ecg_snapshot.append(f"{label}: {_coerce_text(value, max_chars=180)}")
        for finding in _compact_list(ecg.get("findings"), max_items=8, max_chars=180):
            ecg_snapshot.append(f"Finding: {finding}")

    lab_snapshot: list[str] = []
    if labs:
        for label, key in (
            ("Status", "status"),
            ("Troponin", "troponin"),
            ("LDH", "ldh"),
            ("BNP", "bnp"),
            ("Creatinine", "creatinine"),
            ("Hemoglobin", "hemoglobin"),
        ):
            value = labs.get(key)
            if value not in (None, "", [], {}):
                lab_snapshot.append(f"{label}: {_coerce_text(value, max_chars=180)}")
        for finding in _compact_list(labs.get("findings"), max_items=10, max_chars=180):
            lab_snapshot.append(f"Finding: {finding}")

    compact: Dict[str, Any] = {
        "symptoms_text": symptoms[:1400],
        "ecg": ecg_snapshot,
        "labs": lab_snapshot,
        "history_summary_text": history_summary[:1400],
        "retrieval_context_excerpt": context[:2200],
        "references": references,
        "quality": {
            "status": quality.get("status"),
            "rare_search_gate": quality.get("rare_search_gate"),
            "top_common_condition": quality.get("top_common_condition"),
            "top_common_score": quality.get("top_common_score"),
            "rare_top_score": quality.get("rare_top_score"),
        },
    }

    for block_key in ("ecg", "labs", "quality"):
        block = compact.get(block_key)
        if isinstance(block, dict):
            compact[block_key] = {k: v for k, v in block.items() if v not in (None, "", [], {})}

    return {key: value for key, value in compact.items() if value not in (None, "", [], {})}

def build_ora_prompt(
    *,
    kra_input: Dict[str, Any],
    kra_result: Dict[str, Any],
    symptoms_text: str,
    experience_level: str,
) -> str:
    # ORAClient calls this after KRA has already finished. The prompt builder
    # receives the compact KRA input created above plus the compact KRA result,
    # and turns them into the final Gemini prompt for the selected experience
    # level.
    level = experience_level.upper()
    instructions = _LEVEL_MAP.get(level, _SEASONED_INSTRUCTIONS)
    required_headings = (
        [
            "## AI Diagnosis",
            "## 📋 DIAGNOSTIC SUMMARY",
            "## 🔍 KEY FINDINGS",
            "## ⚠️ URGENT CONCERNS (RED FLAGS)",
            "## 📝 DIAGNOSTIC GAPS",
            "## 🧪 RECOMMENDED WORKUP",
            "## 📚 REFERENCES",
        ]
        if level == "NEWBIE"
        else [
            "## AI Diagnosis",
            "# CLINICAL ASSESSMENT BRIEF",
            "### 🩺 DIFFERENTIAL DIAGNOSIS",
            "### 🚩 CLINICAL CONCERNS",
            "### 🔍 DIAGNOSTIC GAPS & LIMITATIONS",
            "### ⚡ RECOMMENDED WORKUP (PRIORITIZED)",
            "### 📚 REFERENCES",
        ]
    )
    required_headings_text = "\n".join(f"- {heading}" for heading in required_headings)
    compact_input = _compact_kra_input_for_prompt(kra_input)
    compact_kra = _compact_kra_for_prompt(kra_result)
    reference_lines = compact_input.get("references") or []

    def _bullet_lines(items: Any, *, max_chars: int = 320, empty_text: str = "Not available") -> str:
        if isinstance(items, list) and items:
            rendered = [
                f"  - {_coerce_text(item, max_chars=max_chars)}"
                for item in items
                if _coerce_text(item, max_chars=max_chars)
            ]
            return "\n".join(rendered) if rendered else f"  - {empty_text}"
        text = _coerce_text(items, max_chars=max_chars)
        return f"  - {text}" if text else f"  - {empty_text}"

    def _render_section(title: str, body_lines: list[str]) -> str:
        body = "\n".join(body_lines).strip()
        return f"{title}\n{body}" if body else f"{title}\n*No structured data available.*"

    input_section = _render_section(
        "CLINICAL INPUT SNAPSHOT:",
        [
            f"- Symptoms / history: {_coerce_text(compact_input.get('symptoms_text', ''), max_chars=900) or 'Not provided'}",
            "- ECG findings:",
            _bullet_lines(compact_input.get("ecg"), max_chars=220),
            "- Lab findings:",
            _bullet_lines(compact_input.get("labs"), max_chars=220),
            f"- History summary: {_coerce_text(compact_input.get('history_summary_text', ''), max_chars=500) or 'Not available'}",
            f"- Retrieval context excerpt: {_coerce_text(compact_input.get('retrieval_context_excerpt', ''), max_chars=900) or 'Not available'}",
            f"- Retrieval quality: {_summarize_mapping(compact_input.get('quality', {}), max_parts=4) or 'Not available'}",
            "- Retrieval references:",
            _bullet_lines(reference_lines, max_chars=500, empty_text="No supporting references available"),
        ],
    )

    kra_section = _render_section(
        "KRA DIAGNOSTIC SNAPSHOT:",
        [
            f"- Summary: {_coerce_text(compact_kra.get('summary', ''), max_chars=700) or 'Not available'}",
            "- Diagnoses:",
            _bullet_lines(compact_kra.get("diagnoses"), max_chars=260),
            "- Differential / uncertainties:",
            _bullet_lines(compact_kra.get("differential"), max_chars=260),
            "- Red flags:",
            _bullet_lines(compact_kra.get("red_flags"), max_chars=260),
            "- Recommended tests:",
            _bullet_lines(compact_kra.get("recommended_tests"), max_chars=260),
            f"- Reasoning: {_coerce_text(compact_kra.get('reasoning', ''), max_chars=900) or 'Not available'}",
        ],
    )

    sections = [
        instructions,
        "\n═══ INPUT DATA ═══",
        f"PATIENT PRESENTATION:\n{symptoms_text.strip()}",
        f"\n{input_section}",
        f"\n{kra_section}",
        "\n═══ TASK ═══",
        f"Generate the {level}-level clinical report following the exact "
        "section structure and formatting specified above. Use bolding, "
        "tables, and bullet lists to make it visually scannable. "
        "Target a clinician-readable summary, not a long narrative. "
        "Aim for approximately 350-650 words for NEWBIE and 250-500 words for SEASONED. "
        "Use these exact headings in this exact order:\n"
        f"{required_headings_text}\n"
        "For each leading diagnosis include up to three supporting findings, "
        "one counterpoint, and a short rationale for each recommended test. "
        "Use the numbered references from the prompt "
        "as support in the body of the report, and add a concise references "
        "section at the end. Never echo the input as raw dicts, JSON, or code "
        "blocks. Convert all structured data into prose or tables. "
        "Do not use markdown code blocks. Do not add sections that are "
        "not in the template. Fill every section — if a section has no "
        "relevant data, state that explicitly rather than omitting it. "
        "Output only the report body; do not print instructions, policy text, "
        "or labels like RULES/INPUT DATA/TASK.",
    ]

    return "\n".join(sections)