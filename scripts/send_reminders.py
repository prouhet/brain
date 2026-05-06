#!/usr/bin/env python3
"""
scripts/send_reminders.py

Runs hourly via GitHub Actions.
Asks Claude (with brain MCP) for due reminders, emails them, marks them fired.

No database needed — everything lives in the brain MCP.
"""

import json
import os
import smtplib
from datetime import datetime
from email.mime.multipart import MIMEMultipart
from email.mime.text import MIMEText

import anthropic

BRAIN_MCP_URL = "https://rzkrydqtgmuyeaipronh.supabase.co/functions/v1/open-brain-mcp"


def get_due_reminders(client: anthropic.Anthropic, brain_key: str) -> list[dict]:
    """Ask Claude to find due/overdue reminders in the brain."""
    now_str = datetime.now().strftime("%Y-%m-%d %H:%M")

    response = client.beta.messages.create(
        model="claude-sonnet-4-20250514",
        max_tokens=500,
        system=(
            "You are a data helper. Search the brain for tasks tagged 'reminder' "
            "that are due now or overdue (due time <= current time). "
            "Return ONLY a JSON array: "
            '[{"id":"...","text":"...","due":"YYYY-MM-DD HH:MM"}] '
            "If none are due, return []. No markdown, no preamble."
        ),
        messages=[{
            "role": "user",
            "content": f"Current time: {now_str}. Find all due or overdue reminders."
        }],
        mcp_servers=[{
            "type": "url",
            "url": BRAIN_MCP_URL,
            "name": "brain",
            "authorization_token": brain_key,
        }],
        betas=["mcp-client-2025-04-04"],
    )

    raw = "".join(
        block.text for block in response.content
        if hasattr(block, "text")
    ).replace("```json", "").replace("```", "").strip()

    try:
        items = json.loads(raw)
        return items if isinstance(items, list) else []
    except json.JSONDecodeError:
        print(f"Could not parse reminder response: {raw[:200]}")
        return []


def mark_fired(client: anthropic.Anthropic, brain_key: str, reminder: dict) -> None:
    """Archive the reminder so it doesn't fire again next hour."""
    try:
        client.beta.messages.create(
            model="claude-sonnet-4-20250514",
            max_tokens=200,
            system="You are a data helper. Archive the specified reminder in the brain.",
            messages=[{
                "role": "user",
                "content": (
                    f"Archive/complete the reminder with id \"{reminder['id']}\" "
                    f"(text: \"{reminder['text']}\"). It has been sent via email."
                )
            }],
            mcp_servers=[{
                "type": "url",
                "url": BRAIN_MCP_URL,
                "name": "brain",
                "authorization_token": brain_key,
            }],
            betas=["mcp-client-2025-04-04"],
        )
    except Exception as e:
        print(f"Warning: could not archive reminder {reminder['id']}: {e}")


def send_email(reminders: list[dict]) -> None:
    """Send reminder email via Gmail SMTP."""
    smtp_user = os.environ["SMTP_USER"]
    smtp_pass = os.environ["SMTP_PASS"]
    to_addrs  = [a.strip() for a in os.environ["EMAIL_TO"].split(",")]
    from_addr = smtp_user

    count = len(reminders)
    subject = f"⏰ Rosey: {count} reminder{'s' if count > 1 else ''} due"

    # Plain text body
    lines = [f"You have {count} reminder{'s' if count > 1 else ''} due:\n"]
    for r in reminders:
        due_str = f"  (was due {r['due']})" if r.get("due") else ""
        lines.append(f"  • {r['text']}{due_str}")
    lines += ["", "Open Rosey to snooze or mark complete.", "", "— Rosey 🌻"]
    text_body = "\n".join(lines)

    # HTML body
    items_html = "".join(
        f'<li style="margin:6px 0;">{r["text"]}'
        + (f' <span style="color:#9a9a94;font-size:12px;">due {r["due"]}</span>' if r.get("due") else "")
        + "</li>"
        for r in reminders
    )
    html_body = f"""
<div style="font-family:'DM Sans',sans-serif;max-width:480px;margin:0 auto;padding:24px">
  <div style="font-size:22px;margin-bottom:4px">🌻 Rosey</div>
  <div style="color:#9a9a94;font-size:13px;margin-bottom:20px">
    {datetime.now().strftime("%A, %B %-d")}
  </div>
  <div style="background:#fffbeb;border:1px solid #fde68a;border-radius:10px;padding:16px 20px">
    <div style="font-size:13px;font-weight:600;color:#92400e;margin-bottom:10px">
      ⏰ {count} reminder{'s' if count > 1 else ''} due
    </div>
    <ul style="margin:0;padding-left:18px;font-size:14px;color:#1a1a18;line-height:1.6">
      {items_html}
    </ul>
  </div>
  <div style="margin-top:16px;font-size:12px;color:#c4c4bc">
    Open Rosey to snooze or mark complete.
  </div>
</div>
"""

    msg = MIMEMultipart("alternative")
    msg["Subject"] = subject
    msg["From"]    = f"Rosey 🌻 <{from_addr}>"
    msg["To"]      = ", ".join(to_addrs)
    msg.attach(MIMEText(text_body, "plain"))
    msg.attach(MIMEText(html_body, "html"))

    with smtplib.SMTP("smtp.gmail.com", 587) as s:
        s.ehlo()
        s.starttls()
        s.login(smtp_user, smtp_pass)
        s.sendmail(from_addr, to_addrs, msg.as_string())

    print(f"Email sent to {', '.join(to_addrs)}")


def main():
    api_key   = os.environ["ANTHROPIC_API_KEY"]
    brain_key = os.environ["BRAIN_KEY"]

    client = anthropic.Anthropic(api_key=api_key)

    print(f"Checking reminders at {datetime.now().strftime('%Y-%m-%d %H:%M')} UTC…")
    reminders = get_due_reminders(client, brain_key)

    if not reminders:
        print("No due reminders. Done.")
        return

    print(f"Found {len(reminders)} due reminder(s): {[r['text'] for r in reminders]}")

    send_email(reminders)

    for r in reminders:
        mark_fired(client, brain_key, r)
        print(f"Archived: {r['text']}")

    print("Done.")


if __name__ == "__main__":
    main()
