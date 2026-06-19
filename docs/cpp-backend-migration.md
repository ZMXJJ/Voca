# C++ Inference Backend Migration — Assessment & Plan

**Branch:** `feat/cpp-inference-backend`
**Status:** Assessment complete · integration scaffolding landed · production rollout pending model conversion
**Goal:** Replace the heavy PyTorch + Python VoxCPM inference stack with the lightweight C++/ggml port [`llama.cpp-omni`](https://github.com/tc-mb/llama.cpp-omni) (`tools/omni/voxcpm2`) to shrink the app, drop the torch dependency, and widen device support.

---

## 1. TL;DR

- **Feasible and high-value.** The C++ port builds to a **269 KB** `voxcpm2-cli` binary on macOS arm64/Metal (verified on this branch), replacing a **~2–4 GB** PyTorch/transformers runtime. Model weights also shrink (GGUF F16/Q8 vs safetensors).
- **Feature parity is strong.** Core TTS, audio voice cloning, CFG scale, inference timesteps, seed, bilingual (model-native), 48 kHz mono WAV output, and voice-design `(instruction)` prefixes are all already implemented and match Voca's needs.
- **Two real gaps** require work, only one of which is C++ secondary development:
  1. **Text normalization** — absent in C++. *Solution: keep it in Python* (`wetext`/`inflect`, both torch-free). No C++ change.
  2. **Extreme/ultimate clone (reference-transcript conditioning)** — the CLI's `--prompt-wav`/`--prompt-text` flags are parsed but dead. *Solution: ~150–200 LOC of low-architectural-risk C++ secondary development* (the generic `prefill()` already supports the needed layout). See §6.
- **Recommended integration:** run `llama-tts-server` (OpenAI-compatible, model stays resident) as a child of the existing Python sidecar; the sidecar keeps owning ASR (already ONNX), model download, voice library, and task orchestration. The CLI subprocess path is a useful proof-of-concept but reloads the model every call.
- **Largest non-code cost:** producing and **hosting pre-converted GGUF weights** (BaseLM + Acoustic per model). On-device conversion needs torch and would defeat the purpose.

---

## 2. What Voca actually consumes from VoxCPM (the contract)

Audited from `desktop/python-service/app/services/voxcpm_bridge.py`, `task_manager.py`, `models/schemas.py`, `audio_enhancer.py`.

The bridge touches a tiny surface:

```python
model = voxcpm.VoxCPM(voxcpm_model_path=path, enable_denoiser=False, optimize=False)
waveform = model.generate(
    text,                    # may carry a "(control instruction)" voice-design prefix
    cfg_value, inference_timesteps, normalize, denoise=False,
    reference_wav_path=None, # voice cloning (audio only)
    prompt_wav_path=None,    # extreme clone: same file as reference
    prompt_text=None,        # extreme clone: transcript of reference
) -> Iterable[float]         # samples in [-1,1]; bridge writes 16-bit mono WAV itself
sr = int(model.tts_model.sample_rate)   # 48000 / 44100 / 16000 by variant
```

Generation parameters originate in `GenerationRequest` (schemas.py) and map as:

| Schema field | Forwarded to engine? | Notes |
|---|---|---|
| `targetText` (+ `controlInstruction`) | yes | `(control)text` prefix = voice design |
| `cfgValue` (default 2.0) | yes → `cfg_value` | |
| `inferenceTimesteps` (default 10) | yes → `inference_timesteps` | |
| `normalize` (default true) | yes → `normalize` | **only torch-free feature C++ lacks** |
| `referenceAudioPath` | yes → `reference_wav_path` | audio voice cloning |
| `extremeClone` + `promptText` | yes → `prompt_wav_path`+`prompt_text` | **the C++ gap (§6)** |
| `denoise` (default false) | **no** — bridge runs ZipEnhancer separately | torch-based, optional |
| `seed`, `streaming`, `mode`, `voiceName` | **no** — schema-only / UI routing | seed is a *dead field* today |

**Torch exists in the service only because VoxCPM needs it.** ASR is already ONNX (`sensevoice_onnx_session.py`, no torch). The only torch touchpoints are: `voxcpm_bridge.py` (CUDA preflight + device reporting), `torch_runtime.py`, and `main.py` health device detection. Removing VoxCPM removes the reason for all of them. The bridge already decodes WAV with the stdlib `wave` module — it does **not** depend on torch tensors from `generate()`.

**Models referenced** (`config/model_catalog.json`): `voxcpm2` (default, 48 kHz, ~5 GB safetensors), `voxcpm1_5` (44.1 kHz), `voxcpm_05b` (16 kHz). The C++ port supports all three versions.

---

## 3. What `llama.cpp-omni` provides

Audited from `/Users/huang/CodePrograms/llama.cpp-omni/tools/omni/voxcpm2/` (CLI, runtime, converter) and `tools/server/server-voxcpm2.cpp`.

- **`voxcpm2-cli`** (`build/bin/voxcpm2-cli`) — standalone TTS binary. Verified building & running here.
- **`llama-tts-server`** (`tools/server/server-voxcpm2.cpp`) — standalone OpenAI-compatible `POST /v1/audio/speech`, model resident, hot-load via `/v1/voxcpm2/init`. *Not built by default* (build target separately).
- **`convert_voxcpm2_to_gguf.py`** — converts official PyTorch weights → 2 GGUF files (BaseLM + Acoustic). F16 default; Q8_0 via `llama-quantize`.
- Pipeline: `BaseLM → ResidualLM → FSQ → LocEnc/LocDiT CFM → AudioVAE`. Output **16-bit mono WAV**, 48 kHz for VoxCPM2.

### CLI surface (verified via `--help`)

```
voxcpm2-cli [options] <BaseLM.gguf> <Acoustic.gguf>
  -t/--text   -o/--output   -r/--reference   --prompt-wav   --prompt-text
  --stream   --steps N(=200)   --timesteps N(=10)   --cfg F(=2.0)
  --temperature F(=1.0)   --seed N(=42)   --cpu   --n-gpu-layers N
```

### Feature parity table

| VoxCPM feature Voca uses | C++ status | Evidence / note |
|---|---|---|
| TTS from text | ✅ | `runtime.generate()` |
| Voice design `(instruction)` prefix | ✅ | native, README §Voice Design |
| Audio voice cloning (reference only) | ✅ | `-r` → `generate_with_clone()` |
| CFG scale | ✅ | `--cfg` |
| Inference timesteps | ✅ | `--timesteps` |
| Bilingual ZH/EN | ✅ | model-native (~30 langs); CJK token splitting in runtime |
| Output 48 kHz mono WAV | ✅ | `write_wav()` |
| Seed / reproducibility | ✅ (bonus) | `--seed`; *note `seed==0` = "don't reseed"* |
| Streaming, temperature, Q8 quant | ✅ (bonus) | not currently used by Voca |
| **Text normalization** | ❌ | raw tokenization; **keep Python `wetext`** |
| **Extreme clone (reference transcript)** | ❌ (dead flags) | parsed, never used; **secondary dev §6** |
| Denoise / ZipEnhancer | ❌ | torch-based, `denoise=True` only; decide §5 |

### Maturity

- Code is substantial (~7,900 LOC), structured, with KV-cache decode, cached graphs, streaming, quantization — production-grade, not a prototype. Only 2 TODOs in the VoxCPM2 path, both perf.
- The local clone has squashed history (one commit referencing PR #70) — commit-activity can't be audited locally; track upstream on GitHub.

---

## 4. Recommended integration architecture

Keep the three-layer shape. **Do not** rewrite the Rust→Python→engine path; swap only what's behind the TTS bridge.

```
React ──invoke()──▶ Rust shell ──HTTP :8765──▶ Python sidecar (FastAPI)
                                                 ├─ ASR (ONNX, unchanged)
                                                 ├─ model download / voice lib / tasks (unchanged)
                                                 └─ TTS bridge ──▶ [C++ backend]
                                                                     ├─ POC: spawn voxcpm2-cli per request
                                                                     └─ Prod: llama-tts-server (resident) via local HTTP
```

**Why keep the Python sidecar:** ASR (ONNX), model catalog/download (HF + ModelScope), voice library (SQLite), and `TaskManager` background orchestration are all backend-agnostic and already torch-free. Replacing them is pure cost with no benefit. The migration is surgically scoped to `voxcpm_bridge.py` + `audio_enhancer.py`.

**CLI vs server:** the CLI reloads BaseLM+Acoustic GGUF on every invocation (seconds of latency per generation), unacceptable for interactive use. `llama-tts-server` keeps the model resident — same behavior as today's in-memory VoxCPM. **Target = server**; CLI = POC/fallback/batch.

**Text normalization** moves into the sidecar as a backend-independent preprocessing step (`wetext`+`inflect`, already in `requirements.runtime.txt`, no torch). Normalize → then send normalized text to the C++ backend.

---

## 5. Migration cost assessment

Effort is rough engineering estimate, assuming familiarity with the codebase.

| # | Work item | Where | Effort | Risk |
|---|---|---|---|---|
| 1 | TTS bridge dispatch behind `VOCA_TTS_BACKEND` (python\|cpp) flag | `voxcpm_bridge.py` (+ new `cpp_tts_backend.py`) | S | low |
| 2 | C++ CLI subprocess backend (POC, contract-preserving) | `cpp_tts_backend.py` | S | low |
| 3 | Python-side text normalization (replace VoxCPM's internal `normalize`) | new `text_normalizer.py` | S–M | med (parity vs VoxCPM frontend) |
| 4 | `llama-tts-server` resident-model backend + lifecycle (spawn/health/shutdown, mirrors `sidecar.rs`) | sidecar + Rust or Python | M | med |
| 5 | **GGUF conversion + hosting** of voxcpm2/1.5/0.5b (BaseLM+Acoustic, F16 & Q8) | ops/CI; `convert_voxcpm2_to_gguf.py` | M | med (must host; on-device convert needs torch) |
| 6 | Model catalog + bootstrap readiness rework: safetensors → 2×GGUF per model | `model_catalog.json`, `bootstrap_assets.py`, download flow, schemas/contracts | M | med |
| 7 | **Extreme-clone secondary dev** in C++ (reference-transcript cloning) | `llama.cpp-omni` runtime+CLI/server | M | med (audio A/B) — see §6 |
| 8 | Denoise decision: drop, or port ZipEnhancer to ONNX (like ASR) | `audio_enhancer.py` | S (drop) / M (ONNX) | low/med |
| 9 | Bundling: compile + ship `voxcpm2-cli`/`llama-tts-server` + ggml/metal dylibs per platform; drop torch from `requirements.runtime.*` and `prepare-*` scripts | `scripts/`, `tauri.conf.json`, requirements | M | med (Windows CUDA vs Metal) |
| 10 | Remove torch touchpoints (`torch_runtime.py`, bridge preflight, health device detect) | sidecar | S | low |
| 11 | E2E validation: audio quality A/B vs Python, all modes, both platforms | — | M | — |

**Net:** the *code* migration is modest and well-isolated. The real schedule drivers are **(5/6) the model pipeline rework** (converting & hosting GGUF, reworking download/bootstrap) and **(9) per-platform bundling of native binaries**. The torch removal is what delivers the payoff: app size, no MPS/CUDA Python wheels, faster cold start, broader device reach (CPU-only machines via ggml).

### Payoff (why it's worth it)
- App/runtime size: **~2–4 GB → tens of MB** of native binaries + ggml.
- Model weights: safetensors → GGUF (F16 smaller; Q8_0 roughly halves again).
- No PyTorch/MPS/CUDA Python wheels; simpler, faster cold start; CPU inference is first-class.

---

## 6. Secondary development: extreme/ultimate clone in C++

**Does the framework support the original VoxCPM features? — Yes. Reference-transcript cloning was the one gap; it has now been implemented in the local `llama.cpp-omni` fork (builds clean on Metal, pending A/B audio validation).**

Original VoxCPM has 4 conditioning modes (`VoxCPM/src/voxcpm/model/voxcpm2.py:769-951`). The upstream C++ port implemented only `reference` mode (audio isolated in `ref_audio_start/end` tokens). Voca's "extreme clone" uses **`continuation` mode**: `text = prompt_text + target_text`, with prompt audio VAE-features time-aligned after the text (boundary token `audio_start`). This is the higher-fidelity path and is *not* reproducible by reference mode (concatenating the transcript into reference-mode text makes the model re-speak the prompt → wrong output).

**Low architectural risk — confirmed.** The generic `prefill(VoxCPM2PrefillInputs)` (`voxcpm2_runtime.cpp:798-943`) already consumes arbitrary `token_ids`/`text_mask`/`feat_mask`/`audio_feat` by mask, and already seeds `prefix_feat_cond` from the last audio-feature position (`:932-936`) — the exact mechanism continuation needs. No new ggml graphs required.

**Implemented (150 insertions / 1 deletion across 3 files in the local fork):**
1. `build_continuation_prefill_inputs()` in `voxcpm2_runtime.cpp` — mirror of `build_reference_prefill_inputs()`: tokens `[(prompt_text+target) tokens, kAudioStartToken, prompt-audio-frame pad]`; `text_mask`=1 over text / 0 over prompt-audio frames; `feat_mask` inverse; `audio_feat`=zero patches over text + prompt VAE features last.
2. `generate_with_continuation(target_text, prompt_text, prompt_wav, params)` — mirror of `generate_with_clone()`. **Tokenizes the concatenated string once** (preserves CJK multichar expansion) — does *not* concatenate token IDs.
3. CLI wiring in `voxcpm2_cli.cpp` `main()` — a branch *before* the `reference_wav_path` branch fires when both `--prompt-wav` and `--prompt-text` are set, making the previously-dead flags functional.
4. **Output head-trim:** intentionally omitted — the C++ `output_pool` never pre-seeds the prompt region (unlike Python, which pre-seeds then trims `patch_len*(streaming_prefix_len-1)`), so `decode_to_waveform` already yields only the generated region. **This is the assumption to scrutinize in A/B validation** — if a prompt-tail bleed appears at clip start, add a `(streaming_prefix_len-1)`-patch trim at the *decoder* output rate (48 kHz), not the encoder rate.

`server-voxcpm2.cpp` (`/v1/audio/speech`) was **not** wired for continuation yet — do that when adopting the resident-server integration (§4). The Python `cpp_tts_backend` already passes `--prompt-wav`/`--prompt-text` for extreme clone, with `-r` retained for cross-version safety against an unpatched binary.

**Validation bar met:** compiles cleanly (`voxcpm2-cli`, no warnings). Audio A/B vs Python pending GGUF weights.

---

## 7. Phased rollout

1. **Phase 0 — de-risk (done on this branch):** clone framework, build `voxcpm2-cli` (✅ Metal), audit parity, confirm extreme-clone gap. 
2. **Phase 1 — bridge scaffolding (this branch):** `VOCA_TTS_BACKEND` dispatch + CLI subprocess backend + Python normalization hook. Python path stays default; C++ opt-in for dev.
3. **Phase 2 — model pipeline:** convert voxcpm2 → GGUF, host it, add a GGUF catalog + bootstrap readiness; validate one model end-to-end via CLI.
4. **Phase 3 — resident server:** build/bundle `llama-tts-server`, wire lifecycle, switch bridge default to server backend; A/B audio quality.
5. **Phase 4 — extreme clone secondary dev (§6)** ✅ *(C++ continuation path implemented & building; A/B audio validation pending weights)* + denoise decision (§5).
6. **Phase 5 — strip torch:** drop torch from requirements + prepare scripts, remove `torch_runtime.py` and device-preflight; per-platform native bundling; remove Python VoxCPM submodule from the runtime path.

---

## 8. Open decisions for the team

- **Denoise:** drop ZipEnhancer, or port to ONNX like ASR? (Only used when `denoise=True`.)
- **GGUF hosting:** own HF/ModelScope repo for pre-converted weights? Quantization level (F16 vs Q8_0) as default?
- **Integration:** confirm `llama-tts-server` over per-call CLI for production (perf).
- **Windows:** CUDA build of the native binaries + ggml; confirm Metal/CUDA bundling story per platform.
- **Submodule:** keep `VoxCPM/` (Python) only as the GGUF conversion source, removed from the shipped runtime.

---

## 9. Implementation progress — GPU enablement & GGUF weights (this branch)

**Goal refinement:** the target is **GPU inference (Metal / CUDA / Vulkan)**, not CPU — CPU is too slow (measured RTF ~2.56). The work below makes VoxCPM2 run on the GPU and publishes ready-to-use GGUF weights.

### Done & verified (Apple M4 Pro / Metal)
- **GGUF conversion.** Converted local VoxCPM2 weights (`model.safetensors` + `audiovae.pth` + `config.json`) → `VoxCPM2-BaseLM-F16.gguf` (3.0 GB) + `VoxCPM2-Acoustic-F16.gguf` (1.7 GB) via `convert_voxcpm2_to_gguf.py` (needs `gguf` pip pkg).
- **Q8_0 quantization.** `llama-quantize` BaseLM F16 → **Q8_0 (1.6 GB)**, directly from F16 (the README's "F32 required" is conservative). Acoustic kept F16.
- **Published to HF (public):** **https://huggingface.co/DennisHuang648/VoxCPM2-GGUF** — F16 BaseLM, Q8_0 BaseLM, F16 Acoustic, + model card.
- **Metal GPU works after two fixes in the local `llama.cpp-omni` fork:**
  1. **PAD op** (`voxcpm2_audiovae.cpp`, +26/-2): AudioVAE causal conv left-pads dim0; the Metal PAD kernel only does right-padding and aborted (`unsupported op 'PAD'`). Replaced with an equivalent `ggml_concat` of a zero block (Metal-supported). **ggml core untouched.**
  2. **Residency-set teardown** (`ggml-metal-device.m`, ~+8): `ggml_metal_rsets_free` asserted all resources freed, aborting at process exit (134) *after* the WAV was written. Tolerate stragglers at teardown → **clean exit 0 with residency sets on (full speed).**
- **Measured RTF (Metal GPU, lower = faster):** Q8 BaseLM **~1.6–1.76**, F16 BaseLM **~1.94**, vs CPU **~2.56**. All produce valid 48 kHz mono WAV of identical length to the CPU reference (sample diffs ~0.4%, expected CPU↔GPU FP divergence through the diffusion sampler).

### Voca backend updates (this branch)
- `cpp_tts_backend.py` prefers the **Q8_0 BaseLM** when present (env overrides still win), and now **accepts a valid WAV even on a nonzero exit code** (covers the teardown abort on an unpatched binary) — fails only when no usable audio is produced.

### Still open
- **Multi-backend builds:** Metal verified. CUDA (`-DGGML_CUDA=ON`) and Vulkan (`-DGGML_VULKAN=ON`) builds + per-platform bundling of the native binary and ggml libs still to do. The same PAD fix applies to all backends (it removed a non-portable op); the residency fix is Metal-only.
- **Model catalog / bootstrap rework:** point a GGUF catalog entry at `DennisHuang648/VoxCPM2-GGUF` and adapt `bootstrap_assets` readiness (2× GGUF instead of safetensors). Not yet wired — current catalog still describes the safetensors layout.
- **Upstreaming:** the two C++ fixes live on the local fork branches; offer them back to `llama.cpp-omni`.
- **A/B audio validation** of extreme-clone (§6) now possible with these weights.
