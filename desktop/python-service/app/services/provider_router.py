from __future__ import annotations

import json
import os
from typing import Any
from urllib.parse import urlencode
from urllib.request import urlopen

from app.models.schemas import ProviderRecommendation

BAIDU_IP_API = "http://opendata.baidu.com/api.php"
PUBLIC_IP_APIS = (
    "https://api.ipify.org?format=json",
    "https://api.ip.sb/jsonip",
    "https://ifconfig.co/json",
)
GEO_IP_APIS = (
    "https://api.ip.sb/geoip/{ip}",
    "https://ipapi.co/{ip}/json/",
)
DEFAULT_NETWORK_TIMEOUT = 2.5


def _read_json(url: str, timeout: float = DEFAULT_NETWORK_TIMEOUT) -> dict[str, Any]:
    with urlopen(url, timeout=timeout) as response:  # nosec B310 - fixed URLs only
        payload = response.read().decode("utf-8")
    return json.loads(payload)


def _clean_text(value: Any) -> str | None:
    text = str(value or "").strip()
    return text or None


def _is_cn_location(*values: Any) -> bool:
    normalized_values = [str(value or "").strip().lower() for value in values]
    return any(
        value in {"cn", "china", "中国", "中华人民共和国"}
        or "中国" in value
        or value.endswith("省")
        or value.endswith("市")
        for value in normalized_values
        if value
    )


def _compose_location(*parts: Any) -> str | None:
    items: list[str] = []
    seen: set[str] = set()
    for part in parts:
        text = _clean_text(part)
        if not text or text in seen:
            continue
        seen.add(text)
        items.append(text)
    if not items:
        return None
    return " / ".join(items)


def get_public_ip() -> str | None:
    env_ip = os.environ.get("VOCA_PUBLIC_IP", "").strip()
    if env_ip:
        return env_ip

    for url in PUBLIC_IP_APIS:
        try:
            data = _read_json(url)
            ip_value = _clean_text(data.get("ip"))
            if ip_value:
                return ip_value
        except Exception:  # pragma: no cover - external network fallback
            continue
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


def get_geoip_location(ip_address: str) -> tuple[str | None, bool | None]:
    env_location = _clean_text(os.environ.get("VOCA_PUBLIC_LOCATION"))
    if env_location:
        return env_location, _is_cn_location(env_location)

    baidu_location = get_baidu_location(ip_address)
    if baidu_location:
        return baidu_location, _is_cn_location(baidu_location)

    for url_template in GEO_IP_APIS:
        try:
            data = _read_json(url_template.format(ip=ip_address))
        except Exception:  # pragma: no cover - external network fallback
            continue

        country = _clean_text(data.get("country") or data.get("country_name"))
        country_code = _clean_text(data.get("country_code") or data.get("countryCode"))
        region = _clean_text(data.get("region") or data.get("region_name"))
        city = _clean_text(data.get("city"))
        location = _compose_location(country, region, city)
        if location:
            return location, _is_cn_location(country_code, country, region, city)

    return None, None


def detect_region() -> tuple[str | None, str | None, bool | None]:
    """Return ``(public_ip, location, is_cn)`` using the shared geo lookup flow."""

    public_ip = get_public_ip()
    if not public_ip:
        return None, None, None
    location, is_cn = get_geoip_location(public_ip)
    return public_ip, location, is_cn


def prefer_cn_downloads() -> bool:
    """Whether domestic mirrors should be preferred for downloads.

    We intentionally keep the fallback aligned with the existing model-provider
    router: when region detection is unavailable, default to the domestic path
    instead of assuming overseas connectivity.
    """

    _public_ip, _location, is_cn = detect_region()
    if is_cn is None:
        return True
    return bool(is_cn)


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

    public_ip, location, is_cn = detect_region()
    if public_ip and location and is_cn:
        return ProviderRecommendation(
            publicIp=public_ip,
            location=location,
            preferred="auto",
            recommended="modelscope",
            current="modelscope",
            reason="ip_region_cn",
            userOverridden=False,
        )
    if public_ip and location:
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
        recommended="modelscope",
        current="modelscope",
        reason="default_fallback",
        userOverridden=False,
    )
