"""Private JSONL adapter for the installed offline MLX speech runtime."""

import contextlib
import fcntl
import gc
import importlib.metadata
import json
import os
from pathlib import Path
import select
import sys
import time


class GenerationRejected(Exception):
    """A complete generation failed validation and must not be published."""


def generation_settings(request):
    parameters = request.get("parameters")
    if parameters is None:
        parameters = {
            "kind": "sentence",
            "temperature": 0.7,
            "maxTokens": 2048,
            "maximumDurationSeconds": 120,
        }
    if not isinstance(parameters, dict) or set(parameters) != {
        "kind", "temperature", "maxTokens", "maximumDurationSeconds"
    }:
        raise ValueError("Invalid generation parameters")
    if parameters["kind"] not in ("word", "sentence"):
        raise ValueError("Unknown generation kind")
    temperature = parameters["temperature"]
    tokens = parameters["maxTokens"]
    duration = parameters["maximumDurationSeconds"]
    if type(temperature) not in (int, float) or not 0 <= temperature <= 2:
        raise ValueError("Invalid generation temperature")
    if type(tokens) is not int or not 1 <= tokens <= 8192:
        raise ValueError("Invalid generation token limit")
    if type(duration) not in (int, float) or not 0.1 <= duration <= 120:
        raise ValueError("Invalid generation duration limit")
    return parameters


def generate_request(model, request, np, write, mx):
    settings = generation_settings(request)
    is_word = settings["kind"] == "word"
    attempts = 2 if is_word else 1
    destination = Path(request["outputFile"])
    if destination.exists():
        raise ValueError("Output already exists")
    for attempt in range(1, attempts + 1):
        try:
            pieces = []
            sample_rate = None
            token_count = 0
            text = request["text"]
            if is_word and attempt == 2 and not text.rstrip().endswith((".", "!", "?")):
                text = text.rstrip() + "."
            for result in model.generate(
                text=text, voice=request["voice"], lang_code="English",
                instruct=None if is_word else request["instructions"],
                temperature=settings["temperature"], max_tokens=settings["maxTokens"],
                verbose=False,
            ):
                if sample_rate is not None and sample_rate != result.sample_rate:
                    raise GenerationRejected("Inconsistent sample rate")
                sample_rate = result.sample_rate
                if result.token_count >= settings["maxTokens"]:
                    raise GenerationRejected("Generation reached its token limit")
                token_count += result.token_count
                pieces.append(np.asarray(result.audio))
            if not pieces or sample_rate != 24000:
                raise GenerationRejected("No valid audio")
            audio = np.concatenate(pieces)
            if audio.ndim != 1 or not np.isfinite(audio).all():
                raise GenerationRejected("Invalid audio")
            duration = len(audio) / sample_rate
            if not 0.1 <= duration <= settings["maximumDurationSeconds"]:
                raise GenerationRejected("Invalid audio duration")
            if np.sqrt(np.mean(audio.astype(np.float64) ** 2)) < 0.0001:
                raise GenerationRejected("Silent audio")
            # Publish only a complete accepted result. Rejected candidates never reach disk.
            try:
                write(str(destination), audio, sample_rate, format="wav")
            except Exception:
                destination.unlink(missing_ok=True)
                raise
            return {
                "tokenCount": token_count,
                "durationSeconds": duration,
                "attempts": attempt,
            }
        except GenerationRejected:
            if attempt == attempts:
                raise
        finally:
            gc.collect()
            mx.clear_cache()


def emit(value):
    print(json.dumps(value, ensure_ascii=False), flush=True)


def main():
    root = Path(sys.argv[1]).resolve()
    idle = float(sys.argv[2])
    manifest = json.loads((root / "model-manifest.json").read_text())
    cache = root / "cache"
    cache.mkdir(parents=True, exist_ok=True)
    lock = (cache / "mini-tts.lock").open("a")
    deadline = time.monotonic() + 40
    while True:
        try:
            fcntl.flock(lock, fcntl.LOCK_EX | fcntl.LOCK_NB)
            break
        except BlockingIOError:
            if time.monotonic() >= deadline:
                emit({"type": "error", "code": "TTS_BUSY"})
                return
            time.sleep(0.2)

    with contextlib.redirect_stdout(sys.stderr):
        import mlx.core as mx
        import numpy as np
        from mlx_audio.audio_io import write
        from mlx_audio.tts.utils import load_model

        mx.set_cache_limit(256 * 1024 * 1024)
        model = load_model(model_path=str(root / manifest["directory"]))

    emit({"type": "ready", "engineVersion": f'{importlib.metadata.version("mlx-audio")}/mlx-{importlib.metadata.version("mlx")}'})
    while select.select([sys.stdin], [], [], idle)[0]:
        line = sys.stdin.readline()
        if not line:
            return
        try:
            request = json.loads(line)
            if request.get("type") == "close":
                return
            if request.get("type") != "generate":
                raise ValueError("Unknown request")
            if request["voice"] not in ("ryan", "aiden", "serena"):
                raise ValueError("Unknown voice")
            if not 0 < len(request["text"]) <= 1000:
                raise ValueError("Invalid text length")
            with contextlib.redirect_stdout(sys.stderr):
                metadata = generate_request(model, request, np, write, mx)
            emit({"type": "complete", "id": request["id"], **metadata})
        except GenerationRejected:
            if (request.get("parameters") or {}).get("kind") == "word":
                emit({"type": "error", "code": "TTS_WORD_INVALID"})
                continue
            emit({"type": "error", "code": "TTS_GENERATION_FAILED"})
            return
        except Exception:
            emit({"type": "error", "code": "TTS_GENERATION_FAILED"})
            return


if __name__ == "__main__":
    try:
        main()
    except Exception:
        emit({"type": "error", "code": "TTS_RUNTIME_FAILED"})
        sys.exit(1)
