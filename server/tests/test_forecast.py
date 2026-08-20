from decimal import Decimal

from app.services.forecast import project


def test_conservative_forecast_spends_more() -> None:
    base = project(Decimal(1000), Decimal(500), Decimal(300), 3, "base")
    conservative = project(Decimal(1000), Decimal(500), Decimal(300), 3, "conservative")
    assert conservative[-1]["balance"] < base[-1]["balance"]
