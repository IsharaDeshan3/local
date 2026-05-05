"""
Builds a Unified Patient Vector from structured symptom, ECG, and lab data.
Produces two query strings:
  - main_query   → for the textbook FAISS index (general search)
  - rare_query   → for the rare-case FAISS index (anomaly-emphasised)

Weighting strategy:  sentence-transformer embeddings cannot be numerically
weighted per-token, so we apply *text emphasis* — anomalous / rare indicators
are repeated in the rare_query so that they dominate the embedding centroid.
"""

from __future__ import annotations
import logging
from dataclasses import dataclass, field
from typing import Any, Dict, List, Optional

logger = logging.getLogger(__name__)

# -------------------------------------------------------------------- #
#  Known "expected" findings for common cardiac conditions               #
#  Used to identify when something does NOT fit the common pattern       #
# -------------------------------------------------------------------- #

_COMMON_CONDITIONS = {
    "myocardial_infarction": {
        "expected_ecg": ["ST-segment elevation", "ST elevation", "ST depression",
                         "T-wave inversion", "Q waves", "STEMI", "NSTEMI"],
        "expected_labs": {"troponin": ("elevated", 0.04),    # ng/mL
                          "bnp": ("elevated", 100),
                          "ldh": ("elevated", 250)},
        "expected_symptoms": ["chest pain", "dyspnea", "diaphoresis",
                              "radiating pain", "jaw pain", "arm pain"],
    },
    "heart_failure": {
        "expected_ecg": ["LVH", "atrial fibrillation", "LBBB"],
        "expected_labs": {"bnp": ("elevated", 100),
                          "troponin": ("normal_or_mild", 0.04)},
        "expected_symptoms": ["dyspnea", "orthopnea", "edema",
                              "fatigue", "weight gain"],
    },
    "pulmonary_embolism": {
        "expected_ecg": ["sinus tachycardia", "S1Q3T3", "right axis deviation",
                         "T-wave inversion V1-V4"],
        "expected_labs": {"troponin": ("mild_elevation", 0.04)},
        "expected_symptoms": ["dyspnea", "pleuritic chest pain",
                              "tachycardia", "hemoptysis"],
    },
}


# -------------------------------------------------------------------- #
#  Output dataclass                                                      #
# -------------------------------------------------------------------- #

@dataclass
class UnifiedPatientVector:
    """Result of the vector-building process."""
    main_query: str                    # for textbook index
    rare_query: str                    # for rare-case index (anomaly-weighted)
    anomalies: List[str] = field(default_factory=list)
    data_completeness: Dict[str, bool] = field(default_factory=dict)
    raw_sections: Dict[str, str] = field(default_factory=dict)


# -------------------------------------------------------------------- #
#  Builder                                                               #
# -------------------------------------------------------------------- #

class UnifiedVectorBuilder:
    """
    Constructs the Unified Patient Vector.

    Usage::

        builder = UnifiedVectorBuilder()
        vector  = builder.build(
            symptoms_text="crushing chest pain with urticaria",
            ecg_findings=["ST-segment elevation", "sinus tachycardia"],
            lab_findings=["elevated troponin", "elevated IgE"],
            age=55, sex="M",
        )
        print(vector.rare_query)   # anomaly-emphasised query
    """

    # ----------------------------------------------------------------
    #  Public API
    # ----------------------------------------------------------------

    def build(
        self,
        symptoms_text: str,
        ecg_findings: Optional[List[str]] = None,
        lab_findings: Optional[List[str]] = None,
        lab_values: Optional[Dict[str, float]] = None,
        age: Optional[int] = None,
        sex: Optional[str] = None,
        chief_complaint: Optional[str] = None,
    ) -> UnifiedPatientVector:

        # WorkflowService passes normalized symptom text plus the flattened ECG
        # and lab findings into this builder through SearchService. The builder
        # does not talk to FAISS directly; it only prepares the two query
        # strings that the search layer will send to the textbook and rare-case
        # retrievers.

        ecg_findings = ecg_findings or []
        lab_findings = lab_findings or []
        lab_values = lab_values or {}

        # 1. Build individual sections.
        # Each section keeps the same information in a text form that is easy
        # for embedding models to consume, while still preserving the original
        # clinical meaning of the request payload.

        symptom_section = self._build_symptom_section(
            symptoms_text, age, sex, chief_complaint)
        ecg_section = self._build_ecg_section(ecg_findings)
        lab_section = self._build_lab_section(lab_findings, lab_values)

        # 2. Detect anomalies.
        # These are the terms that look unusual compared with common cardiac
        # patterns. SearchService uses them to decide whether rare-case search
        # should be turned on after the textbook result comes back.

        anomalies = self._detect_anomalies(
            symptoms_text, ecg_findings, lab_findings, lab_values)

        # 3. Data completeness.
        # The quality map produced here is returned all the way back to
        # WorkflowService so the pipeline can report whether the case was
        # strongly supported or mostly incomplete.

        completeness = {
            "symptoms": bool(symptoms_text.strip()),
            "ecg": bool(ecg_findings),
            "labs": bool(lab_findings or lab_values),
        }

        # 4. Build main query (flat concat).
        # This is the query SearchService sends to the textbook FAISS index.
        main_parts = [s for s in [symptom_section, ecg_section, lab_section] if s]
        main_query = "\n".join(main_parts)

        # 5. Build rare query (anomaly-emphasised).
        # The rare-case search path uses this text instead of the plain main
        # query because repeating anomaly terms pushes them higher in the
        # embedding centroid.
        
        rare_query = self._build_rare_query(
            main_query, anomalies, ecg_findings, lab_findings)


        return UnifiedPatientVector(
            main_query=main_query,
            rare_query=rare_query,
            anomalies=anomalies,
            data_completeness=completeness,
            raw_sections={
                "symptoms": symptom_section,
                "ecg": ecg_section,
                "labs": lab_section,
            },
        )

    # ----------------------------------------------------------------
    #  Build from AnalyzeRequest  (convenience)
    # ----------------------------------------------------------------

    def build_from_request(self, req: Any) -> UnifiedPatientVector:
        """
        Build directly from a backend AnalyzeRequest object.

        This is the transport-layer adapter used by callers that already have a
        validated request object. It keeps the vector builder independent from
        the HTTP route and the workflow orchestration code.
        """
        symptoms_text = req.symptoms.text if req.symptoms else ""
        age = getattr(req.symptoms, "age", None) if req.symptoms else None
        sex = getattr(req.symptoms, "sex", None) if req.symptoms else None
        chief = getattr(req.symptoms, "chief_complaint", None) if req.symptoms else None

        ecg_findings: List[str] = []
        if req.ecg and req.ecg.status != "skipped":
            if req.ecg.findings:
                ecg_findings.extend(req.ecg.findings)
            if req.ecg.st_segment:
                ecg_findings.append(f"ST: {req.ecg.st_segment}")
            if req.ecg.rhythm:
                ecg_findings.append(f"Rhythm: {req.ecg.rhythm}")
            if req.ecg.interpretation:
                ecg_findings.append(req.ecg.interpretation)

        lab_findings: List[str] = []
        lab_values: Dict[str, float] = {}
        if req.labs and req.labs.status != "skipped":
            if req.labs.findings:
                lab_findings.extend(req.labs.findings)
            for marker in ("troponin", "ldh", "bnp", "creatinine", "hemoglobin"):
                val = getattr(req.labs, marker, None)
                if val is not None:
                    lab_values[marker] = val
                    lab_findings.append(f"{marker.capitalize()}={val}")

        return self.build(
            symptoms_text=symptoms_text,
            ecg_findings=ecg_findings,
            lab_findings=lab_findings,
            lab_values=lab_values,
            age=age,
            sex=sex,
            chief_complaint=chief,
        )

    # ----------------------------------------------------------------
    #  Internal helpers
    # ----------------------------------------------------------------

    @staticmethod
    def _build_symptom_section(
        text: str,
        age: Optional[int],
        sex: Optional[str],
        chief: Optional[str],
    ) -> str:
        # Keep the symptom section human-readable, because SearchService feeds
        # it into FAISS as plain text rather than a structured JSON object.
        parts = []
        if age:
            parts.append(f"{age}-year-old")
        if sex:
            parts.append(f"{'male' if sex.upper() == 'M' else 'female'}")
        if chief:
            parts.append(f"presenting with {chief}.")
        parts.append(text.strip())
        return " ".join(parts)

    @staticmethod
    def _build_ecg_section(findings: List[str]) -> str:
        if not findings:
            return ""
        # ECG findings are flattened into a single sentence so the embedding
        # model sees the clinically relevant phrases together.
        return "ECG findings: " + ", ".join(findings)

    @staticmethod
    def _build_lab_section(findings: List[str], values: Dict[str, float]) -> str:
        if not findings and not values:
            return ""
        # Lab values are appended in a compact narrative form because the rare
        # search path needs to preserve discordant markers like troponin, BNP,
        # and eosinophilia-like hints.
        parts = ["Laboratory results:"]
        parts.extend(findings)
        return " ".join(parts)

    # ---------------------------------------------------------------- #

    def _detect_anomalies(
        self,
        symptoms: str,
        ecg_findings: List[str],
        lab_findings: List[str],
        lab_values: Dict[str, float],
    ) -> List[str]:
        """
        Identify findings that do NOT fit common cardiac conditions.
        These are the "rare indicators" that get extra weight.
        """
        # SearchService reads this list after the textbook pass and uses it as a
        # signal that the case may deserve a second pass through the rare-case
        # FAISS index.
        anomalies: List[str] = []
        symptoms_lower = symptoms.lower()

        # --- Unusual symptom combinations ---
        allergic_markers = ["urticaria", "rash", "hives", "angioedema",
                            "bronchospasm", "anaphylaxis", "allergic",
                            "eosinophilia", "ige"]
        cardiac_markers = ["chest pain", "stemi", "st elevation",
                           "troponin", "acs", "coronary"]

        has_allergic = any(m in symptoms_lower for m in allergic_markers)
        has_cardiac = any(m in symptoms_lower for m in cardiac_markers)
        if has_allergic and has_cardiac:
            anomalies.append("Allergic symptoms concurrent with ACS markers")

        # --- Atypical pain locations ---
        atypical_pain = ["jaw pain", "wrist pain", "back pain", "epigastric",
                         "tooth pain", "ear pain"]
        for pain in atypical_pain:
            if pain in symptoms_lower:
                anomalies.append(f"Atypical pain presentation: {pain}")

        # --- ECG-lab discordance ---
        ecg_text = " ".join(ecg_findings).lower()
        has_st_elevation = any(
            x in ecg_text for x in ["st elevation", "st-segment elevation", "stemi"])
        troponin_val = lab_values.get("troponin")
        if has_st_elevation and troponin_val is not None and troponin_val < 0.04:
            anomalies.append("ST elevation with normal troponin (discordant)")

        # --- Young patient with severe cardiac event ---
        # (caller supplies age via the build() method; check downstream)

        # --- Drug / substance associations ---
        substances = ["cocaine", "methamphetamine", "clozapine", "nsaid",
                       "antibiotic", "contrast dye", "chemotherapy"]
        for sub in substances:
            if sub in symptoms_lower:
                anomalies.append(f"Substance-associated cardiac event: {sub}")

        # --- Autoimmune / systemic markers ---
        systemic = ["lupus", "sle", "vasculitis", "sarcoidosis",
                     "amyloidosis", "rheumatoid"]
        for s in systemic:
            if s in symptoms_lower:
                anomalies.append(f"Systemic/autoimmune association: {s}")

        # --- Labs that suggest non-cardiac aetiology ---
        lab_text = " ".join(lab_findings).lower()
        non_cardiac_labs = ["elevated ige", "eosinophilia", "elevated esr",
                            "ana positive", "elevated crp"]
        for lab in non_cardiac_labs:
            if lab in lab_text or lab in symptoms_lower:
                anomalies.append(f"Non-cardiac lab finding: {lab}")

        if anomalies:
            logger.info("Detected %d anomalies: %s", len(anomalies), anomalies)

        return anomalies

    # ---------------------------------------------------------------- #

    @staticmethod
    def _build_rare_query(
        main_query: str,
        anomalies: List[str],
        ecg_findings: List[str],
        lab_findings: List[str],
    ) -> str:
        """
        Build the anomaly-emphasised query for the rare-case index.

        Strategy: repeat anomaly terms so they dominate the embedding.
        """
        if not anomalies:
            # No anomalies detected — use the main query as-is
            return main_query

        # The repeated anomaly block is the main mechanism that biases the rare
        # retrieval toward cases where the textbook-style explanation does not
        # fit the observed pattern.
        emphasis_parts = [main_query]

        # Repeat anomalies to bias the embedding
        anomaly_block = ". ".join(anomalies)
        emphasis_parts.append(f"RARE INDICATORS: {anomaly_block}")
        emphasis_parts.append(f"Anomalous findings: {anomaly_block}")

        return "\n".join(emphasis_parts)
