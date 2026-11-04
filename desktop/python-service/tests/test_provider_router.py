"""Provider recommendation rules.

These pin the *intended* routing behaviour so the mirror selection cannot
silently drift. The region lookup itself is monkeypatched: tests must never
touch the network.
"""

from __future__ import annotations

import pytest

from app.services import provider_router


def test_manual_override_never_probes_the_network(monkeypatch):
    def boom(*_args, **_kwargs):
        raise AssertionError("manual override must not call detect_region")

    monkeypatch.setattr(provider_router, "detect_region", boom)

    for preferred in ("huggingface", "modelscope"):
        recommendation = provider_router.recommend_provider(preferred)
        assert recommendation.recommended == preferred
        assert recommendation.reason == "manual_override"
        assert recommendation.userOverridden is True


def test_cn_region_prefers_modelscope(monkeypatch):
    monkeypatch.setattr(
        provider_router, "detect_region", lambda: ("203.0.113.7", "中国 北京", True)
    )
    recommendation = provider_router.recommend_provider("auto")
    assert recommendation.recommended == "modelscope"
    assert recommendation.reason == "ip_region_cn"
    assert recommendation.publicIp == "203.0.113.7"


def test_global_region_prefers_huggingface(monkeypatch):
    monkeypatch.setattr(
        provider_router, "detect_region", lambda: ("198.51.100.9", "United States", False)
    )
    recommendation = provider_router.recommend_provider("auto")
    assert recommendation.recommended == "huggingface"
    assert recommendation.reason == "ip_region_global"


def test_unknown_region_falls_back_to_modelscope_today(monkeypatch):
    """Documents the current default: detection failure = domestic mirror.

    This is the riskiest branch in the file (it decides which binary/model
    source is preferred when we know nothing), so it is pinned deliberately.
    Changing it should be a conscious, reviewed decision.
    """

    monkeypatch.setattr(provider_router, "detect_region", lambda: (None, None, None))
    recommendation = provider_router.recommend_provider("auto")
    assert recommendation.recommended == "modelscope"
    assert recommendation.reason == "default_fallback"


def test_public_ip_env_override_short_circuits_lookup(monkeypatch):
    monkeypatch.setenv("VOCA_PUBLIC_IP", "203.0.113.42")

    def boom(*_args, **_kwargs):
        raise AssertionError("VOCA_PUBLIC_IP should bypass the IP lookups")

    monkeypatch.setattr(provider_router, "_read_json", boom)
    assert provider_router.get_public_ip() == "203.0.113.42"


def test_cn_detection_accepts_localised_names():
    assert provider_router._is_cn_location("中国")
    assert provider_router._is_cn_location("cn")
    assert provider_router._is_cn_location("北京市")
    assert not provider_router._is_cn_location("Canada")
