"""Prospect scoring and the team's daily stand-up."""

from __future__ import annotations

from dataclasses import dataclass

from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from .models import Prospect, StandupEntry

#: How many prospects the team aims to keep in the pipeline at once.
PIPELINE_TARGET = 100

SCORE_SIGNALS = (
    "no_website",
    "irregular_social",
    "slow_reply",
    "repeat_high_value_sales",
    "accessible_owner",
)


def priority_score(prospect: Prospect) -> int:
    """One point per signal, floored at 1 so every prospect sits on the 1-5 scale."""
    return max(1, sum(bool(getattr(prospect, signal)) for signal in SCORE_SIGNALS))


@dataclass(frozen=True)
class StandupMetric:
    key: str
    label: str
    target: int


@dataclass(frozen=True)
class StandupMember:
    key: str
    name: str
    focus: str
    metrics: tuple[StandupMetric, ...]


TEAM: tuple[StandupMember, ...] = (
    StandupMember(
        "sakib", "Sakib", "Growth & Audits",
        (StandupMetric("video_audits", "Video audits sent", 5), StandupMetric("growth_reviews", "Client growth reviews", 3)),
    ),
    StandupMember(
        "jubayed", "Jubayed", "Leads & Follow-ups",
        (StandupMetric("new_leads", "New leads", 15), StandupMetric("follow_ups", "Follow-ups", 10)),
    ),
    StandupMember(
        "ishtiaq", "Ishtiaq", "Demos & Closing",
        (StandupMetric("demos", "Demos run", 3), StandupMetric("closing_calls", "Closing calls", 2)),
    ),
)
TEAM_KEYS = {member.key for member in TEAM}
_METRICS = {(member.key, metric.key) for member in TEAM for metric in member.metrics}


def is_known_metric(member: str, metric: str) -> bool:
    return (member, metric) in _METRICS


async def standup_day(session: AsyncSession, day: str) -> list[dict[str, object]]:
    result = await session.execute(select(StandupEntry).where(StandupEntry.day == day))
    done = {(entry.member, entry.metric): entry.done for entry in result.scalars()}
    members: list[dict[str, object]] = []
    for member in TEAM:
        metrics = [
            {"key": metric.key, "label": metric.label, "target": metric.target, "done": done.get((member.key, metric.key), 0)}
            for metric in member.metrics
        ]
        target = sum(metric.target for metric in member.metrics)
        # Capped per metric, so overshooting leads cannot hide missed follow-ups.
        achieved = sum(min(item["done"], item["target"]) for item in metrics)
        members.append(
            {
                "key": member.key,
                "name": member.name,
                "focus": member.focus,
                "metrics": metrics,
                "completion_percent": round(achieved / target * 100) if target else 0,
            }
        )
    return members


async def set_standup(session: AsyncSession, day: str, member: str, metric: str, done: int) -> None:
    result = await session.execute(
        select(StandupEntry).where(
            StandupEntry.day == day, StandupEntry.member == member, StandupEntry.metric == metric
        )
    )
    entry = result.scalar_one_or_none()
    if entry is None:
        session.add(StandupEntry(day=day, member=member, metric=metric, done=done))
    else:
        entry.done = done
    await session.flush()
