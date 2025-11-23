import json
import base64
import requests

processed_callback_ids = set()

def parse_callback_data(callback_query):
    s = callback_query.get("data", "")
    if s.startswith("b64:"):
        p = s[4:]
        m = len(p) % 4
        if m:
            p += "=" * (4 - m)
        d = base64.b64decode(p).decode("utf-8")
        return json.loads(d)
    return json.loads(s)

def tg_post(url, payload, timeout=5):
    try:
        return requests.post(url, json=payload, timeout=timeout)
    except Exception:
        return None

def tg_answer_callback(token, callback_query_id, text, show_alert=False, timeout=5):
    url = f"https://api.telegram.org/bot{token}/answerCallbackQuery"
    payload = {
        "callback_query_id": callback_query_id,
        "text": text,
        "show_alert": show_alert
    }
    return tg_post(url, payload, timeout)

def tg_send_message(token, chat_id, text, reply_markup=None, reply_to_message_id=None, timeout=10):
    url = f"https://api.telegram.org/bot{token}/sendMessage"
    payload = {
        "chat_id": chat_id,
        "text": text
    }
    if reply_markup is not None:
        payload["reply_markup"] = reply_markup
    if reply_to_message_id is not None:
        payload["reply_to_message_id"] = reply_to_message_id
    return tg_post(url, payload, timeout)
