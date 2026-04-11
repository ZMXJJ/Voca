from __future__ import annotations

import json
import os
from typing import Any
from urllib.parse import urlencode
from urllib.request import urlopen

from app.models.schemas import ProviderRecommendation

BAIDU_IP_API = "http://opendata.baidu.com/api.php"
PUBLIC_IP_API = "https://api.ipify.org?format=json"


def _read_json(url: str, timeout: float = 5.0) -> dict[str, Any]:
    with urlopen(url, timeout=timeout) as response:  # nosec B310 - fixed URLs only
        payload = response.read().decode("utf-8")
    return json.loads(payload)


def get_public_ip() -> str | None:
    env_ip = os.environ.get("VOCA_PUBLIC_IP", "").strip()
    if env_ip:
        return env_ip

    try:
        data = _read_json(PUBLIC_IP_API)
        return str(data.get("ip") or "").strip() or None
    except Exception:  # pragma: no cover - external network fallback
        return None


def get_baidu_location(ip_address: str) -> str | None:
    query = urlencode(
        {
            "query": ip_address,
            "resource_id": "6006",
            "oe": "utf8",
        }
    )
    try:
        data = _read_json(f"{BAIDU_IP_API}?{query}")
        first_item = (data.get("data") or [{}])[0]
        return str(first_item.get("location") or "").strip() or None
    except Exception:  # pragma: no cover - external network fallback
        return None


def recommend_provider(preferred: str = "auto") -> ProviderRecommendation:
    if preferred in {"huggingface", "modelscope"}:
        return ProviderRecommendation(
            publicIp=None,
            location=None,
            preferred=preferred,
            recommended=preferred,
            current=preferred,
            reason="manual_override",
            userOverridden=True,
        )

    public_ip = get_public_ip()
    if public_ip:
        location = get_baidu_location(public_ip)
        if location and ("中国" in location or "省" in location or "市" in location):
            return ProviderRecommendation(
                publicIp=public_ip,
                location=location,
                preferred="auto",
                recommended="modelscope",
                current="modelscope",
                reason="ip_region_cn",
                userOverridden=False,
            )
        if location:
            return ProviderRecommendation(
                publicIp=public_ip,
                location=location,
                preferred="auto",
                recommended="huggingface",
                current="huggingface",
                reason="ip_region_global",
                userOverridden=False,
            )

    return ProviderRecommendation(
        publicIp=public_ip,
        location=None,
        preferred="auto",
        recommended="huggingface",
        current="huggingface",
        reason="default_fallback",
        userOverridden=False,
    )
