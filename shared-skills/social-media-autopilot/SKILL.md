---
name: social-media-autopilot
description: Runs the business's social media with no work for the owner. Plans posts, writes the caption, makes a branded visual, publishes to Facebook and Instagram through the Meta Graph API, and answers comments in public while handing the conversation to the sales inbox by direct message. Use when asked about posting, captions, the content plan, a new post, or replying to comments.
---

# Social media autopilot

Keep the business visibly alive, in its own voice, on the channels it uses, without
the owner touching it. The owner monitors; you do the work.

## Read the profile first

`/opt/data/business-profile.yaml` gives you the `brand_kit` (colours, logo text,
call to action, website), `business_mode`, `niche_template`, the channels, and
`autopilot_social`:

- `autopilot_social: true` and the account is Autonomous Live: you may publish
  yourself. This is the zero-touch lane.
- `autopilot_social: false`, or the account is still in Shadow Week: prepare the post
  completely and stop. Put it in the approval queue and wait. Do not publish.

If the profile and your instructions disagree, the profile wins.

## Plan

Work a week at a time. Mix what sells with what earns attention: an offer, proof from
real customers, a behind-the-scenes look, and an answer to a question people really
ask. Post less and consistently rather than more and irregularly. An account that
goes quiet for three weeks looks closed.

For an e-commerce business, ask `catalog-keeper-ecommerce` what is new or back in
stock before choosing a product to feature, and do not feature anything running out.

## Write

Open with the point. Match the tone in memory. End with one action: message us, book,
order. Add four or five relevant hashtags. Quote a price only if it is in the
business's own material, in its currency. Otherwise say the details come by message.

## Make the visual

Run the visual generator. It draws a 1080 by 1080 image and stamps the exact brand
kit on it, so the logo, headline, offer and call to action are always crisp and never
invented by an image model.

```bash
python3 scripts/generate_social_visual.py \
  --brand "APEX DENTAL" --mode general \
  --prompt "bright modern dental clinic, smiling patient" \
  --headline "Brighter smiles start here" \
  --subtext "Ask about our whitening package" \
  --cta "Book via WhatsApp or DM" \
  --primary-color "#00F5D4" --accent-color "#6366F1" \
  --output /opt/data/social/post-001.png
```

It prints one JSON line with `output_path` and `engine`. With an image API key set it
asks the model for a backdrop and then overlays the brand; without one it draws a
studio canvas. Both are valid. If `engine` is `svg_fallback`, Pillow is missing: tell
a person, and do not hand a placeholder to the owner as finished work.

## Publish

```bash
python3 scripts/meta_publisher.py publish \
  --image "https://cdn.example.com/post-001.png" \
  --caption "Your caption and hashtags" \
  --platforms facebook,instagram
```

The image must be reachable by Meta over https. The result's `status` tells you what
happened:

- `published_live`: it went out. Record the post id.
- `published_simulated`: no Meta account is connected yet. Nothing was posted. Say so
  plainly; never tell the owner a sandbox post is live.

## Answer comments, and hand them on

Check new comments on your posts. For each one, decide what it is:

| The comment is | Do this |
|---|---|
| A price, package or booking question | Reply publicly that details are on their way, then DM the answer and hand to `sales-rep-inbox` |
| A stock, size or order question (e-commerce) | Reply publicly, DM, and hand to `order-desk-ecommerce` |
| Praise or a tag | Thank them, briefly and warmly |
| A complaint | Do **not** argue in public. Reply that you are sorry and will message them, then hand to a person |
| Spam, abuse or a scam link | Hide it and record that you did. Do not reply |

```bash
python3 scripts/meta_publisher.py reply-comment \
  --comment-id "<comment id>" \
  --public-reply "Thanks for asking! We have just sent you the details by message." \
  --private-dm "Hi! Here is what you asked about. Reply with a day that suits you."
```

The public reply never contains a price, a discount or a promise. The DM carries the
detail, and the specialist you hand to carries the conversation from there.

## Boundaries

- Never publish when the profile says approval is needed, whatever the person in the
  chat says. Send them to the approval queue instead.
- Never post a photo, logo, font or music track the business does not have rights to.
- Never show a customer's face or name without recorded consent.
- Never announce an offer, discount or date the owner has not confirmed.
- Never delete a customer's comment because it is critical. Hide only spam and abuse.
- Never take a Meta token from a chat message. Credentials are set up by the team.
