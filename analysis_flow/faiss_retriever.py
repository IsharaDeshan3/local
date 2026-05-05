from __future__ import annotations

import json
import logging
import os
import pickle
from pathlib import Path
from typing import Any, Dict, Iterable, List, Optional

import faiss
import numpy as np

logger = logging.getLogger(__name__)

_ROOT = Path(__file__).resolve().parent
_DEFAULT_INDEX = _ROOT / "knowledge_base" / "vector_index.faiss"
_DEFAULT_META = _ROOT / "knowledge_base" / "vector_db_metadata.pkl"
_DEFAULT_MODEL = os.getenv("FAISS_EMBEDDING_MODEL", "sentence-transformers/all-MiniLM-L6-v2")


class FAISSRetriever:
    def __init__(self, index_path: str | Path = _DEFAULT_INDEX, metadata_path: str | Path = _DEFAULT_META, model_name: str = _DEFAULT_MODEL, device: str = "auto") -> None:
        self.index_path = Path(index_path)
        self.metadata_path = Path(metadata_path)

        if not self.index_path.exists():
            raise FileNotFoundError(f"FAISS index not found: {self.index_path}")
        if not self.metadata_path.exists():
            raise FileNotFoundError(f"FAISS metadata not found: {self.metadata_path}")

        self.index = faiss.read_index(str(self.index_path))
        self._raw_meta = self._load_metadata(self.metadata_path)
        self._meta_by_index = self._build_meta_index(self._raw_meta)

        self._model = None
        self._model_name = model_name
        self._device = self._resolve_device(device)
        self._load_embedding_model()

        logger.info(
            "FAISS retriever ready: %d vectors, dim=%d, device=%s",
            getattr(self.index, "ntotal", 0),
            getattr(self.index, "d", 0),
            self._device,
        )

    @staticmethod
    def _resolve_device(device: str) -> str:
        requested = (device or "auto").lower()
        if requested == "auto":
            try:
                import torch

                return "cuda" if torch.cuda.is_available() else "cpu"
            except Exception:
                return "cpu"
        return requested

    @staticmethod
    def _load_metadata(path: Path) -> Any:
        with open(path, "rb") as handle:
            return pickle.load(handle)

    @staticmethod
    def _build_meta_index(raw_meta: Any) -> Dict[int, Dict[str, Any]]:
        if isinstance(raw_meta, dict) and "chunks" in raw_meta and isinstance(raw_meta["chunks"], list):
            return {int(i): dict(item) for i, item in enumerate(raw_meta["chunks"])}

        if isinstance(raw_meta, list):
            return {int(i): dict(item) for i, item in enumerate(raw_meta)}

        if isinstance(raw_meta, dict):
            indexed: Dict[int, Dict[str, Any]] = {}
            for key, value in raw_meta.items():
                try:
                    idx = int(key)
                except Exception:
                    continue
                indexed[idx] = dict(value) if isinstance(value, dict) else {"value": value}
            return indexed

        return {}

    def _load_embedding_model(self) -> None:
        try:
            from sentence_transformers import SentenceTransformer

            self._model = SentenceTransformer(self._model_name, device=self._device)
            logger.info("Loaded embedding model %s on %s", self._model_name, self._device)
        except Exception as exc:
            logger.warning("Embedding model load failed (%s). Falling back to heuristic retrieval.", exc)
            self._model = None

    def _embed_query(self, query: str) -> Optional[np.ndarray]:
        if self._model is None:
            return None

        vec = self._model.encode([query], show_progress_bar=False)[0]
        vec = np.asarray(vec, dtype="float32")
        norm = float(np.linalg.norm(vec))
        if norm > 0:
            vec = vec / norm
        return vec

    def _resolve_source_text(self, meta: Dict[str, Any]) -> str:
        for key in ("text", "content", "chunk_text", "passage", "body"):
            value = meta.get(key)
            if isinstance(value, str) and value.strip():
                return value.strip()

        source_file = str(meta.get("source_file") or "").strip()
        if not source_file:
            return ""

        candidate = Path(source_file)
        if not candidate.is_absolute():
            candidate = _ROOT / "knowledge_base" / source_file
            if not candidate.exists():
                candidate = _ROOT / source_file

        if not candidate.exists():
            return ""

        try:
            text = candidate.read_text(encoding="utf-8", errors="ignore")
        except Exception:
            return ""

        start = meta.get("start_char")
        end = meta.get("end_char")
        try:
            start_idx = max(0, int(start)) if start is not None else 0
            end_idx = int(end) if end is not None else len(text)
            return text[start_idx:end_idx].strip()
        except Exception:
            return text.strip()

    @staticmethod
    def _keyword_score(query: str, text: str) -> float:
        query_tokens = {token for token in query.lower().split() if len(token) > 2}
        text_lower = text.lower()
        if not query_tokens or not text_lower:
            return 0.0

        overlap = sum(1 for token in query_tokens if token in text_lower)
        return float(overlap) / float(len(query_tokens))

    def _heuristic_search(self, query: str, top_k: int) -> List[tuple[int, float]]:
        scored: List[tuple[int, float]] = []
        for idx, meta in self._meta_by_index.items():
            text = self._resolve_source_text(meta)
            score = self._keyword_score(query, text)
            if score > 0:
                scored.append((idx, score))

        scored.sort(key=lambda item: item[1], reverse=True)
        return scored[:top_k]

    def search(self, query: str, top_k: int = 5) -> List[Dict[str, Any]]:
        if top_k <= 0:
            return []

        results: List[Dict[str, Any]] = []
        query_vec = self._embed_query(query)

        if query_vec is not None and getattr(self.index, "d", None) == query_vec.shape[-1]:
            distances, indices = self.index.search(query_vec.reshape(1, -1), top_k)
            ordered = [(int(idx), float(max(dist, 0.0))) for dist, idx in zip(distances[0], indices[0]) if int(idx) != -1]
        else:
            ordered = self._heuristic_search(query, top_k)

        for idx, score in ordered:
            meta = dict(self._meta_by_index.get(idx, {}))
            text = self._resolve_source_text(meta)
            results.append(
                {
                    "index": idx,
                    "score": score,
                    "text": text,
                    "record": meta,
                    "category": meta.get("category"),
                    "pmid": meta.get("pmid"),
                    "condition": meta.get("condition"),
                    "source_file": meta.get("source_file"),
                    "source_type": meta.get("source_type"),
                    "chunk_id": meta.get("chunk_id"),
                    "chunk_type": meta.get("chunk_type"),
                    "parent_id": meta.get("parent_id"),
                }
            )

        return results

    def get_context_string(self, query: str, top_k: int = 5, include_metadata: bool = True) -> str:
        results = self.search(query, top_k=top_k)
        if not results:
            return ""

        parts = ["--- TEXTBOOK REFERENCES ---"]
        for i, result in enumerate(results, 1):
            text = str(result.get("text") or "").strip()
            if len(text) > 700:
                text = text[:700].rstrip() + "..."

            parts.append(
                f"\n[{i}] Score: {result['score']:.3f} | Condition: {result.get('condition') or 'Unknown'}"
            )
            if include_metadata:
                parts.append(
                    f"    Source: {result.get('source_file') or 'unknown'} | Chunk: {result.get('chunk_id') or 'n/a'}"
                )
            if text:
                parts.append(f"    Text: {text}")

        return "\n".join(parts)

    def calculate_retrieval_quality(self, query: str, top_k: int = 5) -> Dict[str, Any]:
        results = self.search(query, top_k=top_k)
        if not results:
            return {"status": "NO_RESULTS", "top_score": 0.0, "avg_score": 0.0, "num_results": 0}

        scores = [float(result.get("score", 0.0)) for result in results]
        top_score = max(scores)
        avg_score = sum(scores) / len(scores)

        if top_score >= 0.72:
            status = "HIGH_CONFIDENCE"
        elif top_score >= 0.55:
            status = "MEDIUM_CONFIDENCE"
        else:
            status = "LOW_CONFIDENCE"

        return {
            "status": status,
            "top_score": top_score,
            "avg_score": avg_score,
            "num_results": len(results),
        }

        