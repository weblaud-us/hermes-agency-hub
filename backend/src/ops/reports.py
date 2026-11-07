"""Assemble a client's ROI report from its baseline and monthly snapshots."""

from __future__ import annotations

from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from ..clients.models import Client
from ..clients.schemas import BaselineMetrics
from .models import RoiSnapshot
from .roi import calculate_roi, current_period
from .schemas import RoiFunnel, RoiReport, RoiResultRead


async def roi_report(session: AsyncSession, client: Client, period: str | None = None) -> RoiReport:
    resolved = period or current_period()
    rows = list(
        (
            await session.execute(
                select(RoiSnapshot)
                .where(RoiSnapshot.client_id == client.id)
                .order_by(RoiSnapshot.period.desc())
            )
        ).scalars()
    )
    snapshot = next((row for row in rows if row.period == resolved), None)
    baseline = (
        BaselineMetrics(**client.baseline_metrics_json) if client.baseline_metrics_json else None
    )

    funnel = None
    if snapshot is not None:
        funnel = RoiFunnel(
            total_inquiries=snapshot.total_inquiries,
            qualified_leads=snapshot.qualified_leads,
            confirmed_outcomes=snapshot.confirmed_outcomes,
            conversion_rate=(
                round(snapshot.confirmed_outcomes / snapshot.total_inquiries * 100, 2)
                if snapshot.total_inquiries
                else None
            ),
        )

    result = None
    if snapshot is not None and baseline is not None:
        result = RoiResultRead.model_validate(
            calculate_roi(
                monthly_inquiries=baseline.monthly_inquiries,
                conversion_rate=baseline.conversion_rate,
                avg_value=(
                    snapshot.avg_order_or_profit_value
                    if snapshot.avg_order_or_profit_value is not None
                    else baseline.avg_order_or_profit_value
                ),
                retainer=(
                    snapshot.retainer
                    if snapshot.retainer is not None
                    else baseline.monthly_retainer_investment
                ),
                confirmed_outcomes=snapshot.confirmed_outcomes,
                ad_spend=snapshot.ad_spend,
            )
        )

    return RoiReport(
        period=resolved,
        currency=client.currency,
        business_mode=client.business_mode.value,
        baseline=baseline,
        funnel=funnel,
        result=result,
        available_periods=[row.period for row in rows],
    )
