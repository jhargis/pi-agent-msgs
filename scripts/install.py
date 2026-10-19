#!/usr/bin/env python3
"""Install the CLI/standard agent skill and, optionally, an OFF-by-default Pocket drop-in."""
import argparse
from pathlib import Path
import shutil

ROOT = Path(__file__).resolve().parents[1]


def link(source, target):
    target.parent.mkdir(parents=True, exist_ok=True)
    if target.is_symlink() and target.resolve() == source.resolve():
        return
    if target.exists() or target.is_symlink():
        raise SystemExit(f"Refusing to replace existing path: {target}")
    target.symlink_to(source, target_is_directory=source.is_dir())
    print(f"Linked {target} -> {source}")


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--bin-dir", type=Path, default=Path.home() / ".local/bin")
    parser.add_argument("--skill-dir", type=Path, default=Path.home() / ".agents/skills")
    parser.add_argument("--pocket-data", type=Path, help="Pocket's active data directory (not its source directory)")
    parser.add_argument("--pi-extension-dir", type=Path, help="Optionally install the terminal extension here; reporting stays off per session")
    parser.add_argument("--replace-extension", action="store_true", help="Replace an existing drop-in after reviewing changes")
    args = parser.parse_args()
    target = None
    if args.pocket_data:
        if not (args.pocket_data / "config.json").is_file():
            parser.error("--pocket-data must contain Pocket's config.json")
        target = args.pocket_data / "extensions/pi-agent-msgs.ts"
        if target.exists() and target.read_bytes() != (ROOT / "pocket/pi-agent-msgs.ts").read_bytes() and not args.replace_extension:
            parser.error(f"{target} already exists; review it and use --replace-extension to update")
    link(ROOT / "bin/pi-agent-msgs", args.bin_dir.expanduser() / "pi-agent-msgs")
    link(ROOT / "skills/pi-agent-msgs", args.skill_dir.expanduser() / "pi-agent-msgs")
    if args.pi_extension_dir:
        link(ROOT / "pi", args.pi_extension_dir.expanduser() / "pi-agent-msgs")
    if target:
        target.parent.mkdir(parents=True, exist_ok=True)
        if not target.exists() or target.read_bytes() != (ROOT / "pocket/pi-agent-msgs.ts").read_bytes():
            temp = target.with_suffix(".tmp")
            shutil.copyfile(ROOT / "pocket/pi-agent-msgs.ts", temp)
            temp.chmod(0o600)
            temp.replace(target)
            print(f"Copied {target}")
        print("Pocket: review the drop-in, then turn pi-agent-msgs on in Menu → Extensions.")
        print("Open the receiving conversation and ask: Receive agent messages here.")
    print("Existing agents may need /reload or a new session to discover the skill.")


if __name__ == "__main__":
    main()
