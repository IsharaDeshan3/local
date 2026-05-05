from __future__ import annotations

import asyncio
import json
import logging
import queue
import traceback
from typing import Any, AsyncGenerator, Optional

from fastapi import APIRouter, HTTPException, Request, status
from fastapi.responses import StreamingResponse
from pydantic import BaseModel, Field

logger = logging.getLogger(__name__)

from backend.processing.workflow_state import WorkflowState
from backend.processing.workflow_store import WorkflowStore
from backend.processing.workflow_service import WorkflowService

from backend.processing.supabase_payload import (
    delete_history_record,
    get_patient_history_bundle,
)

router = APIRouter()
# Shared store and service instances stores workflow session state and pipeline events
# aligned across init, extraction, analysis, and cleanup endpoints.
_store = WorkflowStore()
_workflow = WorkflowService()

class SessionInitRequest(BaseModel):
    patient_id: str = Field(..., min_length=1)
    doctor_id: Optional[str] = None
    correlation_id: str = Field(..., min_length=1)

class SessionInitResponse(BaseModel):
    session_id: str
    state: str

class StepSaveResponse(BaseModel):
    session_id: str
    state: str
    saved_step: str
    revision: int
    updated_at: str

class ExtractionSaveRequest(BaseModel):
    symptoms: list[str] = Field(default_factory=list)
    risk_factors: list[str] = Field(default_factory=list)
    translated_text: Optional[str] = None
    raw: Optional[dict[str, Any]] = None

class ECGSaveRequest(BaseModel):
    result: dict[str, Any]

class LabSaveRequest(BaseModel):
    result: dict[str, Any]

class AnalysisRunRequest(BaseModel):
    experience_level: str = Field(default="seasoned")

class AnalysisStopResponse(BaseModel):
    session_id: str
    state: str
    status: str
 
@router.post("/session/init", response_model=SessionInitResponse)
async def init_session(payload: SessionInitRequest) -> SessionInitResponse:
    # The frontend creates a workflow session first so later step payloads and
    # SSE events can be correlated by session_id.
    row = _store.create_session(
        patient_id=payload.patient_id,
        doctor_id=payload.doctor_id,
        correlation_id=payload.correlation_id,
    )
    return SessionInitResponse(session_id=row["session_id"], state=row["current_state"])

@router.get("/session/{session_id}")
async def get_session(session_id: str) -> dict[str, Any]:
    session = _store.get_session(session_id)
    if session is None:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="Session not found")
    return session


@router.get("/session/latest/{patient_id}")
async def get_latest_session(patient_id: str, include_completed: bool = False) -> dict[str, Any]:
    session = _store.get_latest_session_for_patient(
        patient_id,
        include_completed=include_completed,
    )
    if session is None:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="No session found")
    return session


@router.get("/patient/{patient_id}/sessions")
async def list_patient_sessions(
    patient_id: str,
    include_completed: bool = True,
    limit: int = 25,
) -> dict[str, Any]:
    sessions = _store.list_sessions_for_patient(
        patient_id,
        include_completed=include_completed,
        limit=limit,
    )
    return {
        "patient_id": patient_id,
        "count": len(sessions),
        "sessions": sessions,
    }


@router.delete("/patient/{patient_id}/sessions/active")
async def delete_active_patient_sessions(patient_id: str) -> dict[str, Any]:
    deleted = _store.delete_active_sessions_for_patient(patient_id)
    return {
        "status": "ok",
        **deleted,
    }

@router.post("/session/{session_id}/extraction", response_model=StepSaveResponse)
async def save_extraction(session_id: str, payload: ExtractionSaveRequest) -> StepSaveResponse:
    # Step 1 persists the extracted symptom payload before ECG/lab/analysis.
    try:
        result = _store.save_step (
            session_id=session_id,
            step_name="extraction",
            payload=payload.model_dump(),
            next_state=WorkflowState.EXTRACTION_DONE,
        )
        return StepSaveResponse(**result)
    except ValueError:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="Session not found")
    except RuntimeError as exc:
        raise HTTPException(status_code=status.HTTP_409_CONFLICT, detail=str(exc))

@router.post("/session/{session_id}/ecg", response_model=StepSaveResponse)
async def save_ecg(session_id: str, payload: ECGSaveRequest) -> StepSaveResponse:
    # ECG is optional, but when present it advances the workflow state so
    # the analysis step can include structured cardiac findings.
    try:
        result = _store.save_step(
            session_id=session_id,
            step_name="ecg",
            payload=payload.model_dump(),
            next_state=WorkflowState.ECG_DONE,
        )
        return StepSaveResponse(**result)
    except ValueError:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="Session not found")
    except RuntimeError as exc:
        raise HTTPException(status_code=status.HTTP_409_CONFLICT, detail=str(exc))

@router.post("/session/{session_id}/lab", response_model=StepSaveResponse)
async def save_lab(session_id: str, payload: LabSaveRequest) -> StepSaveResponse:
    # Lab results are persisted separately so the analysis pipeline can rerun
    # with updated clinical data without recreating the entire session.
    try:
        result = _store.save_step(
            session_id=session_id,
            step_name="lab",
            payload=payload.model_dump(),
            next_state=WorkflowState.LAB_DONE,
        )
        return StepSaveResponse(**result)
    except ValueError:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="Session not found")
    except RuntimeError as exc:
        raise HTTPException(status_code=status.HTTP_409_CONFLICT, detail=str(exc))

@router.post("/session/{session_id}/analysis/run")
async def run_analysis(session_id: str, payload: AnalysisRunRequest) -> dict[str, Any]:
    # The actual heavy work happens inside WorkflowService.run_analysis(); this
    # handler only moves it off the request thread and returns the result.
    import asyncio
    loop = asyncio.get_event_loop()
    try:
        result = await loop.run_in_executor(
            None,
            lambda: _workflow.run_analysis(
                session_id=session_id,
                experience_level=payload.experience_level,
            ),
        )
        return result
    except ValueError as exc:
        if str(exc) == "SESSION_NOT_FOUND":
            _workflow.event_bus.emit(session_id, {"step": "analysis_done", "status": "error", "message": "Session not found"})
            raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="Session not found")

        _workflow.event_bus.emit(session_id, {"step": "analysis_done", "status": "error", "message": str(exc)})
        logger.error("Analysis pipeline value error:\n%s", traceback.format_exc())
        raise HTTPException(status_code=status.HTTP_500_INTERNAL_SERVER_ERROR, detail=f"Analysis failed: {exc}")

    except RuntimeError as exc:
        status_name = "cancelled" if "ANALYSIS_CANCELLED" in str(exc) else "error"
        _workflow.event_bus.emit(session_id, {"step": "analysis_done", "status": status_name, "message": str(exc)})
        raise HTTPException(status_code=status.HTTP_409_CONFLICT, detail=str(exc))
        
    except Exception as exc:
        _workflow.event_bus.emit(session_id, {"step": "analysis_done", "status": "error", "message": str(exc)})
        logger.error("Analysis pipeline failed:\n%s", traceback.format_exc())
        raise HTTPException(status_code=status.HTTP_500_INTERNAL_SERVER_ERROR, detail=f"Analysis failed: {exc}")

@router.post("/session/{session_id}/analysis/stop", response_model=AnalysisStopResponse)
async def stop_analysis(session_id: str) -> AnalysisStopResponse:
    # Cancellation is cooperative: the request marks the session, and the
    # worker thread stops at the next checkpoint.
    try:
        result = _workflow.request_stop_analysis(session_id=session_id)
        return AnalysisStopResponse(**result)
    except ValueError:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="Session not found")

@router.delete("/patient/{patient_id}/cleanup")
async def cleanup_patient_data(patient_id: str) -> dict[str, Any]:
    """
    Delete all analysis data (Supabase + local SQLite) for a patient.

    Called by the Next.js frontend when a doctor removes a patient.
    """
    from backend.processing.supabase_payload import delete_patient_data
    try:
        result = delete_patient_data(patient_id)
        return {"status": "ok", "patient_id": patient_id, "deleted": result}
    except Exception as exc:
        logger.error("Patient cleanup failed for %s: %s", patient_id, exc)
        raise HTTPException(
            status_code=status.HTTP_500_INTERNAL_SERVER_ERROR,
            detail=f"Cleanup failed: {exc}",
        )

@router.get("/patient/{patient_id}/history")
async def get_patient_history(patient_id: str) -> dict[str, Any]:
    # The frontend uses this to show prior AI output and history summaries that
    # later feed back into the KRA prompt through workflow_service.py.
    try:
        return get_patient_history_bundle(patient_id)
    except Exception as exc:
        logger.error("Patient history fetch failed for %s: %s", patient_id, exc)
        raise HTTPException(
            status_code=status.HTTP_500_INTERNAL_SERVER_ERROR,
            detail=f"History fetch failed: {exc}",
        )

@router.delete("/history/{payload_id}")
async def delete_patient_history(payload_id: str) -> dict[str, Any]:
    try:
        result = delete_history_record(payload_id)
        return {"status": "ok", "payload_id": payload_id, "deleted": result}
    except ValueError as exc:
        if str(exc) == "PAYLOAD_NOT_FOUND":
            raise HTTPException(
                status_code=status.HTTP_404_NOT_FOUND,
                detail="History record not found",
            )
        raise
    except Exception as exc:
        logger.error("History delete failed for %s: %s", payload_id, exc)
        raise HTTPException(
            status_code=status.HTTP_500_INTERNAL_SERVER_ERROR,
            detail=f"History delete failed: {exc}",
        )

@router.get("/session/{session_id}/analysis/events")
async def analysis_events(session_id: str, request: Request) -> StreamingResponse:
    """
    Server-Sent Events stream that emits real-time pipeline step updates.

    Each event is a JSON object::

        {"step": "kra_analysis", "status": "started", "duration_ms": 0}
        {"step": "kra_analysis", "status": "completed", "duration_ms": 3210}
        {"step": "analysis_done",  "status": "completed"}

    The stream closes after the "analysis_done" event or when the client
    disconnects.  Subscribe *before* calling /analysis/run so you don't
    miss early events.
    """
    session = _store.get_session(session_id)
    if session is None:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="Session not found")

    # workflow_service.py publishes step events into this queue while the
    # frontend listens here to update progress in real time.
    queue = _workflow.event_bus.subscribe(session_id)

    async def generator() -> AsyncGenerator[str, None]:
        try:
            while True:
                if await request.is_disconnected():
                    break
                try:
                    event = await asyncio.get_event_loop().run_in_executor(
                        None, lambda: queue.get(timeout=15)
                    )
                except Exception:
                    # Emit a heartbeat comment so long model runs do not look idle
                    # to the browser or any proxy sitting between frontend/backend.
                    yield ": keep-alive\n\n"
                    continue

                data = json.dumps(event)
                yield f"data: {data}\n\n"

                # Close stream once the terminal event arrives
                if event.get("step") == "analysis_done" or event.get("status") in {"error", "cancelled"} or event.get("__eof__"):
                    break
        finally:
            _workflow.event_bus.unsubscribe(session_id, queue)

    return StreamingResponse(
        generator(),
        media_type="text/event-stream",
        headers={
            "Cache-Control": "no-cache",
            "X-Accel-Buffering": "no",
            "Connection": "keep-alive",
        },
    )