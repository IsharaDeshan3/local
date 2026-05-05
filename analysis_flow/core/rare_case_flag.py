"""
core/rare_case_flag.py

Decides whether a "Potential Rare Pathology Detected" alert should fire.

Logic
-----
1. If the rare-case similarity score exceeds the calibrated threshold σ,
   AND the negative filter found contradictions / missing data in the
   common diagnosis  →  fire the alert.

2. If the rare-case score exceeds a very-high "override" threshold
   (σ_override), fire regardless of the negative filter (strong match).

3. If neither condition is met  →  no alert.
"""

from __future__ import annotations

import logging
from dataclasses import dataclass, field
from typing import Dict, List, Optional

from core.negative_filter import ContradictionReport
from core.rare_case_retriever import RareCaseResult

logger = logging.getLogger(__name__)

# Default thresholds  (to be refined via calibration script)
_DEFAULT_SIGMA = 0.55            # primary threshold
_DEFAULT_SIGMA_OVERRIDE = 0.80   # very-high-confidence override

# -------------------------------------------------------------------- #
#  Alert dataclass                                                       #
# -------------------------------------------------------------------- #

@dataclass
class RareCaseAlert:
    """Structured alert passed to KRA → ORA for display."""
    triggered: bool = False
    condition: str = ""
    similarity_score: float = 0.0
    source_pmcid: str = ""
    source_url: str = ""
    doi: str = ""
    keyword: str = ""
    diseases: List[str] = field(default_factory=list)
    year: str = ""
    contradictions: List[str] = field(default_factory=list)
    missing_data: List[str] = field(default_factory=list)
    reasoning: str = ""
    all_matches: List[Dict] = field(default_factory=list)   # top-k summary

    def to_dict(self) -> Dict:
        return {
            "triggered": self.triggered,
            "condition": self.condition,
            "similarity_score": self.similarity_score,
            "source_pmcid": self.source_pmcid,
            "source_url": self.source_url,
            "doi": self.doi,
            "diseases": self.diseases,
            "year": self.year,
            "contradictions": self.contradictions,
            "missing_data": self.missing_data,
            "reasoning": self.reasoning,
        }


# -------------------------------------------------------------------- #
#  Flag evaluator                                                        #
# -------------------------------------------------------------------- #

class RareCaseFlag:
    """
    Evaluates whether a rare-pathology alert should be shown.

    Parameters
    ----------
    sigma : float
        Primary cosine-similarity threshold.  If the top rare-case match
        exceeds this AND the negative filter found problems → alert.
    sigma_override : float
        Override threshold.  If the top match exceeds this, alert fires
        regardless of the negative filter.
    """

    def __init__(
        self,
        sigma: float = _DEFAULT_SIGMA,
        sigma_override: float = _DEFAULT_SIGMA_OVERRIDE,
    ):
        self.sigma = sigma
        self.sigma_override = sigma_override

    def evaluate(
        self,
        rare_results: List[RareCaseResult],
        contradiction_report: ContradictionReport,
    ) -> RareCaseAlert:
        """
        Decide whether to fire the rare-case alert.

        Parameters
        ----------
        rare_results : list of RareCaseResult
            Top-k results from the rare-case FAISS search.
        contradiction_report : ContradictionReport
            Output of the negative filter.

        Returns
        -------
        RareCaseAlert
            With ``triggered=True`` if the alert should be shown.
        """
        # SearchService hands this method the rare-case hits and the
        # contradiction report from NegativeFilter. This is the final decision
        # layer before WorkflowService persists the alert with the patient run.
        if not rare_results:
            return RareCaseAlert(triggered=False, reasoning="No rare-case matches found")

        top = rare_results[0]
        score = top.score

        # Build summary of all matches for audit
        all_matches = [r.to_dict() for r in rare_results[:5]]

        # --- Rule 1: override threshold (very strong match) ---
        if score >= self.sigma_override:
            reasoning = (
                f"Very high similarity ({score:.2%}) with rare case "
                f"'{top.keyword}' exceeds override threshold ({self.sigma_override:.2%}). "
                f"Alert triggered regardless of negative filter."
            )
            return self._build_alert(top, reasoning, contradiction_report, all_matches)

        # --- Rule 2: primary threshold + negative filter ---
        if score >= self.sigma and contradiction_report.should_flag_rare:
            reasons = []
            if contradiction_report.contradictory_findings:
                reasons.append(
                    "Contradictions: " +
                    "; ".join(contradiction_report.contradictory_findings)
                )
            if contradiction_report.missing_critical_data:
                reasons.append(
                    "Missing critical data: " +
                    ", ".join(contradiction_report.missing_critical_data)
                )
            reasoning = (
                f"Similarity ({score:.2%}) with rare case '{top.keyword}' "
                f"exceeds threshold ({self.sigma:.2%}) and common diagnosis "
                f"'{contradiction_report.common_condition}' has issues. "
                + " ".join(reasons)
            )
            return self._build_alert(top, reasoning, contradiction_report, all_matches)

        # --- No alert ---
        reasoning = (
            f"Top rare-case score ({score:.2%}) "
            + (f"below threshold ({self.sigma:.2%})"
               if score < self.sigma
               else f"above threshold but no contradictions in common diagnosis")
        )
        return RareCaseAlert(
            triggered=False,
            condition=top.keyword,
            similarity_score=score,
            reasoning=reasoning,
            all_matches=all_matches,
        )

    # ------------------------------------------------------------------ #

    @staticmethod
    def _build_alert(
        top: RareCaseResult,
        reasoning: str,
        report: ContradictionReport,
        all_matches: List[Dict],
    ) -> RareCaseAlert:
        # Build the structured object that WorkflowService stores in the run
        # history and later exposes to the frontend.
        return RareCaseAlert(
            triggered=True,
            condition=top.keyword,
            similarity_score=top.score,
            source_pmcid=top.pmcid,
            source_url=top.source_url,
            doi=top.doi,
            keyword=top.keyword,
            diseases=top.diseases,
            year=top.year,
            contradictions=report.contradictory_findings,
            missing_data=report.missing_critical_data,
            reasoning=reasoning,
            all_matches=all_matches,
        )
