#!/usr/bin/env python3
"""
Weblaud Autonomous Meta Graph API Publisher & Comment-to-Inbox Responder.
Handles:
1. Direct photo/caption publishing to Facebook Pages (/{page_id}/photos).
2. Direct container publishing to Instagram Business (/{ig_user_id}/media -> media_publish).
3. Automated public comment replies & Private Reply DM handoffs.
4. Graceful dry-run simulation when META_PAGE_ACCESS_TOKEN is not yet connected.
"""
from __future__ import annotations

import argparse
import json
import os
import urllib.parse
import urllib.request
import uuid
from datetime import datetime, timezone
from typing import Any

GRAPH_API_BASE = "https://graph.facebook.com/v21.0"


def _graph_post(endpoint: str, payload: dict[str, Any], access_token: str) -> dict[str, Any]:
    data = urllib.parse.urlencode({**payload, "access_token": access_token}).encode("utf-8")
    req = urllib.request.Request(f"{GRAPH_API_BASE}/{endpoint.lstrip('/')}", data=data, method="POST")
    with urllib.request.urlopen(req, timeout=30) as resp:
        return json.loads(resp.read().decode("utf-8"))


def publish_social_post(
    *,
    image_url_or_path: str,
    caption: str,
    platforms: list[str],
    page_id: str | None = None,
    ig_user_id: str | None = None,
    access_token: str | None = None,
) -> dict[str, Any]:
    token = (access_token or os.environ.get("META_PAGE_ACCESS_TOKEN", "")).strip()
    fb_page = (page_id or os.environ.get("META_PAGE_ID", "")).strip()
    ig_id = (ig_user_id or os.environ.get("META_IG_USER_ID", "")).strip()
    now_iso = datetime.now(timezone.utc).isoformat()

    # If live Meta credentials are not configured yet, return deterministic simulation receipt
    if not token or not fb_page:
        sim_id = f"post_{uuid.uuid4().hex[:10]}"
        return {
            "status": "published_simulated",
            "mode": "sandbox_autopilot",
            "post_id": sim_id,
            "platforms": platforms,
            "permalink": f"https://facebook.com/weblaud.autopilot/posts/{sim_id}",
            "caption": caption,
            "image_ref": image_url_or_path,
            "published_at": now_iso,
        }

    results: dict[str, Any] = {"status": "published_live", "published_at": now_iso, "platforms": {}}

    if "facebook" in platforms and fb_page:
        fb_res = _graph_post(
            f"{fb_page}/photos",
            {"url": image_url_or_path, "caption": caption, "published": "true"},
            token,
        )
        results["platforms"]["facebook"] = fb_res

    if "instagram" in platforms and ig_id:
        container = _graph_post(
            f"{ig_id}/media",
            {"image_url": image_url_or_path, "caption": caption},
            token,
        )
        creation_id = container.get("id")
        if creation_id:
            ig_res = _graph_post(
                f"{ig_id}/media_publish",
                {"creation_id": creation_id},
                token,
            )
            results["platforms"]["instagram"] = ig_res

    return results


def auto_reply_and_dm_comment(
    *,
    comment_id: str,
    public_reply: str,
    private_dm_text: str,
    access_token: str | None = None,
) -> dict[str, Any]:
    token = (access_token or os.environ.get("META_PAGE_ACCESS_TOKEN", "")).strip()
    now_iso = datetime.now(timezone.utc).isoformat()

    if not token:
        return {
            "status": "replied_simulated",
            "comment_id": comment_id,
            "public_reply": public_reply,
            "private_dm_sent": private_dm_text,
            "replied_at": now_iso,
        }

    pub_res = _graph_post(f"{comment_id}/comments", {"message": public_reply}, token)
    dm_res = _graph_post(
        f"{comment_id}/private_replies",
        {"message": private_dm_text},
        token,
    )
    return {
        "status": "replied_live",
        "comment_id": comment_id,
        "public_response": pub_res,
        "private_dm_response": dm_res,
        "replied_at": now_iso,
    }


def main() -> None:
    parser = argparse.ArgumentParser(description="Weblaud Autonomous Meta Publisher.")
    sub = parser.add_subparsers(dest="command", required=True)

    pub = sub.add_parser("publish")
    pub.add_argument("--image", required=True)
    pub.add_argument("--caption", required=True)
    pub.add_argument("--platforms", default="facebook,instagram")

    rep = sub.add_parser("reply-comment")
    rep.add_argument("--comment-id", required=True)
    rep.add_argument("--public-reply", required=True)
    rep.add_argument("--private-dm", required=True)

    args = parser.parse_args()
    if args.command == "publish":
        platforms = [p.strip() for p in args.platforms.split(",") if p.strip()]
        out = publish_social_post(image_url_or_path=args.image, caption=args.caption, platforms=platforms)
        print(json.dumps(out))
    elif args.command == "reply-comment":
        out = auto_reply_and_dm_comment(
            comment_id=args.comment_id,
            public_reply=args.public_reply,
            private_dm_text=args.private_dm,
        )
        print(json.dumps(out))


if __name__ == "__main__":
    main()
