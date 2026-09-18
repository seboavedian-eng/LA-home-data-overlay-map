"""Tests for scripts/listing-server.py.

The server is the only piece of this project that holds a secret, so the
things worth testing are the ones that would leak it or waste it: that a key
in the shell beats a stale one in .env, that the status probe tells the truth
about whether a call can even be made, and that a request with nothing in it
is refused before it reaches the API.

Run:  python tests/test_listing_server.py
"""

import importlib.util
import json
import os
import sys
import tempfile
import threading
import urllib.error
import urllib.request
from functools import partial
from http.server import ThreadingHTTPServer

REPO = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))

# The script has a hyphen in its name, so it cannot be imported by name.
spec = importlib.util.spec_from_file_location(
    "listing_server", os.path.join(REPO, "scripts", "listing-server.py")
)
listing_server = importlib.util.module_from_spec(spec)
spec.loader.exec_module(listing_server)

failures = []


def check(name, ok, detail=""):
    print(f"{'PASS' if ok else 'FAIL'} - {name}" + (f" :: {detail}" if detail else ""))
    if not ok:
        failures.append(name)


def test_dotenv_does_not_overwrite_the_shell():
    with tempfile.TemporaryDirectory() as tmp:
        path = os.path.join(tmp, ".env")
        with open(path, "w", encoding="utf-8") as handle:
            handle.write("# a comment\n")
            handle.write('ANTHROPIC_API_KEY="sk-ant-from-file"\n')
            handle.write("LISTING_MODEL=claude-opus-5\n")
            handle.write("\n")
            handle.write("NOT_A_PAIR\n")

        os.environ.pop("LISTING_MODEL", None)
        os.environ["ANTHROPIC_API_KEY"] = "sk-ant-from-shell"
        listing_server.load_dotenv(path)
        check(
            "an exported key wins over a stale one in .env",
            os.environ["ANTHROPIC_API_KEY"] == "sk-ant-from-shell",
            os.environ["ANTHROPIC_API_KEY"],
        )
        check(
            "a variable the shell did not set is read from .env, quotes stripped",
            os.environ.get("LISTING_MODEL") == "claude-opus-5",
            os.environ.get("LISTING_MODEL"),
        )

        os.environ.pop("ANTHROPIC_API_KEY", None)
        os.environ.pop("LISTING_MODEL", None)
        listing_server.load_dotenv(path)
        check(
            "with nothing exported, the file supplies the key",
            os.environ.get("ANTHROPIC_API_KEY") == "sk-ant-from-file",
            os.environ.get("ANTHROPIC_API_KEY"),
        )

    os.environ.pop("ANTHROPIC_API_KEY", None)
    os.environ.pop("LISTING_MODEL", None)

    listing_server.load_dotenv(os.path.join(tempfile.gettempdir(), "definitely-not-here.env"))
    check("a missing .env is not an error - the shell may have the key", True)


def test_schema_is_self_consistent():
    schema = listing_server.SCHEMA
    props = set(schema["properties"])
    required = set(schema["required"])
    check(
        "every field is required, so a missing one comes back as an explicit null",
        props == required,
        f"only in properties: {sorted(props - required)}; only in required: {sorted(required - props)}",
    )
    check(
        "the schema refuses fields we did not ask for",
        schema["additionalProperties"] is False,
    )
    nullable = [k for k, v in schema["properties"].items() if "null" in v["type"]]
    check(
        "every field can be null - a listing page that does not say must not be guessed at",
        len(nullable) == len(props),
        f"not nullable: {sorted(props - set(nullable))}",
    )
    # The page maps these straight onto a listing, so a rename here silently
    # drops a row from the card.
    expected = {"address", "city", "zip", "price", "beds", "baths", "sqft",
                "lotSqft", "yearBuilt", "hoa", "type", "status", "mls"}
    check(
        "the field names are the ones the Redfin parser already produces",
        expected <= props,
        f"missing: {sorted(expected - props)}",
    )


def serve():
    handler = partial(listing_server.Handler, directory=REPO)
    server = ThreadingHTTPServer(("127.0.0.1", 0), handler)
    thread = threading.Thread(target=server.serve_forever, daemon=True)
    thread.start()
    return server, f"http://127.0.0.1:{server.server_address[1]}"


def post(base, payload, timeout=10):
    request = urllib.request.Request(
        f"{base}/api/extract",
        data=json.dumps(payload).encode("utf-8"),
        headers={"Content-Type": "application/json"},
        method="POST",
    )
    try:
        with urllib.request.urlopen(request, timeout=timeout) as response:
            return response.status, json.loads(response.read())
    except urllib.error.HTTPError as err:
        return err.code, json.loads(err.read())


def test_server():
    os.environ.pop("ANTHROPIC_API_KEY", None)
    os.environ.pop("ANTHROPIC_AUTH_TOKEN", None)
    server, base = serve()
    try:
        with urllib.request.urlopen(f"{base}/blockgroups.html", timeout=10) as response:
            body = response.read().decode("utf-8", "replace")
        check(
            "it still serves the page, so it replaces `python -m http.server` outright",
            "block" in body.lower() and len(body) > 1000,
            f"{len(body)} bytes",
        )

        with urllib.request.urlopen(f"{base}/api/extract", timeout=10) as response:
            status = json.loads(response.read())
        check(
            "with no key, the probe says so rather than claiming to be ready",
            status["ready"] is False and status["haveKey"] is False,
            json.dumps(status),
        )
        check(
            "the probe reports the default model, so the page can name it",
            status["model"] == listing_server.DEFAULT_MODEL,
            status["model"],
        )

        code, body = post(base, {})
        check(
            "a request with neither text nor a URL is refused before any API call",
            code == 400 and "Paste" in body["error"],
            f"{code} {body}",
        )

        code, body = post(base, {"url": "not-a-url"})
        check(
            "something that is not a URL is caught here, not by urllib deep inside",
            code == 400 and "URL" in body["error"],
            f"{code} {body}",
        )

        try:
            import anthropic  # noqa: F401

            have_sdk = True
        except ImportError:
            have_sdk = False

        code, body = post(base, {"text": "3 bd 2 ba"})
        if have_sdk:
            check(
                "with text but no key, the error names the file to put the key in",
                code == 400 and ".env" in body["error"] and "ANTHROPIC_API_KEY" in body["error"],
                f"{code} {body}",
            )
        else:
            # Missing package is checked first, and that is the right order:
            # a key can do nothing without it, so naming the key would send
            # you to fix the wrong thing.
            check(
                "with no SDK, the error is the pip command and not a key you cannot use yet",
                code == 400 and "pip install anthropic" in body["error"],
                f"{code} {body}",
            )

        request = urllib.request.Request(f"{base}/api/nonsense", data=b"{}", method="POST")
        try:
            urllib.request.urlopen(request, timeout=10)
            code = 200
        except urllib.error.HTTPError as err:
            code = err.code
        check("an unknown endpoint is a 404, not a crash", code == 404, str(code))

        # A key that exists but is nonsense must fail as an API error, not as
        # a setup error - otherwise the message sends you to fix a .env that
        # is already correct.
        os.environ["ANTHROPIC_API_KEY"] = "sk-ant-not-a-real-key"
        code, body = post(base, {"text": "3 bd 2 ba"}, timeout=120)
        if have_sdk:
            check(
                "a bad key fails as an API error, not as 'you have no key'",
                code == 502 or (code == 400 and ".env" not in body.get("error", "")),
                f"{code} {body}",
            )
        else:
            check(
                "without the SDK installed, the error is the pip command",
                code == 400 and "pip install anthropic" in body["error"],
                f"{code} {body}",
            )
        os.environ.pop("ANTHROPIC_API_KEY", None)
    finally:
        server.shutdown()
        server.server_close()


def main():
    test_dotenv_does_not_overwrite_the_shell()
    test_schema_is_self_consistent()
    test_server()
    print(f"\n{'FAILED: ' + ', '.join(failures) if failures else 'All listing-server checks passed.'}")
    return 1 if failures else 0


if __name__ == "__main__":
    sys.exit(main())
