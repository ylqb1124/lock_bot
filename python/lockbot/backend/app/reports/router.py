"""Unauthenticated API for the read-only public report page."""

from fastapi import APIRouter, Depends, HTTPException
from sqlalchemy.orm import Session

from lockbot.backend.app.bots.models import Bot
from lockbot.backend.app.database import get_db
from lockbot.backend.app.reports.service import ReportUnavailableError, report_snapshot_service

router = APIRouter(prefix="/api/public/reports", tags=["public reports"])


def _get_public_bot(bot_id: int, db: Session) -> Bot:
    bot = db.get(Bot, bot_id)
    if not bot or bot.is_deleted:
        raise HTTPException(status_code=404, detail="Report bot not found")
    return bot


def _report_response(bot: Bot, force: bool) -> dict:
    try:
        snapshot, cached = report_snapshot_service.get_or_refresh(bot, force=force)
    except ReportUnavailableError as exc:
        raise HTTPException(status_code=409, detail="Bot is not running; report cannot be refreshed") from exc
    snapshot["cached"] = cached
    snapshot["cache_seconds"] = 60
    return snapshot


@router.get("/{bot_id}")
def get_public_report(bot_id: int, db: Session = Depends(get_db)):
    """Return the latest report, refreshing only when its one-minute cache is stale."""
    return _report_response(_get_public_bot(bot_id, db), force=False)


@router.post("/{bot_id}/refresh")
def refresh_public_report(bot_id: int, db: Session = Depends(get_db)):
    """Request a refresh.  The service still coalesces/limits work to one per minute."""
    return _report_response(_get_public_bot(bot_id, db), force=False)
