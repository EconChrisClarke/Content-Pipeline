"""
Publishes one Content Pipeline card to Substack.

Run by .github/workflows/publish-substack.yml — not meant to be run directly
outside that workflow, since it expects to be sitting in a checkout of the
repo (reads/writes data/cards.json relative to the current directory) and
reads its secret from the environment.

Uses python-substack (https://pypi.org/project/python-substack/), a
third-party library built against Substack's undocumented internal API —
Substack has no official public API. Pinned to 0.6.0 in the workflow;
bump deliberately, not automatically, since an internal-API change on
Substack's end could change behavior here without warning.
"""
import os
import sys
import re
import json

CARDS_PATH = "data/cards.json"
PUBLICATION_URL = "https://econchrisclarke.substack.com"


def strip_unsupported_marks(text):
    """
    python-substack's from_markdown() supports headings, bold, italic,
    strikethrough, inline code, links, and images — but not underline.
    Our app's script text uses <u>...</u> for underline (see
    content-pipeline-status.md); rather than let literal "<u>" tags leak
    into the published post, drop the tags and keep the inner text. The
    underline styling itself just doesn't survive the trip to Substack.
    """
    return re.sub(r"</?u>", "", text or "")


def load_cards():
    with open(CARDS_PATH, "r", encoding="utf-8") as f:
        return json.load(f)


def save_cards(data):
    with open(CARDS_PATH, "w", encoding="utf-8") as f:
        json.dump(data, f, indent=2)
        f.write("\n")


def find_card(data, card_id):
    for c in data.get("cards", []):
        if c.get("id") == card_id:
            return c
    return None


def main():
    card_id = os.environ["CARD_ID"]
    dry_run = os.environ.get("DRY_RUN", "false").strip().lower() == "true"
    cookie_value = os.environ["SUBSTACK_SESSION_COOKIE"]

    data = load_cards()
    card = find_card(data, card_id)
    if card is None:
        print(f"::error::Card {card_id} not found in {CARDS_PATH}")
        sys.exit(1)

    card.setdefault("platforms", {}).setdefault(
        "substack", {"status": "not_started", "draft": "", "link": ""}
    )
    st = card["platforms"]["substack"]

    try:
        import requests as _requests

        # python-substack's Api.__init__ creates its requests.Session and
        # immediately uses it (to resolve the publication) before we'd get a
        # chance to touch api._session ourselves. Patch Session.__init__
        # itself so every session — including that internal one — carries
        # browser-like headers from its very first request. The default
        # "python-requests/x.y" User-Agent is a well-known trigger for
        # Cloudflare's bot challenge, which is what blocked the first
        # dry run (see the Actions log for run #1).
        _original_session_init = _requests.Session.__init__

        def _patched_session_init(self, *a, **kw):
            _original_session_init(self, *a, **kw)
            self.headers.update(
                {
                    "User-Agent": (
                        "Mozilla/5.0 (Windows NT 10.0; Win64; x64) "
                        "AppleWebKit/537.36 (KHTML, like Gecko) "
                        "Chrome/131.0.0.0 Safari/537.36"
                    ),
                    "Accept": "application/json, text/plain, */*",
                    "Accept-Language": "en-US,en;q=0.9",
                    "Referer": PUBLICATION_URL + "/",
                    "Origin": PUBLICATION_URL,
                }
            )

        _requests.Session.__init__ = _patched_session_init

        from substack import Api

        api = Api(
            publication_url=PUBLICATION_URL,
            cookies_string=f"substack.sid={cookie_value}",
        )

        title = card.get("title") or "Untitled"
        subtitle = card.get("subtitle") or ""
        script = strip_unsupported_marks(card.get("script") or "")
        tags = card.get("tags") or []

        # Publishing is handled explicitly below (after the cover image is
        # attached), so publish=False here regardless of dry_run.
        result = api.create_draft_from_markdown(
            title=title,
            subtitle=subtitle,
            markdown=script,
            audience="everyone",
            tags=tags,
            prepublish=False,
            publish=False,
        )
        draft = result["draft"]
        draft_id = draft.get("id")
        if draft_id is None:
            raise RuntimeError(f"No draft id in response: {draft}")

        # Cover image: best-effort. python-substack's create_draft_from_markdown
        # has no cover_image parameter, so this uploads the image (the same
        # get_image() call the library uses internally for inline images) and
        # PATCHes it onto the draft afterward. Not verified against a real
        # response yet — check the Actions log on the first real run.
        cover = card.get("coverImage")
        if cover and cover.get("path"):
            cover_path = cover["path"]
            if os.path.exists(cover_path):
                image_result = api.get_image(cover_path)
                cover_url = (
                    image_result.get("url")
                    if isinstance(image_result, dict)
                    else None
                )
                if cover_url:
                    api.put_draft(draft_id, cover_image=cover_url)
                else:
                    print(f"::warning::Could not resolve a cover image URL from: {image_result}")
            else:
                print(f"::warning::Cover image path not found on disk: {cover_path}")

        if dry_run:
            print(f"DRY RUN: draft created (id={draft_id}); not publishing.")
            st["status"] = "drafted"
            st["link"] = f"{PUBLICATION_URL}/publish/post/{draft_id}"
        else:
            api.prepublish_draft(draft_id)
            publish_result = api.publish_draft(
                draft_id, send=True, share_automatically=False
            )
            # The exact response shape isn't documented; try the likely keys
            # before falling back to a constructed URL.
            published_url = (
                publish_result.get("canonical_url")
                or publish_result.get("url")
                or publish_result.get("post_url")
            )
            if not published_url:
                slug = publish_result.get("slug")
                published_url = (
                    f"{PUBLICATION_URL}/p/{slug}"
                    if slug
                    else f"{PUBLICATION_URL}/publish/post/{draft_id}"
                )
            st["status"] = "published"
            st["link"] = published_url
            print(f"Published: {published_url}")

    except Exception as e:
        print(f"::error::Substack publish failed: {e}")
        st["status"] = "publish_failed"
        save_cards(data)
        sys.exit(1)

    save_cards(data)


if __name__ == "__main__":
    main()
