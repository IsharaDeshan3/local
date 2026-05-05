"""

Detects contradictions between a "common diagnosis" match and the
patient's actual ECG / lab data.

If the top common-condition match (e.g. standard MI) has significant
missing or contradictory evidence, this module flags the gap so that the
rare-case alert can fire with higher confidence.
"""

from __future__ import annotations

import logging
from dataclasses import dataclass, field
from typing import Any, Dict, List, Optional

logger = logging.getLogger(__name__)


CONDITION_PROFILES: Dict[str, Dict[str, Any]] = {
    "myocardial infarction": {
        "aliases": ["mi", "stemi", "nstemi", "heart attack",
                    "acute coronary syndrome", "acs"],
        "expected_ecg": ["ST elevation", "ST-segment elevation", "ST depression",
                         "ST-segment depression", "T-wave inversion",
                         "Q waves", "STEMI", "NSTEMI"],
        "expected_labs": {
            "troponin": {"direction": "elevated", "threshold": 0.04},
        },
        "critical_labs": ["troponin"],     # must be present for firm dx
    },
    "heart failure": {
        "aliases": ["hf", "chf", "congestive heart failure"],
        "expected_ecg": ["LVH", "atrial fibrillation", "LBBB"],
        "expected_labs": {
            "bnp": {"direction": "elevated", "threshold": 100},
        },
        "critical_labs": ["bnp"],
    },
    "pulmonary embolism": {
        "aliases": ["pe"],
        "expected_ecg": ["sinus tachycardia", "S1Q3T3",
                         "right axis deviation"],
        "expected_labs": {},
        "critical_labs": [],
    },
    "pericarditis": {
        "aliases": [],
        "expected_ecg": ["diffuse ST elevation", "PR depression"],
        "expected_labs": {},
        "critical_labs": [],
    },
    "aortic dissection": {
        "aliases": ["dissection"],
        "expected_ecg": [],               # often normal
        "expected_labs": {},
        "critical_labs": [],
    },
}


# -------------------------------------------------------------------- #
#  Result dataclass                                                      #
# -------------------------------------------------------------------- #

@dataclass
class ContradictionReport:
    """Output of the negative-filter check."""
    common_condition: str = ""
    has_contradictions: bool = False
    missing_critical_data: List[str] = field(default_factory=list)
    contradictory_findings: List[str] = field(default_factory=list)
    supporting_findings: List[str] = field(default_factory=list)
    data_gaps: List[str] = field(default_factory=list)

    @property
    def should_flag_rare(self) -> bool:
        """True when there is enough contradiction to investigate rare aetiology."""
        return self.has_contradictions or len(self.missing_critical_data) > 0

    def summary(self) -> str:
        parts = [f"Common condition: {self.common_condition}"]
        if self.contradictory_findings:
            parts.append("Contradictions: " + "; ".join(self.contradictory_findings))
        if self.missing_critical_data:
            parts.append("Missing critical: " + ", ".join(self.missing_critical_data))
        if self.data_gaps:
            parts.append("Data gaps: " + ", ".join(self.data_gaps))
        return " | ".join(parts)


# -------------------------------------------------------------------- #
#  Filter logic                                                          #
# -------------------------------------------------------------------- #

class NegativeFilter:
    """
    Checks whether the patient's actual data *contradicts* the top
    common-condition match.

    Input
    -----
    - ``condition``: name/alias of the common condition (from FAISS
      textbook match).
    - Actual ECG findings, lab values, and lab findings.

    Output
    ------
    A ``ContradictionReport`` that the rare-case flag module consumes.
    """

    def check(
        self,
        condition: str,
        ecg_findings: Optional[List[str]] = None,
        lab_values: Optional[Dict[str, float]] = None,
        lab_findings: Optional[List[str]] = None,
        symptoms_text: str = "",
    ) -> ContradictionReport:

        # SearchService calls this after a candidate common diagnosis has been
        # selected from textbook retrieval. The goal is to compare the common
        # hypothesis against the actual ECG/lab/symptom evidence before the rare
        # alert is allowed to fire.
        ecg_findings = ecg_findings or []
        lab_values = lab_values or {}
        lab_findings = lab_findings or []

        report = ContradictionReport(common_condition=condition)

        # --- Resolve condition profile ---
        profile = self._resolve_profile(condition)
        if profile is None:
            # Unknown condition — cannot check → assume no contradiction
            report.data_gaps.append(f"No profile for condition '{condition}'")
            return report

        # --- Check ECG ---
        self._check_ecg(profile, ecg_findings, report)

        # --- Check labs ---
        self._check_labs(profile, lab_values, lab_findings, report)

        # --- Check for unusual additional symptoms ---
        self._check_unusual_symptoms(condition, symptoms_text, report)

        # --- Final verdict ---
        report.has_contradictions = bool(report.contradictory_findings)

        return report

    # ---------------------------------------------------------------- #
    #  Internal helpers                                                  #
    # ---------------------------------------------------------------- #

    @staticmethod
    def _resolve_profile(condition: str) -> Optional[Dict[str, Any]]:
        # The common-condition label comes from SearchService's textbook phase.
        # This helper maps that label to a known profile so contradictions can
        # be checked against condition-specific expectations.
        cond_lower = condition.lower().strip()
        for name, profile in CONDITION_PROFILES.items():
            if cond_lower == name or cond_lower in profile.get("aliases", []):
                return profile
        # Fuzzy: check if condition contains any profile name
        for name, profile in CONDITION_PROFILES.items():
            if name in cond_lower:
                return profile
        return None

    @staticmethod
    def _check_ecg(
        profile: Dict[str, Any],
        ecg_findings: List[str],
        report: ContradictionReport,
    ) -> None:
        # ECG evidence is compared against the expected pattern for the common
        # diagnosis. A mismatch becomes a contradiction signal for the rare
        # case gate.
        expected = profile.get("expected_ecg", [])
        if not expected:
            return  # condition has no expected ECG pattern

        if not ecg_findings:
            report.data_gaps.append("ECG data not available")
            return

        ecg_text = " ".join(ecg_findings).lower()
        found_any = any(e.lower() in ecg_text for e in expected)
        if found_any:
            report.supporting_findings.append("ECG consistent with common diagnosis")
        else:
            report.contradictory_findings.append(
                f"ECG findings ({', '.join(ecg_findings)}) do not match "
                f"expected pattern for {report.common_condition}"
            )

    @staticmethod
    def _check_labs(
        profile: Dict[str, Any],
        lab_values: Dict[str, float],
        lab_findings: List[str],
        report: ContradictionReport,
    ) -> None:
        # Lab values and lab findings are checked together because the workflow
        # may provide either a structured numeric value or a flattened textual
        # result depending on which step produced the data.
        expected_labs = profile.get("expected_labs", {})
        critical_labs = profile.get("critical_labs", [])

        # Check for missing critical labs
        for lab in critical_labs:
            if lab not in lab_values and not any(
                lab.lower() in f.lower() for f in lab_findings
            ):
                report.missing_critical_data.append(lab)

        # Check value contradictions
        for lab_name, spec in expected_labs.items():
            val = lab_values.get(lab_name)
            if val is None:
                continue

            direction = spec["direction"]
            threshold = spec["threshold"]

            if direction == "elevated" and val < threshold:
                report.contradictory_findings.append(
                    f"{lab_name.capitalize()} is {val} (expected elevated >={threshold} "
                    f"for {report.common_condition})"
                )
            elif direction in ("normal", "normal_or_mild") and val > threshold * 3:
                report.contradictory_findings.append(
                    f"{lab_name.capitalize()} is {val} (unexpectedly high "
                    f"for {report.common_condition})"
                )

    @staticmethod
    def _check_unusual_symptoms(
        condition: str,
        symptoms_text: str,
        report: ContradictionReport,
    ) -> None:
        """Flag symptoms that don't fit the common condition profile."""
        # Symptoms are inspected last because they often provide the clearest
        # contradiction signal when the textbook match looks plausible but the
        # story does not fit the condition.
        if not symptoms_text:
            return

        symptoms_lower = symptoms_text.lower()

        # Allergic symptoms alongside cardiac presentation
        allergic_keywords = ["urticaria", "rash", "hives", "angioedema",
                             "bronchospasm", "anaphylaxis", "allergic reaction",
                             "eosinophilia", "elevated ige"]
        cardiac_conditions = ["myocardial infarction", "mi", "acs",
                              "heart attack", "stemi", "nstemi"]

        cond_lower = condition.lower()
        if any(c in cond_lower for c in cardiac_conditions):
            for kw in allergic_keywords:
                if kw in symptoms_lower:
                    report.contradictory_findings.append(
                        f"Allergic symptom '{kw}' is atypical for {condition}"
                    )

        # Young age with typical old-age condition
        # (age is embedded in symptoms text like "28-year-old")
        import re
        age_match = re.search(r"(\d{1,3})-?year", symptoms_lower)
        if age_match:
            age = int(age_match.group(1))
            if age < 35 and any(c in cond_lower for c in cardiac_conditions):
                report.contradictory_findings.append(
                    f"Patient age ({age}) is atypical for {condition}"
                )
