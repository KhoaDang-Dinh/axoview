---
title: The AI assistant
audience: public
---

# The AI assistant

## What the assistant does

The Axoview AI button (bottom right, signed-in users) opens a chat. Ask how to do
something in Axoview and it answers from this manual, citing the sections it
used. Ask about your diagram and it can suggest changes as a checklist. It never
edits your diagram: you make every change yourself.

## Getting suggestions for your diagram

<!-- keywords: see my diagram, review, improve, recommend, suggestions, include this page -->

Tick **Include this page** before sending. The assistant then sees the open
page's item names, icons, connections, rectangles and text, and can suggest
steps such as "Connect Web server to Database" or "Group API and Worker in a
rectangle called Private subnet". Each suggestion is checked against your page:
one that refers to something that is not there is shown as not applicable, with
the reason. Tick suggestions off as you make them.

Without **Include this page**, nothing from your diagram is sent.

## What is sent and kept

<!-- keywords: privacy, data, stored, retention, logged -->

- Your message, and the page summary when you include it, are sent to Amazon
  Nova through Amazon Bedrock and checked by a content-safety guardrail.
- The conversation (your messages and the replies) is kept for 30 days. The page
  summary is used for that one reply and is not stored.
- Prompts and replies are never written to the service logs.

## Limits

<!-- keywords: how many, per day, messages, quota, daily, limit -->

Each account has a daily number of AI requests (20 unless your site sets
another); the count resets at midnight UTC. Messages are up to 2,000 characters.
When the limit is reached the assistant says so until the next day.
