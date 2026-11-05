"""Prop-firm presets, guardrail warnings and webhook dispatch safety.

The webhook tests exist because that endpoint fetches a user-supplied URL from
inside the network. Without the address checks it is a ready-made SSRF
primitive aimed at cloud metadata and anything else on the private range, so
the guard is tested rather than trusted.
"""

from __future__ import annotations

import pytest

from services import propfirm

try:  # `uvicorn main:app` from inside backend/
    from main import _webhook_is_safe, app
except ImportError:  # pragma: no cover - imported as part of a package
    from .main import _webhook_is_safe, app


@pytest.fixture
def client():
    from fastapi.testclient import TestClient

    with TestClient(app) as test_client:
        yield test_client


# ---------------------------------------------------------------------------
# guardrails
# ---------------------------------------------------------------------------

def test_defaults_are_tighter_than_every_preset():
    """3.5% daily and 5% total are the project's standing caps. They must stay
    tighter than the loosest preset, or the default configuration would let a
    user blow a firm's rules before their own guardrail fires."""
    assert propfirm.DEFAULT_DAILY_LOSS_PCT == 3.5
    assert propfirm.DEFAULT_MAX_LOSS_PCT == 5.0

    loosest_daily = max(f["daily_loss_pct"] for f in propfirm.PROP_FIRMS)
    loosest_max = max(f["max_loss_pct"] for f in propfirm.PROP_FIRMS)
    assert propfirm.DEFAULT_DAILY_LOSS_PCT < loosest_daily
    assert propfirm.DEFAULT_MAX_LOSS_PCT <= loosest_max


def test_exceeding_the_firm_limit_is_called_out():
    firm = propfirm.firm_by_id("equityedge_1step_swift")  # 3% daily / 5% max
    warnings = propfirm.guardrail_warning(5.0, 5.0, firm)
    joined = " ".join(warnings)
    assert "EXCEEDS" in joined
    assert "3%" in joined


def test_approaching_the_firm_limit_warns_before_the_breach():
    """A guardrail set at the firm's own limit fires at the same instant as the
    breach, which is too late to act on. Warn with headroom."""
    firm = propfirm.firm_by_id("ftmo_2step")  # 5% daily / 10% max
    warnings = propfirm.guardrail_warning(4.5, 5.0, firm)
    assert any("within 15%" in w for w in warnings)


def test_trailing_drawdown_is_flagged_separately():
    """Trailing max loss follows peak equity, so a static total cap understates
    real exposure. Anyone configuring a trailing program is told so."""
    trailing = propfirm.firm_by_id("equityedge_1step_swift")
    assert trailing["max_loss_type"] == "trailing"

    warnings = propfirm.guardrail_warning(2.0, 3.0, trailing)
    assert any("TRAILING" in w for w in warnings)

    static = propfirm.firm_by_id("ftmo_2step")
    assert not any("TRAILING" in w for w in propfirm.guardrail_warning(2.0, 3.0, static))


def test_no_firm_selected_produces_no_warnings():
    assert propfirm.guardrail_warning(9.0, 15.0, None) == []


# ---------------------------------------------------------------------------
# universe
# ---------------------------------------------------------------------------

def test_universe_covers_every_class_the_brief_asked_for():
    symbols = {row["symbol"] for row in propfirm.INSTRUMENTS}
    for expected in [
        "EURUSD", "GBPUSD",          # forex majors
        "EURGBP", "GBPJPY",          # minors
        "US30", "US100", "US500", "GER40", "UK100",   # indices
        "XAUUSD", "XAGUSD", "USOIL", "UKOIL",         # metals and energy
        "BTCUSD", "ETHUSD", "SOLUSD",                 # crypto
    ]:
        assert expected in symbols, f"{expected} missing from the universe"


def test_spread_limits_match_the_brief():
    limits = {row["symbol"]: propfirm.spread_limit_for(row) for row in propfirm.INSTRUMENTS}
    # The brief specified forex 1.5 pips and gold 30 pips.
    assert limits["EURUSD"]["pips"] == 1.5
    assert limits["XAUUSD"]["pips"] == 30.0


def test_crypto_uses_bps_because_pips_are_meaningless_there():
    btc = next(r for r in propfirm.INSTRUMENTS if r["symbol"] == "BTCUSD")
    limit = propfirm.spread_limit_for(btc)
    assert limit["unit"] == "bps"
    assert limit["bps"] > 0


def test_energies_are_not_labelled_metals():
    """The brief grouped USOIL/UKOIL under metals. Their class drives the
    spread limit, so it stays factually correct even though both appear in the
    same watchlist."""
    classes = {r["symbol"]: r["class"] for r in propfirm.INSTRUMENTS}
    assert classes["XAUUSD"] == "metal"
    assert classes["USOIL"] == "energy"
    assert classes["UKOIL"] == "energy"


def test_describe_exposes_universe_firms_and_defaults():
    payload = propfirm.describe()
    assert payload["universe"]
    assert payload["firms"]
    assert payload["defaults"]["daily_loss_pct"] == 3.5
    assert payload["defaults"]["fixed_risk_choices"] == [0.5, 1.0, 2.0]


@pytest.mark.parametrize("firm_id", [f["id"] for f in propfirm.PROP_FIRMS])
def test_every_preset_documents_where_its_numbers_came_from(firm_id):
    """A limit nobody can trace back to the firm's own rules is a guess, and a
    guess is how an evaluation gets failed on a rule that was never enforced."""
    firm = propfirm.firm_by_id(firm_id)
    assert firm["source"].startswith("http")
    assert firm["note"]
    assert firm["max_loss_type"] in ("static", "trailing")


# ---------------------------------------------------------------------------
# webhook dispatch safety
# ---------------------------------------------------------------------------

@pytest.mark.parametrize(
    "url",
    [
        "http://localhost:8000/hook",
        "http://127.0.0.1/hook",
        "http://169.254.169.254/latest/meta-data/",  # cloud metadata
        "http://10.1.2.3/hook",
        "http://192.168.0.10/hook",
        "http://172.16.5.4/hook",
        "file:///etc/passwd",
        "ftp://example.com/hook",
    ],
)
def test_private_and_nonsense_targets_are_refused(url):
    assert _webhook_is_safe(url) is not None, f"{url} should have been refused"


def test_a_normal_webhook_is_allowed():
    assert _webhook_is_safe("https://discord.com/api/webhooks/123/abc") is None


def test_prop_describe_endpoint(client):
    response = client.get("/api/prop/describe")
    assert response.status_code == 200
    body = response.json()
    assert len(body["universe"]) == len(propfirm.INSTRUMENTS)
    assert body["defaults"]["daily_loss_pct"] == 3.5
