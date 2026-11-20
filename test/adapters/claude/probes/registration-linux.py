"""Run only in the disposable, offline Linux container with the pinned binary."""

import copy
import hashlib
import json
import os
from pathlib import Path
import platform
import subprocess
import tempfile


def write_json(path, value):
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(json.dumps(value, indent=4) + "\n")


def emit(value):
    print(json.dumps(value, sort_keys=True), flush=True)


def run(binary, cwd, env, *args):
    result = subprocess.run([binary, *args], cwd=cwd, env=env,
                            stdin=subprocess.DEVNULL, capture_output=True, text=True, timeout=30)
    emit(dict(argv=[str(binary), *args], cwd=str(cwd), exit=result.returncode,
              stdout=result.stdout, stderr=result.stderr))
    return result


def snapshot(paths):
    return {name: path.read_text() if path.exists() else None for name, path in paths.items()}


def exercise(binary, root, include_note):
    root.mkdir()
    home, project, market = (root / name for name in ("home", "project", "market"))
    home.mkdir()
    project.mkdir()
    env = dict(HOME=str(home), PATH="/usr/local/bin:/usr/bin:/bin", LANG="C.UTF-8",
               DISABLE_AUTOUPDATER="1", DISABLE_TELEMETRY="1")
    subprocess.run(["git", "init", "-q"], cwd=project, env=env, check=True)
    emit(dict(fixture=root.name))
    config = home / ".claude"
    paths = dict(project=project / ".claude/settings.json", local=project / ".claude/settings.local.json",
                 user=config / "settings.json", known=config / "plugins/known_marketplaces.json",
                 installed=config / "plugins/installed_plugins.json")
    subject = "subject@fixture-market"
    neighbor = "neighbor@fixture-market"
    group = dict(matcher="Write", hooks=[dict(type="command", command=f"printf {name}", timeout=4)
                                         for name in ("before", "owned", "after")])
    if include_note:
        group["note"] = "keep"
    initial = dict(hooks={"PreToolUse": [group]},
        enabledPlugins={"neighbor@fixture-market": True, "disabled@fixture-market": False},
        env={"FIXTURE_PROJECT": "original"})
    write_json(paths["project"], initial)
    write_json(paths["user"], {"env": {"FIXTURE_USER": "keep"}})
    write_json(paths["local"], {"env": {"FIXTURE_LOCAL": "keep"}})
    write_json(market / ".claude-plugin/marketplace.json", dict(name="fixture-market",
        owner={"name": "Fixture"}, plugins=[dict(name=name, source=f"./plugins/{name}")
                                          for name in ("neighbor", "subject")]))
    for name in ("neighbor", "subject"):
        write_json(market / f"plugins/{name}/.claude-plugin/plugin.json", dict(name=name, version="1.0.0"))

    verdicts = []

    def check(name, condition):
        verdicts.append(bool(condition))
        emit(dict(check=name, passed=bool(condition)))

    def step(name, *args):
        before = snapshot(paths)
        result = run(binary, project, env, "plugin", *args)
        after = snapshot(paths)
        emit(dict(fixture=root.name, step=name, before=before, after=after))
        return result, before, after

    def installed(state):
        return json.loads(state["installed"] or "{}").get("plugins", {})

    def project_installed(state, plugin, version):
        entries = installed(state).get(plugin, [])
        return len(entries) == 1 and all(entries[0].get(key) == value for key, value in
            dict(scope="project", projectPath=str(project), version=version).items())

    def independent_settings(before, after):
        return all(before[key] == after[key] for key in ("user", "local"))

    add = ("marketplace", "add", str(market), "--scope", "project")

    def guarded_add():
        current = json.loads(paths["project"].read_text())
        # This fixture contract covers this exact shape, not the full Claude schema.
        if any(set(entry) - {"matcher", "hooks"} for entry in current["hooks"]["PreToolUse"]):
            return None
        return step("guarded-add", *add)

    if include_note:
        saved = snapshot(paths)
        check("unproven field: preflight refuses without calling add or changing targets",
              guarded_add() is None and snapshot(paths) == saved)
        return all(verdicts)
    else:
        result, before, after = guarded_add()
    expected = copy.deepcopy(initial)
    expected["extraKnownMarketplaces"] = {"fixture-market": {"source": {"source": "directory", "path": str(market)}}}
    check("project add: exact expected settings delta", result.returncode == 0 and
          json.loads(after["project"] or "null") == expected and independent_settings(before, after))
    check("add registers only the requested local source", json.loads(after["known"] or "{}")
          .get("fixture-market", {}).get("source") == expected["extraKnownMarketplaces"]["fixture-market"]["source"]
          and before["installed"] == after["installed"])

    result, before, after = step("neighbor", "install", neighbor, "--scope", "project")
    check("neighbor installed before subject attempt", result.returncode == 0 and
          project_installed(after, neighbor, "1.0.0") and json.loads(after["project"] or "null") == expected
          and independent_settings(before, after))

    expected["env"]["FIXTURE_PROJECT"] = "user-edit"
    expected["hooks"]["PreToolUse"][0]["hooks"].append(dict(type="command", command="printf user-edit"))
    edited = copy.deepcopy(expected)
    write_json(paths["project"], edited)
    source = market / "plugins/subject"
    moved = source.with_name("subject-offline")
    source.rename(moved)
    result, before, after = step("ordinary-error", "install", subject, "--scope", "project")
    check("missing source: exact expected settings delta and unchanged registries", result.returncode == 1 and
          "Source path does not exist" in result.stderr + result.stdout and before["project"] != after["project"] and
          json.loads(after["project"] or "null") == expected and independent_settings(before, after) and
          before["known"] == after["known"] and before["installed"] == after["installed"] and
          subject not in installed(after))
    moved.rename(source)
    (source / 'fixture.txt').write_text('first')

    result, before, after = step("retry", "install", subject, "--scope", "project")
    expected["enabledPlugins"][subject] = True
    check("retry changes only the subject enablement in settings", result.returncode == 0 and
          json.loads(after["project"] or "null") == expected and independent_settings(before, after))
    check("retry installs at project scope and preserves neighbor", project_installed(after, subject, "1.0.0") and
          installed(after).get(neighbor) == installed(before).get(neighbor) and after["known"] == before["known"])

    result, before, after = step("repeat", "install", subject, "--scope", "project")
    check("repeat install leaves targets unchanged", result.returncode == 0 and before == after)

    (source / "fixture.txt").write_text("second")
    result, before, after = step("same-version-update", "update", subject, "--scope", "project")
    check("same-version update reports current and leaves registry unchanged", result.returncode == 0
          and "already" in (result.stdout + result.stderr).lower() and before == after)

    write_json(source / ".claude-plugin/plugin.json", dict(name="subject", version="1.0.1"))
    result, before, after = step("update", "update", subject, "--scope", "project")
    check("update preserves settings and advances only the subject install", result.returncode == 0 and
          all(before[key] == after[key] for key in ("project", "user", "local", "known")) and
          project_installed(after, subject, "1.0.1") and installed(after).get(neighbor) == installed(before).get(neighbor))

    result, _, _ = step("verify", "list", "--json")
    listed = json.loads(result.stdout) if result.returncode == 0 else []
    check("public list agrees on the project install", any(row.get("id") == subject and
          row.get("scope") == "project" and row.get("projectPath") == str(project) and
          row.get("version") == "1.0.1" and row.get("enabled") is True for row in listed))
    emit(dict(passed=sum(verdicts), total=len(verdicts)))
    return all(verdicts)


def declarative(binary, root):
    home, project, market = (root / name for name in ("home", "project", "market"))
    home.mkdir(parents=True)
    project.mkdir()
    env = dict(HOME=str(home), PATH="/usr/local/bin:/usr/bin:/bin", LANG="C.UTF-8",
               DISABLE_AUTOUPDATER="1", DISABLE_TELEMETRY="1")
    subprocess.run(["git", "init", "-q"], cwd=project, env=env, check=True)
    config = home / ".claude"
    paths = dict(project=project / ".claude/settings.json", local=project / ".claude/settings.local.json",
                 user=config / "settings.json", known=config / "plugins/known_marketplaces.json",
                 installed=config / "plugins/installed_plugins.json")
    plugin = market / "plugins/subject"
    manifest = plugin / ".claude-plugin/plugin.json"
    write_json(manifest, dict(name="subject", version="1.0.0"))
    write_json(market / ".claude-plugin/marketplace.json", dict(name="fixture-market", owner={"name": "Fixture"},
        plugins=[dict(name="subject", source="./plugins/subject")]))
    entry = {"source": {"source": "directory", "path": str(market)}}
    subject = "subject@fixture-market"
    settings = dict(extraKnownMarketplaces={"fixture-market": entry}, enabledPlugins={subject: True},
                    hooks={"PreToolUse": [dict(matcher="Write", note="keep", hooks=[
                        dict(type="command", command="printf before")])]})
    write_json(paths["project"], settings)
    write_json(paths["local"], {"hooks": settings["hooks"], "env": {"FIXTURE_LOCAL": "keep"}})
    trust = home / ".claude.json"
    verdicts = []

    def step(name, args, verify):
        before = snapshot(paths)
        result = run(binary, project, env, *args)
        after = snapshot(paths)
        emit(dict(fixture=root.name, step=name, before=before, after=after))
        unchanged_trust = not any(value.get("hasTrustDialogAccepted") for value in
            json.loads(trust.read_text() if trust.exists() else "{}").get("projects", {}).values())
        passed = unchanged_trust and before["project"] == after["project"] and verify(result, before, after)
        verdicts.append(bool(passed))
        emit(dict(check=name, passed=bool(passed)))

    def no_registration(result, before, after):
        return result.returncode == 0 and json.loads(result.stdout) == [] and before == after

    step("declaration alone: no configured marketplace", ["plugin", "marketplace", "list", "--json"], no_registration)
    step("declaration alone: no installed plugin", ["plugin", "list", "--json"], no_registration)

    settings["hooks"]["PreToolUse"][0]["note"] = "user-edit"
    write_json(paths["project"], settings)
    moved = plugin.with_name("subject-offline")
    plugin.rename(moved)
    step("declarative negative: missing directory rejected by validation",
         ["plugin", "validate", str(plugin)], lambda r, b, a: r.returncode != 0 and b == a)
    step("declarative negative: listing is not a source check", ["plugin", "list", "--json"], no_registration)
    moved.rename(plugin)
    step("declarative source valid after repair", ["plugin", "validate", str(plugin)],
         lambda r, b, a: r.returncode == 0 and b == a)
    step("declarative repeat after repair: still not installed", ["plugin", "list", "--json"], no_registration)
    step("explicit plugin directory resolves for one invocation, not as project install",
         ["--plugin-dir", str(plugin), "plugin", "list", "--json"],
         lambda r, b, a: r.returncode == 0 and b == a and any(row.get("id") == "subject@inline"
             and row.get("scope") == "session" and row.get("installPath") == str(plugin)
             for row in json.loads(r.stdout)))
    emit(dict(fixture=root.name, passed=sum(verdicts), total=len(verdicts)))
    return all(verdicts)


if __name__ == "__main__":
    assert platform.system() == "Linux" and Path("/.dockerenv").is_file() and os.getuid() != 0
    import argparse
    parser = argparse.ArgumentParser()
    parser.add_argument("binary",type=Path)
    executable = parser.parse_args().binary.resolve(strict=True)
    with executable.open("rb") as binary:
        digest = hashlib.file_digest(binary, "sha256").hexdigest()
        if platform.machine() != "aarch64" or digest != "2e2496c9a8065df93acb0fca2d341f59a6b8777649b2e025ab8c9bcd5eef61f3":
            raise SystemExit("unexpected native platform or binary")
    with tempfile.TemporaryDirectory(prefix="claude-registration-") as directory:
        root = Path(directory)
        version = run(executable, root, dict(HOME=directory, PATH="/usr/bin:/bin"), "--version")
        assert version.returncode == 0 and version.stdout.strip() == "2.1.311 (Claude Code)"
        results = [exercise(executable, root / "extended", True), exercise(executable, root / "supported", False),
                   declarative(executable, root / "declarative")]
        raise SystemExit(0 if all(results) else 1)
