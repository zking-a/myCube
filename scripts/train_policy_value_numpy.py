"""Vectorized NumPy trainer for the reusable dynamic policy-value model.

The game/rule side intentionally stays in Node.js. It exports canonical states,
dynamic legal actions and labels as JSONL; this module only owns numerical
optimization and writes the same ``dynamic-policy-value-v1`` checkpoint that
the JavaScript runtime already understands.
"""

from __future__ import annotations

import argparse
import hashlib
import json
import math
import time
from dataclasses import dataclass
from pathlib import Path
from typing import Iterable

import numpy as np


POLICY_COMPONENTS = {
    "stateInput", "stateInputBias", "stateHidden", "stateHiddenBias",
    "actionInput", "actionBias", "policyPair", "policyAction", "policyBias",
}


@dataclass
class Sample:
    """One position from the perspective of the player who is to move."""

    game_id: str
    split_group_id: str
    state: np.ndarray
    actions: np.ndarray
    policy: np.ndarray
    candidate_mask: np.ndarray
    value: float
    value_mask: float
    moves_to_go: float
    progress_mask: float
    ply: int
    final_ply: int


def read_samples(path: Path) -> list[Sample]:
    """Load the line-oriented interchange format without game-specific logic."""
    samples: list[Sample] = []
    with path.open("r", encoding="utf-8") as stream:
        for line_number, line in enumerate(stream, 1):
            if not line.strip():
                continue
            payload = json.loads(line)
            state = np.asarray(payload["state"], dtype=np.float32)
            actions = np.asarray(payload["actions"], dtype=np.float32)
            policy = np.asarray(payload["policy"], dtype=np.float32)
            if actions.ndim != 2 or len(actions) != len(policy) or not len(actions):
                raise ValueError(f"invalid dynamic action set at line {line_number}")
            raw_candidate_mask = payload.get("candidateMask")
            if isinstance(raw_candidate_mask, list) and raw_candidate_mask:
                if len(raw_candidate_mask) != len(actions):
                    raise ValueError(f"candidateMask length mismatch at line {line_number}")
                candidate_mask = np.asarray(raw_candidate_mask, dtype=np.float32) > 0
                if not bool(candidate_mask.any()):
                    raise ValueError(f"candidateMask excludes every legal action at line {line_number}")
                outside_mass = float(np.maximum(policy[~candidate_mask], 0).sum())
                if outside_mass > 1e-5:
                    raise ValueError(f"policyTarget assigns mass outside candidateMask at line {line_number}")
            else:
                # V0 teacher and generic adapters supervise every legal action.
                candidate_mask = np.ones(len(actions), dtype=bool)
            policy = np.where(candidate_mask, policy, 0)
            policy_sum = float(policy.sum())
            if not math.isfinite(policy_sum) or policy_sum <= 0:
                raise ValueError(f"invalid policy distribution at line {line_number}")
            game_id = str(payload.get("gameId") or f"legacy-position-{line_number:08d}")
            split_group_id = str(payload.get("splitGroupId") or "")
            if not split_group_id:
                raise ValueError(f"missing splitGroupId at line {line_number}")
            value_mask = float(np.clip(payload.get("valueMask", 1), 0, 1))
            ply = max(0, int(payload.get("ply", 0)))
            final_ply = max(0, int(payload.get("finalPly", 0)))
            progress_scale = max(1, int(payload.get("progressScale", 160)))
            progress_mask = float(np.clip(
                payload.get("progressMask", value_mask if final_ply > ply else 0), 0, 1,
            ))
            moves_to_go = float(np.clip(
                payload.get("movesToGo", (final_ply - ply) / progress_scale), 0, 1,
            )) if progress_mask > 0 else 0.0
            samples.append(Sample(
                game_id, split_group_id, state, actions, policy / policy_sum, candidate_mask,
                float(np.clip(payload["value"], -1, 1)), value_mask,
                moves_to_go, progress_mask, ply, final_ply,
            ))
    if not samples:
        raise ValueError("training dataset is empty")
    return samples


def stage_name(sample: Sample) -> str:
    """Map an absolute ply to an opening/middle/endgame bucket."""
    progress = sample.ply / max(1, sample.final_ply)
    return "early" if progress < 1 / 3 else ("middle" if progress < 2 / 3 else "late")


def balanced_game_stage_indices(samples: list[Sample], allowed_groups: set[str], *,
                                samples_per_stage: int, seed: int,
                                repeat_short_stages: bool) -> np.ndarray:
    """Give each game and each present phase the same training opportunity.

    Long games must not contribute more optimizer steps simply because they
    contain more positions. Training repeats a short phase when necessary;
    validation never repeats positions and therefore remains descriptive.
    """
    games: dict[str, dict[str, list[int]]] = {}
    for index, sample in enumerate(samples):
        if sample.split_group_id not in allowed_groups:
            continue
        buckets = games.setdefault(sample.game_id, {"early": [], "middle": [], "late": []})
        buckets[stage_name(sample)].append(index)
    random = np.random.default_rng(seed)
    selected: list[int] = []
    for game_id in sorted(games):
        for stage in ("early", "middle", "late"):
            candidates = np.asarray(games[game_id][stage], dtype=np.int64)
            if not len(candidates):
                continue
            if repeat_short_stages:
                chosen = random.choice(
                    candidates, size=samples_per_stage,
                    replace=len(candidates) < samples_per_stage,
                )
            else:
                chosen = random.choice(
                    candidates, size=min(samples_per_stage, len(candidates)), replace=False,
                )
            selected.extend(int(index) for index in chosen)
    return np.asarray(selected, dtype=np.int64)


class DynamicPolicyValueModel:
    """Two-tower state/action network compatible with ``policy_value_model.js``."""

    FORMAT = "dynamic-policy-value-v2"
    READABLE_FORMATS = {"dynamic-policy-value-v1", FORMAT}

    def __init__(self, state_size: int, action_size: int, hidden_size: int = 32,
                 action_hidden_size: int = 12, seed: int = 1) -> None:
        self.state_size = state_size
        self.action_size = action_size
        self.hidden_size = hidden_size
        self.action_hidden_size = action_hidden_size
        self.seed = seed
        random = np.random.default_rng(seed)

        def he(shape: tuple[int, ...], fan_in: int) -> np.ndarray:
            return random.uniform(-1, 1, shape).astype(np.float32) * np.float32(math.sqrt(2 / max(1, fan_in)))

        self.weights: dict[str, np.ndarray] = {
            "stateInput": he((hidden_size, state_size), state_size),
            "stateInputBias": np.zeros(hidden_size, dtype=np.float32),
            "stateHidden": he((hidden_size, hidden_size), hidden_size),
            "stateHiddenBias": np.zeros(hidden_size, dtype=np.float32),
            "actionInput": he((action_hidden_size, action_size), action_size),
            "actionBias": np.zeros(action_hidden_size, dtype=np.float32),
            "policyPair": he((hidden_size, action_hidden_size), hidden_size),
            "policyAction": he((action_hidden_size,), action_hidden_size),
            "policyBias": np.zeros(1, dtype=np.float32),
            "value": he((hidden_size,), hidden_size),
            "valueBias": np.zeros(1, dtype=np.float32),
            "movesToGo": he((hidden_size,), hidden_size),
            "movesToGoBias": np.zeros(1, dtype=np.float32),
        }

    def _batch(self, samples: list[Sample], indices: np.ndarray) -> tuple[np.ndarray, ...]:
        """Pad only the current mini-batch; mask keeps padding out of softmax."""
        batch = [samples[int(index)] for index in indices]
        max_actions = max(len(sample.actions) for sample in batch)
        states = np.stack([sample.state for sample in batch])
        actions = np.zeros((len(batch), max_actions, self.action_size), dtype=np.float32)
        policy = np.zeros((len(batch), max_actions), dtype=np.float32)
        mask = np.zeros((len(batch), max_actions), dtype=bool)
        values = np.asarray([sample.value for sample in batch], dtype=np.float32)
        value_masks = np.asarray([sample.value_mask for sample in batch], dtype=np.float32)
        moves_to_go = np.asarray([sample.moves_to_go for sample in batch], dtype=np.float32)
        progress_masks = np.asarray([sample.progress_mask for sample in batch], dtype=np.float32)
        for row, sample in enumerate(batch):
            count = len(sample.actions)
            actions[row, :count] = sample.actions
            policy[row, :count] = sample.policy
            mask[row, :count] = sample.candidate_mask
        return states, actions, policy, mask, values, value_masks, moves_to_go, progress_masks

    def forward(self, states: np.ndarray, actions: np.ndarray, mask: np.ndarray) -> dict[str, np.ndarray]:
        """Vectorized forward pass for a padded dynamic-action mini-batch."""
        w = self.weights
        first = np.tanh(states @ w["stateInput"].T + w["stateInputBias"])
        second = np.tanh(first @ w["stateHidden"].T + w["stateHiddenBias"])
        action_embeddings = np.tanh(actions @ w["actionInput"].T + w["actionBias"])
        policy_vector = second @ w["policyPair"] + w["policyAction"]
        logits = np.einsum("bma,ba->bm", action_embeddings, policy_vector) + w["policyBias"][0]
        masked_logits = np.where(mask, logits, np.float32(-1e9))
        shifted = masked_logits - masked_logits.max(axis=1, keepdims=True)
        probabilities = np.exp(shifted) * mask
        probabilities /= np.maximum(probabilities.sum(axis=1, keepdims=True), np.float32(1e-12))
        values = np.tanh(second @ w["value"] + w["valueBias"][0])
        progress = 1 / (1 + np.exp(-np.clip(second @ w["movesToGo"] + w["movesToGoBias"][0], -30, 30)))
        return {
            "first": first, "second": second, "action_embeddings": action_embeddings,
            "policy_vector": policy_vector, "logits": logits,
            "policy": probabilities, "value": values, "movesToGo": progress,
        }

    def gradients(self, batch: tuple[np.ndarray, ...], value_weight: float,
                  policy_weight: float, progress_weight: float) -> tuple[dict[str, np.ndarray], dict[str, float]]:
        """Analytic backpropagation; each gradient is averaged over the mini-batch."""
        (states, actions, target_policy, mask, target_values, value_masks,
         target_progress, progress_masks) = batch
        result = self.forward(states, actions, mask)
        w = self.weights
        size = np.float32(len(states))
        d_logits = ((result["policy"] - target_policy) * mask *
                    np.float32(policy_weight) / size)
        grad_policy_bias = np.asarray([d_logits.sum()], dtype=np.float32)
        grad_policy_vector = np.einsum("bm,bma->ba", d_logits, result["action_embeddings"])
        d_action_embeddings = d_logits[:, :, None] * result["policy_vector"][:, None, :]
        grad_policy_pair = result["second"].T @ grad_policy_vector
        grad_policy_action = grad_policy_vector.sum(axis=0)
        d_second = grad_policy_vector @ w["policyPair"].T

        d_action_logits = d_action_embeddings * (1 - result["action_embeddings"] ** 2)
        grad_action_input = np.einsum("bma,bmi->ai", d_action_logits, actions)
        grad_action_bias = d_action_logits.sum(axis=(0, 1))

        value_error = result["value"] - target_values
        supervised_values = max(1.0, float(value_masks.sum()))
        d_value = (np.float32(2 * value_weight) * value_error * value_masks *
                   (1 - result["value"] ** 2) / np.float32(supervised_values))
        grad_value = result["second"].T @ d_value
        grad_value_bias = np.asarray([d_value.sum()], dtype=np.float32)
        d_second += d_value[:, None] * w["value"][None, :]

        progress_error = result["movesToGo"] - target_progress
        huber_delta = np.float32(.1)
        huber_gradient = np.where(
            np.abs(progress_error) <= huber_delta,
            progress_error,
            huber_delta * np.sign(progress_error),
        )
        supervised_progress = max(1.0, float(progress_masks.sum()))
        d_progress = (
            np.float32(progress_weight) * huber_gradient * progress_masks *
            result["movesToGo"] * (1 - result["movesToGo"]) /
            np.float32(supervised_progress)
        )
        grad_moves_to_go = result["second"].T @ d_progress
        grad_moves_to_go_bias = np.asarray([d_progress.sum()], dtype=np.float32)
        d_second += d_progress[:, None] * w["movesToGo"][None, :]

        d_second_logits = d_second * (1 - result["second"] ** 2)
        grad_state_hidden = d_second_logits.T @ result["first"]
        grad_state_hidden_bias = d_second_logits.sum(axis=0)
        d_first = d_second_logits @ w["stateHidden"]
        d_first_logits = d_first * (1 - result["first"] ** 2)
        grad_state_input = d_first_logits.T @ states
        grad_state_input_bias = d_first_logits.sum(axis=0)

        gradients = {
            "stateInput": grad_state_input, "stateInputBias": grad_state_input_bias,
            "stateHidden": grad_state_hidden, "stateHiddenBias": grad_state_hidden_bias,
            "actionInput": grad_action_input, "actionBias": grad_action_bias,
            "policyPair": grad_policy_pair, "policyAction": grad_policy_action,
            "policyBias": grad_policy_bias, "value": grad_value, "valueBias": grad_value_bias,
            "movesToGo": grad_moves_to_go, "movesToGoBias": grad_moves_to_go_bias,
        }
        policy_loss = -float((target_policy * np.log(np.maximum(result["policy"], 1e-9))).sum() / len(states))
        value_loss = float(np.sum((value_error ** 2) * value_masks) / supervised_values)
        absolute_progress_error = np.abs(progress_error)
        progress_loss = float(np.sum(np.where(
            absolute_progress_error <= huber_delta,
            .5 * progress_error ** 2,
            huber_delta * (absolute_progress_error - .5 * huber_delta),
        ) * progress_masks) / supervised_progress)
        return gradients, {
            "policyLoss": policy_loss,
            "valueLoss": value_loss,
            "valueSamples": int(value_masks.sum()),
            "progressLoss": progress_loss,
            "progressSamples": int(progress_masks.sum()),
        }

    def fit(self, samples: list[Sample], train_indices: np.ndarray, *, epochs: int,
            batch_size: int, learning_rate: float, value_weight: float,
            policy_weight: float, progress_weight: float, l2: float,
            seed: int) -> list[dict[str, float]]:
        """Mini-batch Adam optimizer with element-wise gradient clipping."""
        random = np.random.default_rng(seed)
        first_moment = {name: np.zeros_like(value) for name, value in self.weights.items()}
        second_moment = {name: np.zeros_like(value) for name, value in self.weights.items()}
        beta1, beta2, epsilon = np.float32(.9), np.float32(.999), np.float32(1e-8)
        update = 0
        history: list[dict[str, float]] = []
        for epoch in range(1, epochs + 1):
            shuffled = random.permutation(train_indices)
            policy_total = value_total = progress_total = 0.0
            value_samples = progress_samples = 0
            batches = 0
            for start in range(0, len(shuffled), batch_size):
                indices = shuffled[start:start + batch_size]
                gradients, metrics = self.gradients(
                    self._batch(samples, indices), value_weight, policy_weight, progress_weight,
                )
                update += 1
                for name, gradient in gradients.items():
                    apply_regularization = not (
                        (name in {"value", "valueBias"} and metrics["valueSamples"] == 0) or
                        (name in {"movesToGo", "movesToGoBias"} and
                         (metrics["progressSamples"] == 0 or progress_weight <= 0))
                    )
                    regularization = np.float32(l2) * self.weights[name] if apply_regularization else 0
                    gradient = np.clip(gradient + regularization, -.75, .75)
                    first_moment[name] = beta1 * first_moment[name] + (1 - beta1) * gradient
                    second_moment[name] = beta2 * second_moment[name] + (1 - beta2) * gradient * gradient
                    corrected_m = first_moment[name] / (1 - float(beta1) ** update)
                    corrected_v = second_moment[name] / (1 - float(beta2) ** update)
                    self.weights[name] -= np.float32(learning_rate) * corrected_m / (np.sqrt(corrected_v) + epsilon)
                policy_total += metrics["policyLoss"]
                value_total += metrics["valueLoss"] * metrics["valueSamples"]
                value_samples += metrics["valueSamples"]
                progress_total += metrics["progressLoss"] * metrics["progressSamples"]
                progress_samples += metrics["progressSamples"]
                batches += 1
            metrics = {
                "epoch": epoch,
                "policyLoss": policy_total / batches,
                "valueLoss": value_total / max(1, value_samples),
                "valueSamples": value_samples,
                "progressLoss": progress_total / max(1, progress_samples),
                "progressSamples": progress_samples,
            }
            history.append(metrics)
            print(json.dumps({"phase": "numpy_fit", **metrics}, ensure_ascii=False), flush=True)
        return history

    def evaluate(self, samples: list[Sample], indices: Iterable[int], batch_size: int) -> dict[str, float]:
        """Evaluate listwise policy and completed-only value calibration."""
        ordered = np.asarray(list(indices), dtype=np.int64)
        top1 = count = value_count = progress_count = 0
        policy_loss = value_mae = value_brier = progress_mae = 0.0
        calibration = {
            "early": {"count": 0, "predictedWins": 0.0, "actualWins": 0.0, "brier": 0.0},
            "middle": {"count": 0, "predictedWins": 0.0, "actualWins": 0.0, "brier": 0.0},
            "late": {"count": 0, "predictedWins": 0.0, "actualWins": 0.0, "brier": 0.0},
        }
        for start in range(0, len(ordered), batch_size):
            batch_indices = ordered[start:start + batch_size]
            batch = self._batch(samples, batch_indices)
            (states, actions, target_policy, mask, target_values, value_masks,
             target_progress, progress_masks) = batch
            prediction = self.forward(states, actions, mask)
            top1 += int(np.sum(np.argmax(prediction["policy"], axis=1) == np.argmax(target_policy, axis=1)))
            policy_loss -= float((target_policy * np.log(np.maximum(prediction["policy"], 1e-9))).sum())
            value_mae += float((np.abs(prediction["value"] - target_values) * value_masks).sum())
            predicted_wins = (prediction["value"] + 1) / 2
            actual_wins = (target_values + 1) / 2
            squared_probability_error = (predicted_wins - actual_wins) ** 2
            value_brier += float((squared_probability_error * value_masks).sum())
            progress_mae += float((np.abs(prediction["movesToGo"] - target_progress) * progress_masks).sum())
            for row, sample_index in enumerate(batch_indices):
                if value_masks[row] <= 0:
                    continue
                sample = samples[int(sample_index)]
                stage = stage_name(sample)
                bucket = calibration[stage]
                bucket["count"] += 1
                bucket["predictedWins"] += float(predicted_wins[row])
                bucket["actualWins"] += float(actual_wins[row])
                bucket["brier"] += float(squared_probability_error[row])
            value_count += int(value_masks.sum())
            progress_count += int(progress_masks.sum())
            count += len(states)
        calibration_report = {}
        for stage, bucket in calibration.items():
            stage_count = int(bucket["count"])
            calibration_report[stage] = {
                "samples": stage_count,
                "predictedWinRate": round(bucket["predictedWins"] / max(1, stage_count), 4),
                "actualWinRate": round(bucket["actualWins"] / max(1, stage_count), 4),
                "brier": round(bucket["brier"] / max(1, stage_count), 4),
            }
        return {
            "samples": count, "policyTop1": round(top1 / max(1, count), 4),
            "policyLoss": round(policy_loss / max(1, count), 4),
            "valueMae": round(value_mae / max(1, value_count), 4),
            "valueBrier": round(value_brier / max(1, value_count), 4),
            "valueSamples": value_count,
            "valueCalibration": calibration_report,
            "movesToGoMae": round(progress_mae / max(1, progress_count), 4),
            "progressSamples": progress_count,
        }

    @classmethod
    def from_checkpoint(cls, path: Path, state_size: int, action_size: int,
                        seed: int) -> "DynamicPolicyValueModel":
        """Restore a compatible JS/Python checkpoint for real continuation training."""
        model, _initialization = cls.initialize(
            state_size=state_size, action_size=action_size, seed=seed,
            mode="all", source_path=path, hidden_size=32, action_hidden_size=12,
        )
        return model

    @classmethod
    def initialize(cls, *, state_size: int, action_size: int, seed: int,
                   mode: str, source_path: Path | None, hidden_size: int,
                   action_hidden_size: int) -> tuple["DynamicPolicyValueModel", dict]:
        """Create scratch/policy/all initialization with auditable component sources.

        The optimizer is always created later with zero moments. In ``policy``
        mode the shared state tower is intentionally copied because it belongs
        to the deployed policy path; the value head is kept at the exact same
        seeded random initialization used by the scratch control.
        """
        if mode not in {"scratch", "policy", "all"}:
            raise ValueError(f"unsupported initialization mode: {mode}")
        if mode in {"policy", "all"} and not source_path:
            raise ValueError(f"--init-components {mode} requires --init-model")

        payload = None
        source_sha256 = None
        source_name = None
        if source_path:
            payload = json.loads(source_path.read_text(encoding="utf-8"))
            source_sha256 = hashlib.sha256(source_path.read_bytes()).hexdigest()
            source_name = source_path.name
            if payload.get("format") not in cls.READABLE_FORMATS:
                raise ValueError(f"unsupported checkpoint format: {source_path}")
            config = payload.get("config") or {}
            if int(config.get("stateSize", -1)) != state_size or int(config.get("actionSize", -1)) != action_size:
                raise ValueError("initial checkpoint is incompatible with dataset dimensions")
            hidden_size = int(config["hiddenSize"])
            action_hidden_size = int(config["actionHiddenSize"])

        model = cls(
            state_size, action_size, hidden_size=hidden_size,
            action_hidden_size=action_hidden_size, seed=seed,
        )
        copied = set()
        if payload is not None:
            source = payload.get("weights") or {}
            for name, destination in model.weights.items():
                if name not in source and name in {"movesToGo", "movesToGoBias"} and payload.get("format") == "dynamic-policy-value-v1":
                    continue
                if name not in source:
                    raise ValueError(f"initial checkpoint is missing weight: {name}")
                restored = np.asarray(source[name], dtype=np.float32).reshape(destination.shape)
                if not np.all(np.isfinite(restored)):
                    raise ValueError(f"initial checkpoint contains non-finite weight: {name}")
                should_copy = mode == "all" or (mode == "policy" and name in POLICY_COMPONENTS)
                if should_copy:
                    model.weights[name] = restored.copy()
                    copied.add(name)

        source_label = f"checkpoint:sha256:{source_sha256}" if source_sha256 else None
        component_sources = {
            name: source_label if name in copied else f"random:seed:{seed}"
            for name in model.weights
        }
        return model, {
            "mode": mode,
            "sourceCheckpoint": source_name,
            "sourceCheckpointSha256": source_sha256,
            "architectureSource": source_label or "cli",
            "optimizerMoments": "reset-zero",
            "componentSources": component_sources,
        }

    def checkpoint(self, metadata: dict) -> dict:
        """Serialize in the exact row-major format consumed by the JS runtime."""
        weights: dict[str, object] = {}
        for name, value in self.weights.items():
            flattened = np.round(value.reshape(-1), 7).tolist()
            weights[name] = flattened[0] if name in {"policyBias", "valueBias", "movesToGoBias"} else flattened
        return {
            "format": self.FORMAT,
            "config": {
                "stateSize": self.state_size, "actionSize": self.action_size,
                "hiddenSize": self.hidden_size, "actionHiddenSize": self.action_hidden_size,
                "seed": self.seed,
            },
            "weights": weights,
            "metadata": metadata,
        }


def main() -> None:
    parser = argparse.ArgumentParser(description="Train a dynamic policy-value model with vectorized NumPy")
    parser.add_argument("--dataset", required=True, type=Path)
    parser.add_argument("--output", required=True, type=Path)
    parser.add_argument("--init-model", type=Path, help="compatible architecture/component source checkpoint")
    parser.add_argument(
        "--init-components", required=True, choices=("scratch", "policy", "all"),
        help="scratch=random all; policy=copy policy path and reset value; all=continue every component",
    )
    parser.add_argument("--run-log", type=Path, help="optional AI lab latest.json to enrich")
    parser.add_argument("--epochs", type=int, default=12)
    parser.add_argument("--batch-size", type=int, default=32)
    parser.add_argument("--learning-rate", type=float, default=.0012)
    parser.add_argument("--value-weight", type=float, default=.45)
    parser.add_argument("--policy-weight", type=float, default=1.0)
    parser.add_argument("--progress-weight", type=float, default=0.0)
    parser.add_argument("--hidden-size", type=int, default=32)
    parser.add_argument("--action-hidden-size", type=int, default=12)
    parser.add_argument(
        "--samples-per-game-stage", type=int, default=12,
        help="balanced positions drawn from every game phase per epoch dataset",
    )
    parser.add_argument("--model-name", default="Chinese Checkers Policy-Value Robot V1.1 NumPy")
    parser.add_argument("--adapter-feature-version", type=int, default=1)
    parser.add_argument("--seed", type=int, default=20260823)
    args = parser.parse_args()

    started = time.perf_counter()
    samples = read_samples(args.dataset)
    state_size = len(samples[0].state)
    action_size = samples[0].actions.shape[1]
    if any(len(sample.state) != state_size or sample.actions.shape[1] != action_size for sample in samples):
        raise ValueError("dataset mixes incompatible encoder dimensions")
    # Split by opening family so mirrored colors, repeated opponents and every
    # position derived from the same opening can never cross partitions.
    game_ids = sorted({sample.game_id for sample in samples})
    group_ids = sorted({sample.split_group_id for sample in samples})
    split_random = np.random.default_rng(args.seed + 17)
    split_random.shuffle(group_ids)
    validation_group_count = max(1, round(len(group_ids) * .125)) if len(group_ids) > 1 else 0
    validation_groups = set(group_ids[:validation_group_count])
    train_groups = set(group_ids) - validation_groups
    raw_train_indices = np.asarray([
        index for index, sample in enumerate(samples)
        if sample.split_group_id in train_groups
    ], dtype=np.int64)
    raw_validation_indices = np.asarray([
        index for index, sample in enumerate(samples)
        if sample.split_group_id in validation_groups
    ], dtype=np.int64)
    positions_per_stage = max(1, args.samples_per_game_stage)
    train_indices = balanced_game_stage_indices(
        samples, train_groups, samples_per_stage=positions_per_stage,
        seed=args.seed + 31, repeat_short_stages=True,
    )
    validation_indices = balanced_game_stage_indices(
        samples, validation_groups, samples_per_stage=positions_per_stage,
        seed=args.seed + 37, repeat_short_stages=False,
    )
    if not len(train_indices):
        raise ValueError("opening-family split produced no balanced training positions")
    model, initialization = DynamicPolicyValueModel.initialize(
        state_size=state_size, action_size=action_size, seed=args.seed,
        mode=args.init_components, source_path=args.init_model,
        hidden_size=max(8, args.hidden_size),
        action_hidden_size=max(4, args.action_hidden_size),
    )
    history = model.fit(
        samples, train_indices, epochs=max(1, args.epochs), batch_size=max(1, args.batch_size),
        learning_rate=args.learning_rate, value_weight=args.value_weight,
        policy_weight=args.policy_weight, progress_weight=max(0, args.progress_weight),
        l2=1.5e-5, seed=args.seed + 1,
    )
    validation = model.evaluate(samples, validation_indices, max(1, args.batch_size))
    metadata = {
        "name": args.model_name,
        "adapterFeatureVersion": max(1, args.adapter_feature_version),
        "game": "chinese-checkers-2p", "status": "experimental",
        "objective": "policy-value-progress" if args.progress_weight > 0 else "policy-value",
        "algorithm": "candidate-listwise policy + completed-only W/L/MTG; vectorized NumPy mini-batch Adam",
        "trainer": {
            "language": "Python", "backend": "NumPy", "epochs": args.epochs,
            "batchSize": args.batch_size, "hiddenSize": model.hidden_size,
            "actionHiddenSize": model.action_hidden_size,
            "lossWeights": {"policy": args.policy_weight, "value": args.value_weight, "movesToGo": args.progress_weight},
            "initialization": initialization,
        },
        "dataset": {
            "path": args.dataset.name,
            "sha256": hashlib.sha256(args.dataset.read_bytes()).hexdigest(),
            "samples": len(samples),
            "games": len(game_ids), "groups": len(group_ids),
            "trainGroups": len(group_ids) - len(validation_groups),
            "validationGroups": len(validation_groups),
            "splitMode": "opening-family",
            "samplingMode": "uniform-game-stage",
            "samplesPerGameStage": positions_per_stage,
            "rawTrain": len(raw_train_indices), "rawValidation": len(raw_validation_indices),
            "train": len(train_indices), "validation": len(validation_indices),
        },
        "history": history, "validation": validation,
        "elapsedSeconds": round(time.perf_counter() - started, 2),
    }
    args.output.parent.mkdir(parents=True, exist_ok=True)
    args.output.write_text(json.dumps(model.checkpoint(metadata), ensure_ascii=False, indent=2) + "\n", encoding="utf-8")
    if args.run_log:
        run_log = json.loads(args.run_log.read_text(encoding="utf-8"))
        run_log.setdefault("histories", {})["numpy"] = history
        run_log["numericalBackend"] = {
            "language": "Python", "backend": "NumPy", "epochs": args.epochs,
            "batchSize": args.batch_size, "hiddenSize": model.hidden_size,
            "actionHiddenSize": model.action_hidden_size,
            "elapsedSeconds": metadata["elapsedSeconds"],
            "initialization": initialization, "validation": validation,
        }
        args.run_log.write_text(json.dumps(run_log, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")
        print(f"[Run] enriched={args.run_log.resolve()}", flush=True)
    print("TRAINING_RESULT " + json.dumps(metadata, ensure_ascii=False), flush=True)
    print(f"[Model] saved={args.output.resolve()}", flush=True)


if __name__ == "__main__":
    main()
