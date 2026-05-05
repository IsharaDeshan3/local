"""FastAPI backend entry point for the workflow-based analysis service."""

from __future__ import annotations

import asyncio
import logging
import os
import sys
import time
from contextlib import asynccontextmanager
from datetime import datetime
from pathlib import Path

from dotenv import find_dotenv, load_dotenv
from fastapi import FastAPI
from fastapi.middleware.cors import CORSMiddleware

if os.name == "nt":
    # Avoid Windows Proactor socket-accept issues under uvicorn.
    asyncio.set_event_loop_policy(asyncio.WindowsSelectorEventLoopPolicy())

sys.path.insert(0, str(Path(__file__).parent))
sys.path.insert(0, str(Path(__file__).parent.parent))

load_dotenv(find_dotenv(), override=True)

logging.basicConfig(
    level=logging.INFO,
    format="%(asctime)s | %(levelname)s | %(name)s | %(message)s",
)

for noisy_logger in (
    "httpx",
    "urllib3",
    "urllib3.connectionpool",
    "huggingface_hub",
    "sentence_transformers",
    "transformers",
    "filelock",
):
    level = logging.ERROR if noisy_logger == "urllib3.connectionpool" else logging.WARNING
    logging.getLogger(noisy_logger).setLevel(level)

logger = logging.getLogger(__name__)

from routes import workflow


@asynccontextmanager
async def lifespan(app: FastAPI):
    """Application lifespan: validate dependencies and warm heavy components."""
    startup_started = time.perf_counter()
    logger.info("Starting KRA-ORA Medical Analysis System...")

    try:
        schema_started = time.perf_counter()
        from processing.supabase_payload import verify_schema

        schema_result = verify_schema()
        if not schema_result["ok"]:
            logger.warning(
                "SUPABASE SCHEMA INCOMPLETE - run migration_add_columns.sql. Details: %s",
                schema_result["tables"],
            )
        logger.info("Startup: schema check completed in %.1fms", (time.perf_counter() - schema_started) * 1000)
    except Exception as exc:
        logger.warning("Supabase schema check skipped (connection issue): %s", exc)

    try:
        provider_started = time.perf_counter()
        provider_readiness = workflow._workflow.readiness_status()  # pylint: disable=protected-access
        logger.info(
            "Startup: provider readiness KRA=%s ORA=%s in %.1fms",
            provider_readiness.get("kra"),
            provider_readiness.get("ora"),
            (time.perf_counter() - provider_started) * 1000,
        )
    except Exception as exc:
        logger.warning("Inference provider readiness check failed: %s", exc)

    try:
        faiss_started = time.perf_counter()
        from backend.processing.search_service import SearchService

        search_svc = SearchService()
        readiness = search_svc.readiness_status()
        logger.info(
            "Startup: FAISS preload textbook=%s rare_cases=%s in %.1fms",
            readiness.get("faiss_ready"),
            readiness.get("rare_cases_ready"),
            (time.perf_counter() - faiss_started) * 1000,
        )
    except Exception:
         
        logger.warning("FAISS index preload failed - first search will be slower")
        logger.exception("FAISS preload exception")

    logger.info("System ready in %.1fs", (time.perf_counter() - startup_started))
    yield
    logger.info("Shutting down...")


app = FastAPI(
    title="KRA-ORA Medical Analysis API",
    description="Workflow-based AI medical analysis with remote KRA/ORA providers and Supabase persistence",
    version="2.0.0",
    lifespan=lifespan,
)

app.add_middleware(
    CORSMiddleware,
    allow_origins=[
        "http://localhost:3000",
        "http://localhost:5173",
        os.getenv("FRONTEND_URL", "http://localhost:3000"),
    ],
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)

app.include_router(workflow.router, prefix="/api/workflow/v1", tags=["Workflow v1"])


@app.get("/health")
async def health_check():
    return {
        "status": "healthy",
        "timestamp": datetime.utcnow().isoformat(),
        "version": "2.0.0",
    }


@app.get("/health/schema")
async def schema_check():
    from processing.supabase_payload import verify_schema

    return verify_schema()


@app.get("/")
async def root():
    return {
        "name": "KRA-ORA Medical Analysis API",
        "version": "2.0.0",
        "docs": "/docs",
        "health": "/health",
        "workflow": "/api/workflow/v1",
    }


if __name__ == "__main__":
    import uvicorn

    port = int(os.getenv("PORT", 8080))
    uvicorn.run(
        "main:app",
        host="0.0.0.0",
        port=port,
        reload=True,
        log_level="info",
    )