from __future__ import annotations

import logging
import sys
from pathlib import Path
from typing import Any, Dict, List, Optional, Tuple

# Allow importing root-level modules
    # SearchService keeps the textbook retriever as a process-wide singleton so
    # WorkflowService can call the search path repeatedly without reloading the
    # FAISS index on every request.
sys.path.insert(0, str(Path(__file__).parent.parent.parent))

from faiss_retriever import FAISSRetriever                   
from core.rare_case_retriever import RareCaseRetriever       
from core.unified_vector import UnifiedVectorBuilder         
from core.negative_filter import NegativeFilter             
from core.rare_case_flag import RareCaseFlag, RareCaseAlert  

logger = logging.getLogger(__name__)

    # Rare-case search is also lazy-loaded because it is only needed after the
    # textbook phase says the case is uncertain enough to justify the extra cost.

_textbook_retriever: FAISSRetriever | None = None
_rare_retriever: RareCaseRetriever | None = None


def _get_textbook_retriever() -> FAISSRetriever:
    global _textbook_retriever
    if _textbook_retriever is None:
        _textbook_retriever = FAISSRetriever()
        logger.debug(
            "Textbook FAISS index loaded: %d vectors",
            _textbook_retriever.index.ntotal,
        )
    return _textbook_retriever

def _get_rare_retriever() -> RareCaseRetriever:
    global _rare_retriever
    if _rare_retriever is None:
        try:
            _rare_retriever = RareCaseRetriever()
            logger.debug(
                "Rare-case FAISS index loaded: %d vectors",
                _rare_retriever.index.ntotal,
            )
        except Exception as exc:
            logger.error("Failed to load rare-case FAISS index: %s", exc)
            raise
    return _rare_retriever

class SearchService:

    """
    Dual-index search with unified patient vector, negative filtering,
    and rare-case threshold alerting.

    Returns
    -------
    tuple of (context_str, quality_dict, RareCaseAlert)
    """

    # WorkflowService calls this class to build retrieval context for KRA and
    # to decide whether a rare-case search should be added to the prompt.

    def __init__(self) -> None:
        self._vector_builder = UnifiedVectorBuilder()
        self._negative_filter = NegativeFilter()
        self._rare_flag = RareCaseFlag()

    def build_patient_vector(
        self,
        *,
        symptoms_text: str,
        ecg_findings: Optional[List[str]] = None,
        lab_findings: Optional[List[str]] = None,
        lab_values: Optional[Dict[str, float]] = None,
        age: Optional[int] = None,
        sex: Optional[str] = None,
        chief_complaint: Optional[str] = None,
    ):
        """Build a reusable unified patient vector for textbook + rare retrieval."""
        patient_vector = self._vector_builder.build(
            symptoms_text=symptoms_text,
            ecg_findings=ecg_findings,
            lab_findings=lab_findings,
            lab_values=lab_values,
            age=age,
            sex=sex,
            chief_complaint=chief_complaint,
        )
        logger.info(
            "Unified vector built — anomalies: %d, completeness: %s",
            len(patient_vector.anomalies),
            patient_vector.data_completeness,
        )
        return patient_vector

    def search_textbook(
        self,
        *,
        symptoms_text: str,
        top_k: int = 5,
        ecg_findings: Optional[List[str]] = None,
        lab_findings: Optional[List[str]] = None,
        lab_values: Optional[Dict[str, float]] = None,
        age: Optional[int] = None,
        sex: Optional[str] = None,
        chief_complaint: Optional[str] = None,
    ) -> Tuple[Any, str, Dict[str, Any]]:
        # This is the main retrieval path used by workflow_service.py before
        # KRA is called; it produces the baseline context and quality metrics.
        """Run textbook retrieval only and return the reusable patient vector."""
        patient_vector = self.build_patient_vector(
            symptoms_text=symptoms_text,
            ecg_findings=ecg_findings,
            lab_findings=lab_findings,
            lab_values=lab_values,
            age=age,
            sex=sex,
            chief_complaint=chief_complaint,
        )

        textbook_retriever = _get_textbook_retriever()
        context_str: str = textbook_retriever.get_context_string(
            patient_vector.main_query,
            top_k=top_k,
            include_metadata=True,
        )
        quality: Dict[str, Any] = textbook_retriever.calculate_retrieval_quality(
            patient_vector.main_query,
            top_k=top_k,
        )

        textbook_results = textbook_retriever.search(patient_vector.main_query, top_k=1)
        if textbook_results:
            quality["top_common_condition"] = textbook_results[0].get("condition", "Unknown")
        else:
            quality["top_common_condition"] = "Unknown"

        quality["anomalies_detected"] = patient_vector.anomalies
        quality["data_completeness"] = patient_vector.data_completeness
        return patient_vector, context_str, quality

    def should_search_rare_cases(
        self,
        *,
        quality: Dict[str, Any],
        ecg_findings: Optional[List[str]] = None,
        lab_findings: Optional[List[str]] = None,
        lab_values: Optional[Dict[str, float]] = None,
    ) -> Dict[str, Any]:

        """
        Here this part Decides whether rare-case retrieval should run or not.

        The gate is intentionally conservative: Conditions to enable rare-case search are when
        textbook retrieval confidence is weak, anomalies are prominent, or the
        case has multimodal findings that are not well-covered by textbook Findings.
        """

        top_score = float(quality.get("top_score", 0.0) or 0.0)
        avg_score = float(quality.get("avg_score", 0.0) or 0.0)
        status = str(quality.get("status") or "LOW_CONFIDENCE")
        anomalies = quality.get("anomalies_detected") or []

        has_multimodal_signal = bool(ecg_findings) or bool(lab_findings) or bool(lab_values)
        low_textbook_confidence = top_score < 0.72 or avg_score < 0.58 or status != "HIGH_CONFIDENCE"
        anomalous_case = len(anomalies) >= 2
        uncertain = low_textbook_confidence or anomalous_case or (has_multimodal_signal and status != "HIGH_CONFIDENCE")

        return {
            "trigger_rare_search": uncertain,
            "reason": {
                "low_textbook_confidence": low_textbook_confidence,
                "anomalous_case": anomalous_case,
                "has_multimodal_signal": has_multimodal_signal,
                "textbook_status": status,
                "top_score": top_score,
                "avg_score": avg_score,
                "anomaly_count": len(anomalies),
            },
        }

    def search_rare_cases(
        self,
        *,
        patient_vector: Any,
        symptoms_text: str,
        ecg_findings: Optional[List[str]] = None,
        lab_findings: Optional[List[str]] = None,
        lab_values: Optional[Dict[str, float]] = None,
        common_condition: str = "",
    ) -> Tuple[str, Dict[str, Any], RareCaseAlert]:
        
        # When the uncertainty gate opens, this adds rare-case evidence and a
        # structured alert that WorkflowService persists with the session.
        
        """Run rare-case retrieval and alert generation only."""
        
        rare_retriever = _get_rare_retriever()
        rare_results = rare_retriever.search(
            patient_vector.rare_query,
            top_k=3,
        )

        if not rare_results:
            return "", {"rare_cases_searched": 0}, RareCaseAlert(
                triggered=False,
                reasoning="No rare-case matches returned",
            )

        rare_context = rare_retriever.get_context_string(
            patient_vector.rare_query,
            top_k=3,
        )
        contradiction = self._negative_filter.check(
            condition=common_condition,
            ecg_findings=ecg_findings,
            lab_values=lab_values,
            lab_findings=lab_findings,
            symptoms_text=symptoms_text,
        )
        rare_alert = self._rare_flag.evaluate(
            rare_results=rare_results,
            contradiction_report=contradiction,
        )
        rare_quality = {
            "rare_top_score": rare_results[0].score,
            "rare_cases_searched": len(rare_results),
            "rare_alert_triggered": rare_alert.triggered,
        }
        if rare_alert.triggered:
            logger.warning(
                "🚨 RARE CASE ALERT: %s (score=%.3f, condition=%s)",
                rare_alert.condition,
                rare_alert.similarity_score,
                rare_alert.keyword,
            )
        return rare_context, rare_quality, rare_alert

    # ------------------------------------------------------------------ #
    #  Main entry  (called from pipeline_service.py)                      #
    # ------------------------------------------------------------------ #

    def search(
        self,
        symptoms_text: str,
        top_k: int = 5,
        include_rare: bool = True,
        # Structured inputs (optional — used for anomaly detection)
        ecg_findings: Optional[List[str]] = None,
        lab_findings: Optional[List[str]] = None,
        lab_values: Optional[Dict[str, float]] = None,
        age: Optional[int] = None,
        sex: Optional[str] = None,
        chief_complaint: Optional[str] = None,
    ) -> Tuple[str, Dict[str, Any], RareCaseAlert]:
        # Convenience wrapper used by callers that want both textbook and rare
        # retrieval in one call instead of orchestrating the gate themselves.
        """
        Dual-index search with anomaly detection and rare-case flagging.
        
        Returns
        -------
        context_str : str
            Combined textbook + rare-case context for the KRA prompt.
        quality : dict
            Retrieval quality metrics.
        rare_alert : RareCaseAlert
            Structured alert (may or may not be triggered).
        """

        patient_vector, context_str, quality = self.search_textbook(
            symptoms_text=symptoms_text,
            top_k=top_k,
            ecg_findings=ecg_findings,
            lab_findings=lab_findings,
            lab_values=lab_values,
            age=age,
            sex=sex,
            chief_complaint=chief_complaint,
        )

        rare_alert = RareCaseAlert(triggered=False, reasoning="Rare search disabled")

        if include_rare:
            decision = self.should_search_rare_cases(
                quality=quality,
                ecg_findings=ecg_findings,
                lab_findings=lab_findings,
                lab_values=lab_values,
            )
            quality["rare_search_gate"] = decision["reason"]

            if decision["trigger_rare_search"]:
                try:
                    rare_context, rare_quality, rare_alert = self.search_rare_cases(
                        patient_vector=patient_vector,
                        symptoms_text=symptoms_text,
                        ecg_findings=ecg_findings,
                        lab_findings=lab_findings,
                        lab_values=lab_values,
                        common_condition=str(quality.get("top_common_condition") or ""),
                    )
                    if rare_context:
                        context_str += "\n\n" + rare_context
                    quality.update(rare_quality)
                except Exception as exc:
                    logger.warning("Rare-case search failed (non-fatal): %s", exc)
                    rare_alert = RareCaseAlert(
                        triggered=False,
                        reasoning=f"Rare-case search error: {exc}",
                    )
                    quality["rare_cases_searched"] = 0
            else:
                rare_alert = RareCaseAlert(
                    triggered=False,
                    reasoning="Rare-case search gated off by uncertainty policy",
                )
                quality["rare_cases_searched"] = 0
        else:
            quality["rare_cases_searched"] = 0

        return context_str, quality, rare_alert

    # ------------------------------------------------------------------ #
    #  Search from AnalyzeRequest  (convenience)                          #
    # ------------------------------------------------------------------ #

    def search_from_request(
        self,
        req: Any,
        top_k: int = 5,
        include_rare: bool = True,
    ) -> Tuple[str, Dict[str, Any], RareCaseAlert]:
        # Converts the API request shape into retrieval inputs so the same
        # search logic can be reused from both HTTP routes and pipelines.
        """Build a unified vector from a full AnalyzeRequest and search."""
        ecg_findings: List[str] = []
        lab_findings: List[str] = []
        lab_values: Dict[str, float] = {}

        if req.ecg and req.ecg.status != "skipped":
            if req.ecg.findings:
                ecg_findings.extend(req.ecg.findings)
            if req.ecg.st_segment:
                ecg_findings.append(f"ST: {req.ecg.st_segment}")
            if req.ecg.rhythm:
                ecg_findings.append(f"Rhythm: {req.ecg.rhythm}")
            if req.ecg.interpretation:
                ecg_findings.append(req.ecg.interpretation)

        if req.labs and req.labs.status != "skipped":
            if req.labs.findings:
                lab_findings.extend(req.labs.findings)
            for marker in ("troponin", "ldh", "bnp", "creatinine", "hemoglobin"):
                val = getattr(req.labs, marker, None)
                if val is not None:
                    lab_values[marker] = val
                    lab_findings.append(f"{marker.capitalize()}={val}")

        age = getattr(req.symptoms, "age", None) if req.symptoms else None
        sex = getattr(req.symptoms, "sex", None) if req.symptoms else None
        chief = getattr(req.symptoms, "chief_complaint", None) if req.symptoms else None

        return self.search(
            symptoms_text=req.symptoms.text,
            top_k=top_k,
            include_rare=include_rare,
            ecg_findings=ecg_findings,
            lab_findings=lab_findings,
            lab_values=lab_values,
            age=age,
            sex=sex,
            chief_complaint=chief,
        )

    # ------------------------------------------------------------------ #

    def is_ready(self) -> bool:
        # The workflow health endpoint uses this to report whether retrieval is
        # ready before the frontend starts a session.
        """Return True if both FAISS indexes are loaded."""
        try:
            t = _get_textbook_retriever()
            textbook_ok = t.index.ntotal > 0
        except Exception:
            textbook_ok = False

        try:
            r = _get_rare_retriever()
            rare_ok = r.index.ntotal > 0
        except Exception:
            rare_ok = False

        return textbook_ok and rare_ok

    def readiness_status(self) -> Dict[str, bool]:
        """Return per-index readiness using cached singleton retrievers."""
        try:
            textbook_ok = _get_textbook_retriever().index.ntotal > 0
        except Exception:
            textbook_ok = False

        try:
            rare_ok = _get_rare_retriever().index.ntotal > 0
        except Exception:
            rare_ok = False

        return {
            "faiss_ready": textbook_ok,
            "rare_cases_ready": rare_ok,
            "all_ready": textbook_ok and rare_ok,
        }
