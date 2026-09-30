import json
import os
import runpy
import sys
import types

STATE = sys.argv[1]


def read_state():
    try:
        with open(STATE, encoding="utf-8") as handle:
            return json.load(handle)
    except FileNotFoundError:
        return {"remote_email": "old@example.test", "logins": [], "begin": 0, "verify": 0}


def write_state(value):
    temporary = STATE + ".tmp"
    with open(temporary, "w", encoding="utf-8") as handle:
        json.dump(value, handle)
    os.replace(temporary, STATE)


class Auth:
    def close(self):
        return None


class Session:
    def __init__(self, email):
        state = read_state()
        self.account_id = "fixture-account"
        self.factor_id = "fixture-factor"
        self.session_token = "fixture-session-" + email
        self.access_token = "fixture-access-" + email
        self.auth = Auth()
        self.result = types.SimpleNamespace(auth_session_json=json.dumps({"user": {"email": state["remote_email"]}}))


def login(email, password, secret, proxy=None):
    state = read_state()
    if email != state["remote_email"] or password != "fixture-password" or secret != "fixture-totp":
        raise ValueError("fixture login credentials mismatch")
    state["logins"].append(email)
    write_state(state)
    return Session(email)


class ChangeEmailClient:
    def __init__(self, login):
        self.login = login

    def eligibility(self):
        return {"eligible": True}

    def begin(self, new_email):
        state = read_state()
        state["begin"] += 1
        write_state(state)

    def verify(self, new_email, code):
        state = read_state()
        state["verify"] += 1
        state["remote_email"] = new_email
        write_state(state)
        raise TimeoutError("fixture verify response lost after remote commit")


mfa = types.ModuleType("rebind_core.mfa_login")
mfa.login_with_password_and_totp = login
change = types.ModuleType("rebind_core.change_email")
change.ChangeEmailClient = ChangeEmailClient
sys.modules["rebind_core.mfa_login"] = mfa
sys.modules["rebind_core.change_email"] = change
worker_dir = os.path.abspath(os.path.join(os.path.dirname(__file__), "..", "..", "python", "rebind_worker"))
sys.path.insert(0, worker_dir)
runpy.run_path(os.path.join(worker_dir, "worker.py"), run_name="__main__")
