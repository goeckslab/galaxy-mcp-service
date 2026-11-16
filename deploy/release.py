"""Update existing Lightsail MCP/broker containers; never provision infrastructure."""

import argparse
import fcntl
import json
import os
from pathlib import Path
import re
import shlex
import signal
import stat
import subprocess
import sys
import tempfile
from urllib.parse import urlsplit


def run(args, **kwargs):
    return subprocess.run(args, check=True, text=True, **kwargs)


def write_private(path, content):
    with tempfile.NamedTemporaryFile(mode="w", dir=path.parent, prefix=".release-", delete=False) as temporary:
        temporary.write(content)
        temporary.flush()
        os.fsync(temporary.fileno())
        temporary_path = Path(temporary.name)
    try:
        os.replace(temporary_path, path)
    finally:
        temporary_path.unlink(missing_ok=True)


def public_check(origin, broker=False):
    # A broker that shares the MCP hostname has no public readiness path of its own.
    checks = [("/.well-known/oauth-authorization-server", "200")] if broker else [("/readyz", "200"), ("/mcp", "401")]
    for path, expected in checks:
        response = run(["curl", "--silent", "--show-error", "--max-time", "15",
                        "--output", os.devnull, "--write-out", "%{http_code}", origin + path],
                       capture_output=True)
        if response.stdout != expected:
            raise RuntimeError(f"Public {path} check failed (expected {expected}).")


def hostname(config, name, required=True):
    values = re.findall(rf"^{name}=(.*)$", config, re.MULTILINE)
    fields = shlex.split(values[0]) if len(values) == 1 else []
    if len(fields) == 1 and re.fullmatch(r"[A-Za-z0-9-]+(?:\.[A-Za-z0-9-]+)+", fields[0]):
        return fields[0]
    if values or required:
        raise ValueError(f"{name} must be one literal DNS hostname.")
    return None


def release(root, image, with_broker=False, instances=None, build_context=None):
    if not re.fullmatch(r"galaxy-mcp-service:release-[A-Za-z0-9][A-Za-z0-9_.-]{0,100}", image):
        raise ValueError("Use a unique galaxy-mcp-service:release-... image tag.")
    data = root / "data"
    config = data / "lightsail.env"
    if data.is_symlink() or config.is_symlink() or not config.is_file():
        raise ValueError("An existing regular data/lightsail.env is required.")
    if stat.S_IMODE(config.stat().st_mode) != 0o600 or config.stat().st_uid != os.geteuid():
        raise ValueError("Run as the owner of data/lightsail.env; its mode must be 0600.")
    with os.fdopen(os.open(data / "release.lock", os.O_CREAT | os.O_RDWR | os.O_NOFOLLOW, 0o600), "w") as lock:
        fcntl.flock(lock, fcntl.LOCK_EX | fcntl.LOCK_NB)
        original = config.read_text()
        host = hostname(original, "MCP_HOST")
        legacy_mcp = hostname(original, "LEGACY_MCP_HOST", required=False)
        legacy_broker = hostname(original, "LEGACY_BROKER_HOST", required=False)
        if (legacy_mcp is None) != (legacy_broker is None):
            raise ValueError("Set LEGACY_MCP_HOST and LEGACY_BROKER_HOST together.")
        # The broker shares the MCP hostname; the legacy pair keeps the original two hostnames.
        mcps = {"mcp": host, **({"legacy-mcp": legacy_mcp} if legacy_mcp else {})}
        brokers = {"broker": host, **({"legacy-broker": legacy_broker} if legacy_broker else {})}
        candidate, count = re.subn(r"^GALAXY_MCP_IMAGE=.*$", lambda _: f"GALAXY_MCP_IMAGE='{image}'",
                                  original, flags=re.MULTILINE)
        if count != 1:
            raise ValueError("Expected exactly one GALAXY_MCP_IMAGE setting.")
        if instances is not None:
            if not with_broker or not isinstance(instances, dict) or not instances:
                raise ValueError("An instance-map update requires --with-broker and a nonempty JSON object.")
            for alias, value in instances.items():
                if not isinstance(alias, str) or not re.fullmatch(r"[a-z0-9][a-z0-9_-]{0,63}", alias) or not isinstance(value, str) or re.search(r"\s", value):
                    raise ValueError("Invalid approved Galaxy instance mapping.")
                url = urlsplit(value)
                if url.scheme != "https" or not url.hostname or url.username or url.password or url.query or url.fragment or value.endswith("/"):
                    raise ValueError("Use canonical HTTPS Galaxy URLs without credentials, queries, fragments or a trailing slash.")
            maps = re.findall(r"^GALAXY_INSTANCES_JSON=(.*)$", original, re.MULTILINE)
            fields = shlex.split(maps[0]) if len(maps) == 1 else []
            if len(fields) != 1:
                raise ValueError("Expected exactly one literal GALAXY_INSTANCES_JSON setting.")
            previous = json.loads(fields[0])
            if not isinstance(previous, dict) or any(instances.get(alias) != value for alias, value in previous.items()):
                raise ValueError("This release command only adds sites; existing aliases must not be removed or remapped.")
            encoded = shlex.quote(json.dumps(instances, separators=(",", ":")))
            candidate = re.sub(r"^GALAXY_INSTANCES_JSON=.*$", lambda _: "GALAXY_INSTANCES_JSON=" + encoded, candidate, flags=re.MULTILINE)
        compose = ["docker", "compose", "--project-name", "galaxy-mcp", "--env-file", "data/lightsail.env", "-f", "deploy/lightsail.compose.json"]
        keys = set(re.findall(r"^([A-Za-z_][A-Za-z0-9_]*)=", original, re.MULTILINE))
        compose_env = {key: value for key, value in os.environ.items() if key not in keys}
        services = [*mcps, *brokers] if with_broker else [*mcps]
        previous_images = {}
        for service in services:
            current = run(compose + ["ps", "-q", service], cwd=root, env=compose_env, capture_output=True).stdout.strip()
            if not current or "\n" in current:
                raise RuntimeError(f"Exactly one existing {service} container is required.")
            health = run(["docker", "inspect", "--format", "{{.State.Health.Status}}", current], capture_output=True)
            if health.stdout.strip() != "healthy":
                raise RuntimeError(f"The previous {service} container must be healthy before updating.")
            previous_images[service] = run(["docker", "inspect", "--format", "{{.Image}}", current], capture_output=True).stdout.strip()
            if not re.fullmatch(r"sha256:[a-f0-9]{64}", previous_images[service]):
                raise RuntimeError("Could not resolve the previous immutable image ID.")
        exists = subprocess.run(["docker", "image", "inspect", image], stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
        if exists.returncode == 0:
            raise ValueError("That release tag already exists; never overwrite a rollback image.")
        check_public(mcps, brokers if with_broker else {})
        # Dockerfile runs the existing lint, type and service tests before producing this image.
        run(["docker", "build", "-t", image, str(build_context) if build_context is not None else "."], cwd=root)
        with tempfile.NamedTemporaryFile(mode="w", dir=data, prefix="lightsail.env.pre-release-", delete=False) as backup:
            backup.write(original)
            backup.flush()
            os.fsync(backup.fileno())
        update = compose + ["up", "-d", "--no-deps", "--wait", "--wait-timeout", "180"]
        try:
            write_private(config, candidate)
            for service in services:
                run(update + [service], cwd=root, env={**compose_env, "GALAXY_MCP_IMAGE": image})
                if service in brokers:
                    public_check("https://" + brokers[service], broker=True)
            if with_broker:
                # MCP reads broker capabilities at startup; reload after the new broker is healthy.
                run(update + ["--force-recreate", *mcps], cwd=root, env={**compose_env, "GALAXY_MCP_IMAGE": image})
            check_public(mcps, {})
        except BaseException:
            try:
                write_private(config, original)
                # Restore the old broker before the old resource server: old MCP must never consume a bundle.
                for service in [*brokers, *mcps] if with_broker else [*mcps]:
                    run(update + [service], cwd=root, env={**compose_env, "GALAXY_MCP_IMAGE": previous_images[service]})
                check_public(mcps, brokers if with_broker else {})
            except BaseException:
                raise RuntimeError("Update and rollback failed. Recover using the retained configuration backup.") from None
            raise RuntimeError("Update failed; previous configuration and image restored and health checks passed.") from None
        print(f"MCP healthy: {image}. Backup: {Path(backup.name).relative_to(root)}. " + ("Broker updated and healthy." if with_broker else "Broker unchanged."))


def check_public(mcps, brokers):
    for host in brokers.values():
        public_check("https://" + host, broker=True)
    for host in mcps.values():
        public_check("https://" + host)


def interrupted(_signum, _frame):
    raise InterruptedError("Release interrupted.")


if __name__ == "__main__":
    signal.signal(signal.SIGTERM, interrupted)
    try:
        parser = argparse.ArgumentParser(description=__doc__)
        parser.add_argument("image")
        parser.add_argument("--with-broker", action="store_true")
        parser.add_argument("--build-context", type=Path, help="Clean source directory to build; live configuration remains in this checkout")
        parser.add_argument("--instances", type=Path, help="Reviewed additive instance-map JSON; requires --with-broker")
        args = parser.parse_args()
        instances = json.loads(args.instances.read_text()) if args.instances else None
        if args.instances and not isinstance(instances, dict):
            raise ValueError("The approved instance file must contain a JSON object.")
        release(Path(__file__).resolve().parents[1], args.image, with_broker=args.with_broker, instances=instances, build_context=args.build_context)
    except (Exception, KeyboardInterrupt) as error:
        # Do not print subprocess output, environment contents or credential-bearing diagnostics.
        print(str(error) if isinstance(error, (ValueError, RuntimeError)) else "Release failed; inspect the last safe build/status output.", file=sys.stderr)
        sys.exit(1)
