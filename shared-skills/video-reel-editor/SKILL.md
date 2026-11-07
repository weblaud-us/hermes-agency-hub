---
name: video-reel-editor
description: Scripts and assembles short vertical reels from the business's footage, with captions and a shot guide for what still needs filming. Use when asked for a reel, a short video, a cut-down, captions on a clip, or a video concept.
---

# Video and reel editor

Make short vertical video that earns the first three seconds.

## Script every reel

1. **Hook, under 3 seconds.** A claim, a question, or the end result first.
2. **Proof, 10 to 25 seconds.** One idea. Show it, do not describe it.
3. **Ask.** One clear next step: message us, book, order.

Write the script as a table of shots: the time, what the camera sees, the words on
screen, and the voice-over if there is one.

## Shot guide

Before cutting, list what footage exists and what is missing. For anything missing,
write a one-line shot guide the owner or staff can film on a phone: the subject, the
angle (vertical, chest height), the length (5 to 8 seconds), and the light (near a
window, not under a ceiling bulb). If a shot the concept depends on does not exist,
offer a version that works without it rather than padding with stock that does not
match the business.

## Assemble with templates

Export 9:16 at 1080 x 1920, 30 fps. Use FFmpeg so the result is repeatable:

```bash
# Join the shots, scale and crop each to 9:16, and burn in the captions.
ffmpeg -i shot1.mp4 -i shot2.mp4 -i shot3.mp4 \
  -filter_complex "[0:v][1:v][2:v]concat=n=3:v=1:a=0,scale=1080:1920:force_original_aspect_ratio=increase,crop=1080:1920,subtitles=captions.srt:force_style='FontSize=18,Outline=2,Alignment=2'[v]" \
  -map "[v]" -c:v libx264 -pix_fmt yuv420p -crf 20 -r 30 reel.mp4
```

Put the brand's logo text and colour in the first and last second, from `brand_kit` in
the business profile. Keep the rest of the template the same from reel to reel so the
account looks like one business.

## Captions

Most people watch muted, so burn in captions in the language of the audience. Write
them as an SRT file: two lines at most, under 42 characters a line, each on screen long
enough to read.

## Hand over

Deliver the cut with its post caption, hook line and a suggested posting time. Reels sit
in the owner lane unless the owner has promoted them, so present and wait.

## Boundaries

- Only use licensed music. A muted reel beats a struck one.
- Never film or feature a customer without recorded consent.
- Never show a result, such as a before-and-after, that did not really happen.
