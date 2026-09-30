import base64
import json
import os
import runpy
import sys
import types

STATE, MODE = sys.argv[1:3]
EMAIL = sys.argv[3]


def access_token(account):
    claims = {"https://api.openai.com/auth": {"chatgpt_account_id": account}}
    payload = base64.urlsafe_b64encode(json.dumps(claims).encode()).decode().rstrip("=")
    return "fixture." + payload + ".refreshed"


def record(event, **fields):
    with open(STATE, "a", encoding="utf-8") as handle:
        handle.write(json.dumps(dict(event=event, **fields)) + "\n")


def audit(event, args):
    if event in ("socket.connect", "socket.getaddrinfo", "socket.sendto", "subprocess.Popen"):
        record("forbidden_network", operation=event)
        raise AssertionError("fixture network forbidden")


sys.addaudithook(audit)


class CurlError(Exception):
    code = 35


class HTTPError(Exception):
    response = types.SimpleNamespace(status_code=429)


class Cookies:
    def __init__(self):
        self.values = {}

    def set(self, name, value, **kwargs):
        self.values[name] = value


class Session:
    def __init__(self, auth):
        self.auth = auth
        self.cookies = Cookies()

    def get(self, url, **kwargs):
        if url != "https://chatgpt.com/api/auth/session":
            raise AssertionError("unexpected endpoint")
        record("auth_session", proxy=self.auth.proxy, fresh=self.auth.fresh)
        if not self.auth.fresh:
            if self.cookies.values.get("__Secure-next-auth.session-token") != "fixture-session":
                raise AssertionError("cached cookie missing")
            if MODE == "cache401":
                return types.SimpleNamespace(status_code=401)
            if MODE in ("cache429", "cache403"):
                return types.SimpleNamespace(status_code=int(MODE[-3:]))
            if MODE == "cacheTLSAlways" or (MODE == "cacheTLS" and self.auth.proxy.endswith(":8002")):
                raise CurlError("fixture private transport failure")
        account = "wrong-account" if MODE == "cacheMismatch" else "fixture-account"
        data = {"user": {"email": EMAIL}, "accessToken": access_token(account)}
        return types.SimpleNamespace(status_code=200, json=lambda: data)


class Auth:
    def __init__(self, config, fresh=False):
        self.proxy = config.proxy
        self.fresh = fresh
        self.result = types.SimpleNamespace(access_token="", session_token="fixture-session")
        self.session = Session(self)
        record("auth_open", proxy=self.proxy, fresh=fresh)

    def _chatgpt_client_headers(self, include_auth=False):
        if include_auth:
            raise AssertionError("identity probe must use session cookie")
        return {}

    def _extract_session_cookie(self):
        return "fixture-refreshed-session"

    def bootstrap_chatgpt_client_and_probe_trial(self, *, strict_coupon_errors=False):
        if strict_coupon_errors is not True:
            raise AssertionError("strict coupon errors required")
        record("coupon")
        return {"status": "eligible", "campaign_id": "plus-1-month-free", "amount_minor": 0,
                "amount_currency": "USD", "billing_country": "US",
                "source": "protocol_bootstrap/check_coupon", "detail": "check_coupon:state=eligible"}

    def close(self):
        record("close")


def login(email, password, secret, proxy=None):
    record("login", email=email, proxy=proxy,
           credentials_match=password == "fixture-password" and secret == "fixture-totp")
    if password != "fixture-password" or secret != "fixture-totp":
        raise AssertionError("unexpected credentials")
    if MODE == "http429":
        raise HTTPError("fixture private response")
    if MODE == "curl35" and proxy == "http://fixture.invalid:8002":
        raise CurlError("fixture private transport failure")
    if proxy not in ("http://fixture.invalid:8002", "http://fixture.invalid:8003"):
        raise AssertionError("unexpected trial proxy")
    auth = Auth(types.SimpleNamespace(proxy=proxy), fresh=True)
    data = auth.session.get("https://chatgpt.com/api/auth/session").json()
    auth.result.auth_session_json = json.dumps(data)
    auth.result.access_token = data["accessToken"]
    auth.result.session_token = "fixture-refreshed-session"
    return types.SimpleNamespace(account_id="fixture-account", factor_id="fixture-factor",
                                 session_token=auth.result.session_token, access_token=auth.result.access_token,
                                 auth=auth, result=auth.result)


class ChangeEmailClient:
    def __init__(self, *args, **kwargs):
        record("change_email")
        raise AssertionError("trial must not change email")


mfa = types.ModuleType("rebind_core.mfa_login")
mfa.login_with_password_and_totp = login
change = types.ModuleType("rebind_core.change_email")
change.ChangeEmailClient = ChangeEmailClient
sys.modules["rebind_core.mfa_login"] = mfa
sys.modules["rebind_core.change_email"] = change
registration = types.ModuleType("registration_core")
registration.__path__ = []
auth_flow = types.ModuleType("registration_core.auth_flow")
auth_flow.AuthFlow = Auth
config = types.ModuleType("registration_core.config")
config.Config = types.SimpleNamespace
sys.modules["registration_core"] = registration
sys.modules["registration_core.auth_flow"] = auth_flow
sys.modules["registration_core.config"] = config
worker_dir = os.path.abspath(os.path.join(os.path.dirname(__file__), "..", "..", "python", "rebind_worker"))
sys.path.insert(0, worker_dir)
runpy.run_path(os.path.join(worker_dir, "worker.py"), run_name="__main__")
