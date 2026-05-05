from __future__ import annotations

import os
import queue
import threading
import time
import uuid
from concurrent.futures import FIRST_EXCEPTION, ThreadPoolExecutor, wait
from typing import Any, Optional

from backend.processing.kra_client import KRAClient
from backend.processing.ora_client import ORAClient 
from backend.processing.search_service import SearchService
from core.rare_case_flag import RareCaseAlert
from backend.processing.supabase_payload import (
    get_patient_history_bundle,
    save_analysis_payload,
    save_kra_output,
    save_ora_output,
    update_analysis_payload,
    update_payload_status,
)
from backend.processing.workflow_state import WorkflowState
from backend.processing.workflow_store import WorkflowStore

import logging
logger = logging.getLogger(__name__)

# This module orchestrates the end-to-end clinical analysis workflow:
# session state checks, retrieval, KRA/ORA model calls, persistence, and SSE events.

class PipelineEventBus:
    """
    Thread-safe function for pipeline step events.
    The pipeline calls emit() from a thread-pool worker.
    SSE route handlers subscribe via subscribe() and read from queue.Queue.
    """

    def __init__(self) -> None:
        # session_id -> list of subscriber queues (one queue per SSE listener)
        self._subscribers: dict[str, list[queue.Queue]] = {}
        # Protects subscribe/unsubscribe/emit snapshot operations.
        self._lock = threading.Lock()

    def subscribe(self, session_id: str) -> queue.Queue:
        """Register a listener queue for a session's live pipeline events."""
        q: queue.Queue = queue.Queue(maxsize=100)
        with self._lock:
            self._subscribers.setdefault(session_id, []).append(q)
        return q

    def unsubscribe(self, session_id: str, q: queue.Queue) -> None:
        """Detach a listener queue and clean up empty subscriber lists."""
        with self._lock:
            listeners = self._subscribers.get(session_id, [])
            if q in listeners:
                listeners.remove(q)
            if not listeners and session_id in self._subscribers:
                del self._subscribers[session_id]

    def emit(self, session_id: str, event: dict) -> None:
        """Broadcast to all listeners. Thread-safe, non-blocking."""
        with self._lock:
            queues = list(self._subscribers.get(session_id, []))
        for q in queues:
            try:
                q.put_nowait(event)
            except queue.Full:
                pass

    def close_session(self, session_id: str) -> None:
        """Signal EOF so SSE streams close gracefully."""
        self.emit(session_id, {"__eof__": True})


# Analysis can start from any of these states (ECG/Lab may be skipped)
_ANALYSIS_READY_STATES = {
    WorkflowState.EXTRACTION_DONE.value,
    WorkflowState.ECG_DONE.value,
    WorkflowState.LAB_DONE.value,
}

class WorkflowService:
    # This service is the bridge between the session store, retrieval layer,
    # Supabase persistence helpers, and remote KRA/ORA provider clients.
    def __init__(self) -> None:
        """Wire all collaborating components used by the workflow pipeline."""
        # Local store for session state, step payloads, and retrieval traces.
        self._store = WorkflowStore()
        # Retrieval and model clients used by the analysis phases.
        self._search = SearchService()
        self._kra = KRAClient()
        self._ora = ORAClient()
        # Cancellation bookkeeping: set membership + per-session event handle.
        self._cancel_requested: set[str] = set()
        self._cancel_lock = threading.Lock()
        self._cancel_events: dict[str, threading.Event] = {}  # per-session cancel events
        # Shared event bus consumed by SSE routes.
        self.event_bus = PipelineEventBus()

    def readiness_status(self) -> dict[str, Any]:
        """Readiness check for remote KRA and ORA providers."""
        kra_ok = self._kra.health_check()
        ora_ok = self._ora.health_check()
        diagnostics = {
            "kra_provider": "huggingface_api",
            "ora_provider": "gemini_api",
            "kra_api_url_configured": bool(os.getenv("KRA_API_URL", "").strip()),
            "gemini_model": os.getenv("GEMINI_MODEL", "gemini-2.5-flash").strip(),
            "gemini_api_key_configured": bool(os.getenv("GEMINI_API_KEY", "").strip()),
        }
        return {
            "kra": kra_ok,
            "ora": ora_ok,
            "all_ready": kra_ok and ora_ok,
            "diagnostics": diagnostics,
        }

    @staticmethod
    def _kra_timeout_seconds() -> float:
        """Read KRA timeout from env and clamp to a safe minimum."""
        try:
            timeout_raw = os.getenv("KRA_TIMEOUT_SEC") or os.getenv("KRA_API_TIMEOUT_SEC") or "900"
            return max(30.0, float(timeout_raw))
        except ValueError:
            return 900.0

    @staticmethod
    def _ora_timeout_seconds() -> float:
        """Read ORA timeout from env and clamp to a safe minimum."""
        try:
            timeout_raw = os.getenv("ORA_TIMEOUT_SEC") or os.getenv("ORA_GEMINI_TIMEOUT_SEC") or "600"
            return max(30.0, float(timeout_raw))
        except ValueError:
            return 600.0

    @staticmethod
    def _ora_secondary_timeout_seconds() -> float:
        """Bound how long we wait for the optional secondary ORA mode."""
        try:
            timeout_raw = os.getenv("ORA_SECONDARY_TIMEOUT_SEC", "45")
            return max(0.0, float(timeout_raw))
        except ValueError:
            return 45.0

    @staticmethod
    def _is_valid_kra_result(kra_result: dict[str, Any]) -> bool:
        """Guard against malformed KRA output before invoking downstream ORA."""
        diagnoses = kra_result.get("diagnoses")
        uncertainties = kra_result.get("uncertainties")
        recommended_tests = kra_result.get("recommended_tests")
        red_flags = kra_result.get("red_flags")
        return all(
            [
                isinstance(diagnoses, list),
                isinstance(uncertainties, list),
                isinstance(recommended_tests, list),
                isinstance(red_flags, list),
            ]
        )

    def check_spaces_health(self) -> dict[str, Any]:
        """Backward-compatible alias for older callers."""
        return self.readiness_status()

    def request_stop_analysis(self, session_id: str) -> dict[str, Any]:
        """
        Signal the running pipeline to stop at the next checkpoint.

        Only sets a cancel flag — does NOT change session state.
        The pipeline thread detects the flag and rolls back state itself,
        avoiding any race condition between this handler and the worker thread.
        """
        session = self._store.get_session(session_id)
        if session is None:
            raise ValueError("SESSION_NOT_FOUND")

        with self._cancel_lock:
            self._cancel_requested.add(session_id)
            # Signal the cancel event so in-flight KRA/ORA SSE calls break immediately
            event = self._cancel_events.get(session_id)
            if event is not None:
                event.set()

        logger.info("Stop requested for session %s (current_state=%s)",
                    session_id, session["current_state"])

        return {
            "session_id": session_id,
            "state": session["current_state"],
            "status": "CANCEL_REQUESTED",
        }

    def _clear_cancel_request(self, session_id: str) -> None:
        """Clear any stale cancellation flags/events before or after a run."""
        with self._cancel_lock:
            self._cancel_requested.discard(session_id)
            self._cancel_events.pop(session_id, None)

    def _get_or_create_cancel_event(self, session_id: str) -> threading.Event:
        """Return the per-session cancel event, creating it if necessary."""
        with self._cancel_lock:
            if session_id not in self._cancel_events:
                self._cancel_events[session_id] = threading.Event()
            return self._cancel_events[session_id]

    def _raise_if_cancelled(self, session_id: str) -> None:
        """Checkpoint helper used across the pipeline for cooperative cancellation."""
        with self._cancel_lock:
            cancelled = session_id in self._cancel_requested
        if cancelled:
            raise RuntimeError("ANALYSIS_CANCELLED")

    def run_analysis(self, session_id: str, experience_level: str = "seasoned") -> dict[str, Any]:
        """Entry point: validate state, prepare inputs, and execute the pipeline."""
        # Start with a clean cancel state so a previous stop request does not leak.
        self._clear_cancel_request(session_id)
        session = self._store.get_session(session_id)
        if session is None:
            raise ValueError("SESSION_NOT_FOUND")

        current_state = session["current_state"]

        # Reset a stuck ANALYSIS_RUNNING (previous crash without rollback)
        if current_state == WorkflowState.ANALYSIS_RUNNING.value:
            self._store.transition_state(
                session_id=session_id,
                next_state=WorkflowState.LAB_DONE,
                event_type="ANALYSIS_RETRY_RESET",
                message="Resetting stuck ANALYSIS_RUNNING state for retry",
            )
            current_state = WorkflowState.LAB_DONE.value

        # Allow re-run from ANALYSIS_DONE
        if current_state == WorkflowState.ANALYSIS_DONE.value:
            self._store.transition_state(
                session_id=session_id,
                next_state=WorkflowState.ANALYSIS_RUNNING,
                event_type="ANALYSIS_RERUN",
                message="Re-running analysis",
            )
            current_state = WorkflowState.ANALYSIS_RUNNING.value

        # Accept any ready state (handles ECG/Lab skip scenarios)
        if current_state not in _ANALYSIS_READY_STATES and current_state != WorkflowState.ANALYSIS_RUNNING.value:
            raise RuntimeError(f"INVALID_ANALYSIS_STATE:{current_state}")

        extraction = self._store.get_latest_step_payload(session_id, "extraction")
        ecg = self._store.get_latest_step_payload(session_id, "ecg")
        lab = self._store.get_latest_step_payload(session_id, "lab")

        if extraction is None:
            raise RuntimeError("MISSING_EXTRACTION_PAYLOAD")

        if current_state != WorkflowState.ANALYSIS_RUNNING.value:
            self._store.transition_state(
                session_id=session_id,
                next_state=WorkflowState.ANALYSIS_RUNNING,
                event_type="ANALYSIS_START",
                message="Phase B analysis started",
            )

        started = time.time()
        # Missing optional steps are represented as explicit "skipped" payloads.
        extraction_payload = extraction["payload"]
        ecg_payload = ecg["payload"] if ecg is not None else {"result": {"status": "skipped", "reason": "not_submitted"}}
        lab_payload = lab["payload"] if lab is not None else {"result": {"status": "skipped", "reason": "not_submitted"}}

        # Extract patient_id from session for Supabase threading
        patient_id = session.get("patient_id")

        try:
            return self._run_analysis_pipeline(
                session_id=session_id,
                experience_level=experience_level,
                extraction_payload=extraction_payload,
                ecg_payload=ecg_payload,
                lab_payload=lab_payload,
                started=started,
                patient_id=patient_id,
            )
        except RuntimeError as exc:
            if "ANALYSIS_CANCELLED" in str(exc):
                try:
                    self._store.transition_state(
                        session_id=session_id,
                        next_state=WorkflowState.LAB_DONE,
                        event_type="ANALYSIS_CANCELLED",
                        message="Analysis cancelled by user",
                    )
                except Exception:
                    pass
                self.event_bus.emit(session_id, {"step": "cancelled", "status": "cancelled"})
                raise
            else:
                self.event_bus.emit(
                    session_id,
                    {"step": "analysis_done", "status": "error", "message": str(exc)},
                )
                try:
                    self._store.transition_state(
                        session_id=session_id,
                        next_state=WorkflowState.LAB_DONE,
                        event_type="ANALYSIS_ROLLBACK",
                        message=f"Pipeline failed: {exc}",
                    )
                except Exception:
                    pass
                raise
        except Exception as exc:
            self.event_bus.emit(
                session_id,
                {"step": "analysis_done", "status": "error", "message": str(exc)},
            )
            try:
                self._store.transition_state(
                    session_id=session_id,
                    next_state=WorkflowState.LAB_DONE,
                    event_type="ANALYSIS_ROLLBACK",
                    message=f"Pipeline failed: {exc}",
                )
            except Exception:
                pass
            raise
        finally:
            self._clear_cancel_request(session_id)
            self.event_bus.close_session(session_id)

    def _emit(self, session_id: str, step: str, status: str, **kwargs: Any) -> None:
        """Small helper to keep event payloads consistent across steps."""
        self.event_bus.emit(session_id, {"step": step, "status": status, **kwargs})

    def _save_payload_snapshot(
        self,
        *,
        session_id: str,
        symptoms_json: dict[str, Any],
        ecg_json: dict[str, Any],
        labs_json: dict[str, Any],
        context_text: str,
        quality: dict[str, Any],
        history_json: dict[str, Any],
        patient_id: Optional[str],
    ) -> dict[str, Any]:
        """Persist the merged request snapshot; fallback locally if Supabase fails."""
        # Step 3 persists the merged patient payload so later steps can link
        # KRA/ORA output back to the same workflow session and Supabase row.
        try:
            payload_id, payload_url = save_analysis_payload(
                session_id=session_id,
                symptoms=symptoms_json,
                ecg=ecg_json,
                labs=labs_json,
                context_text=context_text,
                quality=quality,
                patient_id=patient_id,
                history_json=history_json,
            )
            self._store.set_supabase_payload_id(session_id, payload_id)
            update_payload_status(payload_id, "processing")
            return {
                "payload_id": payload_id,
                "payload_url": payload_url,
                "supabase_available": True,
            }
        except Exception as exc:
            logger.warning(
                "Supabase payload persistence failed for %s: %s – continuing with local payload id",
                session_id,
                exc,
            )
            payload_id = str(uuid.uuid4())
            return {
                "payload_id": payload_id,
                "payload_url": None,
                "supabase_available": False,
                "error": str(exc),
            }

    @staticmethod
    def _compact_history_bundle_for_payload(
        history_bundle: dict[str, Any],
        max_recent_records: int = 5,
    ) -> dict[str, Any]:
        """Reduce history payload size before storing in analysis_payloads."""
        if not isinstance(history_bundle, dict):
            return {"summary": {}, "record_count": 0, "recent_records": []}

        records = history_bundle.get("records")
        if not isinstance(records, list):
            records = []

        compact_records: list[dict[str, Any]] = []
        for record in records[:max_recent_records]:
            if not isinstance(record, dict):
                continue
            compact_records.append(
                {
                    "payload_id": record.get("payload_id"),
                    "session_id": record.get("session_id"),
                    "created_at": record.get("created_at"),
                    "status": record.get("status"),
                    "experience_level": record.get("experience_level"),
                }
            )

        return {
            "patient_id": history_bundle.get("patient_id"),
            "supabase_status": history_bundle.get("supabase_status"),
            "summary": history_bundle.get("summary") or {},
            "record_count": len(records),
            "recent_records": compact_records,
        }

    def _save_kra_history_entry(
        self,
        *,
        session_id: str,
        payload_id: str,
        symptoms_text: str,
        kra_result: dict[str, Any],
        patient_id: Optional[str],
    ) -> dict[str, Any]:
        """Persist raw KRA output for traceability and downstream linkage."""
        # Step 4 stores the raw KRA result in Supabase and mirrors the ID in
        # the local workflow store for later ORA and cleanup steps.
        try:
            kra_id, kra_url = save_kra_output(
                session_id=session_id,
                payload_id=payload_id,
                symptoms_text=symptoms_text,
                kra_result=kra_result,
                patient_id=patient_id,
            )
            self._store.set_supabase_kra_id(session_id, kra_id)
            return {"kra_id": kra_id, "kra_url": kra_url, "supabase_available": True}
        except Exception as exc:
            logger.warning(
                "KRA history persistence failed for %s: %s – continuing with local KRA id",
                session_id,
                exc,
            )
            return {
                "kra_id": str(uuid.uuid4()),
                "kra_url": None,
                "supabase_available": False,
                "error": str(exc),
            }

    def _save_ora_history_entry(
        self,
        *,
        session_id: str,
        kra_output_id: str,
        experience_level: str,
        ora_result: dict[str, Any],
        patient_id: Optional[str],
    ) -> dict[str, Any]:
        """Persist ORA-refined output; fallback to local IDs on remote failure."""
        # Step 5 stores the ORA-refined result as the final analyst-facing
        # record for this session.
        try:
            ora_output_id, ora_url = save_ora_output(
                session_id=session_id,
                kra_output_id=kra_output_id,
                experience_level=experience_level,
                refined_output=ora_result.get("refined_output", ""),
                disclaimer=ora_result.get("disclaimer"),
                status=ora_result.get("status", "success"),
                patient_id=patient_id,
            )
            return {"ora_id": ora_output_id, "ora_url": ora_url, "supabase_available": True}
        except Exception as exc:
            logger.warning(
                "ORA history persistence failed for %s/%s: %s",
                session_id,
                experience_level,
                exc,
            )
            return {
                "ora_id": str(uuid.uuid4()),
                "ora_url": None,
                "supabase_available": False,
                "error": str(exc),
            }

    def _normalize_symptoms_payload(self, extraction_payload: dict[str, Any]) -> tuple[dict[str, Any], str]:
        """Convert extraction payload into canonical symptoms JSON + narrative text."""
        if not isinstance(extraction_payload, dict):
            extraction_payload = {"translated_text": str(extraction_payload or "")}

        symptoms = extraction_payload.get("symptoms", []) or []
        risk_factors = extraction_payload.get("risk_factors", []) or []
        translated = str(extraction_payload.get("translated_text") or "").strip()

        chief_complaint = str(symptoms[0]).strip() if symptoms else None
        symptoms_text = translated
        if not symptoms_text:
            if symptoms:
                symptoms_text = "Presenting symptoms: " + ", ".join(map(str, symptoms))
            else:
                symptoms_text = "No symptom narrative provided"
        if risk_factors:
            symptoms_text += f"\nRisk factors: {', '.join(map(str, risk_factors))}"

        symptoms_json = {
            "text": symptoms_text,
            "chief_complaint": chief_complaint,
            "additional": {
                "symptoms": symptoms,
                "risk_factors": risk_factors,
                "translated_text": translated,
                "symptom_count": len(symptoms),
                "risk_factor_count": len(risk_factors),
            },
        }
        return symptoms_json, symptoms_text

    def _normalize_ecg_payload(self, ecg_payload: dict[str, Any]) -> dict[str, Any]:
        """Flatten ECG payload variants into a single model-friendly schema."""
        raw = ecg_payload.get("result", {}) if isinstance(ecg_payload, dict) else {}
        if not isinstance(raw, dict):
            raw = {}

        status = str(raw.get("status") or "present").lower()
        if status in {"skipped", "error"}:
            return {
                "status": status,
                "raw": raw,
            }

        rhythm_analysis = raw.get("rhythm_analysis", {}) or {}
        abnormalities = raw.get("abnormalities", {}) or {}
        diagnosis = raw.get("diagnosis", {}) or {}

        findings: list[str] = []
        # Build a compact findings list from multiple possible ECG sections.
        for item in (abnormalities.get("abnormalities", []) or []):
            if item:
                findings.append(str(item))
        severity = abnormalities.get("severity")
        if severity:
            findings.append(f"severity={severity}")
        for item in (diagnosis.get("differential_diagnoses", []) or []):
            if item:
                findings.append(str(item))
        for item in (diagnosis.get("recommendations", []) or []):
            if item:
                findings.append(str(item))
        for item in (raw.get("findings", []) or []):
            if item:
                findings.append(str(item))

        rhythm = raw.get("rhythm") or rhythm_analysis.get("rhythm_type")
        heart_rate_raw = raw.get("heart_rate") or rhythm_analysis.get("heart_rate")
        heart_rate_val = self._to_float(heart_rate_raw)
        heart_rate = int(heart_rate_val) if heart_rate_val is not None else None
        interpretation = raw.get("interpretation") or diagnosis.get("primary_diagnosis")
        st_segment = raw.get("st_segment")

        return {
            "status": "present",
            "rhythm": rhythm,
            "heart_rate": heart_rate,
            "st_segment": st_segment,
            "interpretation": interpretation,
            "findings": findings,
            "raw": raw,
        }

    def _normalize_lab_payload(self, lab_payload: dict[str, Any]) -> dict[str, Any]:
        """Flatten lab payload into structured markers + human-readable findings."""
        raw = lab_payload.get("result", {}) if isinstance(lab_payload, dict) else {}
        if not isinstance(raw, dict):
            raw = {}

        status = str(raw.get("status") or "present").lower()
        if status in {"skipped", "error"}:
            return {
                "status": status,
                "raw": raw,
            }

        comparisons = raw.get("labComparison", []) or []
        findings: list[str] = []
        # Convert non-normal comparison entries into text snippets for retrieval.
        for item in comparisons:
            if not isinstance(item, dict):
                continue
            item_status = str(item.get("status", "")).lower()
            test = str(item.get("test", "")).strip()
            actual = item.get("actualValue")
            if test and item_status and item_status != "normal":
                findings.append(f"{test}: {actual} ({item_status})")

        group1 = raw.get("extractedJsonGroup1", {}) or {}
        group2 = raw.get("extractedJsonGroup2", {}) or {}

        def _pick(*keys: str) -> Optional[float]:
            """Pick first parseable numeric value across group1/group2/raw aliases."""
            for key in keys:
                value = self._to_float(group1.get(key))
                if value is not None:
                    return value
                value = self._to_float(group2.get(key))
                if value is not None:
                    return value
                value = self._to_float(raw.get(key))
                if value is not None:
                    return value
            return None

        return {
            "status": "present",
            "troponin": _pick("troponin", "Troponin"),
            "ldh": _pick("ldh", "LDH"),
            "bnp": _pick("bnp", "BNP"),
            "creatinine": _pick("creatinine", "Creatinine", "Cr"),
            "hemoglobin": _pick("hemoglobin", "Hemoglobin", "Hb"),
            "findings": findings,
            "raw": raw,
        }

    def _run_analysis_pipeline(
        self,
        session_id: str,
        experience_level: str,
        extraction_payload: dict[str, Any],
        ecg_payload: dict[str, Any],
        lab_payload: dict[str, Any],
        started: float,
        patient_id: Optional[str] = None,
    ) -> dict[str, Any]:
        """Core pipeline: normalize -> retrieve -> KRA -> ORA -> persist -> return.

        This is the orchestration center for the whole analysis flow. The
        route layer in ``backend/routes/workflow.py`` only dispatches the HTTP
        request here; from this point onward the workflow is responsible for
        converting raw step payloads into normalized clinical text, passing the
        search inputs to SearchService, and forwarding the final retrieval
        context into KRA and ORA.
        """
        processing_steps: list[dict[str, Any]] = []
        self._raise_if_cancelled(session_id)

        # ── Step 0: Normalise inputs ──────────────────────────────────────────
        # The normalized payload is the common shape consumed by three later
        # stages: SearchService turns it into retrieval text, KRAClient sends it
        # to the remote KRA model, and the persistence helpers store the same
        # structured snapshot in Supabase for history reuse.

        symptoms_json, symptoms_text = self._normalize_symptoms_payload(extraction_payload)
        ecg_json = self._normalize_ecg_payload(ecg_payload)
        labs_json = self._normalize_lab_payload(lab_payload)

        ecg_findings: list[str] = ecg_json.get("findings", []) if ecg_json.get("status") == "present" else []
        lab_findings: list[str] = labs_json.get("findings", []) if labs_json.get("status") == "present" else []
        lab_values: dict[str, float] = {
            marker: value
            for marker, value in {
                "troponin": labs_json.get("troponin"),
                "ldh": labs_json.get("ldh"),
                "bnp": labs_json.get("bnp"),
                "creatinine": labs_json.get("creatinine"),
                "hemoglobin": labs_json.get("hemoglobin"),
            }.items()
            if isinstance(value, (int, float))
        }
        self._emit(session_id, "session_init", "completed")

        # ── Step 1: Textbook retrieval, then uncertainty-gated rare cases ───
        # SearchService is called here because it owns the vector builder,
        # textbook FAISS search, rare-case gate, and rare-case alert creation.
        self._emit(session_id, "faiss_search", "started")
        retrieval_started = time.time()
        patient_vector, textbook_context, quality = self._search.search_textbook(
            symptoms_text=symptoms_text,
            top_k=5,
            ecg_findings=ecg_findings,
            lab_findings=lab_findings,
            lab_values=lab_values,
            age=None,  # Add appropriate value if available
            sex=None,  # Add appropriate value if available
            chief_complaint=None  # Add appropriate value if available
        )

        retrieval_ms = int((time.time() - retrieval_started) * 1000)
        quality: dict[str, Any] = (
            dict(quality) if isinstance(quality, dict) else {"status": "LOW_CONFIDENCE"}
        )

        processing_steps.append(
            {
                "step": "faiss_search",
                "status": "success",
                "duration_ms": retrieval_ms,
                "rare_gate": quality.get("rare_search_gate"),
            }
        )
        self._emit(session_id, "faiss_search", "completed", duration_ms=retrieval_ms)
        self._raise_if_cancelled(session_id)

        context_sections: list[str] = [textbook_context] if textbook_context else []
        rare_context = ""
        rare_alert = RareCaseAlert(
            triggered=False,
            reasoning="Rare-case search gated off by uncertainty policy",
        )

        rare_gate = self._search.should_search_rare_cases(
            quality=quality,
            ecg_findings=ecg_findings,
            lab_findings=lab_findings,
            lab_values=lab_values,
        )

        quality["rare_search_gate"] = rare_gate.get("reason")
        quality.setdefault("rare_cases_searched", 0)
        quality.setdefault("rare_top_score", 0.0)

        # Persist the textbook retrieval context early so the history view can
        # later show what evidence was available before KRA/ORA finished.
        self._store.save_retrieval_context(
            session_id=session_id,
            source_type="books",
            content=textbook_context,
            metadata={
                "quality": quality,
                "experience_level": experience_level,
                "rare_search_gate": rare_gate,
            },
        )

        if rare_gate.get("trigger_rare_search"):
            self._emit(session_id, "rare_case_search", "started")
            rare_started = time.time()
            # When the gate opens, SearchService performs a second retrieval on
            # the rare-case index using the rare_query from UnifiedVectorBuilder
            # and returns both context text and a structured RareCaseAlert.
            rare_context, rare_quality, rare_alert = self._search.search_rare_cases(
                patient_vector=patient_vector,
                symptoms_text=symptoms_text,
                ecg_findings=ecg_findings,
                lab_findings=lab_findings,
                lab_values=lab_values,
                common_condition=str(quality.get("top_common_condition") or ""),
            )
            rare_ms = int((time.time() - rare_started) * 1000)
            quality.update(rare_quality)
            if rare_context:
                context_sections.append(rare_context)
                self._store.save_retrieval_context(
                    session_id=session_id,
                    source_type="rare_cases",
                    content=rare_context,
                    metadata={
                        "rare_alert": rare_alert.to_dict(),
                        "rare_search_gate": rare_gate,
                        "rare_top_score": quality.get("rare_top_score"),
                    },
                    score=float(quality.get("rare_top_score", 0.0) or 0.0),
                )
            processing_steps.append(
                {
                    "step": "rare_case_search",
                    "status": "success",
                    "duration_ms": rare_ms,
                    "triggered": bool(rare_alert.triggered),
                    "top_score": float(quality.get("rare_top_score", 0.0) or 0.0),
                }
            )
            self._emit(
                session_id,
                "rare_case_search",
                "completed",
                duration_ms=rare_ms,
                triggered=bool(rare_alert.triggered),
                top_score=float(quality.get("rare_top_score", 0.0) or 0.0),
            )
        else:
            processing_steps.append(
                {
                    "step": "rare_case_search",
                    "status": "skipped",
                    "duration_ms": 0,
                    "reason": rare_gate.get("reason"),
                }
            )
            self._emit(
                session_id,
                "rare_case_search",
                "completed",
                duration_ms=0,
                triggered=False,
                skipped=True,
                reason=rare_gate.get("reason"),
            )
        self._raise_if_cancelled(session_id)

        context_text = "\n\n".join(section.strip() for section in context_sections if str(section).strip())

        # ── Step 2 + 3: History fetch, payload save, and KRA run in parallel ──
        # Saving the payload and fetching history do not depend on KRA output,
        # so they are overlapped with KRA execution. The history bundle is fed
        # into both the payload snapshot and the KRA prompt so that the model
        # sees longitudinal context without blocking the retrieval stage.
        cancel_event = self._get_or_create_cancel_event(session_id)
        self._emit(session_id, "supabase_save_payload", "started")
        self._emit(session_id, "kra_analysis", "started")

        def run_history_fetch() -> dict[str, Any]:
            """Step 2: Load longitudinal history summary for KRA (non-blocking).

            WorkflowService is the only component that knows both the current
            session and the patient history endpoint, so it fetches the summary
            here and passes only the compact text downstream.
            """
            bundle: dict[str, Any] = {"patient_id": patient_id, "summary": {}, "records": []}
            if patient_id:
                try:
                    bundle = get_patient_history_bundle(patient_id)
                except Exception as exc:
                    logger.warning("Patient history summary fetch failed for %s: %s", patient_id, exc)
            return bundle

        def run_payload_save(history_bundle_ref: list) -> dict[str, Any]:
            """Worker: persist the normalized request snapshot and timing metadata.

            The saved payload is the audit trail for this exact analysis run: it
            stores the normalized symptoms, ECG, labs, and retrieval context so
            the frontend history page can reconstruct the clinical session later.
            """
            started_at = time.time()

            # Wait for history to be available from the shared ref

            hb = history_bundle_ref[0] if history_bundle_ref else {"patient_id": patient_id, "summary": {}, "records": []}
            compact_history = self._compact_history_bundle_for_payload(hb)
            result = self._save_payload_snapshot(
                session_id=session_id,
                symptoms_json=symptoms_json,
                ecg_json=ecg_json,
                labs_json=labs_json,
                context_text=context_text,
                quality=quality,
                history_json=compact_history,
                patient_id=patient_id,
            )
            result["duration_ms"] = int((time.time() - started_at) * 1000)
            return result

        def run_kra_analysis(history_bundle_ref: list) -> dict[str, Any]:
            """Worker: run KRA with retrieved context and optional history summary.

            This is the handoff point from search to reasoning: the retrieval
            context_text built from textbook/rare search is sent to KRA together
            with the normalized ECG/lab payloads and the compact longitudinal
            history summary.
            """
            started_at = time.time()

            # Extract history summary text from the fetched bundle

            hb = history_bundle_ref[0] if history_bundle_ref else {}
            hs = hb.get("summary") or {} if isinstance(hb, dict) else {}
            h_text = str(hs.get("summary_text") or "").strip()

            result = self._kra.analyze(
                symptoms_text=symptoms_text,
                context_text=context_text,
                ecg_dict=ecg_json,
                labs_dict=labs_json,
                history_summary_text=h_text,
                cancel_event=cancel_event,
            )
            return {
                "kra_result": result,
                "duration_ms": int((time.time() - started_at) * 1000),
                "history_injected": bool(h_text),
            }

        # Phase 1: Fetch history first (fast network call), then fire payload+KRA in parallel

        with ThreadPoolExecutor(max_workers=3) as executor:

            # Stage A: fetch history first so both downstream workers use same data.

            history_future = executor.submit(run_history_fetch)

            # Wait for history before starting payload save and KRA (they both need it)

            try:
                history_bundle = history_future.result(timeout=15)
            except Exception as exc:
                logger.warning("History fetch timed out or failed: %s", exc)
                history_bundle = {"patient_id": patient_id, "summary": {}, "records": []}

            history_summary = history_bundle.get("summary") or {} if isinstance(history_bundle, dict) else {}
            history_summary_text = str(history_summary.get("summary_text") or "").strip()

            # Shared ref so both workers see the same history

            history_ref = [history_bundle]

            payload_future = executor.submit(run_payload_save, history_ref)
            kra_future = executor.submit(run_kra_analysis, history_ref)
            done, pending = wait(
                {payload_future, kra_future},
                timeout=self._kra_timeout_seconds(),
                return_when=FIRST_EXCEPTION,
            )
            if kra_future not in done:
                cancel_event.set()
                logger.error("KRA analysis timed out for session %s after %.1fs", session_id, self._kra_timeout_seconds())
                raise RuntimeError("KRA_TIMEOUT")
            first_error = next((future.exception() for future in done if future.exception() is not None), None)
            if first_error is not None:
                cancel_event.set()
                for future in pending:
                    future.cancel()
                raise first_error
            payload_result = payload_future.result()
            self._raise_if_cancelled(session_id)
            kra_run = kra_future.result()

        payload_id = payload_result["payload_id"]
        payload_url = payload_result.get("payload_url")
        supabase_available = bool(payload_result.get("supabase_available"))
        payload_ms = int(payload_result.get("duration_ms") or 0)
        kra_result = kra_run["kra_result"]
        kra_ms = int(kra_run.get("duration_ms") or 0)

        logger.info(
            "KRA output for session %s\n%s\n%s",
            session_id,
            "=" * 80,
            str(kra_result.get("raw_text") or "[empty KRA output]"),
        )
        if not self._is_valid_kra_result(kra_result):
            logger.error(
                "KRA produced invalid output for session %s; aborting before ORA. Raw output:\n%s",
                session_id,
                str(kra_result.get("raw_text") or "[empty KRA output]"),
            )
            raise RuntimeError("KRA_OUTPUT_INVALID_JSON")

        processing_steps.append(
            {
                "step": "supabase_save_payload",
                "status": "success" if supabase_available else "offline_fallback",
                "duration_ms": payload_ms,
                "supabase_id": payload_id,
                "supabase_available": supabase_available,
            }
        )
        processing_steps.append(
            {
                "step": "kra_analysis",
                "status": "success",
                "duration_ms": kra_ms,
                "history_injected": bool(history_summary_text),
            }
        )
        self._emit(
            session_id,
            "supabase_save_payload",
            "completed",
            duration_ms=payload_ms,
            supabase_available=supabase_available,
        )
        self._emit(
            session_id,
            "kra_analysis",
            "completed",
            duration_ms=kra_ms,
            history_injected=bool(history_summary_text),
        )
        self._raise_if_cancelled(session_id)

        # ── Step 4: Persist KRA and run ORA outputs (NEWBIE + SEASONED) ─────
        # ORA only needs KRA output, so we run both experience levels once and
        # return both variants to the frontend toggle. The same KRA input blob
        # is passed to ORAClient, which builds the prompt and sanitizes output.

        kra_input_package = {
            "session_id": session_id,
            "symptoms_text": symptoms_text,
            "context_text": context_text,
            "ecg": ecg_json,
            "labs": labs_json,
            "history_summary_text": history_summary_text,
            "quality": quality,
        }

        requested_level = str(experience_level or "seasoned").strip().upper()
        if requested_level not in {"NEWBIE", "SEASONED"}:
            requested_level = "SEASONED"

        self._emit(session_id, "supabase_save_kra", "started")
        self._emit(session_id, "ora_refinement", "started")

        def run_kra_persist() -> dict[str, Any]:
            """Worker: persist KRA output while ORA refinement executes in parallel."""
            started_at = time.time()
            if not supabase_available:
                return {
                    "kra_id": str(uuid.uuid4()),
                    "kra_url": None,
                    "supabase_available": False,
                    "error": "PAYLOAD_SAVE_UNAVAILABLE",
                    "duration_ms": int((time.time() - started_at) * 1000),
                }
            result = self._save_kra_history_entry(
                session_id=session_id,
                payload_id=payload_id,
                symptoms_text=symptoms_text,
                kra_result=kra_result,
                patient_id=patient_id,
            )
            result["duration_ms"] = int((time.time() - started_at) * 1000)
            return result

        def run_ora_refinement(level: str) -> dict[str, Any]:
            """Worker: produce one ORA variant for a specific experience level.

            ORAClient receives the KRA result plus the retrieval context that was
            assembled above, then emits the final human-readable clinical report.
            """
            started_at = time.time()
            result = self._ora.refine(
                kra_input=kra_input_package,
                kra_result=kra_result,
                symptoms_text=symptoms_text,
                experience_level=level,
                cancel_event=cancel_event,
            )
            return {
                "level": level,
                "ora_result": result,
                "duration_ms": int((time.time() - started_at) * 1000),
            }

        ora_levels = ["NEWBIE", "SEASONED"]
        selected_key = requested_level.lower()
        if selected_key not in {"newbie", "seasoned"}:
            selected_key = "seasoned"
        ora_runs: dict[str, dict[str, Any]] = {}
        ora_failures: dict[str, str] = {}

        with ThreadPoolExecutor(max_workers=2) as executor:

            # Stage B: run KRA persistence + dual ORA variants concurrently.

            kra_save_future = executor.submit(run_kra_persist)
            ora_futures = {
                level: executor.submit(run_ora_refinement, level)
                for level in ora_levels
            }
            primary_future = ora_futures[selected_key.upper()]
            required_futures = {kra_save_future, primary_future}
            done_required, pending_required = wait(
                required_futures,
                timeout=self._ora_timeout_seconds(),
                return_when=FIRST_EXCEPTION,
            )

            if primary_future not in done_required:
                cancel_event.set()
                logger.error("ORA refinement timed out for session %s after %.1fs", session_id, self._ora_timeout_seconds())
                for future in ora_futures.values():
                    future.cancel()
                raise RuntimeError("ORA_TIMEOUT")

            kra_error = kra_save_future.exception() if kra_save_future in done_required else None
            primary_error = primary_future.exception() if primary_future in done_required else None
            if kra_error is not None or primary_error is not None:
                cancel_event.set()
                for future in ora_futures.values():
                    future.cancel()
                raise kra_error or primary_error

            secondary_futures = {
                level: future
                for level, future in ora_futures.items()
                if future is not primary_future
            }
            secondary_done = set()
            if secondary_futures:
                secondary_done, _ = wait(
                    set(secondary_futures.values()),
                    timeout=self._ora_secondary_timeout_seconds(),
                )

            for level, future in ora_futures.items():
                level_key = level.lower()
                if future in done_required or future in secondary_done:
                    try:
                        ora_runs[level_key] = future.result()
                    except Exception as exc:
                        ora_failures[level_key] = str(exc)
                else:

                    # Secondary mode may exceed timeout; keep pipeline alive and
                    # synthesize fallback from available mode below.

                    future.cancel()
                    ora_failures[level_key] = "ORA_TIMEOUT"

            kra_save_result = kra_save_future.result()
            self._raise_if_cancelled(session_id)

            # Keep diagnosis flow resilient: primary ORA must exist, secondary
            # mode is best-effort with deterministic fallback synthesis.

            if selected_key not in ora_runs:
                selected_err = ora_failures.get(selected_key) or "ORA_OUTPUT_EMPTY"
                raise RuntimeError(selected_err)

            # Ensure both experience-level outputs are always available so
            # frontend toggles can switch between two concrete variants.

            required_levels = ("newbie", "seasoned")
            for missing_level in required_levels:
                if missing_level in ora_runs:
                    continue
                source_level = "seasoned" if missing_level == "newbie" else "newbie"
                source_payload = ora_runs.get(source_level)
                if source_payload is None:
                    continue

                source_result = dict(source_payload.get("ora_result") or {})
                source_text = str(source_result.get("refined_output") or "").strip()
                source_disclaimer = str(source_result.get("disclaimer") or "").strip()
                if not source_text:
                    continue

                # If only one ORA branch completed, keep the workflow alive by
                # synthesizing the missing mode from the available report so the UI
                # still has a toggleable result to show.

                label = "Newbie" if missing_level == "newbie" else "Seasoned"
                fallback_text = (
                    f"### {label} Output (Fallback)\n\n"
                    "The dedicated ORA pass for this mode was unavailable in this run; "
                    "showing the alternate mode output below.\n\n"
                    f"{source_text}"
                )
                ora_runs[missing_level] = {
                    "level": missing_level.upper(),
                    "ora_result": {
                        "refined_output": fallback_text,
                        "disclaimer": source_disclaimer,
                        "status": "partial_fallback",
                    },
                    "duration_ms": int(source_payload.get("duration_ms") or 0),
                }

            if ora_failures:
                logger.warning("ORA secondary output failure(s) for session %s: %s", session_id, ora_failures)

        kra_id = kra_save_result["kra_id"]
        kra_url = kra_save_result.get("kra_url")
        kra_save_ms = int(kra_save_result.get("duration_ms") or 0)
        ora_outputs: dict[str, str] = {}
        ora_disclaimers: dict[str, str] = {}
        for level_key, payload in ora_runs.items():
            ora_result = payload["ora_result"]
            ora_outputs[level_key] = str(ora_result.get("refined_output") or "")
            ora_disclaimers[level_key] = str(ora_result.get("disclaimer") or "")

        # Best-effort: persist ORA outputs onto the payload row as well.
        # This keeps history usable even if the separate ora_outputs inserts
        # intermittently fail (network timeouts, transient Supabase issues).

        if payload_url:
            try:
                enriched_quality = dict(quality or {})
                enriched_quality["ora_outputs"] = dict(ora_outputs)
                enriched_quality["ora_disclaimers"] = dict(ora_disclaimers)
                update_analysis_payload(
                    payload_id,
                    {"quality_json": enriched_quality},
                    timeout=60,
                )
            except Exception as exc:
                logger.warning(
                    "Failed to enrich analysis_payloads.quality_json with ORA outputs for payload %s: %s",
                    payload_id,
                    exc,
                )

        selected_ora_result = ora_runs[selected_key]["ora_result"]
        ora_ms = int(ora_runs[selected_key].get("duration_ms") or 0)
        supabase_available = supabase_available and bool(kra_save_result.get("supabase_available"))

        logger.info(
            "ORA output for session %s\n%s\n%s",
            session_id,
            "=" * 80,
            str(selected_ora_result.get("refined_output") or "[empty ORA output]"),
        )

        processing_steps.append(
            {
                "step": "supabase_save_kra",
                "status": "success" if kra_save_result.get("supabase_available") else "offline_fallback",
                "duration_ms": kra_save_ms,
                "supabase_id": kra_id,
            }
        )
        processing_steps.append(
            {
                "step": "ora_refinement",
                "status": selected_ora_result.get("status", "success"),
                "duration_ms": ora_ms,
                "experience_level": requested_level.lower(),
                "available_levels": sorted(list(ora_outputs.keys())),
            }
        )
        self._emit(
            session_id,
            "supabase_save_kra",
            "completed",
            duration_ms=kra_save_ms,
            supabase_available=bool(kra_save_result.get("supabase_available")),
        )
        self._emit(
            session_id,
            "ora_refinement",
            "completed",
            duration_ms=ora_ms,
            experience_level=requested_level.lower(),
            available_levels=sorted(list(ora_outputs.keys())),
        )
        self._raise_if_cancelled(session_id)

        # ── Step 5: Persist available ORA history entries ────────────────────
        
        self._emit(session_id, "supabase_save_ora", "started")
        ora_save_started = time.time()
        ora_save_results: dict[str, dict[str, Any]] = {}
        for level_key, payload in ora_runs.items():
            if not supabase_available:
                ora_save_results[level_key] = {
                    "ora_id": str(uuid.uuid4()),
                    "ora_url": None,
                    "supabase_available": False,
                    "error": "PAYLOAD_SAVE_UNAVAILABLE",
                }
                continue
            try:
                ora_save_results[level_key] = self._save_ora_history_entry(
                    session_id=session_id,
                    kra_output_id=kra_id,
                    experience_level=level_key.upper(),
                    ora_result=payload["ora_result"],
                    patient_id=patient_id,
                )
            except Exception as exc:
                logger.warning(
                    "ORA history persistence failed for %s/%s: %s",
                    session_id,
                    level_key,
                    exc,
                )
                ora_save_results[level_key] = {
                    "ora_id": str(uuid.uuid4()),
                    "ora_url": None,
                    "supabase_available": False,
                    "error": str(exc),
                }
        ora_save_ms = int((time.time() - ora_save_started) * 1000)
        selected_ora_save = ora_save_results.get(selected_key, {})
        selected_ora_id = selected_ora_save.get("ora_id") or ""
        selected_ora_url = selected_ora_save.get("ora_url")
        supabase_available = supabase_available and all(
            bool(item.get("supabase_available"))
            for item in ora_save_results.values()
        )

        processing_steps.append(
            {
                "step": "supabase_save_ora",
                "status": "success" if all(bool(item.get("supabase_available")) for item in ora_save_results.values()) else "offline_fallback",
                "duration_ms": ora_save_ms,
                "supabase_id": selected_ora_id,
                "saved_levels": sorted(list(ora_save_results.keys())),
            }
        )
        self._emit(
            session_id,
            "supabase_save_ora",
            "completed",
            duration_ms=ora_save_ms,
            supabase_available=all(bool(item.get("supabase_available")) for item in ora_save_results.values()),
            saved_levels=sorted(list(ora_save_results.keys())),
        )
        self._raise_if_cancelled(session_id)

        self._store.set_supabase_ora_id(session_id, selected_ora_id)
        if supabase_available:
            try:
                update_payload_status(payload_id, "completed")
            except Exception:
                pass

        self._store.transition_state(
            session_id=session_id,
            next_state=WorkflowState.ANALYSIS_DONE,
            event_type="ANALYSIS_COMPLETE",
            message="Phase C complete: retrieval + payload + KRA/ORA chaining persisted",
        )
        self._emit(session_id, "analysis_done", "completed")

        elapsed_ms = int((time.time() - started) * 1000)
        return {
            "session_id": session_id,
            "status": "COMPLETED",
            "experience_level": experience_level,
            "supabase_available": supabase_available,
            "supabase_payload_id": payload_id,
            "supabase_payload_url": payload_url,
            "supabase_kra_id": kra_id,
            "supabase_kra_url": kra_url,
            "supabase_ora_id": selected_ora_id,
            "supabase_ora_url": selected_ora_url,
            "processing_steps": processing_steps,
            "kra_raw": kra_result.get("raw_text", ""),
            "ora_outputs": ora_outputs,
            "ora_disclaimers": ora_disclaimers,
            "refined_output": ora_outputs.get(selected_key) or ora_outputs.get("seasoned") or ora_outputs.get("newbie") or "",
            "disclaimer": ora_disclaimers.get(selected_key) or ora_disclaimers.get("seasoned") or ora_disclaimers.get("newbie") or "",
            "rare_case_alert": rare_alert.to_dict() if rare_alert.triggered else None,
            "total_duration_ms": elapsed_ms,
            "context_preview": context_text[:1200],
        }

    @staticmethod
    def _to_float(value: Any) -> Optional[float]:
        """Best-effort scalar parser used during payload normalization."""
        try:
            if value is None or value == "":
                return None
            return float(value)
        except (TypeError, ValueError):
            return None
