"""
One-Command Launcher & SMTP Dispatch Bridge for Project Resilience Engine
1. Verifies / generates compact supply_chain_data.json from DataCoSupplyChainDataset.csv if missing
2. Serves /app on http://localhost:8080 and opens browser automatically
3. Exposes POST /api/send-email & GET /api/smtp-status to dispatch real emails to abhinavjonnagadla1234@gmail.com
   using SMTP settings loaded dynamically from .env (never hard-coded).
"""
import json
import os
import smtplib
import sys
import webbrowser
from email.message import EmailMessage
from http.server import HTTPServer, SimpleHTTPRequestHandler

BASE_DIR = os.path.dirname(os.path.abspath(__file__))
APP_DIR = os.path.join(BASE_DIR, "app")
DATA_JSON = os.path.join(APP_DIR, "public", "data", "supply_chain_data.json")
ENV_PATH = os.path.join(BASE_DIR, ".env")

DEFAULT_RECIPIENT = "abhinavjonnagadla1234@gmail.com"


def load_env_config():
    """Reads .env dynamically on each request so changes take effect without restarting."""
    cfg = {
        "SMTP_ENABLED": os.environ.get("SMTP_ENABLED", "true"),
        "SMTP_HOST": os.environ.get("SMTP_HOST", "smtp.gmail.com"),
        "SMTP_PORT": os.environ.get("SMTP_PORT", "587"),
        "SMTP_USER": os.environ.get("SMTP_USER", DEFAULT_RECIPIENT),
        "SMTP_PASSWORD": os.environ.get("SMTP_PASSWORD", ""),
        "ALERT_RECIPIENT_EMAIL": os.environ.get("ALERT_RECIPIENT_EMAIL", DEFAULT_RECIPIENT),
    }
    if os.path.exists(ENV_PATH):
        with open(ENV_PATH, "r", encoding="utf-8", errors="ignore") as f:
            for line in f:
                s = line.strip()
                if not s or s.startswith("#") or "=" not in s:
                    continue
                k, v = s.split("=", 1)
                cfg[k.strip()] = v.strip().strip('"').strip("'")
    return cfg


def send_real_email(subject, body, tier_label="ALERT", region="Global", product="SKU"):
    cfg = load_env_config()
    recipient = cfg.get("ALERT_RECIPIENT_EMAIL") or DEFAULT_RECIPIENT
    smtp_user = cfg.get("SMTP_USER") or recipient
    smtp_pass = cfg.get("SMTP_PASSWORD", "").replace(" ", "")
    smtp_host = cfg.get("SMTP_HOST", "smtp.gmail.com")
    smtp_port = int(cfg.get("SMTP_PORT", "587") or 587)
    enabled = str(cfg.get("SMTP_ENABLED", "true")).lower() in ("true", "1", "yes")

    if not enabled:
        return {"ok": False, "reason": "SMTP_ENABLED is set to false in .env", "recipient": recipient}
    if not smtp_pass:
        return {
            "ok": False,
            "reason": "Missing SMTP_PASSWORD (Gmail 16-char App Password) in .env",
            "recipient": recipient
        }

    msg = EmailMessage()
    msg["Subject"] = subject
    msg["From"] = f"Project Resilience Engine <{smtp_user}>"
    msg["To"] = recipient
    msg.set_content(body)

    with smtplib.SMTP(smtp_host, smtp_port, timeout=12) as server:
        server.ehlo()
        server.starttls()
        server.ehlo()
        server.login(smtp_user, smtp_pass)
        server.send_message(msg)

    return {"ok": True, "recipient": recipient, "host": smtp_host}


class ControlTowerHandler(SimpleHTTPRequestHandler):
    def __init__(self, *args, **kwargs):
        super().__init__(*args, directory=APP_DIR, **kwargs)

    def end_headers(self):
        self.send_header("Cache-Control", "no-store, no-cache, must-revalidate")
        self.send_header("Access-Control-Allow-Origin", "*")
        self.send_header("Access-Control-Allow-Methods", "GET, POST, OPTIONS")
        self.send_header("Access-Control-Allow-Headers", "Content-Type")
        super().end_headers()

    def do_OPTIONS(self):
        self.send_response(200)
        self.end_headers()

    def do_GET(self):
        if self.path.startswith("/api/smtp-status"):
            cfg = load_env_config()
            has_pass = bool(cfg.get("SMTP_PASSWORD", ""))
            enabled = str(cfg.get("SMTP_ENABLED", "true")).lower() in ("true", "1", "yes")
            payload = {
                "configured": has_pass and enabled,
                "enabled": enabled,
                "has_password": has_pass,
                "recipient": cfg.get("ALERT_RECIPIENT_EMAIL", DEFAULT_RECIPIENT),
                "smtp_user": cfg.get("SMTP_USER", DEFAULT_RECIPIENT),
                "smtp_host": cfg.get("SMTP_HOST", "smtp.gmail.com")
            }
            self.send_response(200)
            self.send_header("Content-Type", "application/json")
            self.end_headers()
            self.wfile.write(json.dumps(payload).encode("utf-8"))
            return
        super().do_GET()

    def do_POST(self):
        if self.path.startswith("/api/send-email"):
            length = int(self.headers.get("Content-Length", 0))
            raw = self.rfile.read(length).decode("utf-8") if length > 0 else "{}"
            try:
                data = json.loads(raw)
                res = send_real_email(
                    subject=data.get("subject", "[Project Resilience Engine] Supply Chain Alert"),
                    body=data.get("body", ""),
                    tier_label=data.get("tierLabel", "ALERT"),
                    region=data.get("region", "Global"),
                    product=data.get("product", "SKU")
                )
                self.send_response(200)
            except Exception as e:
                res = {"ok": False, "reason": str(e)}
                self.send_response(200)

            self.send_header("Content-Type", "application/json")
            self.end_headers()
            self.wfile.write(json.dumps(res).encode("utf-8"))
            return

        self.send_response(404)
        self.end_headers()

    def log_message(self, format, *args):
        pass


def main():
    if not os.path.exists(DATA_JSON):
        print("Data bundle not found. Running prep_data.py...")
        import prep_data
        prep_data.main()

    port = int(os.environ.get("PORT", 8080))
    url = f"http://localhost:{port}/index.html"
    print("==========================================================================")
    print("  PROJECT RESILIENCE ENGINE — AUTONOMOUS SUPPLY CHAIN CONTROL TOWER")
    print(f"  Serving interactive React application at: {url}")
    print(f"  Live Email Alert Target: {DEFAULT_RECIPIENT}")
    print("==========================================================================")

    if "--no-browser" not in sys.argv:
        try:
            webbrowser.open(url)
        except Exception:
            pass

    server = HTTPServer(("127.0.0.1", port), ControlTowerHandler)
    try:
        server.serve_forever()
    except KeyboardInterrupt:
        print("\nShutting down Control Tower server.")
        server.server_close()


if __name__ == "__main__":
    main()
