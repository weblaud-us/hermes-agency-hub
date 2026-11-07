"""The Weblaud ROI measurement: before, after, and what the difference was worth.

    baseline outcomes        = monthly inquiries x conversion rate
    incremental gross profit = (confirmed outcomes - baseline outcomes) x value per outcome
    total investment         = retainer + ad spend
    net value generated      = incremental gross profit - total investment
    ROI %                    = net value / total investment x 100

Decimal throughout, because these are figures a client will check with a
calculator, and binary float rounding shows up in exactly that comparison.
"""

from __future__ import annotations

from dataclasses import dataclass
from datetime import datetime, timedelta, timezone
from decimal import ROUND_HALF_UP, Decimal
from typing import Any

#: Bangladesh has no daylight saving, so a fixed offset is exact here and needs
#: no timezone database, which a Windows interpreter may not have.
AGENCY_TZ = timezone(timedelta(hours=6))
_CENTS = Decimal("0.01")


def agency_now() -> datetime:
    return datetime.now(AGENCY_TZ)


def current_period() -> str:
    return agency_now().strftime("%Y-%m")


def _dec(value: Any) -> Decimal:
    # Through str, so 0.1 is the 0.1 the person typed and not its binary neighbour.
    return Decimal(str(value))


def _money(value: Decimal) -> float:
    return float(value.quantize(_CENTS, rounding=ROUND_HALF_UP))


@dataclass(frozen=True)
class RoiResult:
    baseline_outcomes: float
    current_outcomes: int
    value_per_outcome: float
    baseline_gross_profit: float
    current_gross_profit: float
    incremental_gross_profit: float
    retainer: float
    ad_spend: float
    total_investment: float
    net_value: float
    #: ``None`` when nothing was invested, since a percentage of zero is undefined.
    roi_percent: float | None


def calculate_roi(
    *,
    monthly_inquiries: int,
    conversion_rate: float,
    avg_value: float,
    retainer: float,
    confirmed_outcomes: int,
    ad_spend: float,
) -> RoiResult:
    baseline_outcomes = _dec(monthly_inquiries) * _dec(conversion_rate) / Decimal(100)
    value = _dec(avg_value)
    baseline_profit = baseline_outcomes * value
    current_profit = _dec(confirmed_outcomes) * value
    incremental = current_profit - baseline_profit
    investment = _dec(retainer) + _dec(ad_spend)
    net = incremental - investment
    roi = (net / investment * Decimal(100)) if investment > 0 else None
    return RoiResult(
        baseline_outcomes=_money(baseline_outcomes),
        current_outcomes=confirmed_outcomes,
        value_per_outcome=_money(value),
        baseline_gross_profit=_money(baseline_profit),
        current_gross_profit=_money(current_profit),
        incremental_gross_profit=_money(incremental),
        retainer=_money(_dec(retainer)),
        ad_spend=_money(_dec(ad_spend)),
        total_investment=_money(investment),
        net_value=_money(net),
        roi_percent=_money(roi) if roi is not None else None,
    )
