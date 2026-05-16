#!/usr/bin/env python3
"""
scripts/send_reminders.py
Runs hourly via GitHub Actions.
Queries rosi_reminders directly from Supabase — no Claude/MCP needed.
Emails due reminders via Postmark, marks them emailed.
"""

import json
import os
import urllib.request
from datetime import datetime, timezone

SB_URL  = "https://rzkrydqtgmuyeaipronh.supabase.co"


def get_headers(sb_key):
    return {
        "apikey":        sb_key,
        "Authorization": f"Bearer {sb_key}",
        "Content-Type":  "application/json",
    }


def get_due_reminders(sb_key):
    now = datetime.now(timezone.utc).isoformat()
    params = (
        f"household_key=eq.drjampro"
        f"&done=eq.false"
        f"&due_at=lte.{now}"
        f"&select=id,text,due_at,set_by,for_member"
        f"&order=due_at.asc"
    )
    url = f"{SB_URL}/rest/v1/rosi_reminders?{params}"
    req = urllib.request.Request(url, headers=get_headers(sb_key))
    with urllib.request.urlopen(req) as resp:
        return json.loads(resp.read())


def mark_emailed(sb_key, reminder_id):
    url = f"{SB_URL}/rest/v1/rosi_reminders?id=eq.{reminder_id}"
    data = json.dumps({"emailed_at": datetime.now(timezone.utc).isoformat()}).encode()
    headers = {**get_headers(sb_key), "Prefer": "return=minimal"}
    req = urllib.request.Request(url, data=data, headers=headers, method="PATCH")
    with urllib.request.urlopen(req):
        pass


def send_postmark(reminders, postmark_token, from_addr, to_addrs):
    count = len(reminders)
    subject = f"⏰ Rosi: {count} reminder{'s' if count > 1 else ''} due"

    items_html = "".join(
        f'<li style="margin:8px 0;font-size:14px;">'
        f'<strong>{r["text"]}</strong>'
        + (f' <span style="color:#9a9a94;font-size:12px;">— set by {r["set_by"]}</span>' if r.get("set_by") else "")
        + (f'<br><span style="color:#c4c4bc;font-size:11px;">was due {r["due_at"][:16].replace("T"," ")} UTC</span>' if r.get("due_at") else "")
        + "</li>"
        for r in reminders
    )

    html_body = f"""
<div style="font-family:'DM Sans',Helvetica,sans-serif;max-width:480px;margin:0 auto;padding:24px;color:#1a1a18">
  <div style="font-size:24px;margin-bottom:2px">🌻 Rosi</div>
  <div style="color:#9a9a94;font-size:13px;margin-bottom:20px">{datetime.now().strftime("%A, %B %-d")}</div>
  <div style="background:#fffbeb;border:1px solid #fde68a;border-radius:10px;padding:16px 20px">
    <div style="font-size:12px;font-weight:600;color:#92400e;text-transform:uppercase;letter-spacing:.06em;margin-bottom:10px">
      ⏰ {count} reminder{'s' if count > 1 else ''} due
    </div>
    <ul style="margin:0;padding-left:18px;line-height:1.6">{items_html}</ul>
  </div>
  <div style="margin-top:16px;font-size:11px;color:#c4c4bc">
    Open Rosi to snooze or mark complete.
  </div>
</div>"""

    text_body = (
        f"Rosi — {count} reminder(s) due:\n\n"
        + "\n".join(f"• {r['text']}" + (f" [{r['set_by']}]" if r.get("set_by") else "") for r in reminders)
        + "\n\nOpen Rosi to snooze or mark complete."
    )

    payload = json.dumps({
        "From":          f"Rosi 🌻 <{from_addr}>",
        "To":            ", ".join(to_addrs),
        "Subject":       subject,
        "TextBody":      text_body,
        "HtmlBody":      html_body,
        "MessageStream": "outbound",
    }).encode()

    req = urllib.request.Request(
        "https://api.postmarkapp.com/email",
        data=payload,
        headers={
            "Accept":                  "application/json",
            "Content-Type":            "application/json",
            "X-Postmark-Server-Token": postmark_token,
        },
        method="POST",
    )
    with urllib.request.urlopen(req) as resp:
        result = json.loads(resp.read())
        print(f"Email sent to {', '.join(to_addrs)} — MessageID: {result.get('MessageID','?')}")


def main():
    sb_key         = os.environ["SUPABASE_ANON_KEY"]
    postmark_token = os.environ["POSTMARK_TOKEN"]
    from_addr      = os.environ.get("POSTMARK_FROM", "connect@reformed.fit")
    to_addrs       = [a.strip() for a in os.environ["EMAIL_TO"].split(",")]

    print(f"Checking reminders at {datetime.now(timezone.utc).strftime('%Y-%m-%d %H:%M')} UTC…")

    reminders = get_due_reminders(sb_key)

    if not reminders:
        print("No due reminders. Done.")
        return

    print(f"Found {len(reminders)}: {[r['text'] for r in reminders]}")
    send_postmark(reminders, postmark_token, from_addr, to_addrs)

    for r in reminders:
        mark_emailed(sb_key, r["id"])
        print(f"Marked emailed: {r['text']}")

    print("Done.")


if __name__ == "__main__":
    main()
